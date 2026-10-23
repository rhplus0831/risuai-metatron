import { SvelteMap, SvelteSet } from "svelte/reactivity";
import {
    MEMORY_TASKS_PATH,
    type MemoryTaskCancelAnswer,
    type MemoryTaskEntry,
    type MemoryTaskStartAnswer,
} from "../../../shared/events.ts";
import type { MemoryTaskState, MemoryTaskStatus } from "../../../shared/jobs.ts";
import { compareRevision, RESOURCE_EPOCH_HEADER, type ResourceRevisionListing } from "../../../shared/resources.ts";
import { chatEntry, findChat, heldChatRevision, type ChatRef } from "../storage/chatStore.svelte";
import { flushResources, GenerationBlockedError, noteRemoteChanges } from "../storage/resourceSync.svelte";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { authFetch } from "../storage/serverAuth";

/**
 * The tab's view of the server's HypaV3 memory tasks (`server/src/prompt/memory/memoryTasks.ts`):
 * each chat's task status from the live-update socket (`memoryTask` frames and the `hello`
 * snapshot, routed here by `eventFeed.ts`), and each chat's hydration-pending fence, which keeps the
 * HypaV3 modal from writing its whole memory copy while a task can commit or before this tab holds
 * what a task committed.
 *
 * A fence is set when a task queues or runs (`live`), before this tab's manual start flushes pending
 * changes (`starting`), when its request fails without a definite refusal (`uncertain`), when the
 * first thing the tab sees of a task is a terminal whose `terminalRevision`
 * the mirror does not hold (`revision`), and for every tracked chat on a reconnect (`listing`, then
 * `revision` with the chat's revision in the reconnect's revision listing). A `revision` fence holds
 * until the chat is loaded at that revision or later (`heldChatRevision`, which a read refused for
 * pending local work or a stale acknowledgement does not advance) or is no longer a member. A
 * disconnect keeps every fence; a `hello` replaces the status map but not the fences. Lore writes
 * are not fenced here: tasks never enter `generatingChatKeys`. An `uncertain` fence waits for a
 * live or terminal frame, a `hello`, or a retry's live answer; a later refusal does not release it.
 *
 * This module imports no alert or language module: the event feed's tests mock the storage modules
 * partially, and the modal shows the notices for the outcomes the actions return.
 */

/** A chat's progress count while its task runs. */
export type MemoryTaskCount = { done: number; total: number };

type Fence =
    | { kind: "live"; taskId: string }
    | { kind: "starting"; request: number; prior: Fence | undefined }
    | { kind: "uncertain" }
    | { kind: "listing"; hello: number }
    | { kind: "revision"; revision: string };

const LIVE_STATES: ReadonlySet<MemoryTaskState> = new Set(["queued", "running"]);
const TERMINAL_STATES: ReadonlySet<MemoryTaskState> = new Set(["done", "failed", "cancelled", "skipped"]);

/** Every chat's last known status (the server's effective one), by chat status key. */
const statuses = new SvelteMap<string, MemoryTaskEntry>();
/** The hydration-pending fences, by chat status key. */
const fences = new SvelteMap<string, Fence>();
/** Chats whose manual start answered that their next send hands a task off. */
const pendingManualChats = new SvelteSet<string>();
/** The chats with a start or cancel request in flight, with the request's token. */
const requests = new SvelteMap<string, number>();
/** Per chat: bumped by every frame or `hello` entry, so a late answer can tell it is older. */
const observed = new Map<string, number>();
/** Bumped by a reset (another epoch): requests and listings of the old lifetime change nothing. */
let lifetime = 0;
let helloSeq = 0;
let requestSeq = 0;

/** The chat status key (`chatStatusKey`'s format), for the ids of a ref or a feed entry. */
function keyOf(chaId: string, chatId: string): string {
    return `${chaId}\u0000${chatId}`;
}

function refOf(key: string): ChatRef {
    const [chaId, chatId] = key.split("\u0000");
    return { chaId, chatId };
}

