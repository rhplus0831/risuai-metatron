// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import type { BatchConflict } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    createResourceStore,
    JobTokenError,
    ResourceBatchConflictError,
    ResourceConflictError,
    ResourceEpochError,
} from "../data/resourceStore.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";

// The generation lock as the resource store's guard (Phase 5 slice 5): a change that rewrites or
// removes a message a job owns, or deletes its chat or character, is refused with
// `reason: "generating"` before any revision check, unless it carries the owner's job token. The
// lock itself is in memory (`createGenerationLock`); the jobs registry is covered by
// `generationJobs.test.ts` and `generations.test.ts`.

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;
const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const group = (chatId: string, baseRevision: string | null, ops: ChatOp[], characterId = "c") => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});
const bumped = (token: string, n: number) =>
    token.replace(/:\d+$/, `:${Number(token.slice(token.lastIndexOf(":") + 1)) + n}`);
/**
 * The chat `k` conflict entry a refused group gets: with `messageIds` naming `b` when one of its ops
 * targets that message by id (data-loss slice 2a), without the field for a whole-chat refusal.
 */
const refusal = (revision: string, ops: ChatOp[]) => {
    const targetsB = ops.some(
        (op) =>
            (op.op === "setText" || op.op === "patchMessage" || op.op === "begin" || op.op === "setTranslation"
                ? op.id === "b"
                : false) ||
            (op.op === "setMessage" && op.message.chatId === "b") ||
            (op.op === "remove" && op.ids.includes("b")),
    );
    return {
        kind: "chat",
        characterId: "c",
        id: "k",
        revision,
        reason: "generating",
        ...(targetsB ? { messageIds: ["b"] } : {}),
    };
};

function setup() {
    const lock = createGenerationLock();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
    const seeded = store.applyChanges({
        ops: [
            { kind: characters, id: "c", baseRevision: null, data: { chaId: "c" } },
            { kind: characters, id: "d", baseRevision: null, data: { chaId: "d" } },
        ],
        chats: [
            group("k", null, [{ op: "create", chat: { name: "K", message: [m("a", "A"), m("b", "B")] } as never }]),
            group("j", null, [{ op: "create", chat: { name: "J", message: [m("x", "X")] } as never }]),
            group("q", null, [{ op: "create", chat: { name: "Q", message: [m("y", "Y")] } as never }], "d"),
        ],
    });
    const revisions = {
        k: seeded.chats[0].revision!,
        j: seeded.chats[1].revision!,
        q: seeded.chats[2].revision!,
        c: seeded.results[0].revision!,
        d: seeded.results[1].revision!,
    };
    const token = "token-1";
    lock.addToken(token);
    // Job 1 (generation g1) owns message b of chat k.
    lock.acquire({ characterId: "c", chatId: "k", messageId: "b" }, { jobId: "J1", generationId: "g1", token });
    const state = () => JSON.stringify(store.readKinds([characters], { chats: true }));
    const text = (chatId: string, id: string, characterId = "c") =>
        store.readRefs([], { chats: [{ characterId, id: chatId }] }).chats[0].data!.message.find((x) => x.chatId === id)
            ?.data;
    const conflictsOf = (fn: () => unknown): BatchConflict[] => {
        let error: unknown;
        try {
            fn();
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ResourceBatchConflictError);
        return (error as ResourceBatchConflictError).conflicts;
    };
    return { lock, store, revisions, token, state, text, conflictsOf };
}

