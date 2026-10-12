import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallbackName, CallbackResult, GenerationQuestion } from "../../../shared/jobs.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import type { RPCToolCallContent } from "../../../shared/llm/request.ts";
import { callGraphMemTool } from "../../../shared/mcp/graphmem.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, ResourceBatchConflictError, type ResourceStore } from "../data/resourceStore.ts";
import { createVectorCache, type VectorCache } from "../data/vectorCache.ts";
import { JobWriteConflictError, type RunningJob } from "../jobs/generationJobs.ts";
import { loadJobScope } from "../jobs/jobScope.ts";
import type { JobRequestSpec } from "../llm/requests.ts";
import { createLuaBindings, LuaJobFatalError } from "../lua/bindings.ts";
import { createJobToolState, MAX_JOB_TOOL_CALLS } from "../mcp/jobTools.ts";
import { createMcpRegistry } from "../mcp/registry.ts";
import { createEmbeddings, type EmbeddingEnv, type EmbeddingsService } from "../prompt/embeddings.ts";
import type { TransformersService } from "../prompt/transformers.ts";
import type { HostContext } from "../scripts/workerPool.ts";

// Phase 5 slice 12b: the internal MCPs a server job runs (`server/src/mcp/internal.ts`) through the
// real bindings and job tool set over a real store: RisuAccess reads (the store as it is now, the
// job's character for an empty id, another character's history through the tab's `selectedChat`),
// its consent and writes (captured revisions refused on a second conflict, never rebased; one batch
// for a module and its enabled state; resource events), `runLLM` as a nested request of the job (its
// tools, budget, and fatal latch; a nested `runLLM` refused as a tool result), and graph memory on
// the job's chat (its inherited read and fresh-chat behaviors pinned apart from its writes). The job's
// `write` mirrors `writeAsJob`'s conflict rule (`generationJobs.ts`): a resource-only conflict
// rebuilds once, a second one is `JobWriteConflictError`.

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;

const lore = (comment: string, content: string) => ({
    key: "a",
    comment,
    content,
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
});
const character = (chaId: string, name: string, extra: Record<string, unknown> = {}) => ({
    chaId,
    type: "character",
    name,
    firstMessage: "hello",
    desc: `${name} desc`,
    globalLore: [],
    ...extra,
});

type Handler = (
    spec: JobRequestSpec,
) => Promise<{ type: "success"; result: string } | { type: "fail"; result: string }>;

const dirs: string[] = [];
const caches: VectorCache[] = [];
const stores: ResourceStore[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const cache of caches.splice(0)) {
        cache.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A custom-model embedding service over a fake fetch (every text the same vector), recording what it embedded. */
function fakeEmbeddings() {
    const embedded: string[][] = [];
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-mcp-internal-"));
    dirs.push(dir);
    const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite") });
    caches.push(cache);
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
        embedded.push(input);
        return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
    }) as typeof fetch;
    const inner = createEmbeddings({ cache, transformers: {} as TransformersService, fetchImpl });
    const service: EmbeddingsService = {
        ...inner,
        forJob: (arg) =>
            inner.forJob({
                ...arg,
                db: {
                    hypaModel: "custom",
                    hypaCustomSettings: { url: "http://embed.test/v1/", key: "k", model: "emb" },
                } as EmbeddingEnv["db"],
            }),
    };
    return { service, embedded };
}