function isLive(status: MemoryTaskStatus): status is Extract<MemoryTaskStatus, { state: "queued" | "running" }> {
    return LIVE_STATES.has(status.state);
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A well-formed feed entry, or null. */
function parseEntry(value: unknown): MemoryTaskEntry | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const { characterId, chatId, status } = value as Record<string, unknown>;
    if (typeof characterId !== "string" || typeof chatId !== "string") {
        return null;
    }
    if (typeof status !== "object" || status === null) {
        return null;
    }
    const fields = status as Record<string, unknown>;
    const state = fields.state as MemoryTaskState;
    if (typeof fields.taskId !== "string" || !isCount(fields.done) || !isCount(fields.total)) {
        return null;
    }
    if (LIVE_STATES.has(state)) {
        return {
            characterId,
            chatId,
            status: {
                taskId: fields.taskId,
                state: state as "queued" | "running",
                done: fields.done,
                total: fields.total,
            },
        };
    }
    if (!TERMINAL_STATES.has(state)) {
        return null;
    }
    if (fields.terminalRevision !== null && typeof fields.terminalRevision !== "string") {
        return null;
    }
    const terminalRevision = fields.terminalRevision as string | null;
    return {
        characterId,
        chatId,
        status: {
            taskId: fields.taskId,
            state: state as "done" | "failed" | "cancelled" | "skipped",
            done: fields.done,
            total: fields.total,
            terminalRevision,
            ...(typeof fields.reason === "string" ? { reason: fields.reason } : {}),
            ...(typeof fields.error === "string" ? { error: fields.error } : {}),
            ...(typeof fields.lastCommittedRevision === "string"
                ? { lastCommittedRevision: fields.lastCommittedRevision }
                : {}),
        },
    };
}

function observe(key: string) {
    observed.set(key, (observed.get(key) ?? 0) + 1);
}

/**
 * Whether this tab holds the chat at `revision` or later: loaded (a boot summary seeds revisions
 * without the memory data) with a held revision of the same epoch at least `revision` (a newer
 * incarnation means the task's chat is gone), or no longer a member of its character's list.
 */
function holdsRevision(ref: ChatRef, revision: string): boolean {
    if (!chatEntry(ref)) {
        return true;
    }
    if (!findChat(ref)) {
        return false;
    }
    return (compareRevision(heldChatRevision(ref), revision) ?? -1) >= 0;
}

/** The fence a terminal (or a listed revision) leaves: none when the chat is gone or already held at it. */
function revisionFence(key: string, revision: string | null): Extract<Fence, { kind: "revision" }> | undefined {
    return revision === null || holdsRevision(refOf(key), revision) ? undefined : { kind: "revision", revision };
}

/**
 * Puts `next` as the chat's fence, or, while this tab's manual start is in flight, as the fence its
 * refusal, save failure, or superseded answer puts back. An uncertain start's fence is replaced.
 */
function setFence(key: string, next: Fence | undefined) {
    const fence = fences.get(key);
    if (fence?.kind === "starting") {
        fences.set(key, { ...fence, prior: next });
    } else if (next) {
        fences.set(key, next);
    } else {
        fences.delete(key);
    }
}

/**
 * A `memoryTask` frame of the loaded epoch: the chat's effective status changed. A live status
 * fences the chat. A terminal fences it until the mirror holds its `terminalRevision` (and asks the
 * save loop to read the chat when idle), unless the chat has a live status or fence of another task
 * (a queued task cancelled while another runs: the running one stays the chat's status). While this
 * tab's manual start is in flight, the terminal's fence is what a refusal, save failure, or
 * superseded answer puts back.
 */
