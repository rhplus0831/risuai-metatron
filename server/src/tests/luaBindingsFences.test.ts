// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { loadJobScope } from "../jobs/jobScope.ts";
import { createLuaBindings, LuaJobFatalError } from "../lua/bindings.ts";
import type { HostContext } from "../scripts/workerPool.ts";
import { waitFor } from "./testSupport.ts";

// Phase 5 slice 8a: the bindings' cancellation fences on their asynchronous continuations, with
// the production bindings over a real store and a fake job, and a suspendable token counter and
// file check: lore activation whose tokenization is suspended writes no activation flag once the
// host call was aborted, and an image getter aborted during its media check asks the tab nothing.
// The whole path through the worker is in `luaBindings.test.ts`.

const stat = vi.hoisted(() => ({ impl: null as null | ((savePath: string, key: string) => Promise<boolean>) }));
vi.mock("../routes/storage.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../routes/storage.ts")>();
    return {
        ...actual,
        storageFileExists: (savePath: string, key: string) =>
            stat.impl ? stat.impl(savePath, key) : actual.storageFileExists(savePath, key),
    };
});

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;

/** A promise the test releases, which records that it was awaited. */
function gate<T>() {
    let resolve!: (value: T) => void;
    let waited = false;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return {
        wait: () => {
            waited = true;
            return promise;
        },
        waited: () => waited,
        release: resolve,
    };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
    stat.impl = null;
    for (const cleanup of cleanups.splice(0).reverse()) {
        cleanup();
    }
});

function setup(options: { lore?: Record<string, unknown>[]; image?: string; inlay?: boolean } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-lua-fences-"));
    const store: ResourceStore = createResourceStore({ file: path.join(dir, "data", "resources.sqlite"), kinds });
    cleanups.push(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    // The singletons a job scope needs: a preset and a persona (the normalizers fill the fields).
    const singleton = (name: string, data: unknown) => {
        const row = store.get(kind(name), "main");
        store.applyChanges({ ops: [{ kind: kind(name), id: "main", baseRevision: row?.revision ?? null, data }] });
    };
    singleton(RESOURCE_KIND.presets, [{ id: "p", name: "p" }]);
    singleton(RESOURCE_KIND.modelPresets, [{ id: "m", name: "m", aiModel: "gpt-4o" }]);
    singleton("personas", [{ id: "u", name: "Uma" }]);
    const ops: Record<string, unknown>[] = [
        {
            kind: kind(RESOURCE_KIND.characters),
            id: "c",
            baseRevision: null,
            data: {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "hello",
                globalLore: options.lore ?? [],
                ...(options.image ? { image: options.image } : {}),
            },
        },
    ];
    if (options.inlay && options.image) {
        ops.push({
            kind: kind(RESOURCE_KIND.inlays),
            id: options.image,
            baseRevision: null,
            data: { name: options.image, ext: "png", type: "image", asset: options.image },
        });
    }
    store.applyChanges({
        ops: ops as never,
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        // The chat's binding (`docs/plan/chat-binding.md`): the job scope checks the context's ids against it.
                        chat: {
                            id: "k",
                            name: "K",
                            modelPresetId: "m",
                            promptPresetId: "p",
                            bindedPersona: "u",
                            message: [{ role: "user", data: "hi", chatId: "m1" }],
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
    const callbacks: string[] = [];
    const jobController = new AbortController();
    const job: RunningJob = {
        id: "job",
        kind: "command",
        context,
        command: { type: "button", data: "" },
        hooks: NO_GENERATION_HOOKS,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "aborted" }),
            callback: async (name) => {
                callbacks.push(name);
                return { outcome: "refused", refusal: "unregistered", error: "none" };
            },
        },
        ownerAttached: () => true,
        epoch: store.epoch(),
        signal: jobController.signal,
        emit() {},
        emitRecords: () => [],
        write: (build) => store.applyChanges(build() as never, { epoch: store.epoch() }),
        onClientMessage: () => () => {},
    };
    const tokens = gate<number>();
    const bindings = createLuaBindings({
        job,
        scope,
        store,
        kinds,
        rootDir: path.resolve(import.meta.dirname, "../../.."),
        savePath: path.join(dir, "save"),
        llm: {} as never,
        tokens: { count: () => tokens.wait(), encode: async () => [] } as never,
        runCharacterId: "c",
        engineCharacterId: "c",
    });
    const host = new AbortController();
    const ctx: HostContext = {
        identity: { characterId: "c", chatId: "k", presetId: "p", personaId: "u" },
        access: "lowLevel",
        signal: host.signal,
        regex: async () => ({ value: false }),
    };
    const chat = () => store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data as Chat;
    return { store, bindings, ctx, host, tokens, callbacks, chat };
}

describe("the bindings' fences", () => {
    it("writes no lore activation flag after its host call was aborted while tokenization was suspended, and latches the abort as fatal", async () => {
        const { bindings, ctx, host, tokens, chat } = setup({
            lore: [
                {
                    key: "",
                    comment: "keep",
                    content: "@@keep_activate_after_match\nAlways on",
                    alwaysActive: true,
                    insertorder: 100,
                    mode: "normal",
                    secondkey: "",
                    selective: false,
                },
            ],
        });
        const run = bindings.host.async!.loadLoreBooksMain([null], ctx);
        await waitFor(() => tokens.waited());
        host.abort(new Error("stop during tokens"));
        tokens.release(3);
        await expect(run).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(bindings.fatal()).toBeInstanceOf(LuaJobFatalError);
        // The `__internal_ka_*` flag the activation writes after tokenizing never landed.
        expect(chat().scriptstate ?? {}).toEqual({});
    });

    it("asks the tab for no image when the host call was aborted during the media check, and reports the abort as fatal", async () => {
        const { bindings, ctx, host, callbacks } = setup({ image: "assets/pic.png", inlay: true });
        const check = gate<boolean>();
        stat.impl = () => check.wait();
        const run = bindings.host.async!.getCharacterImageMain([], ctx);
        await waitFor(() => check.waited());
        host.abort(new Error("stop during stat"));
        check.release(false);
        await expect(run).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(callbacks).toEqual([]);
        expect(bindings.fatal()).toBeInstanceOf(LuaJobFatalError);
    });

    it("draws a missing image through the tab when nothing was aborted (the control for the fence)", async () => {
        const { bindings, ctx, callbacks } = setup({ image: "assets/pic.png", inlay: true });
        stat.impl = async () => false;
        expect(await bindings.host.async!.getCharacterImageMain([], ctx)).toBe("");
        expect(callbacks).toEqual(["inlayImage"]);
        expect(bindings.fatal()).toBeNull();
    });
});