function setup(options: { attached?: boolean; embeddings?: EmbeddingsService } = {}) {
    const store = createResourceStore({ file: ":memory:", kinds });
    stores.push(store);
    const singleton = (name: string, data: unknown) => {
        const row = store.get(kind(name), SINGLETON_RESOURCE_ID);
        store.applyChanges({
            ops: [{ kind: kind(name), id: SINGLETON_RESOURCE_ID, baseRevision: row?.revision ?? null, data }],
        });
    };
    singleton(RESOURCE_KIND.presets, [{ id: "p", name: "p" }]);
    singleton(RESOURCE_KIND.modelPresets, [{ id: "m", name: "m", aiModel: "gpt-4o" }]);
    singleton(RESOURCE_KIND.personas, [{ id: "u", name: "Uma" }]);
    singleton(RESOURCE_KIND.modules, [
        { id: "m", name: "Module", description: "a module", lorebook: [lore("A", "original")] },
        { id: "ai", name: "AI", mcp: { url: "internal:aiaccess" } },
        { id: "gm", name: "GM", mcp: { url: "internal:graphmem" } },
    ]);
    singleton(RESOURCE_KIND.enabledModules, ["ai", "gm"]);
    // Stored order: the owner, the other character, then two of one name (`tz` first).
    const characters = [
        character("c", "Owner"),
        character("o", "Other", { globalLore: [lore("A", "original")] }),
        character("tz", "Twin"),
        character("ta", "Twin"),
    ];
    store.applyChanges({
        ops: characters.map((data) => ({
            kind: kind(RESOURCE_KIND.characters),
            id: data.chaId,
            baseRevision: null,
            data,
        })) as never,
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "k",
                            name: "K",
                            // The chat's binding (`docs/plan/chat-binding.md`): the job scope checks the context's ids against it.
                            modelPresetId: "m",
                            promptPresetId: "p",
                            bindedPersona: "u",
                            message: [
                                { role: "user", data: "hi", chatId: "m1" },
                                { role: "char", data: "owner reply", chatId: "m2" },
                            ],
                        },
                    },
                ],
            },
            {
                characterId: "o",
                chatId: "o1",
                baseRevision: null,
                ops: [
                    { op: "create", chat: { id: "o1", message: [{ role: "char", data: "first chat", chatId: "x1" }] } },
                ],
            },
            {
                characterId: "o",
                chatId: "o2",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "o2",
                            message: [
                                { role: "user", data: "second question", chatId: "y1" },
                                { role: "char", data: "second chat", chatId: "y2" },
                            ],
                        },
                    },
                ],
            },
        ],
    });
    const context = {
        characterId: "c",
        chatId: "k",
        presetId: "p",
        modelPresetId: "m",
        personaId: "u",
        mode: "button",
        input: "",
        chatRevision: store.chatRevision("c", "k")!,
    };
    const scope = loadJobScope(store, kinds, context);

    const log = {
        questions: [] as GenerationQuestion[],
        callbacks: [] as { name: CallbackName; payload: unknown; timeoutMs?: number }[],
        emitted: [] as { kind: string; id: string }[][],
        conflicts: 0,
        requests: [] as JobRequestSpec[],
    };
    const controller = new AbortController();
    const hooks = {
        /** Answers the consent question (the tab's `alertConfirm` result), or ends it. */
        ask: async (_question: GenerationQuestion): Promise<{ outcome: string; value?: unknown }> => ({
            outcome: "answered",
            value: true,
        }),
        /** Answers a callback (`selectedChat`). */
        callback: async (_name: CallbackName, _payload: unknown): Promise<CallbackResult> => ({
            outcome: "answered",
            value: { chatId: "o2" },
        }),
        /** Runs between a write's build and its apply, on every attempt (a concurrent writer). */
        beforeApply: null as ((attempt: number) => void) | null,
        /** The job's request (`llm.runInJob`). */
        request: (async () => ({ type: "success", result: "done" })) as Handler,
    };
    const job: RunningJob = {
        id: "job",
        kind: "command",
        context,
        command: { type: "button", data: "" },
        hooks: NO_GENERATION_HOOKS,
        channel: {
            notice() {},
            ask: async (question: GenerationQuestion) => {
                log.questions.push(question);
                return hooks.ask(question);
            },
            callback: async (name: CallbackName, payload: unknown, callbackOptions?: { timeoutMs?: number }) => {
                log.callbacks.push({ name, payload, timeoutMs: callbackOptions?.timeoutMs });
                return hooks.callback(name, payload);
            },
        } as unknown as RunningJob["channel"],
        ownerAttached: () => options.attached ?? true,
        epoch: store.epoch(),
        signal: controller.signal,
        emit() {},
        emitRecords: (records) => {
            log.emitted.push([...(records.refs ?? [])]);
            return [];
        },
        // `writeAsJob`'s conflict rule: a resource-only conflict rebuilds once, a second one is refused.
        write: (build) => {
            for (let attempt = 0; ; attempt++) {
                if (controller.signal.aborted) {
                    throw new Error("The job has ended");
                }
                const changes = build();
                hooks.beforeApply?.(attempt);
                try {
                    return store.applyChanges(changes as never, { epoch: store.epoch() });
                } catch (error) {
                    if (error instanceof ResourceBatchConflictError) {
                        log.conflicts++;
                        const resourceOnly = error.conflicts.every(
                            (conflict) =>
                                conflict.kind !== "chat" &&
                                conflict.kind !== "chatOrder" &&
                                !("reason" in conflict && conflict.reason),
                        );
                        if (resourceOnly && attempt === 0) {
                            continue;
                        }
                        throw new JobWriteConflictError(error.conflicts);
                    }
                    throw error;
                }
            }
        },
        onClientMessage: () => () => {},
    };
    const state = createJobToolState();
    const bindings = createLuaBindings({
        job,
        scope,
        store,
        kinds,
        rootDir: "/nonexistent",
        savePath: "/nonexistent/save",
        llm: {
            runInJob: async (spec: JobRequestSpec) => {
                log.requests.push(spec);
                return hooks.request(spec);
            },
        } as never,
        tokens: { count: async () => 1, encode: async () => [] } as never,
        runCharacterId: "c",
        engineCharacterId: "c",
        mcp: {
            registry: createMcpRegistry({
                store,
                kinds,
                fetchImpl: (async () => {
                    throw new Error("no network in this test");
                }) as typeof fetch,
            }),
            state,
        },
        ...(options.embeddings ? { embeddings: options.embeddings } : {}),
    });
    const ctx: HostContext = {
        identity: { characterId: "c", chatId: "k", presetId: "p", personaId: "u" },
        access: "lowLevel",
        signal: new AbortController().signal,
        regex: async () => ({ value: false }),
    };
    /** One request of the job whose model calls `name` once: the tool's content (a throw is the job's end). */
    const tool = async (name: string, args: unknown): Promise<RPCToolCallContent[]> => {
        let content: RPCToolCallContent[] | undefined;
        const previous = hooks.request;
        hooks.request = async (spec) => {
            hooks.request = previous;
            content = await spec.tools.call(name, args);
            return { type: "success", result: "done" };
        };
        try {
            await bindings.services.request(
                { formated: [{ role: "user", content: "go" }], bias: {} } as never,
                "model",
                ctx,
                "mcp",
            );
        } finally {
            hooks.request = previous;
        }
        return content!;
    };
    const text = (content: RPCToolCallContent[]) => content.map((entry) => (entry as { text?: string }).text).join("");
    const stored = (chaId: string) => store.get(kind(RESOURCE_KIND.characters), chaId)?.data as Record<string, any>;
    const storedModules = () => store.get(kind(RESOURCE_KIND.modules), SINGLETON_RESOURCE_ID)?.data as any[];
    const storedEnabled = () => store.get(kind(RESOURCE_KIND.enabledModules), SINGLETON_RESOURCE_ID)?.data as string[];
    const put = (name: string, id: string, data: unknown) =>
        store.put(kind(name), id, data, store.get(kind(name), id)?.revision ?? null);
    return {
        store,
        scope,
        bindings,
        state,
        hooks,
        log,
        controller,
        ctx,
        tool,
        text,
        stored,
        storedModules,
        storedEnabled,
        put,
    };
}

