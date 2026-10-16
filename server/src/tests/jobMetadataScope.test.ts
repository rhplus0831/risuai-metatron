// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { character } from "../../../shared/database.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { applyTriggerChat } from "../jobs/chatResult.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { loadJobScope, refreshCharacter, refreshChat, refreshChatAfterWrite, scopeChat } from "../jobs/jobScope.ts";
import { createJobRunState, createRunSetup } from "../jobs/runSetup.ts";
import { loadRequestDb } from "../llm/settings.ts";

// Operation counts, not timings: unchanged transcripts and character records must stay unread.
// Each assertion drives the same scope, bindings, or result boundary used by a running job.
const cleanups: (() => void)[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
    const prepare = DatabaseSync.prototype.prepare;
    let messageReads = 0;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        if (sql === "SELECT data FROM messages WHERE chatSeq = ? ORDER BY position") {
            const all = statement.all;
            statement.all = function (...args) {
                messageReads++;
                return Reflect.apply(all, this, args);
            };
        }
        return statement;
    });
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const characters = kinds.get("characters")!;
    const lock = createGenerationLock();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
    cleanups.push(() => store.close());
    const first = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const bound = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    for (const [id, name] of [
        ["c", "Owner"],
        ["s", "Speaker"],
    ]) {
        store.put(characters, id, { chaId: id, type: "character", name, desc: "before", firstMessage: "hello" }, null);
    }
    const write = (ops: ChatOp[], baseRevision = store.chatRevision("c", "k")) =>
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision, ops }],
        });
    write([
        {
            op: "create",
            chat: {
                id: "k",
                name: "K",
                note: "before",
                localLore: [],
                scriptstate: { $old: "kept" },
                modelPresetId: bound.modelPresetId,
                promptPresetId: bound.presetId,
                bindedPersona: bound.personaId,
                message: [{ role: "char", chatId: "m", data: "unchanged transcript", saying: "s" }],
            },
        },
    ]);
    const context = {
        characterId: "c",
        chatId: "k",
        ...bound,
        speakerChaId: "s",
        mode: "manual",
        input: "",
        chatRevision: store.chatRevision("c", "k")!,
    };
    const load = () => loadJobScope(store, kinds, context);
    const patchCharacter = (id: string, set: Record<string, unknown>) =>
        store.applyChanges({
            ops: [{ kind: characters, id, baseRevision: store.revisionOf(characters, id)!, patch: { set } }],
        });
    const job: RunningJob = {
        id: "job",
        kind: "command",
        context,
        command: { type: "manual", name: "go" },
        hooks: NO_GENERATION_HOOKS,
        epoch: store.epoch(),
        signal: new AbortController().signal,
        ownerAttached: () => false,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "aborted" }),
            callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
        },
        emit() {},
        emitRecords: vi.fn(() => []),
        onClientMessage: () => () => {},
        write: (build) => store.applyChanges(build(), { epoch: store.epoch() }),
    };
    const run = (scope = load()) =>
        createRunSetup(
            job,
            {
                store,
                kinds,
                lock,
                rootDir: "/nonexistent",
                savePath: "/nonexistent/save",
                tokens: { count: async (text: string) => text.length, encode: async () => [] } as never,
                scriptWorkers: {} as never,
                llm: {} as never,
                embeddings: {} as never,
                transformers: {} as never,
            },
            createJobRunState(job),
            scope,
            { runCharacterId: "s", engineCharacterId: "c" },
        );
    return {
        store,
        kinds,
        characters,
        context,
        write,
        load,
        patchCharacter,
        job,
        lock,
        run,
        reads: () => messageReads,
    };
}

