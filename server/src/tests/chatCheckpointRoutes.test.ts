// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointSummary } from "../../../shared/chatCheckpoints.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import type { GenerationKind } from "../../../shared/jobs.ts";
import { createChangeFeed, type ChangeFeedEvent } from "../data/changeFeed.ts";
import { createCheckpointService } from "../data/checkpointService.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ChatInvalidation } from "../data/resourceStore.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { createResourceTestClient, json, type ResourceTestClient, type TestServerOptions } from "./testSupport.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const ref = { characterId: "c/one", chatId: "k/one" };
const path = "/api/chat-checkpoints";
const m = (chatId: string, data = chatId, role: Message["role"] = "user"): Message => ({ chatId, data, role });
const group = (baseRevision: string | null, ops: ChatOp[]) => ({ ...ref, baseRevision, ops });
const initial: Chat = { name: "Story", note: "saved note", localLore: [], message: [m("a"), m("b", "B", "char")] };
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}
async function answer(response: Response, status: number) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body as any;
}
async function server(options: TestServerOptions = {}) {
    const s = await createResourceTestClient(options);
    cleanups.push(() => s.close());
    await answer(
        await s.json("/api/resources/batch", {
            ops: [ref.characterId, "other"].map((id) => ({
                kind: "characters",
                id,
                baseRevision: null,
                data: { chaId: id },
            })),
            chats: [group(null, [{ op: "create", chat: initial }])],
        }),
        200,
    );
    return s;
}
async function read(s: ResourceTestClient) {
    const body = await answer(
        await s.json("/api/resources/read", { chats: [{ characterId: ref.characterId, id: ref.chatId }] }),
        200,
    );
    return body.chats[0] as { revision: string; data: Chat };
}
async function edit(s: ResourceTestClient, ops: ChatOp[], baseRevision?: string, extra: Record<string, unknown> = {}) {
    return s.json("/api/resources/batch", {
        chats: [{ ...group(baseRevision ?? (await read(s)).revision, ops), ...extra }],
    });
}
async function save(s: ResourceTestClient, name = "Fork"): Promise<CheckpointSummary> {
    const body = await answer(await s.json(`${path}/save`, { ...ref, name }), 200);
    expect(body.epoch).toBe(s.epoch);
    return body.checkpoint;
}
async function list(s: ResourceTestClient): Promise<CheckpointSummary[]> {
    const body = await answer(await s.request(`${path}?${new URLSearchParams(ref)}`, {}, null), 200);
    expect(body.epoch).toBe(s.epoch);
    return body.checkpoints;
}
async function load(s: ResourceTestClient, id: string, chatBaseRevision?: string) {
    return s.json(`${path}/load`, { ...ref, id, chatBaseRevision: chatBaseRevision ?? (await read(s)).revision });
}

function storeFixture() {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const feed = createChangeFeed();
    const store = createResourceStore({ file: ":memory:", kinds, feed });
    cleanups.push(() => store.close());
    store.put(kinds.get("characters")!, ref.characterId, { chaId: ref.characterId }, null);
    store.applyChanges({ chats: [group(null, [{ op: "create", chat: initial }])] });
    const events: ChangeFeedEvent[] = [];
    const notices: ChatInvalidation[] = [];
    feed.subscribe((event) => events.push(event));
    store.onChatInvalidated((notice) => notices.push(notice));
    const revision = () => store.chatRevision(ref.characterId, ref.chatId)!;
    const write = (ops: ChatOp[]) => store.applyChanges({ chats: [group(revision(), ops)] });
    const chat = () => store.readChatSource(ref.characterId, ref.chatId);
    const service = (afterLoad?: () => unknown) =>
        createCheckpointService({ store, busy: () => false, memoryTasks: null, afterLoad });
    const checkpoint = (name = "Fork", kind: "manual" | "safety" = "manual") =>
        store.checkpoints.save(ref.characterId, ref.chatId, name, kind)!;
    const request = (id: string) => ({ epoch: store.epoch(), body: { ...ref, id, chatBaseRevision: revision() } });
    return { store, events, notices, revision, write, chat, service, checkpoint, request };
}

