import { randomUUID } from "node:crypto";
import type { Chat, character, groupChat } from "../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import type {
    GenerationContext,
    MemoryChatRef,
    MemoryTaskInput,
    MemoryTaskService,
    MemoryTaskStatus,
    SummaryWriterLease,
} from "../../../../shared/jobs.ts";
import { LLMFormat } from "../../../../shared/llm.ts";
import type { SerializableHypaV3Data } from "../../../../shared/memory.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import type { ResourceKindRegistry } from "../../data/kinds.ts";
import {
    type ChatInvalidation,
    ResourceBatchConflictError,
    ResourceEpochError,
    type ResourceStore,
} from "../../data/resourceStore.ts";
import { MaintenanceError, type MaintenanceGate } from "../../data/snapshots.ts";
import { checkChatBinding, readChatBindingState } from "../../jobs/chatBinding.ts";
import { GenerationRunnerError } from "../../jobs/generationJobs.ts";
import {
    ChatBindingError,
    type JobScope,
    loadJobScope,
    memorySettingsFingerprint,
    scopeChat,
} from "../../jobs/jobScope.ts";
import { moduleTriggers } from "../../jobs/runSetup.ts";
import { resolveJobRequestModel } from "../../llm/request.ts";
import { RequestTargetGoneError } from "../../llm/settings.ts";
import { hasRequestTriggers } from "../triggers.ts";
import type { MemoryHost } from "./host.ts";
import {
    createHypaV3SourceValidator,
    executeHypaV3Plan,
    type HypaV3CurrentSource,
    type HypaV3ExecutionHooks,
    planHypaV3Summaries,
    prepareHypaV3,
    warmHypaV3Vectors,
} from "./hypav3.ts";
import { createMemoryTaskHost, MemoryHostFailure, type MemoryTaskHostDeps } from "./memoryTaskHost.ts";

/** The service's caps and times (D9). Tests shrink them. */
export type MemoryTaskLimits = {
    /** Tasks whose work has not settled, server-wide (also after their terminal). */
    maxRunning: number;
    /** Chats with a queued input. */
    maxPendingChats: number;
    /** The estimated bytes of every retained input (running, queued, and each chat's idle latest one). */
    maxRetainedBytes: number;
    /** One task's lifetime from its start; past it the task fails and writes nothing more. */
    taskDeadlineMs: number;
    /** How long a terminal status stays reported (`status`, `snapshot`). */
    terminalRetentionMs: number;
    /** How long `drain` waits for unsettled work. */
    drainWaitMs: number;
};

export const MEMORY_TASK_LIMITS: Readonly<MemoryTaskLimits> = {
    maxRunning: 4,
    maxPendingChats: 32,
    maxRetainedBytes: 64 * 1024 * 1024,
    taskDeadlineMs: 30 * 60_000,
    terminalRetentionMs: 10 * 60_000,
    drainWaitMs: 5000,
};

/** A published status change of a chat's memory task (the event feed maps it to the `memoryTask` frame). */
export type MemoryTaskEvent = { epoch: string; chatRef: MemoryChatRef; status: MemoryTaskStatus };

/**
 * A manual start's answer: refused; the chat's task already runs or is queued (or the retained input
 * was queued now); or no usable input is retained, so the chat's next input job hands off (`pendingManual`).
 */
export type MemoryTaskStartResult =
    | { outcome: "refused"; reason: "shuttingDown" | "maintenance" | "chatGone" | "queueFull" }
    | { outcome: "running" | "queued"; status: MemoryTaskStatus }
    | { outcome: "pendingManual" };

export type MemoryTasks = ReturnType<typeof createMemoryTasks>;

type TerminalState = "done" | "failed" | "cancelled" | "skipped";
type TerminalDetails = { reason?: string; error?: string };

/** The abort reason of an ended task: thrown through its host's fence. */
class MemoryTaskEnd extends Error {
    readonly state: TerminalState;
    constructor(state: TerminalState) {
        super("The memory task ended");
        this.state = state;
        this.name = "MemoryTaskEnd";
    }
}

/** A start check that failed: the task ends `skipped` with the reason (D10). */
type Skip = { skip: string };

/** One captured input and who keeps it: `"pending"`, `"latest"`, or a task whose work has not settled. */
type Retained = { input: MemoryTaskInput; size: number; holders: Set<unknown> };

type Task = {
    taskId: string;
    key: string;
    chatRef: MemoryChatRef;
    /** The registry epoch the task started in (its input's). */
    epoch: string;
    retained: Retained;
    controller: AbortController;
    deadlineAt: number;
    deadline: ReturnType<typeof setTimeout> | undefined;
    done: number;
    total: number;
    published: { done: number; total: number } | null;
    lastCommittedRevision?: string;
    /** Set at the terminal: the write fence is closed from then on. */
    ended: TerminalState | null;
    workSettled: boolean;
    /** Host calls the host stopped waiting for that have not settled (a worker regex, a Google count). */
    pendingCalls: number;
};