describe("metadata job scope", () => {
    it("refreshes messages only after the stored chat revision changes", () => {
        const h = setup();
        const scope = h.load();
        const before = h.reads();
        for (let i = 0; i < 50; i++) expect(refreshChat(h.store, scope)).toBe(true);
        expect(h.reads() - before).toBe(0);
        h.write([{ op: "setText", id: "m", text: "another tab" }]);
        expect(refreshChat(h.store, scope)).toBe(true);
        expect(h.reads() - before).toBe(1);
        expect(scopeChat(scope)!.message[0].data).toBe("another tab");
        expect(scope.chatRevision).toBe(h.store.chatRevision("c", "k"));
        expect(refreshChat(h.store, scope)).toBe(true);
        expect(h.reads() - before).toBe(1);
        h.write([{ op: "delete" }]);
        expect(refreshChat(h.store, scope)).toBe(false);
        expect(scopeChat(scope)).toBeUndefined();
    });

    it("adopts stored metadata and its revision after an own write without reading or serializing messages", () => {
        const h = setup();
        const scope = h.load();
        const messages = scopeChat(scope)!.message;
        const serialize = vi.fn(() => {
            throw new Error("unchanged transcript serialized");
        });
        Object.defineProperty(messages, "toJSON", { value: serialize });
        const ops: ChatOp[] = [{ op: "meta", set: { note: "new", scriptstate: { $x: "1" } }, unset: ["fmIndex"] }];
        const before = h.reads();
        const result = h.write(ops, scope.chatRevision).chats[0];
        expect(refreshChatAfterWrite(h.store, scope, ops, result)).toBe(true);
        expect(h.reads() - before).toBe(0);
        expect(serialize).not.toHaveBeenCalled();
        expect(scopeChat(scope)).toMatchObject({ note: "new", scriptstate: { $x: "1" } });
        // Adopt the normalizer's stored default, not just the requested unset.
        expect(scopeChat(scope)!.fmIndex).toBe(-1);
        expect(scopeChat(scope)!.message).toBe(messages);
        expect(scope.chatRevision).toBe(h.store.chatRevision("c", "k"));
    });

    it.each(["stale base", "subsequent write"])(
        "reads the transcript after an own metadata write with a %s",
        (reason) => {
            const h = setup();
            const scope = h.load();
            const ops: ChatOp[] = [{ op: "meta", set: { note: "own" } }];
            const external = () => h.write([{ op: "setText", id: "m", text: "external message" }]);
            if (reason === "stale base") external();
            const result = h.write(ops, scope.chatRevision).chats[0];
            if (reason === "subsequent write") external();
            const before = h.reads();
            expect(refreshChatAfterWrite(h.store, scope, ops, result)).toBe(true);
            expect(h.reads() - before).toBe(1);
            expect(scopeChat(scope)).toMatchObject({ note: "own", message: [{ data: "external message" }] });
            expect(scope.chatRevision).toBe(h.store.chatRevision("c", "k"));
        },
    );

    it("reuses unchanged characters, reloads a changed character, and reports deletion", () => {
        const h = setup();
        const scope = h.load();
        const get = vi.spyOn(h.store, "get");
        const chats = scope.db.characters.find((c) => c.chaId === "c")!.chats;
        for (let i = 0; i < 50; i++) expect(refreshCharacter(h.store, h.kinds, scope, "c")).toBe(true);
        expect(get.mock.calls).toHaveLength(0);
        h.patchCharacter("c", { name: "Changed" });
        expect(refreshCharacter(h.store, h.kinds, scope, "c")).toBe(true);
        expect(get).toHaveBeenCalledTimes(1);
        expect(scope.db.characters.find((c) => c.chaId === "c")).toMatchObject({ name: "Changed", chats });
        h.store.delete(h.characters, "c", h.store.revisionOf(h.characters, "c")!);
        expect(refreshCharacter(h.store, h.kinds, scope, "c")).toBe(false);
        expect(scope.db.characters.some((c) => c.chaId === "c")).toBe(false);
        const calls = get.mock.calls.length;
        expect(refreshCharacter(h.store, h.kinds, scope, "c")).toBe(false);
        expect(get).toHaveBeenCalledTimes(calls);
    });

    it("does not repeatedly load an absent speaker on later chat refreshes", () => {
        const h = setup();
        const scope = h.load();
        const read = vi.spyOn(h.store, "readRefs");
        h.write([
            {
                op: "append",
                anchor: { end: true },
                messages: [{ role: "char", chatId: "late", saying: "gone", data: "hello" }],
            },
        ]);
        refreshChat(h.store, scope);
        h.write([{ op: "meta", set: { note: "later" } }]);
        refreshChat(h.store, scope);
        expect(
            read.mock.calls.flatMap(([refs]) =>
                refs.filter((ref) => ref.kind.name === "characters").map((ref) => ref.id),
            ),
        ).toEqual(["gone"]);
    });

    it("loads owner and speaker names once for a job, while requests without names still read them", () => {
        const h = setup();
        const read = vi.spyOn(h.store, "readRefs");
        const characterIds = () =>
            read.mock.calls.flatMap(([refs]) =>
                refs.filter((ref) => ref.kind.name === "characters").map((ref) => ref.id),
            );
        const scope = h.load();
        expect(scope.request).toMatchObject({ selectedCharacterName: "Owner", speakerName: "Speaker" });
        expect(characterIds()).toEqual(["c", "s"]);
        read.mockClear();
        const ids = { ...h.context, selectedPersonaId: h.context.personaId, selectedCharacterId: "c", speakerId: "s" };
        expect(loadRequestDb(h.store, h.kinds, ids, { selectedCharacterName: "", speakerName: null })).toMatchObject({
            selectedCharacterName: "",
            speakerName: null,
        });
        expect(characterIds()).toEqual([]);
        h.patchCharacter("s", { name: "New speaker" });
        expect(loadRequestDb(h.store, h.kinds, ids)).toMatchObject({
            selectedCharacterName: "Owner",
            speakerName: "New speaker",
        });
        expect(characterIds()).toEqual(["c", "s"]);
    });

    it("skips already stored trigger metadata but restores a changed key overwritten by another writer", () => {
        const h = setup();
        const scope = h.load();
        const baseline = { chat: structuredClone(scopeChat(scope)!), revision: scope.chatRevision };
        const result = { ...structuredClone(baseline.chat), scriptstate: { $x: "final" }, note: "trigger note" };
        h.write([{ op: "meta", set: { scriptstate: result.scriptstate, note: result.note } }]);
        const revision = h.store.chatRevision("c", "k");
        const writes = vi.spyOn(h.job, "write");
        applyTriggerChat({ ...h, scope }, baseline, result);
        expect(writes).not.toHaveBeenCalled();
        expect(h.store.chatRevision("c", "k")).toBe(revision);
        h.write([{ op: "meta", set: { note: "other writer" } }]);
        applyTriggerChat({ ...h, scope }, baseline, result);
        expect(writes).toHaveBeenCalledTimes(1);
        expect(h.store.chatMeta("c", "k")!.data).toMatchObject({ note: "trigger note", scriptstate: { $x: "final" } });
        expect(scope.chatRevision).toBe(h.store.chatRevision("c", "k"));
    });

    it("Lua setters land before the next task, preserve concurrent keys, and adopt metadata without message reads", async () => {
        const h = setup();
        const run = h.run();
        // A host call's write lands before the next macrotask (the next host call, another tab's request).
        const call = async (key: string, value: string) => {
            run.bindings.host.sync!.setChatVar(["id", key, value], run.nativeCtx);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        };
        const before = h.reads();
        await call("x", "first");
        expect(h.store.chatMeta("c", "k")!.data.scriptstate).toEqual({ $old: "kept", $x: "first" });
        expect(run.bindings.services.parse("{{getvar::x}}", null)).toBe("first");
        await call("y", "second");
        expect(h.reads() - before).toBe(0);
        h.write([
            { op: "meta", set: { scriptstate: { $old: "kept", $x: "first", $y: "second", $concurrent: "tab" } } },
        ]);
        await call("x", "third");
        expect(h.store.chatMeta("c", "k")!.data.scriptstate).toEqual({
            $old: "kept",
            $x: "third",
            $y: "second",
            $concurrent: "tab",
        });
        expect(run.bindings.services.parse("{{getvar::x}}/{{getvar::concurrent}}", null)).toBe("third/tab");
        expect(run.scope.chatRevision).toBe(h.store.chatRevision("c", "k"));
    });

    it("Lua run-character getters observe another tab's edit without reparsing unchanged records", () => {
        const h = setup();
        const run = h.run();
        const get = vi.spyOn(h.store, "get");
        const name = () => run.bindings.host.sync!.getName(["id"], run.nativeCtx);
        expect(name()).toBe("Speaker");
        expect(name()).toBe("Speaker");
        expect(get.mock.calls).toHaveLength(0);
        h.patchCharacter("s", { name: "Other tab" });
        expect(name()).toBe("Other tab");
        expect(get).toHaveBeenCalledTimes(1);
    });

    it("the command path reuses its stored character and sees a trigger another tab changed", async () => {
        const h = setup();
        const trigger = (value: string) => [
            {
                comment: "inner",
                type: "manual",
                conditions: [],
                effect: [{ type: "v2SetVar", indent: 0, var: "seen", operator: "=", valueType: "value", value }],
            },
        ];
        h.patchCharacter("c", { triggerscript: trigger("before") });
        const run = h.run();
        const outer = {
            ...run.scope.db.characters.find((c) => c.chaId === "c"),
            triggerscript: [
                {
                    comment: "outer",
                    type: "manual",
                    conditions: [],
                    effect: [{ type: "v2Command", indent: 0, valueType: "value", value: "/trigger inner" }],
                },
            ],
        } as character;
        const get = vi.spyOn(h.store, "get");
        const invoke = () =>
            run.runTrigger(outer, "manual", { manualName: "outer", chat: structuredClone(scopeChat(run.scope)!) });
        await invoke();
        expect(h.store.chatMeta("c", "k")!.data.scriptstate?.$seen).toBe("before");
        expect(get.mock.calls.filter(([kind]) => kind.name === "characters")).toHaveLength(0);
        h.patchCharacter("c", { triggerscript: trigger("after") });
        await invoke();
        expect(h.store.chatMeta("c", "k")!.data.scriptstate?.$seen).toBe("after");
    });
});
