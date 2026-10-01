import { v4 as uuidv4 } from "uuid";
import type {
    GenerationCreateBody,
    GenerationEvent,
    GenerationStatus,
    GenerationTerminalEvent,
} from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { applyServerGeneration, type ChatRef, endServerJob } from "../storage/chatStore.svelte";
import { authFetch, getNodeServerProxyAuth } from "../storage/nodeStorage";
import { epochMismatch, getResourceEpoch, ResourceRequestError } from "../storage/resourceClient";
import { applyHydration } from "../storage/resourceSync.svelte";

/**
 * The client transport of server generation jobs (Phase 5, `generation-jobs`; `shared/jobs.ts`):
 * create, status, abort, and the owner socket, plus `applyGenerationEvent`, which mirrors a job's
 * events into the chat module and the save loop without any outgoing write. The tab's `clientId`
 * and its jobs (one per chat) are kept in `sessionStorage`, so a reloaded tab can attach again
 * (`resumeSavedGenerations`). Nothing calls this yet: prompt assembly (slice 9) wires it behind the
 * client flag.
 */

const CLIENT_ID_KEY = "risu-generation-client";
const JOBS_KEY = "risu-generation-jobs";

/** 409 `chatBusy`: the chat has a running job; its owner can attach to `jobId`. */
export class GenerationBusyError extends Error {
    readonly jobId: string;
    constructor(jobId: string) {
        super("This chat is generating a reply");
        this.name = "GenerationBusyError";
        this.jobId = jobId;
    }
}

/** 409 `stale`: the chat changed on the server since the revision sent. */
export class GenerationStaleError extends Error {
    constructor() {
        super("The chat changed on the server; reload it and send again");
        this.name = "GenerationStaleError";
    }
}

function storage(): Storage | null {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
}

let fallbackClientId: string | null = null;

/** This tab's id, created once and kept across reloads of the tab. */
export function generationClientId(): string {
    const store = storage();
    const saved = store?.getItem(CLIENT_ID_KEY);
    if (saved) {
        return saved;
    }
    const id = fallbackClientId ?? uuidv4();
    fallbackClientId = id;
    store?.setItem(CLIENT_ID_KEY, id);
    return id;
}

/** Ids may contain `/`, so the saved key is a JSON pair. */
const chatKey = (ref: ChatRef) => JSON.stringify([ref.chaId, ref.chatId]);