describe("the generation lock guard on chat groups", () => {
    it("refuses every rewrite or removal of an owned message, and the replace or delete of its chat, with reason generating and nothing written", () => {
        const { store, revisions, state, conflictsOf } = setup();
        const before = state();
        const refused: ChatOp[][] = [
            [{ op: "setText", id: "b", text: "mine" }],
            [{ op: "setMessage", message: m("b", "mine") as never }],
            [{ op: "remove", ids: ["b"] }],
            [{ op: "remove", ids: ["a", "b"] }],
            [{ op: "begin", id: "b", generationId: "g-client" }],
            [{ op: "delete" }],
            [{ op: "replace", chat: { name: "K2", message: [m("a", "A")] } as never }],
            // A forged client write carrying the job's generation id grants nothing.
            [{ op: "setText", id: "b", text: "forged", generation: { id: "g1", seq: 99 } }],
            // Several ops, one of them refused: the whole group conflicts.
            [
                { op: "meta", set: { note: "n" } },
                { op: "setText", id: "b", text: "mine" },
            ],
        ];
        for (const ops of refused) {
            const conflicts = conflictsOf(() => store.applyChanges({ chats: [group("k", revisions.k, ops)] }));
            expect(conflicts, JSON.stringify(ops)).toEqual([refusal(revisions.k, ops)]);
        }
        expect(state()).toBe(before);
    });

    it("names the targeted messages a job owns in op order, once each, leaving out free targets and the caller's own job's, and no list for a whole-chat refusal", () => {
        const { store, revisions, lock, token, state, conflictsOf } = setup();
        // Job 2 (another token) owns message a of the same chat.
        lock.addToken("token-2");
        lock.acquire(
            { characterId: "c", chatId: "k", messageId: "a" },
            { jobId: "J2", generationId: "g2", token: "token-2" },
        );
        const before = state();
        const entry = (ops: ChatOp[], options?: { epoch: string; jobToken: string }) =>
            conflictsOf(() => store.applyChanges({ chats: [group("k", revisions.k, ops)] }, options));
        // In op order, each id once: b (setText), then a (the bulk remove), b again not repeated.
        expect(
            entry([
                { op: "setText", id: "b", text: "mine" },
                { op: "remove", ids: ["a", "b"] },
                { op: "patchMessage", id: "b", set: { name: "n" } },
            ]),
        ).toEqual([
            {
                kind: "chat",
                characterId: "c",
                id: "k",
                revision: revisions.k,
                reason: "generating",
                messageIds: ["b", "a"],
            },
        ]);
        // Job 1's own write (its token) is refused only for job 2's message, which alone is named.
        expect(
            entry(
                [
                    { op: "setText", id: "b", text: "owner" },
                    { op: "setText", id: "a", text: "not mine" },
                ],
                { epoch: store.epoch(), jobToken: token },
            ),
        ).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: revisions.k, reason: "generating", messageIds: ["a"] },
        ]);
        // A whole-chat replace or delete of a chat holding a lock: refused, nothing named (the
        // client keeps and retries the whole group).
        for (const ops of [
            [{ op: "delete" }] as ChatOp[],
            [{ op: "replace", chat: { name: "K2", message: [m("z", "Z")] } as never }] as ChatOp[],
            [
                { op: "meta", set: { note: "n" } },
                { op: "replace", chat: { name: "K2", message: [] } as never },
            ] as ChatOp[],
        ]) {
            expect(entry(ops), JSON.stringify(ops)).toEqual([
                { kind: "chat", characterId: "c", id: "k", revision: revisions.k, reason: "generating" },
            ]);
        }
        // A whole-chat replace alongside a locked message edit names that message.
        expect(
            entry([
                { op: "replace", chat: { name: "K2", message: [m("z", "Z")] } as never },
                { op: "setText", id: "b", text: "mine" },
            ]),
        ).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: revisions.k, reason: "generating", messageIds: ["b"] },
        ]);
        expect(state()).toBe(before);
    });

    it("refuses a setTranslation of an owned message as generating (a clear too), applies one of another message, and applies the owner's with its token", () => {
        const { store, revisions, token, state, conflictsOf } = setup();
        const translation = (text: string, source: string) => ({
            text,
            sourceHash: translationSourceHash(source),
            targetLanguage: "ko",
            translatedAt: 1,
        });
        const before = state();
        for (const value of [translation("ㄴ", "B"), null]) {
            const conflicts = conflictsOf(() =>
                store.applyChanges({
                    chats: [group("k", revisions.k, [{ op: "setTranslation", id: "b", translation: value }])],
                }),
            );
            expect(conflicts, JSON.stringify(value)).toEqual([
                {
                    kind: "chat",
                    characterId: "c",
                    id: "k",
                    revision: revisions.k,
                    reason: "generating",
                    messageIds: ["b"],
                },
            ]);
        }
        expect(state()).toBe(before);
        // Another message of the same chat is free.
        const free = store.applyChanges({
            chats: [group("k", revisions.k, [{ op: "setTranslation", id: "a", translation: translation("ㄱ", "A") }])],
        }).chats[0];
        expect(free.translations).toEqual(["applied"]);
        // The owner's in-process write carries its token.
        const own = store.applyChanges(
            {
                chats: [
                    group("k", free.revision!, [
                        { op: "setTranslation", id: "b", translation: translation("ㄴ", "B") },
                    ]),
                ],
            },
            { epoch: store.epoch(), jobToken: token },
        );
        expect(own.chats[0].translations).toEqual(["applied"]);
        expect(
            store
                .readRefs([], { chats: [{ characterId: "c", id: "k" }] })
                .chats[0].data!.message.find((x) => x.chatId === "b"),
        ).toEqual({ ...m("b", "B"), translation: translation("ㄴ", "B") });
    });

    it("answers generating before a stale-revision conflict, and before a missing-target one", () => {
        const { store, revisions, conflictsOf, state } = setup();
        // Advance the chat so `revisions.k` is stale.
        const current = store.applyChanges({
            chats: [group("k", revisions.k, [{ op: "meta", set: { note: "moved on" } }])],
        }).chats[0].revision!;
        const before = state();
        for (const ops of [
            [{ op: "delete" }] as ChatOp[],
            [{ op: "remove", ids: ["a", "b"] }] as ChatOp[],
            [{ op: "setText", id: "b", text: "mine" }] as ChatOp[],
            [{ op: "begin", id: "b", generationId: "g-client" }] as ChatOp[],
        ]) {
            expect(conflictsOf(() => store.applyChanges({ chats: [group("k", revisions.k, ops)] }))).toEqual([
                refusal(current, ops),
            ]);
        }
        expect(state()).toBe(before);
    });

    it("lets meta, append, and ops on other messages apply, in this chat and in other chats", () => {
        const { store, revisions, text, lock } = setup();
        const applied = store.applyChanges({
            chats: [
                group("k", revisions.k, [
                    { op: "meta", set: { note: "n" } },
                    { op: "setText", id: "a", text: "A2" },
                    { op: "append", messages: [m("z", "Z")], anchor: { end: true } },
                    { op: "remove", ids: ["z"] },
                ]),
                group("j", revisions.j, [{ op: "setText", id: "x", text: "X2" }]),
                group("q", revisions.q, [{ op: "delete" }], "d"),
            ],
        });
        expect(applied.chats.map((r) => r.revision === null)).toEqual([false, false, true]);
        expect(text("k", "a")).toBe("A2");
        expect(text("k", "b")).toBe("B");
        expect(text("j", "x")).toBe("X2");
        expect(lock.ownerOf({ characterId: "c", chatId: "k", messageId: "b" })?.generationId).toBe("g1");
    });

    it("applies the owner's write with its live token and epoch, refuses a dead token or another epoch before writing, and another job's token as generating", () => {
        const { store, revisions, token, lock, text, state, conflictsOf } = setup();
        const own = store.applyChanges(
            {
                chats: [
                    group("k", revisions.k, [
                        { op: "begin", id: "b", generationId: "g1" },
                        { op: "setText", id: "b", text: "ours", generation: { id: "g1", seq: 1 } },
                    ]),
                ],
            },
            { epoch: store.epoch(), jobToken: token },
        );
        expect(own.chats[0].checkpoints).toEqual(["applied"]);
        expect(text("k", "b")).toBe("ours");
        const revision = own.chats[0].revision!;
        const before = state();
        const write = (options: { epoch?: string; jobToken?: string }) =>
            store.applyChanges(
                {
                    chats: [
                        group("k", revision, [
                            { op: "setText", id: "b", text: "late", generation: { id: "g1", seq: 2 } },
                        ]),
                    ],
                },
                options,
            );
        expect(() => write({ epoch: store.epoch(), jobToken: "dead-token" })).toThrow(JobTokenError);
        expect(() => write({ epoch: "00000000-0000-4000-8000-000000000000", jobToken: token })).toThrow(
            ResourceEpochError,
        );
        lock.addToken("token-2");
        expect(conflictsOf(() => write({ epoch: store.epoch(), jobToken: "token-2" }))).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision, reason: "generating", messageIds: ["b"] },
        ]);
        expect(state()).toBe(before);
        // Once the job ends, the token is dead and the message is free: an ordinary write applies.
        lock.endJob(token);
        expect(() => write({ epoch: store.epoch(), jobToken: token })).toThrow(JobTokenError);
        expect(
            store.applyChanges({ chats: [group("k", revision, [{ op: "setText", id: "b", text: "free" }])] }).chats[0]
                .revision,
        ).toBe(bumped(revision, 1));
        expect(text("k", "b")).toBe("free");
    });

    it("rolls back a mixed batch when one of its chat groups is refused", () => {
        const { store, revisions, state, conflictsOf } = setup();
        const before = state();
        const conflicts = conflictsOf(() =>
            store.applyChanges({
                ops: [{ kind: characters, id: "e", baseRevision: null, data: { chaId: "e" } }],
                chats: [
                    group("j", revisions.j, [{ op: "setText", id: "x", text: "X2" }]),
                    group("k", revisions.k, [{ op: "setText", id: "b", text: "mine" }]),
                ],
                chatOrders: [
                    {
                        characterId: "c",
                        baseRevision: store.readRefs([], { chatCollections: ["c"] }).chatCollections[0].order!.revision,
                        ids: ["j", "k"],
                    },
                ],
            }),
        );
        expect(conflicts).toEqual([
            { kind: "chat", characterId: "c", id: "k", revision: revisions.k, reason: "generating", messageIds: ["b"] },
        ]);
        expect(state()).toBe(before);
        expect(store.get(characters, "e")).toBeNull();
    });
});