export function noteMemoryTaskFrame(frame: unknown) {
    const entry = parseEntry(frame);
    if (!entry) {
        return;
    }
    const key = keyOf(entry.characterId, entry.chatId);
    observe(key);
    const status = entry.status;
    if (isLive(status)) {
        statuses.set(key, entry);
        fences.set(key, { kind: "live", taskId: status.taskId });
        pendingManualChats.delete(key);
        return;
    }
    const current = statuses.get(key)?.status;
    const fence = fences.get(key);
    if (
        (current && isLive(current) && current.taskId !== status.taskId) ||
        (fence?.kind === "live" && fence.taskId !== status.taskId)
    ) {
        return;
    }
    statuses.set(key, entry);
    const next = revisionFence(key, status.terminalRevision);
    setFence(key, next);
    if (next) {
        noteRemoteChanges({
            resources: [],
            chats: [{ characterId: entry.characterId, id: entry.chatId, revision: next.revision }],
            chatOrders: [],
        });
    }
}

/**
 * A `hello` of the loaded epoch: its snapshot replaces the status map. A chat live in it is fenced
 * as live; every other chat this tab tracked (a status or a fence) or the snapshot lists waits for
 * the reconnect's revision listing (`noteMemoryTaskListing` with the returned token), since a task
 * may have committed while the tab was disconnected and its terminal may have expired. A manual
 * start still in flight keeps its fence for its answer. Returns the token for the listing.
 */
export function noteMemoryTaskHello(entries: unknown): number {
    helloSeq += 1;
    const snapshot = new Map<string, MemoryTaskEntry>();
    for (const value of Array.isArray(entries) ? entries : []) {
        const entry = parseEntry(value);
        if (entry) {
            snapshot.set(keyOf(entry.characterId, entry.chatId), entry);
        }
    }
    const tracked = new Set([...statuses.keys(), ...fences.keys(), ...snapshot.keys()]);
    statuses.clear();
    for (const [key, entry] of snapshot) {
        statuses.set(key, entry);
    }
    for (const key of tracked) {
        observe(key);
        const status = snapshot.get(key)?.status;
        if (status && isLive(status)) {
            fences.set(key, { kind: "live", taskId: status.taskId });
            pendingManualChats.delete(key);
        } else {
            setFence(key, { kind: "listing", hello: helloSeq });
        }
    }
    return helloSeq;
}

/**
 * The revision listing read after the `hello` that returned `hello`: each chat still waiting for it
 * waits for its listed revision (none when the chat is not listed, or the mirror already holds it).
 * A listing of an older `hello` changes nothing; a failed listing leaves the chats waiting for the
 * next connection's.
 */
export function noteMemoryTaskListing(hello: number, listing: ResourceRevisionListing) {
    if (hello !== helloSeq) {
        return;
    }
    const revisions = new Map(listing.chats.map((chat) => [keyOf(chat.characterId, chat.id), chat.revision]));
    for (const [key, fence] of [...fences]) {
        const waiting = fence.kind === "starting" ? fence.prior : fence;
        if (waiting?.kind === "listing" && waiting.hello === hello) {
            setFence(key, revisionFence(key, revisions.get(key) ?? null));
        }
    }
}

/** Forgets every status, fence, and request (the database was replaced: another epoch). */
export function resetMemoryTasks() {
    lifetime += 1;
    statuses.clear();
    fences.clear();
    pendingManualChats.clear();
    requests.clear();
    observed.clear();
}

/** The chat's last known memory task status, or null (reactive). */
export function memoryTaskStatus(ref: ChatRef): MemoryTaskStatus | null {
    return statuses.get(keyOf(ref.chaId, ref.chatId))?.status ?? null;
}

/**
 * Whether the HypaV3 modal must not write the chat's memory data: a task is queued or running, this
 * tab's start is in flight or uncertain, or the mirror does not hold what a task (or, after a reconnect, the
 * server) committed. Never changes state; a reactive reader is not notified when only the held
 * revision advances (the modal re-checks on every write).
 */
export function memoryTaskFenced(ref: ChatRef): boolean {
    const fence = fences.get(keyOf(ref.chaId, ref.chatId));
    if (!fence) {
        return false;
    }
    return fence.kind !== "revision" || !holdsRevision(ref, fence.revision);
}