describe("internal:risuai on the server: reads", () => {
    it("is call-only when no module names it, reads the job's character for an empty id, the first stored match of a name, and the store's order", async () => {
        const s = setup();
        let offered: string[] = [];
        s.hooks.request = async (spec) => {
            offered = spec.tools.descriptors.map((descriptor) => descriptor.name);
            return { type: "success", result: "done" };
        };
        await s.bindings.services.request({ formated: [], bias: {} } as never, "model", s.ctx, "mcp");
        // The modules name aiaccess and graphmem: theirs are offered, RisuAccess's are not.
        expect(offered).toEqual(["runLLM", "writeMemory", "readMemory"]);

        expect(JSON.parse(s.text(await s.tool("risu-get-character-info", { id: "", fields: ["id", "name"] })))).toEqual(
            {
                id: "c",
                name: "Owner",
            },
        );
        // Two characters of one name: the first stored one, as the tab takes the first in its list.
        expect(JSON.parse(s.text(await s.tool("risu-get-character-info", { id: "Twin", fields: ["id"] })))).toEqual({
            id: "tz",
        });
        expect(JSON.parse(s.text(await s.tool("risu-list-characters", { count: 2, offset: 1 })))).toEqual([
            { id: "o", name: "Other", type: "character" },
            { id: "tz", name: "Twin", type: "character" },
        ]);
        // The store as it is now, not the job's frozen projection.
        s.put(RESOURCE_KIND.characters, "o", { ...s.stored("o"), name: "Renamed" });
        expect(JSON.parse(s.text(await s.tool("risu-get-character-info", { id: "o", fields: ["name"] })))).toEqual({
            name: "Renamed",
        });
        expect(s.text(await s.tool("risu-get-character-info", { id: "nobody" }))).toContain("nobody");
        expect(s.bindings.fatal()).toBeNull();
    });

    it("reads the job's chat for the job's character (empty id, id, or name) without asking the tab", async () => {
        const s = setup();
        const expected = JSON.stringify([
            { type: "text", text: "Owner: owner reply" },
            { type: "text", text: "User: hi" },
        ]);
        for (const id of ["", "c", "Owner"]) {
            expect(s.text(await s.tool("risu-get-chat-history", { id }))).toBe(expected);
        }
        expect(s.log.callbacks).toEqual([]);
    });

    it("reads another character's history from the chat the tab has selected, read from the store, and refuses a chat that is not that character's", async () => {
        const s = setup();
        expect(s.text(await s.tool("risu-get-chat-history", { id: "o" }))).toBe(
            JSON.stringify([
                { type: "text", text: "Other: second chat" },
                { type: "text", text: "User: second question" },
            ]),
        );
        expect(s.log.callbacks).toEqual([{ name: "selectedChat", payload: { characterId: "o" }, timeoutMs: 30_000 }]);
        // The owner's chat id named for another character: not that character's chat.
        for (const answer of [
            { outcome: "answered", value: { chatId: "k" } },
            { outcome: "answered", value: null },
            { outcome: "answered", value: { chatId: 7 } },
            { outcome: "failed", failure: "hook", error: "no such character in this tab" },
            { outcome: "refused", refusal: "unregistered", error: "none" },
        ] as CallbackResult[]) {
            s.hooks.callback = async () => answer;
            expect(s.text(await s.tool("risu-get-chat-history", { id: "o" }))).toBe(
                "Error: The character has no selected chat",
            );
        }
        expect(s.bindings.fatal()).toBeNull();
    });

    it("checks the character again after the tab answered: a group or a deleted one is refused, its history not read", async () => {
        const s = setup();
        s.hooks.callback = async () => {
            s.put(RESOURCE_KIND.characters, "o", { ...s.stored("o"), type: "group", characters: [] });
            return { outcome: "answered", value: { chatId: "o2" } };
        };
        expect(s.text(await s.tool("risu-get-chat-history", { id: "o" }))).toBe(
            "Error: The id pointed to a group chat, not a character.",
        );
        s.put(RESOURCE_KIND.characters, "o", { ...s.stored("o"), type: "character" });
        s.hooks.callback = async () => {
            s.store.delete(
                kind(RESOURCE_KIND.characters),
                "o",
                s.store.get(kind(RESOURCE_KIND.characters), "o")!.revision,
            );
            return { outcome: "answered", value: { chatId: "o2" } };
        };
        expect(s.text(await s.tool("risu-get-chat-history", { id: "o" }))).toBe(
            "Error: Character with ID o not found.",
        );
        expect(s.bindings.fatal()).toBeNull();
    });

    it("answers a tool error without asking when the owner's tab is not connected, and ends the job when the callback is lost after it was sent", async () => {
        vi.useFakeTimers();
        try {
            const away = setup({ attached: false });
            const pending = away.tool("risu-get-chat-history", { id: "o" });
            await vi.advanceTimersByTimeAsync(11_000);
            expect(away.text(await pending)).toBe(
                "Error: The chat history of another character needs the owner's tab, which is not connected",
            );
            expect(away.log.callbacks).toEqual([]);
            expect(away.bindings.fatal()).toBeNull();
        } finally {
            vi.useRealTimers();
        }

        for (const lost of [
            { outcome: "timedOut", error: "late" },
            { outcome: "disconnected", error: "gone" },
            { outcome: "failed", failure: "barrier", error: "discarded" },
        ] as CallbackResult[]) {
            const s = setup();
            s.hooks.callback = async () => lost;
            await expect(s.tool("risu-get-chat-history", { id: "o" })).rejects.toBeInstanceOf(LuaJobFatalError);
            expect(s.bindings.fatal()).toBeInstanceOf(LuaJobFatalError);
        }
    });
});

