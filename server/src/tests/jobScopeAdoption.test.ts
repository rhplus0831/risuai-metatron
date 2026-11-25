// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatGroupResult, ChatOp } from "../../../shared/chats.ts";
import type { Message } from "../../../shared/database.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { createChangeFeed } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { createGenerationJobs, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import {
    chatMetadataFor,
    loadJobScope,
    refreshChat,
    refreshChatAfterWrite,
    scopeChat,
    type JobScope,
} from "../jobs/jobScope.ts";
import { applyOwnWrite } from "./ownWrite.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const message = (chatId: string, data = chatId, saying?: string): Message => ({
    chatId,
    role: "char",
    data,
    ...(saying ? { saying } : {}),
});

function setup() {
    // Install before the store prepares its statements; count execution, not preparation.
    const prepare = DatabaseSync.prototype.prepare;
    let wholeReads = 0;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        if (sql === "SELECT data FROM messages WHERE chatSeq = ? ORDER BY position") {
            const all = statement.all;
            statement.all = function (...args) {
                wholeReads++;
                return Reflect.apply(all, this, args);
            };
        }
        return statement;
    });
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const feed = createChangeFeed();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock, feed });
    cleanups.push(() => store.close());
    const first = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const bound = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    for (const id of ["c", "new-speaker", "changed-speaker"]) {
        store.put(
            kinds.get("characters")!,
            id,
            { chaId: id, type: "character", name: id, desc: `${id} description` },
            null,
        );
    }
    const write = (ops: ChatOp[], baseRevision = store.chatRevision("c", "k")) =>
        applyOwnWrite(store, {
            chats: [{ characterId: "c", chatId: "k", baseRevision, ops }],
        });
    write([
        {
            op: "create",
            chat: {
                id: "k",
                name: "Chat",
                note: "stored note",
                localLore: [],
                fmIndex: 7,
                scriptstate: { $old: "kept" },
                modelPresetId: bound.modelPresetId,
                promptPresetId: bound.presetId,
                bindedPersona: bound.personaId,
                message: [message("a"), message("b"), message("c")],
            },
        },
    ]);
    const context = {
        characterId: "c",
        chatId: "k",
        ...bound,
        mode: "normal",
        input: "",
        chatRevision: store.chatRevision("c", "k")!,
    };
    const load = () => loadJobScope(store, kinds, context);
    const job: RunningJob = {
        id: "job",
        kind: "send",
        command: null,
        context,
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
        emitRecords: () => [],
        onClientMessage: () => () => {},
        write: (build) => applyOwnWrite(store, build(), { epoch: store.epoch() }),
    };
    // Call only AFTER the read-count assertion: this oracle deliberately reads the transcript.
    const expectStored = (scope: JobScope, pending?: { note: string; scriptstate: Record<string, string> }) => {
        const fresh = store.readChatSource("c", "k");
        expect(fresh.data).not.toBeNull();
        const expected = pending
            ? { ...fresh.data, note: pending.note, scriptstate: { ...fresh.data!.scriptstate, ...pending.scriptstate } }
            : fresh.data;
        expect(scopeChat(scope)).toEqual(expected);
        expect(scope.chatRevision).toBe(fresh.revision);
        expect(scope.chatSourceGeneration).toBe(fresh.sourceGeneration);
    };
    return { store, kinds, lock, feed, context, load, write, job, expectStored, reads: () => wholeReads };
}