describe("the generation lock guard on character deletes", () => {
    it("refuses the single delete with reason generating, before the revision check, and records the conflict inside a transaction even when caught", () => {
        const { store, revisions, lock, state } = setup();
        const before = state();
        let error: unknown;
        try {
            store.delete(characters, "c", revisions.c);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ResourceConflictError);
        expect((error as ResourceConflictError).reason).toBe("generating");
        expect((error as ResourceConflictError).current).toBe(revisions.c);
        // A stale token is still a generating refusal (the lock preflight comes first).
        try {
            store.delete(characters, "c", bumped(revisions.c, 5));
        } catch (e) {
            error = e;
        }
        expect((error as ResourceConflictError).reason).toBe("generating");
        // Another character is deletable, and a caught refusal still poisons the transaction.
        expect(() =>
            store.transaction(() => {
                store.put(characters, "d", { chaId: "d", name: "renamed" }, revisions.d);
                try {
                    store.delete(characters, "c", revisions.c);
                } catch {
                    // swallowed: the transaction must still roll back
                }
            }),
        ).toThrow(ResourceConflictError);
        expect(state()).toBe(before);
        expect(store.get(characters, "d")!.data).toEqual(normalizeCharacter({ chaId: "d" }));
        // The owner's token passes nothing here either: a character delete is never a job's write.
        lock.endJob("token-1");
        store.delete(characters, "c", revisions.c);
        expect(store.get(characters, "c")).toBeNull();
        expect(store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].revision).toBeNull();
    });

    it("refuses the batch delete with reason generating (current or stale token) and rolls the batch back; a job's own token does not pass it", () => {
        const { store, revisions, token, lock, state, conflictsOf } = setup();
        lock.addToken("token-other");
        const before = state();
        for (const baseRevision of [revisions.c, bumped(revisions.c, 3)]) {
            const conflicts = conflictsOf(() =>
                store.applyChanges({
                    ops: [
                        { kind: characters, id: "d", baseRevision: revisions.d, data: { chaId: "d", name: "renamed" } },
                        { kind: characters, id: "c", baseRevision, delete: true },
                    ],
                }),
            );
            expect(conflicts).toEqual([{ kind: "characters", id: "c", revision: revisions.c, reason: "generating" }]);
        }
        expect(
            conflictsOf(() =>
                store.applyChanges(
                    { ops: [{ kind: characters, id: "c", baseRevision: revisions.c, delete: true }] },
                    { epoch: store.epoch(), jobToken: "token-other" },
                ),
            ).map((c) => "reason" in c && c.reason),
        ).toEqual(["generating"]);
        expect(state()).toBe(before);
        // The owning job's token may delete (its own cascade); a put of the character never touches chats.
        store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: revisions.c, data: { chaId: "c", name: "ok" } }],
        });
        expect(store.get(characters, "c")!.data).toEqual(normalizeCharacter({ chaId: "c", name: "ok" }));
        store.applyChanges(
            { ops: [{ kind: characters, id: "c", baseRevision: store.get(characters, "c")!.revision, delete: true }] },
            { epoch: store.epoch(), jobToken: token },
        );
        expect(store.get(characters, "c")).toBeNull();
    });
});