/** Whether the chat is fenced awaiting feed evidence or hydration (no known live task or start in flight). */
export function memoryTaskAwaitingSync(ref: ChatRef): boolean {
    const fence = fences.get(keyOf(ref.chaId, ref.chatId));
    return (
        (fence?.kind === "uncertain" || fence?.kind === "listing" || fence?.kind === "revision") &&
        memoryTaskFenced(ref)
    );
}

/** Whether the chat's manual start waits for its next send (reactive). */
export function memoryTaskPendingManual(ref: ChatRef): boolean {
    return pendingManualChats.has(keyOf(ref.chaId, ref.chatId));
}

/** Whether a start or cancel request for the chat is in flight (reactive). */
export function memoryTaskRequestPending(ref: ChatRef): boolean {
    return requests.has(keyOf(ref.chaId, ref.chatId));
}

/**
 * The chats whose task is queued or running, by chat status key, each with its count while it runs
 * with a known total (null otherwise). Reactive.
 */
export function summarizingChats(): ReadonlyMap<string, MemoryTaskCount | null> {
    const result = new Map<string, MemoryTaskCount | null>();
    for (const [key, { status }] of statuses) {
        if (isLive(status)) {
            result.set(
                key,
                status.state === "running" && status.total > 0 ? { done: status.done, total: status.total } : null,
            );
        }
    }
    return result;
}

export type MemoryTaskRefusal =
    "notEnabled" | "chatGone" | "queueFull" | "shuttingDown" | "maintenance" | "epoch" | "discarded" | "generating";