describe("job scope adoption", () => {
    it("adopts a text checkpoint without a whole read and preserves previous snapshots and untouched rows", () => {
        const h = setup();
        h.write([{ op: "begin", id: "b", generationId: "generation" }]);
        const scope = h.load();
        const previous = scopeChat(scope)!;
        const previousMessages = previous.message;
        const snapshot = structuredClone(previous);
        const sourceGeneration = scope.chatSourceGeneration;
        const before = h.reads();
        expect(refreshChat(h.store, scope)).toBe(true);
        const applied = h.write(
            [{ op: "setText", id: "b", text: "checkpoint", generation: { id: "generation", seq: 1 } }],
            scope.chatRevision,
        );
        expect(applied.chats[0].checkpoints).toEqual(["applied"]);
        expect(refreshChatAfterWrite(h.store, scope, applied.chats[0], applied.written?.chats[0])).toBe(true);
        expect(h.reads() - before).toBe(0);
        const current = scopeChat(scope)!;
        expect(current).not.toBe(previous);
        expect(current.message).not.toBe(previousMessages);
        expect(previous.message).toBe(previousMessages);
        expect(previous).toEqual(snapshot);
        expect(current.message[0]).toBe(previousMessages[0]);
        expect(current.message[2]).toBe(previousMessages[2]);
        expect(scope.chatSourceGeneration).toBe(sourceGeneration);
        h.expectStored(scope);
    });

    it("lays pending metadata over the stored metadata and rows of an adopted write", () => {
        vi.useFakeTimers({ toFake: ["queueMicrotask"] });
        const h = setup();
        const scope = h.load();
        const pending = { note: "pending note", scriptstate: { $own: "pending" } };
        chatMetadataFor(h.job, h.store, scope).queue(pending, (error) => error);
        const previous = scopeChat(scope)!;
        const snapshot = structuredClone(previous);
        const applied = h.write(
            [
                { op: "setText", id: "b", text: "stored text" },
                {
                    op: "meta",
                    set: { note: "written note", scriptstate: { $old: "updated", $own: "written", $external: "kept" } },
                    unset: ["fmIndex"],
                },
            ],
            scope.chatRevision,
        );
        const before = h.reads();
        expect(refreshChatAfterWrite(h.store, scope, applied.chats[0], applied.written?.chats[0])).toBe(true);
        expect(h.reads() - before).toBe(0);
        expect(previous).toEqual(snapshot);
        h.expectStored(scope, pending);
    });

    it.each<{ name: string; ops: ChatOp[] }>([
        {
            name: "an insertion at an anchor",
            ops: [{ op: "append", anchor: { after: "a" }, messages: [message("x", "inserted", "new-speaker")] }],
        },
        {
            name: "several inserted rows",
            ops: [
                { op: "append", anchor: { start: true }, messages: [message("x"), message("y")] },
                { op: "append", anchor: { after: "b" }, messages: [message("z")] },
            ],
        },
        {
            name: "a changed row anchored on a new row",
            ops: [
                { op: "patchMessage", id: "b", set: { data: "changed", saying: "changed-speaker" } },
                { op: "append", anchor: { after: "a" }, messages: [message("x", "inserted", "new-speaker")] },
            ],
        },
        {
            name: "an anchor removed in the same group",
            ops: [
                { op: "append", anchor: { after: "b" }, messages: [message("x")] },
                { op: "remove", ids: ["b"] },
            ],
        },
        {
            name: "repeated touches of one id",
            ops: [
                { op: "setText", id: "b", text: "intermediate" },
                { op: "append", anchor: { after: "a" }, messages: [message("x")] },
                { op: "patchMessage", id: "b", set: { data: "final", saying: "changed-speaker" } },
            ],
        },
    ])("adopts $name in stored order with its speakers", ({ ops }) => {
        const h = setup();
        const scope = h.load();
        const previous = scopeChat(scope)!;
        const snapshot = structuredClone(previous);
        expect(scope.db.characters.map((entry) => entry.chaId)).toEqual(["c"]);
        const applied = h.write(ops, scope.chatRevision);
        const before = h.reads();
        expect(refreshChatAfterWrite(h.store, scope, applied.chats[0], applied.written?.chats[0])).toBe(true);
        expect(h.reads() - before).toBe(0);
        expect(previous).toEqual(snapshot);
        h.expectStored(scope);
        // A fresh scope projects exactly the speakers named by the final stored rows.
        expect(scope.db.characters).toEqual(h.load().db.characters);
    });

    it.each(["stale group", "replace", "reappend", "scope not at base", "mismatched result revision"] as const)(
        "reads the whole chat after a %s and refreshes its source generation",
        (reason) => {
            const h = setup();
            const scope = h.load();
            const sourceGeneration = scope.chatSourceGeneration;
            const initialRevision = scope.chatRevision;
            let baseRevision = initialRevision;
            let resultOverride: ChatGroupResult | undefined;
            let ops: ChatOp[] = [{ op: "setText", id: "a", text: "own write" }];
            if (reason === "stale group" || reason === "scope not at base" || reason === "mismatched result revision") {
                const external = h.write([{ op: "setText", id: "c", text: "external write" }]);
                if (reason !== "scope not at base") expect(refreshChat(h.store, scope)).toBe(true);
                if (reason !== "stale group") baseRevision = h.store.chatRevision("c", "k")!;
                if (reason === "mismatched result revision") resultOverride = external.chats[0];
            } else if (reason === "replace") {
                ops = [
                    {
                        op: "replace",
                        chat: { ...scopeChat(scope)!, note: "replacement", message: [message("replacement")] },
                    },
                ];
            } else if (reason === "reappend") {
                ops = [
                    { op: "remove", ids: ["b"] },
                    { op: "append", anchor: { end: true }, messages: [message("b", "reappended")] },
                ];
            }
            const applied = h.write(ops, baseRevision);
            const result = resultOverride ?? applied.chats[0];
            const change = applied.written?.chats[0];
            if (reason === "replace" || reason === "reappend") expect(change).toBeUndefined();
            else {
                expect(change).toBeDefined();
                expect(applied.chats[0].stale).toBe(reason === "stale group" ? true : undefined);
                expect(scope.chatRevision === change!.baseRevision).toBe(reason !== "scope not at base");
                expect(result.revision === change!.revision).toBe(reason !== "mismatched result revision");
            }
            const before = h.reads();
            expect(refreshChatAfterWrite(h.store, scope, result, change)).toBe(true);
            expect(h.reads() - before).toBe(1);
            h.expectStored(scope);
            if (reason === "replace") expect(scope.chatSourceGeneration).not.toBe(sourceGeneration);
        },
    );

    it("reads the later chat written by a synchronous feed listener before the own write returns", () => {
        const h = setup();
        const scope = h.load();
        let returned = false;
        const listenerWrites: { beforeReturn: boolean; revision: string | null }[] = [];
        const unsubscribe = h.feed.subscribe((event) => {
            if (event.type !== "change") return;
            unsubscribe();
            const later = h.write([{ op: "setText", id: "c", text: "listener write" }]);
            listenerWrites.push({ beforeReturn: !returned, revision: later.chats[0].revision });
        });
        cleanups.push(unsubscribe);
        const applied = h.write([{ op: "setText", id: "a", text: "own write" }], scope.chatRevision);
        returned = true;
        const change = applied.written?.chats[0];
        expect(change).toBeDefined();
        expect(applied.chats[0].stale).toBeUndefined();
        expect(scope.chatRevision).toBe(change!.baseRevision);
        expect(applied.chats[0].revision).toBe(change!.revision);
        expect(listenerWrites).toEqual([{ beforeReturn: true, revision: h.store.chatRevision("c", "k") }]);
        expect(h.store.chatRevision("c", "k")).not.toBe(change!.revision);
        const before = h.reads();
        expect(refreshChatAfterWrite(h.store, scope, applied.chats[0], change)).toBe(true);
        expect(h.reads() - before).toBe(1);
        h.expectStored(scope);
    });

    it("returns the job chat's stored change from the real registry for adoption without whole reads", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        const h = setup();
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-scope-adoption-"));
        const snapshots = createSnapshotManager({ store: h.store, dir });
        let settle!: { resolve(): void; reject(error: unknown): void };
        const outcome = new Promise<void>((resolve, reject) => {
            settle = { resolve, reject };
        });
        const jobs = createGenerationJobs({
            store: h.store,
            kinds: h.kinds,
            gate: snapshots.gate,
            snapshots,
            lock: h.lock,
            authorize: async () => true,
            now: () => 0,
            runner: async (job) => {
                try {
                    const scope = loadJobScope(h.store, h.kinds, job.context);
                    const before = h.reads();
                    // The same pre-write refresh, capability, and after-write refresh as writeOwn.
                    expect(refreshChat(h.store, scope)).toBe(true);
                    const baseRevision = scope.chatRevision;
                    const applied = job.write(() => ({
                        chats: [
                            {
                                characterId: "c",
                                chatId: "k",
                                baseRevision,
                                ops: [
                                    { op: "begin", id: "b", generationId: "job-generation" },
                                    {
                                        op: "setText",
                                        id: "b",
                                        text: "job checkpoint",
                                        generation: { id: "job-generation", seq: 1 },
                                    },
                                ],
                            },
                        ],
                    }));
                    expect(applied.written?.chats[0]).toMatchObject({
                        baseRevision,
                        revision: applied.chats[0].revision,
                    });
                    expect(refreshChatAfterWrite(h.store, scope, applied.chats[0], applied.written?.chats[0])).toBe(
                        true,
                    );
                    expect(h.reads() - before).toBe(0);
                    h.expectStored(scope);
                    job.emit({ type: "done", revision: scope.chatRevision });
                    settle.resolve();
                } catch (error) {
                    settle.reject(error);
                }
            },
        });
        cleanups.push(async () => {
            await jobs.drain();
            jobs.dispose();
            await snapshots.stop();
            rmSync(dir, { recursive: true, force: true });
        });
        expect(jobs.create({ kind: "send", clientId: "tab", context: h.context }, h.store.epoch()).ok).toBe(true);
        await outcome;
        await jobs.drain();
    });
});
