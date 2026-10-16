import { randomUUID } from "node:crypto";
import type { ChatOp, MessageAnchor, MessageGeneration } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import { GenerationRunnerError, JobWriteConflictError, type RunningJob } from "./generationJobs.ts";
import type { MessageGuard } from "./generationLock.ts";
import { type JobScope, refreshChat, refreshChatAfterWrite, scopeChat } from "./jobScope.ts";

/** A message the job is generating: its id and the next checkpoint of its generation (`seq` advanced). */
export type OwnedGeneration = {
    messageId: string;
    next(): MessageGeneration;
    /**
     * The newest streamed chunk the message's stored text includes (a completed stream's last one):
     * each generation write claims it, so the tab does not put older streamed text over the write.
     */
    covers?(): { generationId: string; seq: number } | undefined;
};

/** What a trigger started from: the job's chat as stored then, with its revision. */
export type ChatBaseline = { chat: Chat; revision: string };

const nonMetaKeys = new Set(["message", "id", "isStreaming", "activeStreamingDisplayOptimizationMode"]);

const json = (value: unknown) => JSON.stringify(value);

/**
 * `applyChatResult` of `src/ts/storage/chatStore.svelte.ts` as one job write (Phase 5 slice 8b):
 * what a trigger changed in its copy of the job's chat (`result`) against the copy it started from
 * (`baseline`), onto the chat as stored now. Messages the trigger removed are removed (one op),
 * added ones are inserted after their predecessor, changed message fields are merged into the
 * stored message, changed chat fields are set or removed; changes made meanwhile by others are
 * kept. A reorder of surviving messages replaces the whole chat, but only when the chat has not
 * changed since the baseline and no message of it is being generated; otherwise the order change
 * is dropped with a warning and the rest applies. Every op goes in one group on the stored
 * revision, so the write is atomic: a change to a message another generation owns fails it whole
 * (the client throws before any write), and the job ends with that error. A gone chat applies
 * nothing.
 */
export function applyTriggerChat(
    deps: { job: RunningJob; store: ResourceStore; scope: JobScope; lock: MessageGuard },
    baseline: ChatBaseline,
    result: Chat,
    options: { generation?: OwnedGeneration } = {},
): void {
    const { job, store, scope, lock } = deps;
    if (!refreshChat(store, scope)) {
        return;
    }
    const current = scopeChat(scope) as Chat;
    const currentIds = new Set(current.message.map((message) => message.chatId!));

    const next = structuredClone(result);
    next.message ??= [];
    const baseMessages = new Map(baseline.chat.message.map((message) => [message.chatId!, message]));
    const taken = new Set<string>();
    for (const message of next.message) {
        if (!isValidResourceId(message.chatId) || taken.has(message.chatId!)) {
            message.chatId = randomUUID();
        }
        taken.add(message.chatId!);
    }
    for (const message of next.message) {
        // A new message may not reuse an id the chat already has.
        if (!baseMessages.has(message.chatId!) && currentIds.has(message.chatId!)) {
            message.chatId = randomUUID();
        }
    }
    const resultIds = new Set(next.message.map((message) => message.chatId!));
    const removed = baseline.chat.message
        .map((message) => message.chatId!)
        .filter((id) => !resultIds.has(id) && currentIds.has(id));
    const changedMessages = next.message.filter((message) => {
        const before = baseMessages.get(message.chatId!);
        return before !== undefined && json(before) !== json(message);
    });
    const survivorsBefore = baseline.chat.message.map((message) => message.chatId!).filter((id) => resultIds.has(id));
    const survivorsAfter = next.message.map((message) => message.chatId!).filter((id) => baseMessages.has(id));
    const reordered = survivorsBefore.some((id, index) => survivorsAfter[index] !== id);

    const write = (ops: ChatOp[]) => {
        if (ops.length === 0) {
            return;
        }
        let applied;
        try {
            const cover = options.generation?.covers?.();
            applied = job.write(
                () => ({
                    chats: [
                        { characterId: scope.characterId, chatId: scope.chatId, baseRevision: scope.chatRevision, ops },
                    ],
                }),
                cover ? { covers: [{ messageId: options.generation!.messageId, ...cover }] } : undefined,
            );
        } catch (error) {
            if (
                error instanceof JobWriteConflictError &&
                error.conflicts.some((conflict) => conflict.kind === "chat" && conflict.reason === "generating")
            ) {
                throw new GenerationRunnerError(409, "The trigger changed a message that is being generated", {
                    stage: "persist",
                });
            }
            throw error;
        }
        refreshChatAfterWrite(store, scope, ops, applied.chats[0]);
        job.emitRecords({ chats: [{ characterId: scope.characterId, id: scope.chatId }] });
    };

    if (reordered) {
        const unchanged = scope.chatRevision === baseline.revision;
        const generating = lock.chatHolders(scope.characterId, scope.chatId).size > 0;
        if (unchanged && !generating) {
            write([{ op: "replace", chat: next }]);
            return;
        }
        console.warn(
            "[Trigger] A trigger reordered messages of a chat that changed meanwhile; the order change is dropped",
        );
    }

    const ops: ChatOp[] = [];
    if (removed.length > 0) {
        ops.push({ op: "remove", ids: removed });
    }
    const present = new Set([...currentIds].filter((id) => !removed.includes(id)));
    for (const message of changedMessages) {
        const before = baseMessages.get(message.chatId!)!;
        const stored = current.message.find((entry) => entry.chatId === message.chatId);
        if (!stored || !present.has(message.chatId!)) {
            continue;
        }
        const merged = structuredClone(stored) as unknown as Record<string, unknown>;
        const beforeFields = before as unknown as Record<string, unknown>;
        const afterFields = message as unknown as Record<string, unknown>;
        for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
            if (json(beforeFields[key]) !== json(afterFields[key])) {
                if (Object.hasOwn(afterFields, key)) {
                    merged[key] = afterFields[key];
                } else {
                    delete merged[key];
                }
            }
        }
        // The message the job generates (a continue's) is written as a checkpoint of that generation,
        // so the edit keeps its generation open (the client's `applyChatResult` with its capability).
        const owned = options.generation;
        const generation = owned && owned.messageId === message.chatId ? owned.next() : undefined;
        ops.push({ op: "setMessage", message: merged as unknown as Message, ...(generation ? { generation } : {}) });
    }
    // New messages after their predecessor as the chat holds it, counting the ones inserted before.
    let previous: string | null = null;
    for (const message of next.message) {
        const id = message.chatId!;
        if (!baseMessages.has(id)) {
            const anchor: MessageAnchor =
                previous === null ? { start: true } : present.has(previous) ? { after: previous } : { end: true };
            ops.push({ op: "append", messages: [message], anchor });
            present.add(id);
        }
        if (present.has(id)) {
            previous = id;
        }
    }

    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const baseFields = baseline.chat as unknown as Record<string, unknown>;
    const nextFields = next as unknown as Record<string, unknown>;
    const currentFields = current as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(baseFields), ...Object.keys(nextFields)])) {
        if (
            nonMetaKeys.has(key) ||
            json(baseFields[key]) === json(nextFields[key]) ||
            json(currentFields[key]) === json(nextFields[key])
        ) {
            continue;
        }
        if (Object.hasOwn(nextFields, key) && nextFields[key] !== undefined) {
            set[key] = nextFields[key];
        } else {
            unset.push(key);
        }
    }
    if (Object.keys(set).length > 0 || unset.length > 0) {
        ops.push({
            op: "meta",
            ...(Object.keys(set).length > 0 ? { set } : {}),
            ...(unset.length > 0 ? { unset } : {}),
        });
    }
    write(ops);
}