type ChatEntry = {
    key: string;
    chatRef: MemoryChatRef;
    running: Task | null;
    pending: { taskId: string; retained: Retained } | null;
    /** The newest accepted input: idle when only `"latest"` holds it. */
    latest: Retained | null;
    /** A manual start waiting for the next input, with the chat's source generation then. */
    pendingManual: { epoch: string; sourceGeneration: number } | null;
    last: { status: MemoryTaskStatus; at: number } | null;
    lru: number;
};

const keyOf = (chatRef: MemoryChatRef) => `${chatRef.chaId}\u0000${chatRef.chatId}`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The detached HypaV3 memory task service: a job hands it its chat's memory input after `done`, and
 * a task writes the summaries the input's lookahead plan needs, one per commit.
 *
 * - Queue: per chat one running task and one queued input (a newer hand-off replaces it, keeping its
 *   task id); a queued input starts after the current turn (so after the handing-off job's terminal),
 *   when the chat has no running task and no summary writer lease, and fewer than `maxRunning` tasks
 *   have unsettled work (an ended task counts until its work, and the host calls it stopped waiting
 *   for, settle). At most `maxPendingChats` chats queue; a hand-off past it is dropped with a log line.
 * - Retention: the inputs a running task, a queue, or a chat's latest hand-off keep are capped at
 *   `maxRetainedBytes` (their JSON size); a hand-off evicts idle latest inputs least recently used
 *   first and is dropped when that is not enough. Running and queued inputs are never evicted.
 * - Start checks (synchronous, before anything is awaited; a failure ends the task `skipped` with the
 *   reason): the chat exists (`chatGone`); the epoch and source generation are the input's
 *   (`staleInput`); the admitted binding is still the chat's (`bindingInvalid`); a fresh `loadJobScope`
 *   with the input's effective presets, the admitted persona, and the speaker (`chain` binding when a
 *   `presetChain` picked the prompt preset) loads (`bindingInvalid`); the owner's memory is on
 *   (`memoryOff`); HypaV3 is the active method (`notHypaV3`); the `memory` slot is not a Plugin model
 *   (`pluginModel`) and the owner has no applicable `request` trigger (`requestTrigger`); the preset's
 *   summarization model is `subModel` (`localSummarization`); the settings fingerprint is the input's
 *   (`staleInput`).
 * - Work: prepare without the orphan cleanup (stored coverage past the input's history: `skipped
 *   staleInput`), a lookahead plan, an execution whose every summary is validated against the chat as
 *   stored (D15) and saved at once: a `meta` write merged onto the stored value, on the admitted
 *   revision (a recreated chat conflicts) and the input's epoch, refused (`writeSkipped`) when the
 *   source generation moved, the merge refuses, or the write conflicts. Then the new summaries'
 *   vectors are warmed (also the saved prefix of a provider failure); a warming failure keeps them.
 * - Ends: `done`; `failed` (a provider failure, a host failure, the deadline: errors redacted);
 *   `skipped` (a start check, `writeSkipped`, `sourceInvalid`); `cancelled` (`cancel`, a writer
 *   lease, an invalidation notice, maintenance, shutdown). A terminal closes the task's write fence,
 *   reads the chat's revision (`terminalRevision`, null when the chat is gone), and publishes, in one
 *   synchronous step; what the task's work does afterwards changes nothing. An epoch change clears the
 *   registry without publishing (the `epoch` event is the signal).
 */
export function createMemoryTasks(deps: {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    gate: MaintenanceGate;
    hostDeps: MemoryTaskHostDeps;
    now?: () => number;
    limits?: Partial<MemoryTaskLimits>;
}) {
    const { store, kinds, gate, hostDeps } = deps;
    const now = deps.now ?? Date.now;
    const limits: MemoryTaskLimits = { ...MEMORY_TASK_LIMITS, ...deps.limits };
    const charactersKind = kinds.get(RESOURCE_KIND.characters);
    if (!charactersKind) {
        throw new Error(`Unknown resource kind ${RESOURCE_KIND.characters}`);
    }

    let registryEpoch = store.epoch();
    let entries = new Map<string, ChatEntry>();
    /** Chats with a queued input, in queue order. */
    let queue = new Set<string>();
    /** Held writer leases by chat (kept across an epoch change: their jobs release them). */
    const leases = new Map<string, Set<object>>();
    /** Tasks whose work or tracked host calls have not settled: the capacity and drain count. */
    const alive = new Set<Task>();
    const listeners = new Set<(event: MemoryTaskEvent) => void>();
    const notifications: MemoryTaskEvent[] = [];
    let dispatching = false;
    const drainWaiters = new Set<() => void>();
    let retainedBytes = 0;
    let lruClock = 0;
    let paused = false;
    let closed = false;
    let pumpScheduled = false;

    // ---------------------------------------------------------------------------------------------
    // Retention

    const hold = (retained: Retained, holder: unknown) => {
        if (retained.holders.size === 0) {
            retainedBytes += retained.size;
        }
        retained.holders.add(holder);
    };
    const drop = (retained: Retained, holder: unknown) => {
        if (retained.holders.delete(holder) && retained.holders.size === 0) {
            retainedBytes -= retained.size;
        }
    };
    const isIdle = (entry: ChatEntry) =>
        !!entry.latest && entry.latest.holders.size === 1 && entry.latest.holders.has("latest");

    /** Evicts idle inputs of other chats until `size` fits with `entry`'s queued and latest inputs replaced. */
    const makeRoom = (entry: ChatEntry, size: number): boolean => {
        let projected = retainedBytes + size;
        for (const replaced of new Set([entry.pending?.retained, entry.latest])) {
            if (replaced && [...replaced.holders].every((holder) => holder === "pending" || holder === "latest")) {
                projected -= replaced.size;
            }
        }
        if (projected <= limits.maxRetainedBytes) {
            return true;
        }
        const victims: ChatEntry[] = [];
        const idle = [...entries.values()].filter((other) => other !== entry && isIdle(other));
        idle.sort((a, b) => a.lru - b.lru);
        for (const other of idle) {
            if (projected <= limits.maxRetainedBytes) {
                break;
            }
            projected -= other.latest!.size;
            victims.push(other);
        }
        if (projected > limits.maxRetainedBytes) {
            return false;
        }
        for (const victim of victims) {
            drop(victim.latest!, "latest");
            victim.latest = null;
            prune(victim);
        }
        return true;
    };

    // ---------------------------------------------------------------------------------------------
    // Registry and status

    const entryOf = (chatRef: MemoryChatRef): ChatEntry => {
        const key = keyOf(chatRef);
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                key,
                chatRef: { chaId: chatRef.chaId, chatId: chatRef.chatId },
                running: null,
                pending: null,
                latest: null,
                pendingManual: null,
                last: null,
                lru: 0,
            };
            entries.set(key, entry);
        }
        return entry;
    };

    const lastStatus = (entry: ChatEntry): MemoryTaskStatus | null => {
        if (entry.last && now() - entry.last.at >= limits.terminalRetentionMs) {
            entry.last = null;
        }
        return entry.last?.status ?? null;
    };

    /** Drops an entry that holds nothing (an expired terminal included). */
    const prune = (entry: ChatEntry) => {
        if (
            !entry.running &&
            !entry.pending &&
            !entry.latest &&
            !entry.pendingManual &&
            lastStatus(entry) === null &&
            entries.get(entry.key) === entry
        ) {
            entries.delete(entry.key);
        }
    };

    const runningStatus = (task: Task): MemoryTaskStatus => ({
        taskId: task.taskId,
        state: "running",
        done: task.done,
        total: task.total,
    });
    const queuedStatus = (pending: { taskId: string }): MemoryTaskStatus => ({
        taskId: pending.taskId,
        state: "queued",
        done: 0,
        total: 0,
    });

    /** The chat's running task, else its queued one, else its last terminal (while retained). */
    const effectiveStatus = (entry: ChatEntry): MemoryTaskStatus | null => {
        if (entry.running) {
            return runningStatus(entry.running);
        }
        if (entry.pending) {
            return queuedStatus(entry.pending);
        }
        return lastStatus(entry);
    };

    /** Nested publications wait until the current event reaches every listener. */
    const dispatchNotifications = () => {
        if (dispatching) {
            return;
        }
        dispatching = true;
        try {
            while (notifications.length > 0) {
                const event = notifications.shift()!;
                for (const listener of [...listeners]) {
                    if (event.epoch !== registryEpoch) {
                        break;
                    }
                    try {
                        listener(event);
                    } catch (error) {
                        console.error(
                            "[memory] status listener failed:",
                            error instanceof Error ? error.name : typeof error,
                        );
                    }
                }
            }
        } finally {
            dispatching = false;
        }
    };

    const publish = (epoch: string, chatRef: MemoryChatRef, status: MemoryTaskStatus) => {
        if (epoch !== registryEpoch) {
            return;
        }
        notifications.push({
            epoch,
            chatRef: { chaId: chatRef.chaId, chatId: chatRef.chatId },
            status,
        });
        dispatchNotifications();
    };

    /** A terminal status, its revision read now (the same synchronous step that closed the writes). */
    const terminalStatus = (
        taskId: string,
        chatRef: MemoryChatRef,
        state: TerminalState,
        counts: { done: number; total: number; lastCommittedRevision?: string },
        details: TerminalDetails,
    ): MemoryTaskStatus => ({
        taskId,
        state,
        done: counts.done,
        total: counts.total,
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
        ...(details.error !== undefined ? { error: details.error } : {}),
        terminalRevision: store.chatRevision(chatRef.chaId, chatRef.chatId),
        ...(counts.lastCommittedRevision !== undefined ? { lastCommittedRevision: counts.lastCommittedRevision } : {}),
    });

    const publishRunning = (task: Task) => {
        const entry = entries.get(task.key);
        if (task.ended || entry?.running !== task || task.epoch !== registryEpoch) {
            return;
        }
        if (task.published?.done === task.done && task.published.total === task.total) {
            return;
        }
        task.published = { done: task.done, total: task.total };
        publish(task.epoch, task.chatRef, runningStatus(task));
    };

    /**
     * Ends a running task: closes its write fence and aborts its work, and, when it is still its
     * chat's task in the registry's epoch, publishes its terminal (then the chat's queued one, if
     * any). Its work and input stay counted until they settle. Idempotent.
     */
    const endRunning = (task: Task, state: TerminalState, details: TerminalDetails = {}) => {
        if (task.ended) {
            return;
        }
        task.ended = state;
        clearTimeout(task.deadline);
        const entry = entries.get(task.key);
        let status: MemoryTaskStatus | null = null;
        if (entry?.running === task) {
            entry.running = null;
            if (task.epoch === registryEpoch) {
                status = terminalStatus(task.taskId, task.chatRef, state, task, details);
                entry.last = { status, at: now() };
            }
        }
        // Queue the terminal before abort callbacks can publish a newer status.
        const wasDispatching = dispatching;
        dispatching = true;
        try {
            if (status) {
                publish(task.epoch, task.chatRef, status);
            }
            task.controller.abort(new MemoryTaskEnd(state));
        } finally {
            dispatching = wasDispatching;
            dispatchNotifications();
        }
        if (entry && entries.get(task.key) === entry && task.epoch === registryEpoch) {
            if (!entry.running && entry.pending && entry.pending.retained.input.epoch === registryEpoch) {
                publish(entry.pending.retained.input.epoch, entry.chatRef, queuedStatus(entry.pending));
            }
            prune(entry);
        }
        schedulePump();
    };

    /** Ends a chat's queued task (it never started): its terminal, with the chat's revision now. */
    const endPending = (entry: ChatEntry, state: TerminalState, details: TerminalDetails = {}) => {
        const pending = entry.pending;
        if (!pending || entries.get(entry.key) !== entry || pending.retained.input.epoch !== registryEpoch) {
            return;
        }
        entry.pending = null;
        queue.delete(entry.key);
        drop(pending.retained, "pending");
        const status = terminalStatus(pending.taskId, entry.chatRef, state, { done: 0, total: 0 }, details);
        if (!entry.running) {
            entry.last = { status, at: now() };
        }
        publish(pending.retained.input.epoch, entry.chatRef, status);
        prune(entry);
    };

    const releaseAlive = (task: Task) => {
        if (!task.workSettled || task.pendingCalls > 0 || !alive.has(task)) {
            return;
        }
        alive.delete(task);
        clearTimeout(task.deadline);
        drop(task.retained, task);
        if (alive.size === 0) {
            for (const resolve of drainWaiters) {
                resolve();
            }
            drainWaiters.clear();
        }
        schedulePump();
    };

    // ---------------------------------------------------------------------------------------------
    // Scope and start checks

    /**
     * The task's fresh scope (the host's contract): the admitted binding checked against the chat now, then
     * `loadJobScope` with the input's effective presets, the admitted persona, and the speaker.
     */
    const loadTaskScope = (input: MemoryTaskInput): { scope: JobScope } | Skip => {
        const { chaId, chatId } = input.chatRef;
        const binding = readChatBindingState(store, kinds, { characterId: chaId, chatId });
        if (!binding.chat) {
            return { skip: "chatGone" };
        }
        if (checkChatBinding(binding.chat, binding.lookup, input.binding, "send")) {
            return { skip: "bindingInvalid" };
        }
        const context: GenerationContext = {
            characterId: chaId,
            chatId,
            presetId: input.effective.presetId,
            modelPresetId: input.effective.modelPresetId,
            personaId: input.binding.personaId,
            mode: "memory",
            input: "",
            chatRevision: input.admittedRevision,
            ...(input.speakerId !== null ? { speakerChaId: input.speakerId } : {}),
        };
        try {
            return {
                scope: loadJobScope(store, kinds, context, { binding: input.effective.fromChain ? "chain" : "send" }),
            };
        } catch (error) {
            if (
                error instanceof ChatBindingError ||
                error instanceof RequestTargetGoneError ||
                (error instanceof GenerationRunnerError && error.status === 404)
            ) {
                return { skip: "bindingInvalid" };
            }
            throw error;
        }
    };

    /** Whether the input's epoch and source generation are still the chat's. */
    const inputCurrent = (input: MemoryTaskInput) =>
        input.epoch === registryEpoch &&
        store.epoch() === input.epoch &&
        store.chatSourceGeneration(input.chatRef.chaId, input.chatRef.chatId) === input.sourceGeneration;

    /** D10's checks on a fresh scope, synchronously. */
    const startChecks = (input: MemoryTaskInput): { scope: JobScope } | Skip => {
        if (store.chatRevision(input.chatRef.chaId, input.chatRef.chatId) === null) {
            return { skip: "chatGone" };
        }
        if (!inputCurrent(input)) {
            return { skip: "staleInput" };
        }
        const loaded = loadTaskScope(input);
        if ("skip" in loaded) {
            return loaded;
        }
        const { scope } = loaded;
        const db = scope.db;
        const owner = db.characters.find((entry) => entry?.chaId === input.chatRef.chaId);
        if (!owner?.supaMemory) {
            return { skip: "memoryOff" };
        }
        if (db.hanuraiEnable || db.hypav2 || !db.hypaV3) {
            return { skip: "notHypaV3" };
        }
        const memoryModel = resolveJobRequestModel(scope.request.db, "memory");
        if (memoryModel.kind === "resolved" && memoryModel.modelInfo.format === LLMFormat.Plugin) {
            return { skip: "pluginModel" };
        }
        if (hasRequestTriggers(owner, moduleTriggers(scope))) {
            return { skip: "requestTrigger" };
        }
        if (selectedHypaV3Preset(db)?.settings.summarizationModel !== "subModel") {
            return { skip: "localSummarization" };
        }
        if (memorySettingsFingerprint(scope) !== input.settingsFingerprint) {
            return { skip: "staleInput" };
        }
        return { scope };
    };

    // ---------------------------------------------------------------------------------------------
    // A task's work

    /** Throws once the task ended; ends it `failed` first when its deadline passed. */
    const live = (task: Task) => {
        if (!task.ended && now() >= task.deadlineAt) {
            endRunning(task, "failed", { reason: "deadline", error: "The memory task took too long" });
        }
        if (task.ended) {
            throw task.controller.signal.reason;
        }
    };

    /** The host's dependencies with the calls it may stop waiting for counted until they settle. */
    const trackedHostDeps = (task: Task): MemoryTaskHostDeps => {
        const track = <T>(promise: Promise<T>): Promise<T> => {
            task.pendingCalls++;
            const settle = () => {
                task.pendingCalls--;
                releaseAlive(task);
            };
            promise.then(settle, settle);
            return promise;
        };
        return {
            ...hostDeps,
            tokens: {
                encode: (text, scope) => track(hostDeps.tokens.encode(text, scope)),
                count: (text, scope) => track(hostDeps.tokens.count(text, scope)),
            },
            scriptWorkers: {
                regex: (...args: Parameters<MemoryTaskHostDeps["scriptWorkers"]["regex"]>) =>
                    track(hostDeps.scriptWorkers.regex(...args)),
            },
        };
    };

    /** The chat as stored now with its owner's stored greeting (a window's source validation). */
    const readCurrent = (input: MemoryTaskInput, ownerIsGroup: boolean): HypaV3CurrentSource | null => {
        const { chaId, chatId } = input.chatRef;
        const read = store.readRefs([{ kind: charactersKind, id: chaId }], {
            chats: [{ characterId: chaId, id: chatId }],
        });
        const chat = read.chats[0]?.data as Chat | null | undefined;
        if (!chat) {
            return null;
        }
        let greeting: string | undefined;
        if (!ownerIsGroup) {
            const stored = read.items[0]?.data as character | groupChat | null | undefined;
            if (!stored || stored.type === "group") {
                return null;
            }
            greeting = chat.fmIndex === -1 ? stored.firstMessage : stored.alternateGreetings?.[chat.fmIndex as number];
        }
        return { messages: chat.message, fmIndex: chat.fmIndex, greeting };
    };

    /** One summary save (synchronous): a `meta` write on the admitted revision, merged onto the stored value. */
    const checkpointOf =
        (task: Task, input: MemoryTaskInput): NonNullable<HypaV3ExecutionHooks["checkpoint"]> =>
        (write) => {
            live(task);
            gate.assertOpen();
            const { chaId, chatId } = input.chatRef;
            if (
                closed ||
                store.epoch() !== input.epoch ||
                store.chatSourceGeneration(chaId, chatId) !== input.sourceGeneration
            ) {
                return "skipped";
            }
            const stored = store.chatMeta(chaId, chatId);
            if (!stored) {
                return "skipped";
            }
            const merged = write.merge((stored.data as Chat).hypaV3Data as SerializableHypaV3Data | null | undefined);
            if (!merged) {
                console.warn("[HypaV3] The memory data changed during the summary; this summary is not saved");
                return "skipped";
            }
            try {
                store.applyChanges(
                    {
                        chats: [
                            {
                                characterId: chaId,
                                chatId,
                                baseRevision: input.admittedRevision,
                                ops: [{ op: "meta", set: { hypaV3Data: merged } }],
                            },
                        ],
                    },
                    {
                        epoch: input.epoch,
                        // Counted before the change is published: a listener that ends the task meanwhile
                        // reports this summary too.
                        committed: (applied) => {
                            task.done++;
                            const revision = applied.chats[0]?.revision;
                            if (revision) {
                                task.lastCommittedRevision = revision;
                            }
                            return [];
                        },
                    },
                );
            } catch (error) {
                if (error instanceof ResourceBatchConflictError) {
                    return "skipped";
                }
                throw error;
            }
            return "committed";
        };

    /** Ends the task for a thrown error (nothing when it already ended). */
    const endFromError = (task: Task, error: unknown, host: MemoryHost | null) => {
        if (task.ended) {
            return;
        }
        if (error instanceof MemoryTaskEnd) {
            endRunning(task, error.state);
        } else if (error instanceof MemoryHostFailure) {
            endRunning(task, "failed", { error: error.message });
        } else if (error instanceof MaintenanceError) {
            endRunning(task, "cancelled", { reason: "maintenance" });
        } else if (error instanceof ResourceEpochError) {
            endRunning(task, "cancelled", { reason: "staleInput" });
        } else {
            const text = messageOf(error);
            endRunning(task, "failed", { error: host ? host.redact(text) : "The memory task failed" });
            console.error("[memory] task failed:", error instanceof Error ? error.name : typeof error);
        }
    };

    async function work(task: Task): Promise<void> {
        const input = task.retained.input;
        let host: MemoryHost | null = null;
        try {
            const checked = startChecks(input);
            if ("skip" in checked) {
                endRunning(task, "skipped", { reason: checked.skip });
                return;
            }
            const { scope } = checked;
            const built = createMemoryTaskHost({
                scope,
                input,
                deps: trackedHostDeps(task),
                signal: task.controller.signal,
                fence: () => live(task),
            });
            host = built.host;
            const room = structuredClone(scopeChat(scope)) as Chat;
            const outcome = await prepareHypaV3(
                host,
                input.history,
                input.currentTokens,
                input.maxContext,
                room,
                built.tokenizer,
                { cleanup: false },
            );
            live(task);
            if (!outcome.ok) {
                endRunning(task, "failed", {
                    error: host.redact(outcome.result.error ?? "[HypaV3] Preparation failed"),
                });
                return;
            }
            const prepared = outcome.prepared;
            if (prepared.coverageAhead) {
                endRunning(task, "skipped", { reason: "staleInput" });
                return;
            }
            const plan = await planHypaV3Summaries(prepared, { lookahead: true });
            live(task);
            // The experimental implementation reports a planning error before summarizing anything.
            if (plan.error !== undefined && prepared.implementation === "experimental") {
                endRunning(task, "failed", { error: host.redact(plan.error) });
                return;
            }
            task.total = plan.llmCalls;
            publishRunning(task);

            const ownerIsGroup =
                scope.db.characters.find((entry) => entry?.chaId === input.chatRef.chaId)?.type === "group";
            const execution = await executeHypaV3Plan(host, prepared, plan, {
                progress: (done, total) => {
                    task.total = total;
                    publishRunning(task);
                },
                checkpoint: checkpointOf(task, input),
                validate: createHypaV3SourceValidator(input.sources, () => readCurrent(input, ownerIsGroup)),
            });
            live(task);

            let warming: string | undefined;
            if (execution.endReason === "complete" || execution.endReason === "providerFailed") {
                // The saved summaries' document vectors, so the next send embeds none of them.
                const saved = execution.data.summaries.slice(prepared.data.summaries.length);
                if (saved.length > 0) {
                    try {
                        await warmHypaV3Vectors(host, saved);
                        live(task);
                    } catch (error) {
                        if (task.ended || error instanceof MemoryHostFailure || error instanceof MemoryTaskEnd) {
                            throw error;
                        }
                        warming = host.redact(messageOf(error));
                        console.warn("[memory] warming the new summaries failed");
                    }
                }
            }

            switch (execution.endReason) {
                case "providerFailed":
                    endRunning(task, "failed", { error: host.redact(execution.error) });
                    return;
                case "writeSkipped":
                case "sourceInvalid":
                    // Nothing more is written: after `sourceInvalid` the state is rewound past saved windows.
                    endRunning(task, "skipped", { reason: execution.endReason });
                    return;
                case "stopped":
                    endRunning(task, "cancelled");
                    return;
            }
            // The standard implementation reports it after summarizing the windows before it.
            if (plan.error !== undefined) {
                endRunning(task, "failed", { error: host.redact(plan.error) });
                return;
            }
            endRunning(task, "done", warming !== undefined ? { reason: "warmingFailed", error: warming } : {});
        } catch (error) {
            endFromError(task, error, host);
        }
    }

    const startTask = (entry: ChatEntry) => {
        const pending = entry.pending!;
        entry.pending = null;
        queue.delete(entry.key);
        const task: Task = {
            taskId: pending.taskId,
            key: entry.key,
            chatRef: entry.chatRef,
            epoch: registryEpoch,
            retained: pending.retained,
            controller: new AbortController(),
            deadlineAt: now() + limits.taskDeadlineMs,
            deadline: undefined,
            done: 0,
            total: 0,
            published: null,
            ended: null,
            workSettled: false,
            pendingCalls: 0,
        };
        hold(task.retained, task);
        drop(task.retained, "pending");
        alive.add(task);
        entry.running = task;
        task.deadline = setTimeout(
            () => endRunning(task, "failed", { reason: "deadline", error: "The memory task took too long" }),
            limits.taskDeadlineMs,
        );
        task.deadline.unref?.();
        publishRunning(task);
        void work(task).finally(() => {
            task.workSettled = true;
            releaseAlive(task);
        });
    };

    function pump() {
        if (paused || closed) {
            return;
        }
        for (const key of [...queue]) {
            if (alive.size >= limits.maxRunning) {
                return;
            }
            const entry = entries.get(key);
            if (!entry?.pending) {
                queue.delete(key);
                continue;
            }
            if (entry.running || (leases.get(key)?.size ?? 0) > 0) {
                continue;
            }
            startTask(entry);
        }
    }

    /** Starts what can start after the current turn (a hand-off's job emits its terminal first). */
    function schedulePump() {
        if (pumpScheduled) {
            return;
        }
        pumpScheduled = true;
        queueMicrotask(() => {
            pumpScheduled = false;
            pump();
        });
    }

    /** Ends every running and queued task with `reason` (maintenance, shutdown). */
    const endAll = (reason: string) => {
        for (const entry of [...entries.values()]) {
            endPending(entry, "cancelled", { reason });
            if (entry.running) {
                endRunning(entry.running, "cancelled", { reason });
            }
        }
    };

    // ---------------------------------------------------------------------------------------------
    // The service

    const service = {
        /**
         * Queues the chat's latest input (replacing a queued one). Dropped while paused or shutting down,
         * when its epoch or source generation is no longer the chat's, past the pending-chat limit, or
         * when the retention cap cannot make room. Satisfies the chat's `pendingManual`.
         */
        handOff(input: MemoryTaskInput): void {
            if (closed || paused) {
                return;
            }
            if (!inputCurrent(input)) {
                return;
            }
            const owned = structuredClone(input);
            const size = Buffer.byteLength(JSON.stringify(owned));
            const entry = entryOf(owned.chatRef);
            if (!entry.pending && queue.size >= limits.maxPendingChats) {
                console.warn("[memory] hand-off dropped: too many chats are queued");
                prune(entry);
                return;
            }
            if (!makeRoom(entry, size)) {
                console.warn("[memory] hand-off dropped: the retained inputs are at their cap");
                prune(entry);
                return;
            }
            const retained: Retained = { input: owned, size, holders: new Set() };
            hold(retained, "pending");
            hold(retained, "latest");
            const queued = !entry.pending;
            if (entry.pending) {
                drop(entry.pending.retained, "pending");
                entry.pending.retained = retained;
            } else {
                entry.pending = { taskId: randomUUID(), retained };
                queue.add(entry.key);
            }
            if (entry.latest) {
                drop(entry.latest, "latest");
            }
            entry.latest = retained;
            entry.pendingManual = null;
            entry.lru = ++lruClock;
            if (queued && !entry.running) {
                publish(owned.epoch, entry.chatRef, queuedStatus(entry.pending));
            }
            schedulePump();
        },

        /** The chat's running task, else its queued one, else its last terminal (kept `terminalRetentionMs`). */
        status(chatRef: MemoryChatRef): MemoryTaskStatus | null {
            const entry = entries.get(keyOf(chatRef));
            if (!entry) {
                return null;
            }
            const status = effectiveStatus(entry);
            prune(entry);
            return status;
        },

        /**
         * The chat's summary writer lease: the chat's running task ends `cancelled` (`writerLease`) now,
         * its write fence closed, so a late provider result writes nothing (its saves are synchronous: no
         * write is in flight). Until `release`, hand-offs and manual starts for the chat only queue.
         */
        async acquireSummaryWriter(chatRef: MemoryChatRef, ownerId: string): Promise<SummaryWriterLease> {
            const key = keyOf(chatRef);
            const lease = { ownerId };
            let held = leases.get(key);
            if (!held) {
                held = new Set();
                leases.set(key, held);
            }
            held.add(lease);
            const running = entries.get(key)?.running;
            if (running) {
                endRunning(running, "cancelled", { reason: "writerLease" });
            }
            let released = false;
            return {
                release() {
                    if (released) {
                        return;
                    }
                    released = true;
                    const set = leases.get(key);
                    set?.delete(lease);
                    if (set?.size === 0) {
                        leases.delete(key);
                    }
                    schedulePump();
                },
            };
        },

        /** Whether a manual start waits for the chat's next input (its source generation still current). */
        pendingManual(chatRef: MemoryChatRef): boolean {
            const manual = entries.get(keyOf(chatRef))?.pendingManual;
            return (
                !!manual &&
                manual.epoch === registryEpoch &&
                store.epoch() === manual.epoch &&
                store.chatSourceGeneration(chatRef.chaId, chatRef.chatId) === manual.sourceGeneration
            );
        },

        /**
         * A manual start (D8): the chat's running or queued task as it is; else its retained latest input
         * queued again when its epoch and source generation are current and a fresh scope has its
         * settings fingerprint; else `pendingManual` (the chat's next input job hands off).
         */
        start(chatRef: MemoryChatRef): MemoryTaskStartResult {
            if (closed) {
                return { outcome: "refused", reason: "shuttingDown" };
            }
            if (paused || gate.active) {
                return { outcome: "refused", reason: "maintenance" };
            }
            if (store.chatRevision(chatRef.chaId, chatRef.chatId) === null) {
                return { outcome: "refused", reason: "chatGone" };
            }
            const entry = entryOf(chatRef);
            if (entry.running) {
                return { outcome: "running", status: runningStatus(entry.running) };
            }
            if (entry.pending) {
                return { outcome: "queued", status: queuedStatus(entry.pending) };
            }
            const latest = entry.latest;
            if (latest) {
                const loaded = inputCurrent(latest.input) ? loadTaskScope(latest.input) : null;
                if (
                    loaded &&
                    "scope" in loaded &&
                    memorySettingsFingerprint(loaded.scope) === latest.input.settingsFingerprint
                ) {
                    if (queue.size >= limits.maxPendingChats) {
                        return { outcome: "refused", reason: "queueFull" };
                    }
                    const pending = { taskId: randomUUID(), retained: latest };
                    hold(latest, "pending");
                    entry.pending = pending;
                    queue.add(entry.key);
                    entry.lru = ++lruClock;
                    const status = queuedStatus(pending);
                    publish(latest.input.epoch, entry.chatRef, status);
                    schedulePump();
                    return { outcome: "queued", status };
                }
                drop(latest, "latest");
                entry.latest = null;
            }
            entry.pendingManual = {
                epoch: registryEpoch,
                sourceGeneration: store.chatSourceGeneration(chatRef.chaId, chatRef.chatId),
            };
            return { outcome: "pendingManual" };
        },

        /** Cancels the chat's queued and running task and its `pendingManual`; whether anything was cancelled. */
        cancel(chatRef: MemoryChatRef): boolean {
            const entry = entries.get(keyOf(chatRef));
            if (!entry) {
                return false;
            }
            const cancelled = !!entry.pending || !!entry.running || !!entry.pendingManual;
            entry.pendingManual = null;
            endPending(entry, "cancelled", { reason: "cancelled" });
            if (entry.running) {
                endRunning(entry.running, "cancelled", { reason: "cancelled" });
            }
            prune(entry);
            return cancelled;
        },

        /**
         * A chat's source changed (`onChatInvalidated`): its queued and running task, retained input, and
         * `pendingManual` from an older source generation end or go. State at or past the notice's
         * generation is newer than the notice and stays.
         */
        invalidate(notice: ChatInvalidation): void {
            if (notice.epoch !== registryEpoch) {
                return;
            }
            const entry = entries.get(keyOf({ chaId: notice.characterId, chatId: notice.id }));
            if (!entry) {
                return;
            }
            const older = (input: MemoryTaskInput) => input.sourceGeneration < notice.sourceGeneration;
            if (entry.pending && older(entry.pending.retained.input)) {
                endPending(entry, "cancelled", { reason: "sourceChanged" });
            }
            if (entry.running && older(entry.running.retained.input)) {
                endRunning(entry.running, "cancelled", { reason: "sourceChanged" });
            }
            if (entry.latest && older(entry.latest.input)) {
                drop(entry.latest, "latest");
                entry.latest = null;
            }
            if (entry.pendingManual && entry.pendingManual.sourceGeneration < notice.sourceGeneration) {
                entry.pendingManual = null;
            }
            prune(entry);
        },

        /** Every chat's effective status (running, queued, or a terminal kept `terminalRetentionMs`). */
        snapshot(): { chatRef: MemoryChatRef; status: MemoryTaskStatus }[] {
            const result: { chatRef: MemoryChatRef; status: MemoryTaskStatus }[] = [];
            for (const entry of [...entries.values()]) {
                const status = effectiveStatus(entry);
                if (status) {
                    result.push({ chatRef: { ...entry.chatRef }, status });
                }
                prune(entry);
            }
            return result;
        },

        /** Status changes as they are published; returns the removal. A listener's throw is logged. */
        onStatus(listener: (event: MemoryTaskEvent) => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        /** Maintenance began: running and queued tasks end `cancelled` (`maintenance`); nothing starts until `resume`. */
        pause() {
            paused = true;
            endAll("maintenance");
        },

        /** Maintenance ended (a service that is shutting down stays closed). Ended tasks do not restart. */
        resume() {
            paused = false;
            schedulePump();
        },

        /** Refuses hand-offs and starts; running and queued tasks end `cancelled` (`shutdown`). */
        beginShutdown() {
            closed = true;
            endAll("shutdown");
        },

        /** Resolves once every task's work and tracked host calls have settled, or after `drainWaitMs`. */
        async drain(): Promise<void> {
            if (alive.size === 0) {
                return;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            let waiter: (() => void) | undefined;
            await new Promise<void>((resolve) => {
                waiter = resolve;
                drainWaiters.add(resolve);
                timer = setTimeout(resolve, limits.drainWaitMs);
            });
            clearTimeout(timer);
            if (waiter) {
                drainWaiters.delete(waiter);
            }
        },

        /**
         * The database epoch changed (a restore): every task ends without a status (the `epoch` event is
         * the signal) and the registry starts empty in the new epoch. Unsettled work still counts toward
         * capacity and `drain`; leases stay with their jobs.
         */
        resetEpoch() {
            const previous = [...entries.values()];
            entries = new Map();
            queue = new Set();
            notifications.length = 0;
            registryEpoch = store.epoch();
            const running: Task[] = [];
            for (const entry of previous) {
                if (entry.running) {
                    running.push(entry.running);
                }
                if (entry.pending) {
                    drop(entry.pending.retained, "pending");
                }
                if (entry.latest) {
                    drop(entry.latest, "latest");
                }
                entry.running = null;
                entry.pending = null;
                entry.latest = null;
                entry.pendingManual = null;
            }
            for (const task of running) {
                endRunning(task, "cancelled", { reason: "epoch" });
            }
        },

        /** For tests: tasks with unsettled work, queued chats, and the retained input bytes. */
        aliveCount: () => alive.size,
        queuedCount: () => queue.size,
        retainedBytes: () => retainedBytes,
    };
    return service satisfies MemoryTaskService;
}
