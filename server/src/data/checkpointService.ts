import { randomUUID } from "node:crypto";
import { SAFETY_KEEP, type CheckpointPolicy, type CheckpointSummary } from "../../../shared/chatCheckpoints.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { MemoryTasks } from "../prompt/memory/memoryTasks.ts";
import {
    isValidResourceId,
    ResourceBatchConflictError,
    ResourceConflictError,
    ResourceEpochError,
    type ResourceStore,
    ResourceValidationError,
} from "./resourceStore.ts";

/** Parsed JSON (or query fields), with the mutation's epoch header kept separate. */
export type CheckpointRequest = { body: unknown; epoch?: string };

type CheckpointError =
    | { status: 400 | 404; body: { error: string } }
    | { status: 409; body: { reason: "generating" } | { error: string; revision: string | null } }
    | { status: 412; body: { error: "EpochMismatch"; epoch: string } };

type CheckpointResult<T> = { status: 200; body: T } | CheckpointError;

function parseRequest(body: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!isPlainObject(body)) {
        throw new ResourceValidationError("The body must be an object");
    }
    for (const key of Object.keys(body)) {
        if (!fields.includes(key)) {
            throw new ResourceValidationError(`Unknown field: ${key}`);
        }
    }
    return body;
}

function stringField(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    if (typeof value !== "string") {
        throw new ResourceValidationError(`${key} must be a string`);
    }
    return value;
}

function idField(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    if (!isValidResourceId(value)) {
        throw new ResourceValidationError(`${key} must be an id`);
    }
    return value;
}

const chatFields = ["characterId", "chatId"];
const notFound = (): CheckpointError => ({ status: 404, body: { error: "Chat or checkpoint not found" } });
const generating = (): CheckpointError => ({ status: 409, body: { reason: "generating" } });

/**
 * Synchronous checkpoint operations, independent of HTTP. The caller checks maintenance immediately
 * before invoking a mutation. Loads take the summary writer lease synchronously and release its
 * promised handle after the transaction, without awaiting inside the operation.
 */
