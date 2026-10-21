// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { character } from "../../../shared/database.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import type { triggerEffect } from "../../../shared/triggers.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { GenerationJobEndedError, JobWriteConflictError, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import {
    bindChatMetadata,
    flushChatMetadata,
    loadJobScope,
    refreshChatAfterWrite,
    scopeChat,
} from "../jobs/jobScope.ts";
import { createJobRunState, createRunSetup } from "../jobs/runSetup.ts";
import { createCommandExecutor } from "../prompt/commands.ts";
import { createTriggerRuntime } from "../prompt/triggers.ts";

// Real storage and runtime boundaries; the fake job deliberately has no setPendingFlush hook.
const cleanups: (() => void)[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
    const counts = { transactions: 0, metadata: 0, messages: 0 };
    const prepare = DatabaseSync.prototype.prepare;
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        const field =
            sql === "SELECT data FROM messages WHERE chatSeq = ? ORDER BY position"
                ? "messages"
                : /^SELECT\b.*\bmeta\b.*\bFROM chats\b/i.test(sql)
                  ? "metadata"
                  : null;
        if (field) {
            for (const method of ["get", "all"] as const) {
                const original = statement[method];
                statement[method] = function (...args) {
                    counts[field]++;
                    return Reflect.apply(original, this, args);
                };
            }
        }
        return statement;
    });
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
        if (/^BEGIN\b/i.test(sql)) counts.transactions++;
        return exec.call(this, sql);
    });
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
    cleanups.push(() => store.close());
    const first = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const bound = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    store.put(kinds.get("characters")!, "c", { chaId: "c", type: "character", name: "Owner" }, null);
    const write = (ops: ChatOp[]) =>
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision: store.chatRevision("c", "k"), ops }],
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
                hypaV3Data: {
                    summaries: [{ text: "large unchanged metadata ".repeat(2000), chatMemos: [], isImportant: false }],
                },
                modelPresetId: bound.modelPresetId,
                promptPresetId: bound.presetId,
                bindedPersona: bound.personaId,
                message: [{ role: "char", chatId: "m", data: "unchanged transcript" }],
            },
        },
    ]);
    const abort = new AbortController();
    const context = {
        characterId: "c",
        chatId: "k",
        ...bound,
        mode: "manual",
        input: "",
        chatRevision: store.chatRevision("c", "k")!,
    };
    const job: RunningJob = {
        id: "job",
        kind: "command",
        context,
        command: { type: "manual", name: "go" },
        hooks: NO_GENERATION_HOOKS,
        epoch: store.epoch(),
        signal: abort.signal,
        ownerAttached: () => false,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "answered", value: "answer" }),
            callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
        },
        emit() {},
        emitRecords: vi.fn(() => []),
        onClientMessage: () => () => {},
        write: (build) => store.applyChanges(build(), { epoch: store.epoch() }),
    };
    const workers = { runLua: vi.fn(), regex: vi.fn() };
    const deps = {
        store,
        kinds,
        lock,
        rootDir: "/nonexistent",
        savePath: "/nonexistent/save",
        tokens: { count: async (text: string) => text.length, encode: async () => [] } as never,
        scriptWorkers: workers as never,
        llm: {} as never,
        embeddings: {} as never,
        transformers: {} as never,
    };
    const state = createJobRunState(job);
    const load = () => loadJobScope(store, kinds, context);
    const makeRun = (scope = load(), frozen = false) =>
        createRunSetup(job, deps, state, scope, { runCharacterId: "c", engineCharacterId: "c" }, { frozen });
    const run = makeRun();
    const services = run.bindings.services;
    const set = (key: string, value: string) => run.bindings.host.sync!.setChatVar(["id", key, value], run.nativeCtx);
    const get = (key: string) => run.bindings.host.sync!.getChatVar(["id", key], run.nativeCtx);
    const stored = () => store.chatMeta("c", "k")!;
    const resetCounts = () => Object.assign(counts, { transactions: 0, metadata: 0, messages: 0 });
    const char = (effect: triggerEffect[]) =>
        ({
            ...run.scope.db.characters[0],
            triggerscript: [{ comment: "go", type: "manual", conditions: [], effect }],
        }) as character;
    const runtime = (now: () => number) =>
        createTriggerRuntime({
            services,
            chatRef: { chaId: "c", chatId: "k" },
            ctx: run.nativeCtx,
            observeCharacterPatches: run.bindings.observeCharacterPatches,
            runLua: run.runLua,
            moduleTriggers: () => [],
            runCommand: async () => "",
            effects: state.effects,
            templateDefaultVariables: undefined,
            selectedPersonaPrompt: "",
            effectivePersonaId: null,
            now,
        });
    return {
        store,
        job,
        lock,
        abort,
        state,
        write,
        load,
        makeRun,
        run,
        services,
        set,
        get,
        stored,
        counts,
        resetCounts,
        char,
        runtime,
        workers,
    };
}