describe("internal:risuai on the server: consent and writes", () => {
    it("asks in English, writes the confirmed patch to the stored record, refreshes the job's copy, and sends the record to the tab", async () => {
        const s = setup();
        expect(s.text(await s.tool("risu-set-character-lorebook", { id: "o", name: "A", content: "edited" }))).toBe(
            'Successfully updated lorebook entry "A" for character Other',
        );
        expect(s.log.questions).toEqual([
            {
                kind: "alertConfirm",
                payload: {
                    message:
                        'risu-set-character-lorebook is trying to "add/modify character (Other) global lorebook (A)". Do you want to allow this?',
                },
            },
        ]);
        expect(s.stored("o").globalLore).toEqual([lore("A", "edited")]);
        expect(s.log.emitted).toEqual([[{ kind: RESOURCE_KIND.characters, id: "o" }]]);

        // The job's own character: its copy in the job is read again after the write.
        expect(s.text(await s.tool("risu-set-character-info", { id: "", data: { description: "new desc" } }))).toBe(
            "Successfully updated character Owner",
        );
        expect(s.stored("c").desc).toBe("new desc");
        expect((s.scope.db.characters.find((entry) => entry?.chaId === "c") as { desc?: string }).desc).toBe(
            "new desc",
        );
        expect(s.bindings.fatal()).toBeNull();
    });

    it("changes nothing when the user denies, and answers what the record is after the prompt: deleted, now a group, or replaced", async () => {
        const s = setup();
        s.hooks.ask = async () => ({ outcome: "answered", value: false });
        expect(s.text(await s.tool("risu-set-character-info", { id: "o", data: { description: "x" } }))).toBe(
            "Access denied by user.",
        );
        expect(s.stored("o").desc).toBe("Other desc");
        expect(s.log.emitted).toEqual([]);

        // Deleted while the prompt was open.
        s.hooks.ask = async () => {
            s.store.delete(
                kind(RESOURCE_KIND.characters),
                "o",
                s.store.get(kind(RESOURCE_KIND.characters), "o")!.revision,
            );
            return { outcome: "answered", value: true };
        };
        expect(s.text(await s.tool("risu-set-character-info", { id: "o", data: { description: "x" } }))).toContain(
            "not found",
        );
        // Converted into a group while the prompt was open.
        s.hooks.ask = async () => {
            s.put(RESOURCE_KIND.characters, "tz", { ...s.stored("tz"), type: "group", characters: [] });
            return { outcome: "answered", value: true };
        };
        expect(s.text(await s.tool("risu-set-character-info", { id: "tz", data: { description: "x" } }))).toBe(
            "Error: The id pointed to a group chat, not a character.",
        );
        expect(s.stored("tz").desc).toBe("Twin desc");
        // Replaced while the prompt was open: the patch is built from the record as it is now.
        s.hooks.ask = async () => {
            s.put(RESOURCE_KIND.characters, "ta", {
                ...s.stored("ta"),
                globalLore: [lore("A", "original"), lore("B", "added meanwhile")],
            });
            return { outcome: "answered", value: true };
        };
        expect(s.text(await s.tool("risu-set-character-lorebook", { id: "ta", name: "A", content: "edited" }))).toBe(
            'Successfully updated lorebook entry "A" for character Twin',
        );
        expect(s.stored("ta").globalLore).toEqual([lore("A", "edited"), lore("B", "added meanwhile")]);
        expect(s.log.emitted).toEqual([[{ kind: RESOURCE_KIND.characters, id: "ta" }]]);
        expect(s.bindings.fatal()).toBeNull();
    });

    it("refuses a record changed between the read and the write on both attempts, never rebasing an older array", async () => {
        const s = setup();
        s.hooks.beforeApply = (attempt) => {
            if (attempt === 0) {
                const current = s.stored("o");
                s.put(RESOURCE_KIND.characters, "o", {
                    ...current,
                    globalLore: [...current.globalLore, lore("concurrent", "keep me")],
                });
            }
        };
        expect(s.text(await s.tool("risu-set-character-lorebook", { id: "o", name: "A", content: "edited" }))).toBe(
            "Error: The record changed while it was being written; nothing was changed",
        );
        // The first conflict rebuilt, the second (the same captured revision) is the refusal.
        expect(s.log.conflicts).toBe(2);
        expect(s.stored("o").globalLore).toEqual([lore("A", "original"), lore("concurrent", "keep me")]);

        // A module, the same.
        s.log.conflicts = 0;
        s.hooks.beforeApply = (attempt) => {
            if (attempt === 0) {
                const [module, ...rest] = s.storedModules();
                s.put(RESOURCE_KIND.modules, SINGLETON_RESOURCE_ID, [
                    { ...module, lorebook: [...module.lorebook, lore("concurrent", "keep me")] },
                    ...rest,
                ]);
            }
        };
        expect(s.text(await s.tool("risu-set-module-lorebook", { id: "m", name: "A", content: "edited" }))).toBe(
            "Error: The record changed while it was being written; nothing was changed",
        );
        expect(s.log.conflicts).toBe(2);
        expect(s.storedModules()[0].lorebook).toEqual([lore("A", "original"), lore("concurrent", "keep me")]);
        expect(s.log.emitted).toEqual([]);
        expect(s.bindings.fatal()).toBeNull();
    });

    it("writes a module's fields and its enabled state in one batch, emitting both, and refuses both when the enabled list changed", async () => {
        const s = setup();
        expect(
            s.text(await s.tool("risu-set-module-info", { id: "m", data: { name: "Renamed", enabled: true } })),
        ).toBe("Successfully updated module Renamed");
        expect(s.storedModules()[0].name).toBe("Renamed");
        expect(s.storedEnabled()).toEqual(["ai", "gm", "m"]);
        expect(s.log.emitted).toEqual([
            [
                { kind: RESOURCE_KIND.modules, id: SINGLETON_RESOURCE_ID },
                { kind: RESOURCE_KIND.enabledModules, id: SINGLETON_RESOURCE_ID },
            ],
        ]);

        // A concurrent change of the enabled list only: the module's new name does not land either.
        s.hooks.beforeApply = (attempt) => {
            if (attempt === 0) {
                s.put(RESOURCE_KIND.enabledModules, SINGLETON_RESOURCE_ID, ["concurrent"]);
            }
        };
        expect(
            s.text(await s.tool("risu-set-module-info", { id: "m", data: { name: "Not applied", enabled: false } })),
        ).toBe("Error: The record changed while it was being written; nothing was changed");
        expect(s.storedModules()[0].name).toBe("Renamed");
        expect(s.storedEnabled()).toEqual(["concurrent"]);
        expect(s.log.emitted).toHaveLength(1);

        // A wrongly typed field is refused before anything is written (the tool's own check).
        s.hooks.beforeApply = null;
        expect(s.text(await s.tool("risu-set-module-info", { id: "m", data: { name: 3, enabled: true } }))).toBe(
            "Error: Field name must be a string.",
        );
        expect(s.storedEnabled()).toEqual(["concurrent"]);
        // An MCP module is not writable.
        expect(s.text(await s.tool("risu-set-module-info", { id: "ai", data: { name: "x" } }))).toContain("not found");
        expect(s.bindings.fatal()).toBeNull();
    });

    it("ends the job when the consent question is lost or the job ends while it is open, writing nothing", async () => {
        for (const outcome of ["timedOut", "disconnected", "aborted"]) {
            const s = setup();
            s.hooks.ask = async () => ({ outcome });
            await expect(
                s.tool("risu-set-character-info", { id: "o", data: { description: "x" } }),
            ).rejects.toBeInstanceOf(LuaJobFatalError);
            expect(s.bindings.fatal()?.message).toContain(outcome);
            expect(s.stored("o").desc).toBe("Other desc");
            expect(s.log.emitted).toEqual([]);
        }
        // The job is cancelled while the prompt is open: the user's later yes writes nothing.
        const s = setup();
        s.hooks.ask = async () => {
            s.controller.abort();
            return { outcome: "answered", value: true };
        };
        await expect(s.tool("risu-set-character-info", { id: "o", data: { description: "x" } })).rejects.toBeInstanceOf(
            LuaJobFatalError,
        );
        expect(s.stored("o").desc).toBe("Other desc");
        expect(s.log.emitted).toEqual([]);
    });
});