export function createCheckpointService({
    store,
    busy,
    memoryTasks,
    afterLoad,
}: {
    store: ResourceStore;
    busy: (characterId: string, chatId: string) => boolean;
    memoryTasks: Pick<MemoryTasks, "acquireSummaryWriter"> | null;
    /** Test seam: runs after all load writes, inside the transaction; a throw rolls them back. */
    afterLoad?: () => unknown;
}) {
    function respond<T>(fn: () => CheckpointResult<T>): CheckpointResult<T> {
        try {
            return fn();
        } catch (error) {
            if (error instanceof ResourceEpochError) {
                return { status: 412, body: { error: "EpochMismatch", epoch: error.epoch } };
            }
            if (error instanceof ResourceValidationError) {
                return { status: 400, body: { error: error.message } };
            }
            if (error instanceof ResourceConflictError) {
                return error.reason === "generating"
                    ? generating()
                    : { status: 409, body: { error: error.message, revision: error.current } };
            }
            if (error instanceof ResourceBatchConflictError) {
                const conflict = error.conflicts[0];
                return conflict && "reason" in conflict && conflict.reason === "generating"
                    ? generating()
                    : { status: 409, body: { error: error.message, revision: conflict?.revision ?? null } };
            }
            throw error;
        }
    }

    return {
        autoSave(characterId: string, chatId: string): void {
            if (busy(characterId, chatId)) {
                return;
            }
            const policy = store.checkpoints.readPolicy(characterId, chatId);
            if (!policy) {
                return;
            }
            const chat = store.readChatSource(characterId, chatId);
            if (chat.data === null) {
                return;
            }
            const userTurns = chat.data.message.filter((message) => message.role === "user").length;
            const { autoEvery, autoKeep } = policy;
            if (policy.lastAutoTurns !== null && userTurns < policy.lastAutoTurns) {
                store.checkpoints.writePolicy(characterId, chatId, { autoEvery, autoKeep, lastAutoTurns: userTurns });
                return;
            }
            if (policy.lastAutoTurns === null || userTurns - policy.lastAutoTurns >= autoEvery) {
                store.applyChanges(
                    {},
                    {
                        inTransaction: {
                            before(tx) {
                                const saved = tx.save(characterId, chatId, "Auto", "auto");
                                if (!saved) {
                                    return;
                                }
                                tx.writePolicy(characterId, chatId, {
                                    autoEvery,
                                    autoKeep,
                                    lastAutoTurns: saved.userTurns,
                                });
                                tx.prune(characterId, chatId, "auto", autoKeep);
                            },
                        },
                    },
                );
            }
        },

        readPolicy(request: CheckpointRequest) {
            return respond(() => {
                const body = parseRequest(request.body, chatFields);
                const characterId = idField(body, "characterId");
                const chatId = idField(body, "chatId");
                if (store.chatRevision(characterId, chatId) === null) {
                    return notFound();
                }
                const policy = store.checkpoints.readPolicy(characterId, chatId);
                return {
                    status: 200,
                    body: {
                        epoch: store.epoch(),
                        policy: policy ? { autoEvery: policy.autoEvery, autoKeep: policy.autoKeep } : null,
                    },
                };
            });
        },

        writePolicy(request: CheckpointRequest) {
            return respond(() => {
                const body = parseRequest(request.body, [...chatFields, "autoEvery", "autoKeep", "off"]);
                const characterId = idField(body, "characterId");
                const chatId = idField(body, "chatId");
                let policy: CheckpointPolicy | null;
                if ("off" in body) {
                    if (body.off !== true || "autoEvery" in body || "autoKeep" in body) {
                        throw new ResourceValidationError(
                            "off must be true and cannot be combined with autoEvery or autoKeep",
                        );
                    }
                    policy = null;
                } else {
                    const { autoEvery, autoKeep } = body;
                    if (
                        typeof autoEvery !== "number" ||
                        !Number.isInteger(autoEvery) ||
                        typeof autoKeep !== "number" ||
                        !Number.isInteger(autoKeep)
                    ) {
                        throw new ResourceValidationError("autoEvery and autoKeep must be integers");
                    }
                    policy = { autoEvery, autoKeep };
                }
                store.assertEpoch(request.epoch);
                if (store.chatRevision(characterId, chatId) === null) {
                    return notFound();
                }
                store.checkpoints.writePolicy(characterId, chatId, policy);
                return { status: 200, body: { epoch: store.epoch(), policy } };
            });
        },

        list(request: CheckpointRequest) {
            return respond(() => {
                const body = parseRequest(request.body, chatFields);
                const checkpoints = store.checkpoints.list(idField(body, "characterId"), idField(body, "chatId"));
                return checkpoints ? { status: 200, body: { epoch: store.epoch(), checkpoints } } : notFound();
            });
        },

        save(request: CheckpointRequest) {
            return respond(() => {
                const body = parseRequest(request.body, [...chatFields, "name"]);
                const characterId = idField(body, "characterId");
                const chatId = idField(body, "chatId");
                const name = stringField(body, "name");
                store.assertEpoch(request.epoch);
                if (busy(characterId, chatId)) {
                    return generating();
                }
                const checkpoint = store.checkpoints.save(characterId, chatId, name, "manual");
                return checkpoint ? { status: 200, body: { epoch: store.epoch(), checkpoint } } : notFound();
            });
        },

        rename(request: CheckpointRequest) {
            return respond(() => {
                const body = parseRequest(request.body, [...chatFields, "id", "baseRevision", "name"]);
                const characterId = idField(body, "characterId");
                const chatId = idField(body, "chatId");
                const id = idField(body, "id");
                const baseRevision = stringField(body, "baseRevision");
                const name = stringField(body, "name");
                store.assertEpoch(request.epoch);
                const checkpoint = store.checkpoints.rename(characterId, chatId, id, baseRevision, name);
                return checkpoint ? { status: 200, body: { epoch: store.epoch(), checkpoint } } : notFound();
            });
        },

        remove(request: CheckpointRequest) {
            return respond(() => {
                const body = parseRequest(request.body, [...chatFields, "id", "baseRevision"]);
                const characterId = idField(body, "characterId");
                const chatId = idField(body, "chatId");
                const id = idField(body, "id");
                const baseRevision = stringField(body, "baseRevision");
                store.assertEpoch(request.epoch);
                const removed = store.checkpoints.delete(characterId, chatId, id, baseRevision);
                return removed ? { status: 200, body: { epoch: store.epoch(), ok: true } } : notFound();
            });
        },

        load(request: CheckpointRequest) {
            return respond(() => {
                const body = parseRequest(request.body, [...chatFields, "id", "chatBaseRevision"]);
                const characterId = idField(body, "characterId");
                const chatId = idField(body, "chatId");
                const id = idField(body, "id");
                const chatBaseRevision = stringField(body, "chatBaseRevision");
                store.assertEpoch(request.epoch);
                const epoch = store.epoch();
                if (busy(characterId, chatId)) {
                    return generating();
                }
                const composed = store.checkpoints.compose(characterId, chatId, id);
                const checkpoint = store.checkpoints.list(characterId, chatId)?.find((entry) => entry.id === id);
                if (!composed || !checkpoint) {
                    return notFound();
                }
                const current = store.chatRevision(characterId, chatId);
                if (current !== chatBaseRevision) {
                    throw new ResourceConflictError(current);
                }
                const lease = memoryTasks?.acquireSummaryWriter({ chaId: characterId, chatId }, "checkpoint-load");
                try {
                    const saved: { safety?: CheckpointSummary } = {};
                    const applied = store.applyChanges(
                        {
                            chats: [
                                {
                                    characterId,
                                    chatId,
                                    baseRevision: chatBaseRevision,
                                    groupId: randomUUID(),
                                    ops: [{ op: "replace", chat: composed }],
                                },
                            ],
                        },
                        {
                            epoch,
                            inTransaction: {
                                before(tx) {
                                    const safety = tx.save(
                                        characterId,
                                        chatId,
                                        "Before loading " + checkpoint.name,
                                        "safety",
                                    );
                                    if (!safety) {
                                        throw new Error("Chat disappeared during checkpoint load");
                                    }
                                    saved.safety = safety;
                                },
                                after(_applied, tx) {
                                    tx.setFloor(characterId, chatId);
                                    const policy = tx.readPolicy(characterId, chatId);
                                    if (policy) {
                                        tx.writePolicy(characterId, chatId, {
                                            ...policy,
                                            lastAutoTurns: checkpoint.userTurns,
                                        });
                                    }
                                    tx.prune(characterId, chatId, "safety", SAFETY_KEEP);
                                    return afterLoad?.();
                                },
                            },
                        },
                    );
                    return {
                        status: 200,
                        body: { epoch, chatRevision: applied.chats[0].revision!, safety: saved.safety! },
                    };
                } finally {
                    void lease?.then(
                        (held) => held.release(),
                        () => {},
                    );
                }
            });
        },
    };
}

export type CheckpointService = ReturnType<typeof createCheckpointService>;