function readSavedJobs(): Record<string, string> {
    try {
        const parsed = JSON.parse(storage()?.getItem(JOBS_KEY) ?? "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
}

function writeSavedJobs(jobs: Record<string, string>) {
    try {
        storage()?.setItem(JOBS_KEY, JSON.stringify(jobs));
    } catch {}
}

/** The saved jobs of this tab, by chat (`JSON.stringify([chaId, chatId])` → job id). */
export function savedGenerationJobs(): Record<string, string> {
    return readSavedJobs();
}

export function rememberGenerationJob(ref: ChatRef, jobId: string) {
    writeSavedJobs({ ...readSavedJobs(), [chatKey(ref)]: jobId });
}

export function forgetGenerationJob(jobId: string) {
    const jobs = readSavedJobs();
    for (const [key, id] of Object.entries(jobs)) {
        if (id === jobId) {
            delete jobs[key];
        }
    }
    writeSavedJobs(jobs);
}

async function failure(response: Response): Promise<never> {
    let body: { error?: string; jobId?: string; epoch?: string } = {};
    try {
        body = await response.json();
    } catch {}
    if (response.status === 409 && body.error === "chatBusy" && typeof body.jobId === "string") {
        throw new GenerationBusyError(body.jobId);
    }
    if (response.status === 409 && body.error === "stale") {
        throw new GenerationStaleError();
    }
    if (response.status === 412 && body.error === "EpochMismatch") {
        // The restore notice and reload, as for any other resource request.
        throw epochMismatch(body.epoch ?? "");
    }
    throw new ResourceRequestError(response.status, body.error ?? `Request failed (${response.status})`);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
        response = await authFetch(path, { ...init, cache: "no-store" });
    } catch (error) {
        throw new ResourceRequestError(0, error instanceof Error ? error.message : String(error));
    }
    return response.ok ? response : failure(response);
}

/** Creates a job for `body.context`'s chat and remembers it for this tab. */
export async function createGenerationJob(body: Omit<GenerationCreateBody, "clientId">): Promise<string> {
    const response = await request("/api/generations", {
        method: "POST",
        headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
        body: JSON.stringify({ ...body, clientId: generationClientId() }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    rememberGenerationJob({ chaId: body.context.characterId, chatId: body.context.chatId }, jobId);
    return jobId;
}

const jobPath = (jobId: string) =>
    `/api/generations/${encodeURIComponent(jobId)}?clientId=${encodeURIComponent(generationClientId())}`;

/** This tab's job, or null when the server does not know it (ended long ago, or another tab's). */
export async function readGenerationJob(jobId: string): Promise<GenerationStatus | null> {
    try {
        return (await (await request(jobPath(jobId))).json()) as GenerationStatus;
    } catch (error) {
        if (error instanceof ResourceRequestError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

/** Aborts this tab's job (the server persists the text so far). */
export async function abortGenerationJob(jobId: string): Promise<void> {
    try {
        await request(jobPath(jobId), { method: "DELETE" });
    } catch (error) {
        if (!(error instanceof ResourceRequestError && error.status === 404)) {
            throw error;
        }
    }
}

export type GenerationFollow = {
    /** Sends a JSON message to the job (the `job-channel` answers); false while the socket is not open. */
    send(message: unknown): boolean;
    close(): void;
    /** Resolves when the socket closes, with the terminal event if one arrived. */
    closed: Promise<{ terminal: GenerationTerminalEvent | null }>;
};

/**
 * Follows a job over its socket: on every attach the server sends the job chat and the records it
 * changed (fresh), the chosen preset, the current reply with its text, and the result if the job
 * ended. Events of another epoch than the loaded one are dropped, as are pings.
 */
/** The newest follow of each job: a newer follow cancels the older one (its socket, events, and sends). */
const currentFollows = new Map<string, { cancel(): void }>();

/** Orders this tab's attaches across reloads (a later page's stamp is higher): the server keeps the newest. */
let lastStamp = 0;
function attachStamp(): number {
    const now = performance.timeOrigin + performance.now();
    lastStamp = Math.max(now, lastStamp + 0.001);
    return lastStamp;
}

export function followGenerationJob(jobId: string, onEvent: (event: GenerationEvent) => void): GenerationFollow {
    let ws: WebSocket | null = null;
    let cancelled = false;
    let terminal: GenerationTerminalEvent | null = null;
    // Settles on the socket's close or on cancellation, whichever comes first (even before auth).
    let resolveClosed!: (value: { terminal: GenerationTerminalEvent | null }) => void;
    const closed = new Promise<{ terminal: GenerationTerminalEvent | null }>((resolve) => {
        resolveClosed = resolve;
    });
    const finish = () => resolveClosed({ terminal });
    const handle = {
        cancel() {
            cancelled = true;
            // Closing a CONNECTING socket aborts its handshake; a socket not built yet never is.
            ws?.close();
            finish();
        },
    };
    // A newer follow of the job supersedes this one at once (its events, sends, and connection).
    currentFollows.get(jobId)?.cancel();
    currentFollows.set(jobId, handle);
    const stamp = attachStamp();
    void (async () => {
        const auth = await getNodeServerProxyAuth();
        if (cancelled) {
            return;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const url =
            `${protocol}//${location.host}/api/generations/${encodeURIComponent(jobId)}/ws` +
            `?risu-auth=${encodeURIComponent(auth)}&clientId=${encodeURIComponent(generationClientId())}` +
            `&attach=${stamp}`;
        const socket = new WebSocket(url);
        ws = socket;
        socket.onmessage = (message) => {
            if (cancelled) {
                return;
            }
            let event: GenerationEvent;
            try {
                event = JSON.parse(String(message.data)) as GenerationEvent;
            } catch {
                return;
            }
            if (!event || typeof event !== "object" || event.type === "ping") {
                return;
            }
            if (event.epoch !== getResourceEpoch()) {
                return;
            }
            if (event.type === "done" || event.type === "error") {
                terminal = event;
            }
            onEvent(event);
            if (terminal) {
                socket.close();
            }
        };
        socket.onerror = () => {};
        socket.onclose = () => {
            if (currentFollows.get(jobId) === handle) {
                currentFollows.delete(jobId);
            }
            finish();
        };
    })().catch((error) => {
        // Authentication failed: no socket; the follow is over.
        console.error("[Generation]", error);
        if (currentFollows.get(jobId) === handle) {
            currentFollows.delete(jobId);
        }
        finish();
    });
    return {
        send(message) {
            const socket = ws as WebSocket | null;
            if (cancelled || !socket || socket.readyState !== WebSocket.OPEN) {
                return false;
            }
            socket.send(JSON.stringify(message));
            return true;
        },
        close() {
            if (currentFollows.get(jobId) === handle) {
                currentFollows.delete(jobId);
            }
            handle.cancel();
        },
        closed,
    };
}

/**
 * Mirrors one event of a job on `ref`'s chat: the reply's text and lock (`accepted`, `chunk`), the
 * records the job changed (`resource`, through `applyHydration`), and the end (`done`, `error`:
 * every lock of the job is released and the saved job is forgotten). Nothing is sent back.
 */
export function applyGenerationEvent(jobId: string, ref: ChatRef, event: GenerationEvent) {
    switch (event.type) {
        case "accepted":
            if (event.messageId && event.generationId) {
                applyServerGeneration(ref, {
                    jobId,
                    messageId: event.messageId,
                    generationId: event.generationId,
                    text: event.text,
                    seq: event.seq ?? 0,
                });
            }
            return;
        case "chunk":
            applyServerGeneration(ref, {
                jobId,
                messageId: event.messageId,
                generationId: event.generationId,
                text: event.text,
                seq: event.seq,
            });
            return;
        case "resource":
            applyHydration({
                kind: event.kind,
                id: event.id,
                characterId: event.characterId,
                revision: event.revision,
                data: event.data,
                ...("streaming" in event && event.streaming ? { job: { jobId, streaming: event.streaming } } : {}),
            });
            return;
        case "done":
        case "error":
            endServerJob(jobId);
            forgetGenerationJob(jobId);
            return;
    }
}

/**
 * Attaches again to this tab's saved jobs (after a reload): each one the server still knows is
 * followed and its events applied; an unknown one is forgotten. Returns the follows started.
 */
export async function resumeSavedGenerations(
    onEvent?: (jobId: string, ref: ChatRef, event: GenerationEvent) => void,
): Promise<GenerationFollow[]> {
    const follows: GenerationFollow[] = [];
    for (const jobId of Object.values(readSavedJobs())) {
        const status = await readGenerationJob(jobId);
        if (!status || status.epoch !== getResourceEpoch()) {
            forgetGenerationJob(jobId);
            continue;
        }
        const ref = { chaId: status.characterId, chatId: status.chatId };
        follows.push(
            followGenerationJob(jobId, (event) => {
                applyGenerationEvent(jobId, ref, event);
                onEvent?.(jobId, ref, event);
            }),
        );
    }
    return follows;
}