describe("chat checkpoint routes", () => {
    it("authenticates every route and fences mutations by epoch and maintenance, with uncached answers", async () => {
        const s = await server();
        const checkpoint = await save(s);
        const bodies = {
            save: { ...ref, name: "Another" },
            rename: { ...ref, id: checkpoint.id, baseRevision: checkpoint.revision, name: "Renamed" },
            delete: { ...ref, id: checkpoint.id, baseRevision: checkpoint.revision },
            load: { ...ref, id: checkpoint.id, chatBaseRevision: (await read(s)).revision },
        };
        expect(await answer(await s.app.request(`${path}?${new URLSearchParams(ref)}`), 400)).toEqual({
            error: "No auth header",
        });
        const before = await read(s);
        for (const [operation, body] of Object.entries(bodies)) {
            expect(await answer(await s.app.request(`${path}/${operation}`, json(body)), 400)).toEqual({
                error: "No auth header",
            });
            for (const epoch of [null, "wrong-epoch"]) {
                expect(await answer(await s.json(`${path}/${operation}`, body, {}, epoch), 412)).toEqual({
                    error: "EpochMismatch",
                    epoch: s.epoch,
                });
            }
        }
        const entered = deferred();
        const release = deferred();
        const held = s.context.snapshots.withMaintenance(async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        try {
            for (const [operation, body] of Object.entries(bodies)) {
                await answer(await s.json(`${path}/${operation}`, body), 503);
            }
            expect(await list(s)).toEqual([checkpoint]);
        } finally {
            release.resolve();
            await held;
        }
        expect(await read(s)).toEqual(before);
        expect(await list(s)).toEqual([checkpoint]);
        await save(s, "Gate reopened");
    });

    it("lists, renames and deletes checkpoints with revision checks, missing-resource checks and validation limits", async () => {
        const s = await server();
        expect(await list(s)).toEqual([]);
        const saved = await save(s, "Original");
        expect(saved).toMatchObject({ name: "Original", kind: "manual", userTurns: 1, messageCount: 2 });
        expect(await list(s)).toEqual([saved]);
        const renamed = await answer(
            await s.json(`${path}/rename`, { ...ref, id: saved.id, baseRevision: saved.revision, name: "Renamed" }),
            200,
        );
        expect(renamed).toMatchObject({
            epoch: s.epoch,
            checkpoint: { ...saved, name: "Renamed", revision: expect.any(String) },
        });
        expect(renamed.checkpoint.revision).not.toBe(saved.revision);
        for (const operation of ["rename", "delete"]) {
            await answer(
                await s.json(`${path}/${operation}`, {
                    ...ref,
                    id: saved.id,
                    baseRevision: saved.revision,
                    ...(operation === "rename" ? { name: "Stale" } : {}),
                }),
                409,
            );
        }
        const bodies = {
            save: { name: "Missing" },
            rename: { id: saved.id, baseRevision: renamed.checkpoint.revision, name: "Missing" },
            delete: { id: saved.id, baseRevision: renamed.checkpoint.revision },
            load: { id: saved.id, chatBaseRevision: (await read(s)).revision },
        };
        for (const missing of [
            { ...ref, chatId: "missing" },
            { ...ref, characterId: "other" },
        ]) {
            await answer(await s.request(`${path}?${new URLSearchParams(missing)}`), 404);
            for (const [operation, body] of Object.entries(bodies))
                await answer(await s.json(`${path}/${operation}`, { ...missing, ...body }), 404);
        }
        for (const operation of ["rename", "delete", "load"] as const) {
            await answer(await s.json(`${path}/${operation}`, { ...ref, ...bodies[operation], id: "missing" }), 404);
        }
        await answer(await s.request(`${path}?characterId=${encodeURIComponent(ref.characterId)}`), 400);
        for (const operation of Object.keys(bodies)) {
            await answer(await s.json(`${path}/${operation}`, []), 400);
            await answer(await s.json(`${path}/${operation}`, ref), 400);
            await answer(
                await s.request(`${path}/${operation}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{",
                }),
                400,
            );
        }
        await answer(await s.json(`${path}/save`, { ...ref, name: 123 }), 400);
        expect(await list(s)).toEqual([renamed.checkpoint]);
        await answer(
            await s.json(`${path}/delete`, { ...ref, id: saved.id, baseRevision: renamed.checkpoint.revision }),
            200,
        );
        expect(await list(s)).toEqual([]);
        await answer(await load(s, saved.id), 404);
    });

    it("restores captured story fields, keeps current bindings and toggles, and closes only surviving message fences", async () => {
        const s = await server();
        const captured = {
            note: "Saved story",
            scriptstate: { chapter: 1 },
            localLore: [{ key: "gate", content: "Open" }],
            hypaV3Data: { summaries: [{ text: "Saved summary", chatMemos: ["a"], isImportant: true }] },
            supaMemoryData: "Saved older memory",
            lastMemory: "a",
            bookmarks: ["a"],
            GLGlobalVariables: { story: "saved", toggle_theme: "old" },
        };
        await answer(
            await edit(s, [
                { op: "meta", set: { ...captured, bindedPersona: "old-persona", name: "Old name" } },
                { op: "begin", id: "a", generationId: "ga" },
                { op: "setText", id: "a", text: "Saved A", generation: { id: "ga", seq: 1 } },
                { op: "begin", id: "b", generationId: "gb" },
                { op: "setText", id: "b", text: "Saved B", generation: { id: "gb", seq: 1 } },
            ]),
            200,
        );
        const checkpoint = await save(s);
        await answer(
            await edit(s, [
                { op: "setText", id: "a", text: "Current A" },
                { op: "remove", ids: ["b"] },
                { op: "append", anchor: { end: true }, messages: [m("later")] },
                {
                    op: "meta",
                    set: {
                        note: "Current story",
                        scriptstate: { chapter: 9, extra: true },
                        localLore: [],
                        hypaV3Data: { summaries: [] },
                        supaMemoryData: "Current older memory",
                        lastMemory: "later",
                        bookmarks: ["later"],
                        GLGlobalVariables: {
                            story: "current",
                            extra: "remove me",
                            toggle_theme: "new",
                            toggle_added: "on",
                        },
                        bindedPersona: "new-persona",
                        name: "New name",
                    },
                },
            ]),
            200,
        );
        const before = await read(s);
        const loaded = await answer(await load(s, checkpoint.id), 200);
        expect(loaded).toMatchObject({
            epoch: s.epoch,
            chatRevision: expect.any(String),
            safety: { kind: "safety", messageCount: 2 },
        });
        expect(loaded.chatRevision).not.toBe(before.revision);
        const restored = await read(s);
        expect(restored.revision).toBe(loaded.chatRevision);
        expect(restored.data).toMatchObject({
            ...captured,
            bindedPersona: "new-persona",
            name: "New name",
            GLGlobalVariables: { story: "saved", toggle_theme: "new", toggle_added: "on" },
            message: [m("a", "Saved A"), m("b", "Saved B", "char")],
        });
        expect(restored.data.GLGlobalVariables).toEqual({ story: "saved", toggle_theme: "new", toggle_added: "on" });
        expect(await list(s)).toEqual(expect.arrayContaining([checkpoint, loaded.safety]));
        const chunks = await answer(
            await edit(s, [
                { op: "setText", id: "a", text: "Old A", generation: { id: "ga", seq: 1 } },
                { op: "setText", id: "b", text: "Old B", generation: { id: "gb", seq: 1 } },
            ]),
            200,
        );
        expect(chunks.chats[0].checkpoints).toEqual(["duplicate", "ignored"]);
        const reopened = await answer(
            await edit(s, [
                { op: "begin", id: "a", generationId: "ga" },
                { op: "begin", id: "b", generationId: "gb" },
                { op: "setText", id: "a", text: "Late A", generation: { id: "ga", seq: 2 } },
                { op: "setText", id: "b", text: "New B", generation: { id: "gb", seq: 2 } },
            ]),
            200,
        );
        expect(reopened.chats[0].checkpoints).toEqual(["ignored", "applied"]);
        expect((await read(s)).data.message).toEqual([m("a", "Saved A"), m("b", "New B", "char")]);
        await answer(await load(s, loaded.safety.id), 200);
        expect((await read(s)).data).toEqual(before.data);
    });

    it("rejects pre-restore edits and re-anchored appends while replaying recorded groups and accepting the new revision", async () => {
        const s = await server();
        const checkpoint = await save(s);
        const recordedBase = (await read(s)).revision;
        const ops: ChatOp[] = [{ op: "append", anchor: { end: true }, messages: [m("removed")] }];
        const recorded = await answer(await edit(s, ops, recordedBase, { groupId: "recorded" }), 200);
        const oldBase = (await read(s)).revision;
        const beforeStaleLoad = await read(s);
        await answer(await load(s, checkpoint.id, recordedBase), 409);
        expect(await read(s)).toEqual(beforeStaleLoad);
        expect(await list(s)).toEqual([checkpoint]);
        const loaded = await answer(await load(s, checkpoint.id), 200);
        const before = await read(s);
        for (const ops of [
            [{ op: "setText", id: "a", text: "stale" }],
            [{ op: "meta", set: { note: "stale" } }],
        ] as ChatOp[][]) {
            const conflict = await answer(await edit(s, ops, oldBase), 409);
            expect(conflict.conflicts).toEqual([
                { kind: "chat", characterId: ref.characterId, id: ref.chatId, revision: loaded.chatRevision },
            ]);
        }
        for (const after of ["removed", "a"]) {
            const conflict = await answer(
                await edit(s, [{ op: "append", anchor: { after }, messages: [m("must-not-land")] }], oldBase, {
                    groupId: "queued-append",
                }),
                409,
            );
            expect(conflict.conflicts).toEqual([
                { kind: "chat", characterId: ref.characterId, id: ref.chatId, revision: loaded.chatRevision },
            ]);
        }
        expect(await answer(await edit(s, ops, recordedBase, { groupId: "recorded", retry: true }), 200)).toEqual(
            recorded,
        );
        expect(await read(s)).toEqual(before);
        await answer(
            await edit(
                s,
                [
                    { op: "setText", id: "a", text: "fresh" },
                    { op: "meta", set: { note: "fresh" } },
                ],
                loaded.chatRevision,
            ),
            200,
        );
        expect((await read(s)).data).toMatchObject({ note: "fresh", message: [m("a", "fresh"), m("b", "B", "char")] });
    });

    it("refuses save and load for every admitted job kind and for a message lock without a chat slot", async () => {
        let entered = deferred<RunningJob>();
        let release = deferred();
        const s = await server({
            generationRunner: async (job) => {
                entered.resolve(job);
                await release.promise;
            },
        });
        const bound: Record<string, string> = {};
        for (const [kind, field] of [
            ["presets", "presetId"],
            ["modelPresets", "modelPresetId"],
            ["personas", "personaId"],
        ]) {
            bound[field] = (await answer(await s.get(kind, "main"), 200)).data[0].id;
        }
        await answer(
            await edit(s, [
                {
                    op: "meta",
                    set: {
                        promptPresetId: bound.presetId,
                        modelPresetId: bound.modelPresetId,
                        bindedPersona: bound.personaId,
                    },
                },
            ]),
            200,
        );
        const checkpoint = await save(s);
        const lockedRef = { ...ref, chatId: "locked" };
        await answer(
            await s.json("/api/resources/batch", {
                chats: [{ ...lockedRef, baseRevision: null, ops: [{ op: "create", chat: initial }] }],
            }),
            200,
        );
        const lockedCheckpoint = (await answer(await s.json(`${path}/save`, { ...lockedRef, name: "Locked" }), 200))
            .checkpoint;
        for (const kind of [
            "send",
            "continue",
            "reroll",
            "group",
            "preview",
            "previewPrompt",
            "command",
        ] satisfies GenerationKind[]) {
            entered = deferred<RunningJob>();
            release = deferred();
            const revision = (await read(s)).revision;
            await answer(
                await s.json("/api/generations", {
                    kind,
                    clientId: "tab",
                    context: { ...ref, ...bound, chatRevision: revision, input: "", mode: "normal" },
                    ...(kind === "command" ? { command: { type: "button", data: "" } } : {}),
                }),
                200,
            );
            const job = await entered.promise;
            try {
                for (const operation of ["save", "load"]) {
                    const body =
                        operation === "save"
                            ? { ...ref, name: "Busy" }
                            : { ...ref, id: checkpoint.id, chatBaseRevision: revision };
                    expect(await answer(await s.json(`${path}/${operation}`, body), 409)).toEqual({
                        reason: "generating",
                    });
                }
                if (kind === "send") {
                    const locked = (
                        await answer(
                            await s.json("/api/resources/read", {
                                chats: [{ characterId: ref.characterId, id: "locked" }],
                            }),
                            200,
                        )
                    ).chats[0];
                    const written = job.write(() => ({
                        chats: [
                            {
                                ...lockedRef,
                                baseRevision: locked.revision,
                                ops: [{ op: "begin", id: "a", generationId: "lock" }],
                            },
                        ],
                    }));
                    expect(s.context.generationJobs.chatBusy(ref.characterId, "locked")).toBe(false);
                    for (const operation of ["save", "load"]) {
                        const body =
                            operation === "save"
                                ? { ...lockedRef, name: "Busy" }
                                : {
                                      ...lockedRef,
                                      id: lockedCheckpoint.id,
                                      chatBaseRevision: written.chats[0].revision,
                                  };
                        expect(await answer(await s.json(`${path}/${operation}`, body), 409)).toEqual({
                            reason: "generating",
                        });
                    }
                }
                expect(await list(s)).toEqual([checkpoint]);
                expect((await read(s)).revision).toBe(revision);
            } finally {
                release.resolve();
                await s.context.generationJobs.drain();
            }
        }
        await answer(await load(s, checkpoint.id), 200);
        await save(s, "Idle");
    });
});

describe("checkpoint load transactions", () => {
    it("commits the pre-load safety, restore floor, policy reset and pruning with one chat change and invalidation", () => {
        const t = storeFixture();
        const saved = t.checkpoint();
        t.write([{ op: "append", anchor: { end: true }, messages: [m("later")] }]);
        const older = [
            t.checkpoint("oldest", "safety"),
            t.checkpoint("middle", "safety"),
            t.checkpoint("newest", "safety"),
        ];
        t.store.checkpoints.writePolicy(ref.characterId, ref.chatId, { autoEvery: 4, autoKeep: 2, lastAutoTurns: 99 });
        const before = t.chat();
        const count = t.store.writeCount();
        t.events.length = 0;
        const result = t.service().load(t.request(saved.id));
        expect(result.status).toBe(200);
        if (result.status !== 200) throw new Error("load refused");
        const revision = result.body.chatRevision;
        expect(revision).not.toBe(before.revision);
        expect(t.store.checkpoints.compose(ref.characterId, ref.chatId, result.body.safety.id)).toEqual(before.data);
        expect(t.store.checkpoints.list(ref.characterId, ref.chatId)).toEqual(
            expect.arrayContaining([saved, older[1], older[2], result.body.safety]),
        );
        expect(t.store.checkpoints.list(ref.characterId, ref.chatId)).toHaveLength(4);
        expect(t.store.checkpoints.compose(ref.characterId, ref.chatId, older[0].id)).toBeNull();
        expect(t.store.checkpoints.readFloor(ref.characterId, ref.chatId)).toBe(Number(revision.split(":").at(-1)));
        expect(t.store.checkpoints.readPolicy(ref.characterId, ref.chatId)).toEqual({
            autoEvery: 4,
            autoKeep: 2,
            lastAutoTurns: 1,
        });
        expect(t.store.writeCount()).toBeGreaterThan(count + 1);
        expect(t.events).toEqual([
            {
                type: "change",
                epoch: t.store.epoch(),
                changes: {
                    resources: [],
                    chats: [{ characterId: ref.characterId, id: ref.chatId, revision }],
                    chatOrders: [],
                },
            },
        ]);
        expect(t.store.chatSourceGeneration(ref.characterId, ref.chatId)).toBe(before.sourceGeneration + 1);
        expect(t.notices).toEqual([
            {
                epoch: t.store.epoch(),
                characterId: ref.characterId,
                id: ref.chatId,
                sourceGeneration: before.sourceGeneration + 1,
            },
        ]);
    });

    it("rolls back stale loads and post-replace failures without changing safety history, the floor, policy, writes or notices", () => {
        const t = storeFixture();
        const saved = t.checkpoint();
        expect(t.service().load(t.request(saved.id)).status).toBe(200);
        t.checkpoint("second safety", "safety");
        t.checkpoint("third safety", "safety");
        t.store.checkpoints.writePolicy(ref.characterId, ref.chatId, { autoEvery: 4, autoKeep: 2, lastAutoTurns: 99 });
        const stale = t.request(saved.id);
        t.write([{ op: "setText", id: "a", text: "Keep this" }]);
        const state = () => ({
            chat: t.chat(),
            floor: t.store.checkpoints.readFloor(ref.characterId, ref.chatId),
            checkpoints: t.store.checkpoints.list(ref.characterId, ref.chatId),
            policy: t.store.checkpoints.readPolicy(ref.characterId, ref.chatId),
            writes: t.store.writeCount(),
        });
        const before = state();
        t.events.length = 0;
        t.notices.length = 0;
        expect(t.service().load(stale).status).toBe(409);
        expect(state()).toEqual(before);
        expect(() =>
            t
                .service(() => {
                    throw new Error("after load failed");
                })
                .load(t.request(saved.id)),
        ).toThrow("after load failed");
        expect(state()).toEqual(before);
        expect(t.events).toEqual([]);
        expect(t.notices).toEqual([]);
    });

    it("saves and loads messages at the append depth limit while preserving whole-array JSON semantics", async () => {
        const s = await server();
        let nested: unknown = "leaf";
        for (let i = 0; i < 255; i++) nested = { child: nested };
        const message = { ...m("deep"), extra: nested };
        await answer(await edit(s, [{ op: "append", anchor: { end: true }, messages: [message] }]), 200);
        const saved = await save(s);
        await answer(await edit(s, [{ op: "remove", ids: ["deep"] }]), 200);
        await answer(await load(s, saved.id), 200);
        expect((await read(s)).data.message).toEqual([...initial.message, message]);
        const tooDeep = { ...m("too-deep"), extra: { child: nested } };
        await answer(
            await edit(s, [
                {
                    op: "append",
                    anchor: { end: true },
                    messages: [tooDeep],
                },
            ]),
            400,
        );

        const t = storeFixture();
        const messages = Object.assign([m("discarded")], {
            toJSON(key: string) {
                expect(key).toBe("");
                return [
                    m("first"),
                    {
                        toJSON(elementKey: string) {
                            return m("keyed", elementKey);
                        },
                    },
                ];
            },
        });
        t.write([{ op: "replace", chat: { ...initial, message: messages } }]);
        expect(t.chat().data!.message).toEqual([m("first"), m("keyed", "1")]);
    });

    it("requires synchronous transaction callbacks and transaction-bound writes, counting them only after commit", () => {
        const t = storeFixture();
        const before = t.chat();
        const count = t.store.writeCount();
        const batch = () => ({
            chats: [group(t.revision(), [{ op: "replace", chat: { ...initial, note: "replaced" } }])],
        });
        for (const phase of ["before", "after"] as const) {
            expect(() =>
                t.store.applyChanges(batch(), {
                    inTransaction: {
                        before(tx) {
                            tx.save(ref.characterId, ref.chatId, "Safety", "safety");
                            if (phase === "before") return { then() {} };
                        },
                        after(_applied, tx) {
                            tx.setFloor(ref.characterId, ref.chatId);
                            if (phase === "after") return Promise.resolve();
                        },
                    },
                }),
            ).toThrow(/synchronous/);
            expect(t.chat()).toEqual(before);
            expect(t.store.checkpoints.list(ref.characterId, ref.chatId)).toEqual([]);
            expect(t.store.checkpoints.readFloor(ref.characterId, ref.chatId)).toBeNull();
            expect(t.store.writeCount()).toBe(count);
        }
        for (const write of [
            () => t.store.checkpoints.save(ref.characterId, ref.chatId, "Escaped", "safety"),
            () => t.write([{ op: "meta", set: { note: "escaped" } }]),
        ]) {
            expect(() =>
                t.store.applyChanges(batch(), {
                    inTransaction: {
                        before(tx) {
                            tx.save(ref.characterId, ref.chatId, "Safety", "safety");
                            write();
                        },
                    },
                }),
            ).toThrow();
            expect(t.chat()).toEqual(before);
            expect(t.store.checkpoints.list(ref.characterId, ref.chatId)).toEqual([]);
            expect(t.store.writeCount()).toBe(count);
        }
        t.store.applyChanges(batch(), {
            inTransaction: {
                before(tx) {
                    tx.save(ref.characterId, ref.chatId, "Safety", "safety");
                    expect(t.store.writeCount()).toBe(count);
                },
                after(_applied, tx) {
                    tx.setFloor(ref.characterId, ref.chatId);
                    expect(t.store.writeCount()).toBe(count);
                },
            },
        });
        expect(t.store.writeCount()).toBe(count + 3);
    });
});