describe("internal:aiaccess on the server", () => {
    it("runs runLLM as a request of the job (the lite model as otherAx) that offers the job's tools again and shares its budget; a nested runLLM is a tool result", async () => {
        const s = setup();
        const seen: { mode: string; formated: unknown; offered: string[]; nested?: string }[] = [];
        s.hooks.request = async (spec) => {
            seen.push({
                mode: spec.mode,
                formated: spec.arg.formated,
                offered: spec.tools.descriptors.map((descriptor) => descriptor.name),
            });
            // The nested request's model asks for runLLM again.
            expect(spec.tools.charge()).toBe(true);
            const nested = await spec.tools.call("runLLM", { model: "normal", messages: [] });
            seen[seen.length - 1].nested = s.text(nested);
            return { type: "success", result: "inner answer" };
        };
        const answer = await s.tool("runLLM", {
            model: "lite",
            messages: [{ role: "user", content: "summarize", extra: "dropped" }],
        });
        expect(JSON.parse(s.text(answer))).toEqual({ success: true, message: "inner answer" });
        expect(seen).toEqual([
            {
                mode: "otherAx",
                formated: [{ role: "user", content: "summarize" }],
                offered: ["runLLM", "writeMemory", "readMemory"],
                nested: "Tool call failed with error: runLLM cannot be called while another runLLM call of the job is running",
            },
        ]);
        // The nested request charged the job's budget; the counter is free again.
        expect(s.state.attempts).toBe(1);
        expect(s.state.llm.active).toBe(0);

        // A failed nested request is the tool's answer; a request that throws frees the counter too.
        s.hooks.request = async () => ({ type: "fail", result: "provider said no" });
        expect(JSON.parse(s.text(await s.tool("runLLM", { model: "normal", messages: [] })))).toEqual({
            success: false,
            message: "provider said no",
        });
        s.hooks.request = async () => {
            throw new Error("broken adapter");
        };
        expect(s.text(await s.tool("runLLM", { model: "normal", messages: [] }))).toBe(
            "Tool call failed with error: broken adapter",
        );
        expect(s.state.llm.active).toBe(0);
        expect(s.text(await s.tool("runLLM", { model: "normal" }))).toBe(
            "Invalid arguments for runLLM. Please provide a valid model and messages.",
        );
        expect(s.bindings.fatal()).toBeNull();
    });

    it("keeps the job's signal and fatal latch in the nested request: a job failure inside it ends the outer call too", async () => {
        const s = setup();
        let nestedSignal: AbortSignal | undefined;
        s.hooks.request = async (spec) => {
            nestedSignal = spec.signal;
            // The nested request spent the budget (`runInJob` ends the job through `endJob`).
            spec.endJob(`The job reached its tool call limit (${MAX_JOB_TOOL_CALLS})`);
            throw new Error("ended");
        };
        await expect(s.tool("runLLM", { model: "normal", messages: [] })).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(s.bindings.fatal()?.message).toBe(`The job reached its tool call limit (${MAX_JOB_TOOL_CALLS})`);
        expect(s.state.llm.active).toBe(0);
        // The nested request's signal is the job's: the job's end aborts it.
        expect(nestedSignal?.aborted).toBe(false);
        s.controller.abort();
        expect(nestedSignal?.aborted).toBe(true);
    });
});