describe("chatRevision and the lock's bookkeeping", () => {
    it("reads a chat's token without its messages, and null for a missing chat", () => {
        const { store, revisions } = setup();
        expect(store.chatRevision("c", "k")).toBe(revisions.k);
        expect(store.chatRevision("c", "nope")).toBeNull();
        expect(store.chatRevision("nobody", "k")).toBeNull();
    });

    it("hands a message between generations of one job, restores a replaced owner, and releases only the owning generation", () => {
        const lock = createGenerationLock();
        const ref = { characterId: "c", chatId: "k", messageId: "b" };
        lock.addToken("t1");
        lock.addToken("t2");
        expect(lock.acquire(ref, { jobId: "J1", generationId: "g1", token: "t1" })).toBeNull();
        // The same job's later generation replaces the owner and reports the previous one.
        expect(lock.acquire(ref, { jobId: "J1", generationId: "g2", token: "t1" })).toEqual({
            jobId: "J1",
            generationId: "g1",
            token: "t1",
        });
        expect(() => lock.acquire(ref, { jobId: "J2", generationId: "x", token: "t2" })).toThrow(
            "Another generation job owns this message",
        );
        expect(() =>
            lock.acquire({ ...ref, messageId: "z" }, { jobId: "J3", generationId: "x", token: "dead" }),
        ).toThrow("The job has ended");
        // A final of the earlier generation does not release the later one.
        lock.release(ref, "t1", "g1");
        expect(lock.ownerOf(ref)?.generationId).toBe("g2");
        lock.release(ref, "t2", "g2");
        expect(lock.ownerOf(ref)?.generationId).toBe("g2");
        // Restoring puts the previous owner back; restoring null frees the message.
        lock.restore(ref, { jobId: "J1", generationId: "g1", token: "t1" });
        expect(lock.ownerOf(ref)?.generationId).toBe("g1");
        expect(lock.holder("c", "k", "b")).toBe("t1");
        expect([...lock.chatHolders("c", "k")]).toEqual(["t1"]);
        expect([...lock.characterHolders("c")]).toEqual(["t1"]);
        expect(lock.ownedBy("t1")).toEqual([{ ...ref, generationId: "g1" }]);
        lock.restore(ref, null);
        expect(lock.ownerOf(ref)).toBeNull();
        // Ending a job kills its token and frees everything it owned.
        lock.acquire(ref, { jobId: "J1", generationId: "g3", token: "t1" });
        lock.acquire({ ...ref, chatId: "j", messageId: "x" }, { jobId: "J1", generationId: "g4", token: "t1" });
        expect(lock.isLive("t1")).toBe(true);
        lock.endJob("t1");
        expect(lock.isLive("t1")).toBe(false);
        expect(lock.ownedBy("t1")).toEqual([]);
        expect(lock.chatHolders("c", "k").size).toBe(0);
    });
});