function revisionAfter(revision: string, writes: number) {
    const parts = revision.split(":");
    parts[2] = String(Number(parts[2]) + writes);
    return parts.join(":");
}
const setEffect = (key: string, value: string): triggerEffect => ({
    type: "v2SetVar",
    indent: 0,
    var: key,
    operator: "=",
    valueType: "value",
    value,
});
// Hold the automatic fallback only when testing a mandatory explicit flush boundary.
function holdMicrotasks() {
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation(() => {});
}

describe("chat metadata coalescing", () => {
    it("coalesces 1 and 50 synchronous host setters into one write and adoption with immediate reads", async () => {
        const h = setup();
        const adoption = vi.spyOn(h.store, "chatMeta");
        const samples = [];
        for (const n of [1, 50]) {
            const before = h.store.chatRevision("c", "k")!;
            const oldMap = scopeChat(h.run.scope)!.scriptstate;
            adoption.mockClear();
            vi.mocked(h.job.emitRecords).mockClear();
            h.resetCounts();
            for (let i = 0; i < n; i++) {
                h.set("x", `${n}/${i}`);
                h.services.writeChat(() => [{ op: "meta", set: { note: `note ${i}` } }]);
                expect(h.get("x")).toBe(`${n}/${i}`);
                expect(h.services.parse("{{getvar::x}}", null)).toBe(`${n}/${i}`);
            }
            expect(h.store.chatRevision("c", "k")).toBe(before);
            expect(oldMap).not.toHaveProperty("$x", `${n}/${n - 1}`);
            // Promise jobs must observe the commit too; a timer-based flush is too late.
            await Promise.resolve();
            expect(h.counts.transactions).toBe(1);
            expect(h.counts.messages).toBe(0);
            expect(adoption).toHaveBeenCalledTimes(1);
            expect(h.job.emitRecords).toHaveBeenCalledTimes(1);
            samples.push({ ...h.counts });
            expect(h.stored()).toMatchObject({
                revision: revisionAfter(before, 1),
                data: { note: `note ${n - 1}`, scriptstate: { $old: "kept", $x: `${n}/${n - 1}` } },
            });
            expect(h.run.scope.chatRevision).toBe(h.stored().revision);
        }
        expect(samples[1]).toEqual(samples[0]);
    });

    it("coalesces one CBS evaluation and separates awaited command segments", async () => {
        const h = setup();
        const before = h.stored().revision;
        h.resetCounts();
        expect(
            h.run.bindings.evaluator.risuChatParser("{{setvar::x::one}}{{setvar::y::{{getvar::x}}/two}}{{getvar::y}}", {
                runVar: true,
                chatRef: { chaId: "c", chatId: "k" },
            }),
        ).toBe("one/two");
        await Promise.resolve();
        expect(h.counts.transactions).toBe(1);
        const commands = createCommandExecutor({
            services: h.services,
            ctx: h.run.nativeCtx,
            character: () => h.run.scope.db.characters[0],
            runManualTrigger: async () => {},
            multisend() {},
        });
        expect(
            await commands.processMultiCommand(
                "/setvar key=x three | /getvar key=x | /setvar key=y {{pipe}}/four | /getvar key=y",
            ),
        ).toBe("three/four");
        expect(h.counts.transactions).toBe(3);
        expect(h.stored()).toMatchObject({
            revision: revisionAfter(before, 3),
            data: { scriptstate: { $old: "kept", $x: "three", $y: "three/four" } },
        });
    });

    it("merges only pending keys over concurrent stored state and overlays both refresh paths", () => {
        const h = setup();
        holdMicrotasks();
        h.set("own", "pending");
        h.services.writeChat(() => [{ op: "meta", set: { note: "pending note" } }]);
        h.write([{ op: "meta", set: { scriptstate: { $old: "changed by tab", $external: "tab" }, note: "tab note" } }]);
        h.services.refresh();
        expect(h.services.parse("{{getvar::own}}/{{getvar::external}}/{{getvar::old}}", null)).toBe(
            "pending/tab/changed by tab",
        );
        expect(h.services.liveChat().note).toBe("pending note");
        const ops: ChatOp[] = [{ op: "meta", set: { name: "other field" } }];
        const result = h.write(ops).chats[0];
        refreshChatAfterWrite(h.store, h.run.scope, ops, result);
        expect(h.services.liveChat()).toMatchObject({
            name: "other field",
            note: "pending note",
            scriptstate: { $own: "pending", $external: "tab" },
        });
        flushChatMetadata(h.job);
        expect(h.stored().data.scriptstate).toEqual({ $old: "changed by tab", $external: "tab", $own: "pending" });
        expect(h.stored().data.note).toBe("pending note");
    });

    it("writes pending variables as a scriptstate merge and the note as a set, never the whole map", () => {
        const h = setup();
        holdMicrotasks();
        const writes = vi.spyOn(h.job, "write");
        h.set("a", "1");
        h.set("b", "2");
        h.set("a", "3");
        h.services.writeChat(() => [{ op: "meta", set: { note: "pending note" } }]);
        // Another tab's variable lands before the flush: the merge never carries the refreshed map.
        h.write([{ op: "meta", merge: { scriptstate: { $tab: "tab" } } }]);
        flushChatMetadata(h.job);
        expect(writes).toHaveBeenCalledTimes(1);
        // The builder reads the scope's revision when it runs; rebuilt here, only its ops are pinned.
        expect(writes.mock.calls[0][0]()).toMatchObject({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    ops: [{ op: "meta", set: { note: "pending note" }, merge: { scriptstate: { $a: "3", $b: "2" } } }],
                },
            ],
        });
        expect(h.stored().data).toMatchObject({
            note: "pending note",
            scriptstate: { $old: "kept", $tab: "tab", $a: "3", $b: "2" },
        });
        expect(h.services.liveChat().scriptstate).toEqual({ $old: "kept", $tab: "tab", $a: "3", $b: "2" });
        // Variables alone: no `set` at all; a note alone: no `merge`.
        h.set("c", "4");
        flushChatMetadata(h.job);
        expect(writes.mock.calls[1][0]().chats![0].ops).toEqual([{ op: "meta", merge: { scriptstate: { $c: "4" } } }]);
        h.services.writeChat(() => [{ op: "meta", set: { note: "only" } }]);
        flushChatMetadata(h.job);
        expect(writes.mock.calls[2][0]().chats![0].ops).toEqual([{ op: "meta", set: { note: "only" } }]);
        expect(h.stored().data).toMatchObject({
            note: "only",
            scriptstate: { $old: "kept", $tab: "tab", $a: "3", $b: "2", $c: "4" },
        });
    });

    it.each([false, true])("flushes separately before another chat write (generating=%s)", (generating) => {
        const h = setup();
        holdMicrotasks();
        if (generating) {
            h.lock.addToken("other");
            h.lock.acquire(
                { characterId: "c", chatId: "k", messageId: "m" },
                { token: "other", jobId: "other", generationId: "g" },
            );
        }
        const before = h.stored().revision;
        const writes = vi.spyOn(h.job, "write");
        h.set("x", "accepted");
        h.services.writeChat(() => [{ op: "setText", id: "m", text: "new message" }]);
        expect(h.stored()).toMatchObject({
            revision: revisionAfter(before, generating ? 1 : 2),
            data: { scriptstate: { $x: "accepted" } },
        });
        expect(writes).toHaveBeenCalledTimes(generating ? 1 : 2);
        expect(h.store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data).toMatchObject({
            message: [{ data: generating ? "unchanged transcript" : "new message" }],
        });
    });

    it.each(["CBS limit", "abort"])(
        "stores accepted setters through a later %s and rejects later setters",
        (failure) => {
            const h = setup();
            holdMicrotasks();
            h.set("accepted", "yes");
            h.services.writeChat(() => [{ op: "meta", set: { note: "accepted note" } }]);
            if (failure === "CBS limit")
                expect(() => h.services.parse("{{range::[0,1e18]}}", null)).toThrow(/CBS limit/);
            else h.abort.abort();
            expect(() => h.set("late", "no")).toThrow();
            expect(() => flushChatMetadata(h.job)).not.toThrow();
            expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $accepted: "yes" });
            expect(h.stored().data.note).toBe("accepted note");
            expect(() => h.run.check()).toThrow();
        },
    );

    it.each(["conflict", "ended"])(
        "latches an asynchronous flush failure (%s) at the next fence and explicit flush",
        async (failure) => {
            const h = setup();
            const error =
                failure === "conflict"
                    ? new JobWriteConflictError([
                          { kind: "chat", characterId: "c", id: "k", revision: h.stored().revision },
                      ])
                    : new GenerationJobEndedError();
            const before = h.stored().revision;
            const peer = h.makeRun(h.run.scope);
            h.set("x", "pending");
            vi.spyOn(h.job, "write").mockImplementation(() => {
                throw error;
            });
            vi.spyOn(console, "error").mockImplementation(() => {});
            await Promise.resolve();
            expect(h.run.bindings.fatal()?.message).toBe(error.message);
            expect(() => h.run.check()).toThrow(h.run.bindings.fatal()!);
            expect(() => peer.check()).toThrow(h.run.bindings.fatal()!);
            expect(() => flushChatMetadata(h.job)).toThrow(h.run.bindings.fatal()!);
            expect(() => h.set("later", "no")).toThrow();
            expect(h.stored().revision).toBe(before);
            expect(h.stored().data.scriptstate).toEqual({ $old: "kept" });
        },
    );

    it("silently discards a batch when the chat was deleted", async () => {
        const h = setup();
        h.set("x", "pending");
        h.write([{ op: "delete" }]);
        const writes = vi.spyOn(h.job, "write");
        await Promise.resolve();
        expect(() => flushChatMetadata(h.job)).not.toThrow();
        expect(h.run.bindings.fatal()).toBeNull();
        expect(writes).not.toHaveBeenCalled();
        expect(h.store.chatRevision("c", "k")).toBeNull();
    });

    it("flushes before the trigger baseline and on successful or throwing trigger exit", async () => {
        const h = setup();
        holdMicrotasks();
        h.set("before", "baseline");
        const pending = h.run.runOnCopy(h.char([setEffect("inside", "{{getvar::before}}/effect")]), "manual", {
            manualName: "go",
        });
        try {
            expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $before: "baseline" });
        } finally {
            await pending;
        }
        expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $before: "baseline", $inside: "baseline/effect" });
        await expect(
            h.run.runOnCopy(
                h.char([setEffect("survives", "yes"), setEffect("fails", "{{range::[0,1e18]}}")]),
                "manual",
                { manualName: "go" },
            ),
        ).rejects.toThrow(/CBS limit/);
        expect(h.stored().data.scriptstate).toEqual({
            $old: "kept",
            $before: "baseline",
            $inside: "baseline/effect",
            $survives: "yes",
        });
    });

    it("flushes when Lua completes and when the live preset scope is replaced", async () => {
        const h = setup();
        holdMicrotasks();
        h.workers.runLua.mockImplementation(async () => {
            h.set("lua", "finished");
            return { res: "result", stopSending: false };
        });
        expect(await h.run.runLua("fixture", { mode: "manual", lowLevelAccess: false })).toMatchObject({
            res: "result",
        });
        expect(h.stored().data.scriptstate?.$lua).toBe("finished");
        const next = h.load();
        h.set("oldScope", "landed");
        bindChatMetadata(h.job, next);
        expect(h.stored().data.scriptstate?.$oldScope).toBe("landed");
        const nextRun = h.makeRun(next);
        nextRun.bindings.services.setChatVar("newScope", "landed");
        flushChatMetadata(h.job);
        expect(h.stored().data.scriptstate).toEqual({
            $old: "kept",
            $lua: "finished",
            $oldScope: "landed",
            $newScope: "landed",
        });
    });

    it("keeps a frozen display snapshot out of the live job batch", async () => {
        const h = setup();
        const frozen = h.makeRun(h.load(), true);
        const before = h.stored().revision;
        h.set("live", "yes");
        expect(
            frozen.bindings.evaluator.risuChatParser("{{setvar::display::only}}{{getvar::display}}", {
                runVar: true,
                chatRef: { chaId: "c", chatId: "k" },
            }),
        ).toBe("only");
        expect(frozen.bindings.services.parse("{{getvar::live}}", null)).toBe("null");
        await Promise.resolve();
        expect(h.stored()).toMatchObject({
            revision: revisionAfter(before, 1),
            data: { scriptstate: { $old: "kept", $live: "yes" } },
        });
        expect(h.stored().data.scriptstate).not.toHaveProperty("$display");
        expect(frozen.bindings.services.parse("{{getvar::display}}/{{getvar::live}}", null)).toBe("only/null");
    });

    it("keeps the trigger result's whole-map replay after a concurrent key arrives", async () => {
        const h = setup();
        const parse = h.services.parse;
        vi.spyOn(h.services, "parse").mockImplementation((text, ...args) => {
            if (text === "external-write") {
                flushChatMetadata(h.job);
                h.write([{ op: "meta", set: { scriptstate: { ...h.stored().data.scriptstate, $concurrent: "tab" } } }]);
                return "after";
            }
            return parse(text, ...args);
        });
        await h.run.runOnCopy(
            h.char([
                setEffect("x", "own"),
                { type: "v2SetAuthorNote", indent: 0, valueType: "value", value: "external-write" },
            ]),
            "manual",
            { manualName: "go" },
        );
        expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $x: "own" });
        expect(h.stored().data.note).toBe("after");
    });

    it("splits a native loop at its iteration yield", async () => {
        const h = setup();
        const before = h.stored().revision;
        h.resetCounts();
        const snapshots: string[] = [];
        vi.mocked(h.job.emitRecords).mockImplementation(() => {
            snapshots.push(String(h.stored().data.scriptstate!.$count));
            return [];
        });
        await h
            .runtime(() => 0)
            .runTrigger(
                h.char([
                    { type: "v2LoopNTimes", indent: 0, valueType: "value", value: "150" },
                    { type: "v2SetVar", indent: 1, var: "count", operator: "+=", valueType: "value", value: "1" },
                    { type: "v2EndIndent", indent: 1, endOfLoop: true },
                ]),
                "manual",
                { manualName: "go", chat: structuredClone(scopeChat(h.run.scope)!) },
            );
        // A 150-iteration loop crosses one iteration yield. Both batches must land;
        // do not pin the historical loop-counter off-by-one to the new coalescer.
        expect(snapshots).toHaveLength(2);
        expect(Number(snapshots[0])).toBeGreaterThanOrEqual(100);
        expect(Number(snapshots[0])).toBeLessThan(150);
        expect(snapshots[1]).toBe("150");
        expect(h.counts.transactions).toBe(2);
        expect(h.stored().revision).toBe(revisionAfter(before, 2));
    });

    it("splits native setter batches at the effect clock yield", async () => {
        const h = setup();
        let clock = 0;
        const parse = h.services.parse;
        vi.spyOn(h.services, "parse").mockImplementation((text, ...args) => {
            if (text === "slow") {
                clock = 51;
                return "first";
            }
            if (text === "after-yield") {
                expect(h.stored().data.scriptstate?.$x).toBe("first");
                return "second";
            }
            return parse(text, ...args);
        });
        h.resetCounts();
        await h
            .runtime(() => clock)
            .runTrigger(
                h.char([setEffect("x", "slow"), setEffect("x", "after-yield"), setEffect("y", "{{getvar::x}}")]),
                "manual",
                { manualName: "go", chat: structuredClone(scopeChat(h.run.scope)!) },
            );
        expect(h.counts.transactions).toBe(2);
        expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $x: "second", $y: "second" });
    });

    it("keeps an alert answer and the setters after it in one write when the event loop ran during the wait", async () => {
        const h = setup();
        let clock = 0;
        // The user takes 10 s: the event loop turns while the question waits, and the clock moves.
        vi.spyOn(h.services, "ask").mockImplementation(async () => {
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            clock = 10_000;
            return "go";
        });
        h.resetCounts();
        await h
            .runtime(() => clock)
            .runTrigger(
                h.char([
                    { type: "v2GetAlertInput", indent: 0, displayType: "value", display: "ready", outputVar: "ready" },
                    setEffect("x", "one"),
                    setEffect("y", "two"),
                ] as triggerEffect[]),
                "manual",
                { manualName: "go", chat: structuredClone(scopeChat(h.run.scope)!) },
            );
        expect(h.counts.transactions).toBe(1);
        expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $ready: "go", $x: "one", $y: "two" });
    });

    it("still yields after an answer that came back without the event loop running", async () => {
        const h = setup();
        let clock = 0;
        // An answer settled in microtasks (a refused or already settled question) never released the thread.
        vi.spyOn(h.services, "ask").mockImplementation(async () => {
            clock = 51;
            return "go";
        });
        h.resetCounts();
        await h
            .runtime(() => clock)
            .runTrigger(
                h.char([
                    { type: "v2GetAlertInput", indent: 0, displayType: "value", display: "ready", outputVar: "ready" },
                    setEffect("x", "one"),
                ] as triggerEffect[]),
                "manual",
                { manualName: "go", chat: structuredClone(scopeChat(h.run.scope)!) },
            );
        expect(h.counts.transactions).toBe(2);
        expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $ready: "go", $x: "one" });
    });

    it("still yields after a token count that held the thread past 50 ms without the event loop running", async () => {
        const h = setup();
        let clock = 0;
        // A cached count: no macrotask runs, yet its synchronous encode spends the stretch.
        vi.spyOn(h.services, "tokenize").mockImplementation(async () => {
            clock = 51;
            return 3;
        });
        h.resetCounts();
        await h
            .runtime(() => clock)
            .runTrigger(
                h.char([
                    setEffect("x", "one"),
                    { type: "v2Tokenize", indent: 0, valueType: "value", value: "text", outputVar: "n" },
                    setEffect("y", "two"),
                ] as triggerEffect[]),
                "manual",
                { manualName: "go", chat: structuredClone(scopeChat(h.run.scope)!) },
            );
        // `$x` flushes at the count's own await; the yield before `$y` then splits `$n` from it.
        expect(h.counts.transactions).toBe(3);
        expect(h.stored().data.scriptstate).toEqual({ $old: "kept", $x: "one", $n: "3", $y: "two" });
    });
});