describe("internal:graphmem on the server", () => {
    it("writes the graph into the job chat's variable; a chat that never held it starts with an empty graph", async () => {
        const s = setup();
        const jobChatGraph = () => {
            const chat = s.store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data as {
                scriptstate?: Record<string, unknown>;
            };
            return JSON.parse(String(chat.scriptstate?.["$graphmem_graph"]));
        };
        // An unset chat variable reads as the text "null" (Stop D fix D1): the write starts a graph of one entry.
        expect(s.text(await s.tool("writeMemory", { name: "n1", summary: "s1" }))).toBe(
            'Memory entry "n1" written successfully.',
        );
        expect(s.bindings.fatal()).toBeNull();
        expect(jobChatGraph()).toEqual([{ name: "n1", summary: "s1", connections: [] }]);

        // A graph set to an empty array is used as it is.
        s.bindings.services.setChatVar("graphmem_graph", "[]", s.ctx);
        expect(s.text(await s.tool("writeMemory", { name: "n1", summary: "s1", connections: ["n2"] }))).toBe(
            'Memory entry "n1" written successfully.',
        );
        expect(jobChatGraph()).toEqual([{ name: "n1", summary: "s1", connections: ["n2"] }]);
        // Only the job's chat holds it.
        const other = s.store.readRefs([], { chats: [{ characterId: "o", id: "o2" }] }).chats[0].data as {
            scriptstate?: Record<string, unknown>;
        };
        expect(other.scriptstate?.["$graphmem_graph"]).toBeUndefined();
    });

    it("reads with the job's embeddings and finds the stored entry; no embeddings is a tool error", async () => {
        const embeddings = fakeEmbeddings();
        const s = setup({ embeddings: embeddings.service });
        s.bindings.services.setChatVar(
            "graphmem_graph",
            JSON.stringify([{ name: "n1", summary: "s1", connections: [] }]),
            s.ctx,
        );
        const read = s.text(await s.tool("readMemory", { query: ["n1"], search_depth: 1e12 }));
        expect(JSON.parse(read)).toEqual([
            { queryTerm: "n1", entries: [{ name: "n1", summary: "s1", connections: [] }] },
        ]);
        // On a cold cache the entry names were embedded as documents (and stored for the search), and the query once.
        expect(embeddings.embedded).toEqual([["n1"], ["n1"]]);

        const without = setup();
        without.bindings.services.setChatVar(
            "graphmem_graph",
            JSON.stringify([{ name: "n1", summary: "s1" }]),
            without.ctx,
        );
        expect(without.text(await without.tool("readMemory", { query: ["n1"] }))).toBe(
            "Error: The embeddings service is not available",
        );
        expect(without.bindings.fatal()).toBeNull();
    });

    it("ends the job, not the tool, when the job ends during the embedding call", async () => {
        const env = fakeEmbeddings();
        let onEmbed = () => {};
        const service: EmbeddingsService = {
            ...env.service,
            forJob: (arg) => {
                const inner = env.service.forJob(arg);
                return {
                    ...inner,
                    fetchImpl: (async (...request: Parameters<typeof fetch>) => {
                        onEmbed();
                        return inner.fetchImpl(...request);
                    }) as typeof fetch,
                };
            },
        };
        const s = setup({ embeddings: service });
        s.bindings.services.setChatVar("graphmem_graph", JSON.stringify([{ name: "n1", summary: "s1" }]), s.ctx);
        onEmbed = () => s.controller.abort();
        await expect(s.tool("readMemory", { query: ["n1"] })).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(s.bindings.fatal()).toBeInstanceOf(LuaJobFatalError);
    });

    it("writes then reads on a fresh chat; a later read's new processor takes the names' vectors from the cache and embeds only its query (Stop D fixes)", async () => {
        const embeddings = fakeEmbeddings();
        const s = setup({ embeddings: embeddings.service });
        expect(s.text(await s.tool("writeMemory", { name: "Alice", summary: "likes tea", connections: ["Bob"] }))).toBe(
            'Memory entry "Alice" written successfully.',
        );
        expect(s.text(await s.tool("writeMemory", { name: "Bob", summary: "likes coffee" }))).toBe(
            'Memory entry "Bob" written successfully.',
        );
        const entries = [
            { name: "Alice", summary: "likes tea", connections: ["Bob"] },
            { name: "Bob", summary: "likes coffee", connections: [] },
        ];
        const cold = JSON.parse(s.text(await s.tool("readMemory", { query: ["who"] })));
        expect(cold).toEqual([{ queryTerm: "who", entries }]);
        // The names as documents once, then the query; the connection `Bob` is searched at depth 2.
        expect(embeddings.embedded).toEqual([["Alice", "Bob"], ["who"], ["Bob"]]);

        embeddings.embedded.length = 0;
        const warm = JSON.parse(s.text(await s.tool("readMemory", { query: ["tea"], search_depth: 1 })));
        expect(warm).toEqual([{ queryTerm: "tea", entries }]);
        expect(embeddings.embedded).toEqual([["tea"]]);
        expect(s.bindings.fatal()).toBeNull();
    });

    it("ends the job, not the tool, when the job ends during the query's embedding after the names came from the cache", async () => {
        const env = fakeEmbeddings();
        let onEmbed = (_input: string[]) => {};
        const service: EmbeddingsService = {
            ...env.service,
            forJob: (arg) => {
                const inner = env.service.forJob(arg);
                return {
                    ...inner,
                    fetchImpl: (async (...request: Parameters<typeof fetch>) => {
                        onEmbed(JSON.parse(String(request[1]?.body)).input);
                        return inner.fetchImpl(...request);
                    }) as typeof fetch,
                };
            },
        };
        const s = setup({ embeddings: service });
        s.bindings.services.setChatVar("graphmem_graph", JSON.stringify([{ name: "n1", summary: "s1" }]), s.ctx);
        // Warm the cache with the names.
        await s.tool("readMemory", { query: ["first"], search_depth: 1 });
        env.embedded.length = 0;
        const seen: unknown[] = [];
        onEmbed = (input) => {
            seen.push(input);
            s.controller.abort();
        };
        await expect(s.tool("readMemory", { query: ["second"] })).rejects.toBeInstanceOf(LuaJobFatalError);
        // The only embedding asked for was the query's: the names were not embedded again.
        expect(seen).toEqual(["second"]);
        expect(s.bindings.fatal()).toBeInstanceOf(LuaJobFatalError);
    });
});