/** What a start or cancel came to; the caller shows the notice. */
export type MemoryTaskActionResult =
    | { outcome: "running" | "queued" | "pendingManual" | "cancelled" | "notCancelled" }
    /** Another request is in flight, or a newer observation or epoch superseded the answer: nothing to show. */
    | { outcome: "busy" | "superseded" }
    | { outcome: "refused"; reason: MemoryTaskRefusal }
    /** `save`: the chat's local changes could not be saved first; `request`: the request failed. */
    | { outcome: "failed"; stage: "save" | "request"; error: string };

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
    try {
        const parsed: unknown = await response.json();
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** The refusal or failure of a route's non-2xx answer (a 412 resets this module and halts saving). */
function refusalOf(response: Response, body: Record<string, unknown>): MemoryTaskActionResult {
    if (response.status === 412 && body.error === "EpochMismatch") {
        resetMemoryTasks();
        epochMismatch(typeof body.epoch === "string" ? body.epoch : "");
        return { outcome: "refused", reason: "epoch" };
    }
    if (response.status === 404) {
        return { outcome: "refused", reason: "chatGone" };
    }
    switch (body.reason) {
        case "notEnabled":
        case "queueFull":
        case "shuttingDown":
        case "maintenance":
            return { outcome: "refused", reason: body.reason };
    }
    return {
        outcome: "failed",
        stage: "request",
        error: typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    };
}

/** Runs `request` as the chat's one request in flight; its answer is dropped after a reset. */
async function exclusive(
    key: string,
    request: (token: number, owns: () => boolean) => Promise<MemoryTaskActionResult>,
): Promise<MemoryTaskActionResult> {
    if (requests.has(key)) {
        return { outcome: "busy" };
    }
    const token = ++requestSeq;
    const life = lifetime;
    requests.set(key, token);
    try {
        const result = await request(token, () => life === lifetime);
        return life === lifetime ? result : { outcome: "superseded" };
    } finally {
        if (requests.get(key) === token) {
            requests.delete(key);
        }
    }
}

/**
 * "Summarize now" for a chat: fences before saving the tab's pending changes (any change a conflict
 * discarded refuses the start, as a send does), then asks the server. The answer's status is taken
 * only when no frame or hello of the chat arrived meanwhile; a live answer cannot revive the fence
 * of a known terminal task. A refusal, a `pendingManual` answer, or a save failure puts back the
 * prior fence, including feed updates during the request. A transport failure or unrecognized
 * answer replaces this request's fence with `uncertain`, awaiting feed evidence or a live retry.
 */
export function startMemoryTask(ref: ChatRef): Promise<MemoryTaskActionResult> {
    const key = keyOf(ref.chaId, ref.chatId);
    return exclusive(key, async (token, current) => {
        const seen = observed.get(key) ?? 0;
        fences.set(key, { kind: "starting", request: token, prior: fences.get(key) });
        const ownsFence = () => {
            const fence = fences.get(key);
            return fence?.kind === "starting" && fence.request === token;
        };
        const release = () => {
            const fence = fences.get(key);
            if (current() && fence?.kind === "starting" && fence.request === token) {
                if (fence.prior) {
                    fences.set(key, fence.prior);
                } else {
                    fences.delete(key);
                }
            }
        };
        try {
            const { discarded } = await flushResources();
            if (discarded.length > 0) {
                release();
                return { outcome: "refused", reason: "discarded" };
            }
        } catch (error) {
            release();
            if (error instanceof GenerationBlockedError) {
                return { outcome: "refused", reason: "generating" };
            }
            return { outcome: "failed", stage: "save", error: errorText(error) };
        }
        if (!current()) {
            return { outcome: "superseded" };
        }
        let result: MemoryTaskActionResult;
        try {
            const response = await authFetch(MEMORY_TASKS_PATH, {
                method: "POST",
                cache: "no-store",
                headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
                body: JSON.stringify({ characterId: ref.chaId, chatId: ref.chatId }),
            });
            const body = await readBody(response);
            if (!current()) {
                return { outcome: "superseded" };
            }
            if (!response.ok) {
                result = refusalOf(response, body);
            } else {
                const answer = body as MemoryTaskStartAnswer;
                if (answer.outcome === "running" || answer.outcome === "queued") {
                    const entry = parseEntry({ characterId: ref.chaId, chatId: ref.chatId, status: answer.status });
                    if (entry && isLive(entry.status)) {
                        if (ownsFence()) {
                            const unchanged = (observed.get(key) ?? 0) === seen;
                            if (!unchanged && statuses.get(key)?.status.taskId === entry.status.taskId) {
                                release();
                            } else {
                                fences.set(key, { kind: "live", taskId: entry.status.taskId });
                                pendingManualChats.delete(key);
                                if (unchanged) {
                                    statuses.set(key, entry);
                                }
                            }
                        }
                        return { outcome: answer.outcome };
                    }
                }
                if (answer.outcome === "pendingManual") {
                    if ((observed.get(key) ?? 0) === seen) {
                        pendingManualChats.add(key);
                        result = { outcome: "pendingManual" };
                    } else {
                        result = { outcome: "superseded" };
                    }
                } else {
                    result = { outcome: "failed", stage: "request", error: "Unexpected answer" };
                }
            }
        } catch (error) {
            result = { outcome: "failed", stage: "request", error: errorText(error) };
        }
        if (result.outcome === "failed") {
            if (current() && ownsFence()) {
                fences.set(key, { kind: "uncertain" });
            }
        } else {
            release();
        }
        return result;
    });
}

/** "Cancel" for a chat: ends its queued or running task, or its waiting manual start. */
export function cancelMemoryTask(ref: ChatRef): Promise<MemoryTaskActionResult> {
    const key = keyOf(ref.chaId, ref.chatId);
    return exclusive(key, async (_token, current) => {
        try {
            const response = await authFetch(
                `${MEMORY_TASKS_PATH}/${encodeURIComponent(ref.chaId)}/${encodeURIComponent(ref.chatId)}`,
                { method: "DELETE", cache: "no-store", headers: { [RESOURCE_EPOCH_HEADER]: getResourceEpoch() } },
            );
            const body = await readBody(response);
            if (!current()) {
                return { outcome: "superseded" };
            }
            if (!response.ok) {
                return refusalOf(response, body);
            }
            pendingManualChats.delete(key);
            return { outcome: (body as MemoryTaskCancelAnswer).cancelled === true ? "cancelled" : "notCancelled" };
        } catch (error) {
            return { outcome: "failed", stage: "request", error: errorText(error) };
        }
    });
}