describe("graph memory's write (shared/mcp/graphmem.ts, Stop D fixes)", () => {
    function host(stored: string) {
        const vars: Record<string, string> = { graphmem_graph: stored };
        return {
            vars,
            host: {
                getVar: (key: string) => vars[key] ?? "null",
                setVar: (key: string, value: string) => {
                    vars[key] = value;
                },
                search: async () => async () => [],
            },
        };
    }
    const entry = { name: "n", summary: "s", connections: [] };

    it("starts an empty graph when the variable is unset (the text null), malformed, or not an array", async () => {
        for (const stored of ["null", "", "{not json", '{"0":{"name":"x"}}', "42", '"text"', "true"]) {
            const h = host(stored);
            expect(await callGraphMemTool(h.host, "writeMemory", { name: "n", summary: "s" })).toEqual([
                { type: "text", text: 'Memory entry "n" written successfully.' },
            ]);
            expect(JSON.parse(h.vars.graphmem_graph)).toEqual([entry]);
        }
    });

    it("appends to a stored array, keeping its entries, and reads nothing from a graph that is not an array", async () => {
        const first = { name: "a", summary: "x", connections: ["n"] };
        const h = host(JSON.stringify([first]));
        await callGraphMemTool(h.host, "writeMemory", { name: "n", summary: "s" });
        expect(JSON.parse(h.vars.graphmem_graph)).toEqual([first, entry]);

        for (const stored of ["null", '{"name":"a"}']) {
            expect(await callGraphMemTool(host(stored).host, "readMemory", { query: ["q"] })).toEqual([
                { type: "text", text: "No memory entries found in the graph database." },
            ]);
        }
    });
});

describe("graph memory's read loop (shared/mcp/graphmem.ts)", () => {
    const graph = (entries: { name: string; connections: string[] }[]) =>
        JSON.stringify(entries.map((entry) => ({ ...entry, summary: "" })));
    /** A depth whose comparisons are counted: one per depth level the loop checks (the levels it enters and the one that ends it). */
    function countedDepth(depth: number) {
        const counter = {
            reads: 0,
            valueOf() {
                counter.reads++;
                if (counter.reads > 10_000) {
                    throw new Error("the depth loop does not stop");
                }
                return depth;
            },
        };
        return counter;
    }

    it("stops when its frontier is empty whatever search_depth is, with the same result", async () => {
        const searched: string[] = [];
        const host = (stored: string, answers: Record<string, string[]>) => ({
            getVar: () => stored,
            setVar: () => {},
            search: async () => async (term: string) => {
                searched.push(term);
                return answers[term] ?? [];
            },
        });
        // Nothing found: one level searched, the next comparison ends the loop.
        const empty = countedDepth(1e12);
        const none = await callGraphMemTool(host(graph([{ name: "a", connections: [] }]), {}), "readMemory", {
            query: ["q"],
            search_depth: empty,
        });
        expect(JSON.parse((none[0] as { text: string }).text)).toEqual([{ queryTerm: "q", entries: [] }]);
        expect(empty.reads).toBe(2);
        expect(searched).toEqual(["q"]);

        // A chain a -> b -> c: three productive levels and one that searches nothing new.
        searched.length = 0;
        const chain = graph([
            { name: "a", connections: ["b"] },
            { name: "b", connections: ["c"] },
            { name: "c", connections: [] },
        ]);
        const answers = { q: ["a"], b: ["b"], c: ["c"] };
        const deep = countedDepth(1e12);
        const result = await callGraphMemTool(host(chain, answers), "readMemory", { query: ["q"], search_depth: deep });
        expect(
            JSON.parse((result[0] as { text: string }).text)[0].entries.map((entry: { name: string }) => entry.name),
        ).toEqual(["a", "b", "c"]);
        // At most `graph.length + 1` levels per query (the last finds nothing new and ends it).
        expect(deep.reads).toBe(3 + 1);
        // The default depth (2) still stops at two levels.
        const two = await callGraphMemTool(host(chain, answers), "readMemory", { query: ["q"] });
        expect(
            JSON.parse((two[0] as { text: string }).text)[0].entries.map((entry: { name: string }) => entry.name),
        ).toEqual(["a", "b"]);
    });

    it("throws on a failure the host calls fatal instead of answering it", async () => {
        const fatal = new Error("job ended");
        const host = {
            getVar: () => graph([{ name: "a", connections: [] }]),
            setVar: () => {},
            search: async () => {
                throw fatal;
            },
            fatal: (error: unknown) => error === fatal,
        };
        await expect(callGraphMemTool(host, "readMemory", { query: ["q"] })).rejects.toBe(fatal);
        expect(await callGraphMemTool({ ...host, fatal: () => false }, "readMemory", { query: ["q"] })).toEqual([
            { type: "text", text: "Error: job ended" },
        ]);
    });
});
