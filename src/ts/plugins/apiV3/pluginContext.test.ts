import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 4, slice 3 (`plugin-call-context`): a plugin hook runs with a captured call context (the
// chat, the preset, and the persona id), and the selection-dependent host functions the plugin
// calls inside the hook act on the hook's chat and preset instead of the tab's selection. Two fake
// plugins are registered through the real API object (`SandboxHost` mocked, as in
// `hostApiRouting.test.ts`), and the hooks are invoked as the runners invoke them: through
// `invokeHook` (the output-listener runner), the server transform's continuation
// (`serverProcessScript`, the script-handler runner of the tab since the Phase 5 cutover; the server
// is a stand-in), and `requestChatData` (the replacer and provider runners). Pinned here:
// - the capture: the chat ref, the selected preset, and the chat's bound persona (else the selected one);
// - a `chatOutput` listener for a chat that is not selected reads and writes its own character and
//   chat (`getChar`/`getCharacter` report the hook's chat as `chatPage`; a `setChar` round trip does
//   not change the user's chat selection), and the tab's selection is unchanged;
// - attribution: a host call from the second plugin during the first plugin's hook resolves to the
//   selection; two hooks of one plugin in flight resolve to the innermost (the recorded limit);
//   out-of-order completion pops the right entry; a hook that throws (synchronously or by
//   rejection) pops its entry; a call after the hook settled resolves to the selection;
// - settings: `setDatabase`/`setDatabaseLite` inside a hook land in the hook's preset after a preset
//   switch, also across the database consent and the install prompt, and `getDatabase` reads it;
// - gone targets: a deleted chat, character, or preset throws `PluginTargetGoneError` (never a
//   redirect to the selection), `runLLMModel` refuses before dispatch, a settings write with a gone
//   preset applies nothing, and a custom key that shares a forwarded name (`aiModel`) still lands in
//   the custom storage;
// - the runners: a script handler and the replacers and provider of a request get the context the
//   caller passes (a preset selected later is not recaptured), else one captured at entry;
// - the forwarding host functions: `parseRisuChat` parses with the hook's character and chat, scoped
//   to the hook's preset and persona (`risuChatParserScoped`), and, with `processRegex`, its script
//   stage is the server transform for the hook's chat, preset, and persona, whose plugin handlers run
//   with the hook's context (without a saved chat the stage is skipped); `runLLMModel` sends the
//   request for the hook's chat with the hook's context (a plugin model blocked unless allowed);
//   `getCurrentLorebookEntries` answers the hook's character, chat, and module lore. Another plugin
//   instance observes the forwarded context, since the calling plugin's own hooks would see it
//   ambiently either way;
// - `sendChat` inside a hook appends to the hook's chat and sends that chat with the context; its
//   busy refusal is unchanged;
// - unload: a reload removes the old instance's script handlers, replacers, and listeners, the old
//   instance's stack is not the reloaded instance's, and `SandboxHost.terminate` rejects a pending
//   callback so the hook's entry pops.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { captured, alerts, grants, sends, transforms } = vi.hoisted(() => ({
    captured: { apis: [] as CapturedApi[] },
    alerts: { confirm: vi.fn(async (_text: string) => true) },
    grants: { value: true },
    sends: [] as { index: number; arg: any }[],
    /** The calls to the server transform stand-in (`/api/transform` and its continuation). */
    transforms: [] as { path: string; body: any }[],
}));

vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(apiFactory: CapturedApi) {
            captured.apis.push(apiFactory);
        }
        run() {}
        executeInIframe() {
            return Promise.resolve();
        }
        dispose() {}
        terminate() {}
    },
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));

vi.mock("src/ts/alert", () => ({
    alertConfirm: alerts.confirm,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertToast: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));

// The module-update effect of `stores.svelte.ts` tracks `enabledModules`; nothing here needs modules.
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

// The real parser module installs a module-level `$effect.root` over the selection, which is still
// uninitialized here because the modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    risuChatParserScoped: vi.fn((text: string) => text),
    risuEscape: vi.fn((text: string) => text),
    risuUnescape: vi.fn((text: string) => text),
}));

// The permissions are granted unless a test lowers `grants.value` (then `alertConfirm` is asked).
vi.mock("./permissionStore", () => ({
    hasPermissionGrant: () => grants.value,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(async () => undefined),
}));

// The send pipeline is a stand-in: `sendChat` records what the plugin's `sendChat` passes it.
vi.mock("src/ts/process/index.svelte", async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    return {
        doingChat: writable(false),
        sendChat: vi.fn(async (index: number, arg: any) => {
            sends.push({ index, arg });
            return true;
        }),
        previewBody: vi.fn(),
    };
});

// The tools of `requestChatData` are stand-ins; the plugin provider is real.
vi.mock("src/ts/process/mcp/mcp", () => ({ getTools: vi.fn(async () => []) }));

// `requestChatDataMain` is spied on so a refused `runLLMModel` can be shown not to dispatch. The factory
// does not load the actual module: loading it there loads its imports (the plugin API among them, which
// imports this module) while the mock is still being made, and an importer entered in that window binds
// to the unspied original, so whether the API saw the spy depended on the import order. Each export
// forwards to the actual module at its call instead, so every importer gets the spy in any order.
vi.mock("src/ts/process/request/request", () => {
    type Request = typeof import("src/ts/process/request/request");
    const actual = () => vi.importActual<Request>("src/ts/process/request/request");
    return {
        requestChatData: async (...args: Parameters<Request["requestChatData"]>) =>
            (await actual()).requestChatData(...args),
        requestChatDataMain: vi.fn(async (...args: Parameters<Request["requestChatDataMain"]>) =>
            (await actual()).requestChatDataMain(...args),
        ),
        // `runLLMModel` runs inside the request's chat guard (Phase 6 slice 9b): the real helper.
        withRequestChat: async (...args: Parameters<Request["withRequestChat"]>) =>
            (await actual()).withRequestChat(...args),
    };
});

// The server transform is a stand-in: with the tab's plugin handlers every text is pending as it came
// (the server's stages before the handlers leave it alone here), and the continuation answers the
// handlers' texts; without handlers a text is answered as it came.
//
// The factory does not load the actual module (as `request` above): since Phase 6 slice 9a its imports
// reach the chat module and, through it, the transform client, which then bound to the unmocked
// `authFetch` while the mock was being made. The other export forwards to the actual module at its call.
vi.mock("src/ts/storage/serverAuth", () => {
    type ServerAuthModule = typeof import("src/ts/storage/serverAuth");
    const actual = () => vi.importActual<ServerAuthModule>("src/ts/storage/serverAuth");
    const answer = (id: string, text: string) => ({
        id,
        ok: true,
        text,
        emotions: [],
        key: `key:${text}`,
        cached: false,
    });
    return {
        getNodeServerProxyAuth: async () => (await actual()).getNodeServerProxyAuth(),
        authFetch: vi.fn(async (path: string, init: { body: string }) => {
            const body = JSON.parse(init.body);
            transforms.push({ path, body });
            let reply: unknown;
            if (path === "/api/transform/continue") {
                reply = {
                    results: body.texts.map((entry: any) =>
                        "error" in entry
                            ? { id: entry.id, ok: false, error: entry.error }
                            : answer(entry.id, entry.text),
                    ),
                };
            } else if (path === "/api/transform" && body.handlers) {
                reply = {
                    results: [],
                    snapshotId: "snapshot-1",
                    pending: body.targets.map((target: any) => ({ id: target.id, text: target.source })),
                };
            } else if (path === "/api/transform") {
                reply = { results: body.targets.map((target: any) => answer(target.id, target.source)) };
            } else {
                throw new Error(`No stand-in for ${path}`);
            }
            return { status: 200, ok: true, json: async () => reply };
        }),
    };
});

import * as chatStore from "src/ts/storage/chatStore.svelte";
import { characterList, removeCharacter } from "src/ts/storage/characterStore.svelte";
import {
    selectCharacterAt,
    selectedIndex,
    selection,
    selectModelPreset,
    selectPersona,
    selectPreset,
} from "src/ts/storage/selection.svelte";
import { activeMainProfile, activePreset, readSettingsRoot, settings } from "src/ts/storage/settingsViews.svelte";
import { chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets";
import { doingChat } from "src/ts/process/index.svelte";
import { requestChatData, requestChatDataMain } from "src/ts/process/request/request";
import { captureTransform, serverProcessScript } from "src/ts/parser/transformClient";
import { getModuleLorebooks } from "src/ts/process/modules";
import { risuChatParser, risuChatParserScoped } from "src/ts/parser/parser.svelte";
import { clearPluginHooks, pluginHooks } from "../pluginHooks";
import { capturePluginContext, invokeHook, PluginTargetGoneError, type PluginCallContext } from "./pluginContext";
import { executePluginV3, getV3PluginInstance, loadV3Plugins } from "./v3.svelte";

// `getModelInfo` clones an unknown built-in model (`undefined`) before it looks the plugin model up;
// the JSON stand-in of `vitest.setup.ts` cannot clone `undefined`, as `structuredClone` can.
vi.stubGlobal("safeStructuredClone", (value: unknown) =>
    value === undefined ? value : JSON.parse(JSON.stringify(value)),
);

const preset = (id: string) => settings.presets.find((entry: { id: string }) => entry.id === id) as any;
/** The main profile of the model preset `id` (`docs/plan/model-profiles.md`): `m-a` or `m-b`. */
const mainProfile = (id: string) =>
    settings.modelProfiles.find((entry: { id: string }) => entry.id === `m-${id}`) as any;
const characterOf = (chaId: string) => characterList().find((entry: any) => entry?.chaId === chaId) as any;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const texts = (ref: chatStore.ChatRef) => chatStore.findChat(ref)!.message.map((message) => message.data);
/** Marks chats as saved on the server (a held revision): the server transform applies to them. */
const saved = (...refs: chatStore.ChatRef[]) =>
    chatStore.seedChats(
        refs.map((ref) => ({ characterId: ref.chaId, id: ref.chatId, revision: "rev-1" })) as never,
        [],
    );

const refB1 = { chaId: "b", chatId: "b1" };
const refA1 = { chaId: "a", chatId: "a1" };

const chat = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    note: "",
    localLore: [],
    message: [{ role: "char", data: `hello from ${id}`, chatId: `m-${id}` }],
    ...fields,
});

/**
 * The live records, installed as boot installs them (the whole-database aggregate is gone since
 * Phase 6 slice 10): the record fields into the records, the characters' chats into the chat module
 * (Phase 6 slice 9a), the selection resolved.
 */
function liveDatabase() {
    selectPreset("a");
    selectModelPreset("a");
    selectPersona("p");
    const raw: Record<string, unknown> = {
        botPresets: [
            { id: "a", name: "A", temperature: 10 },
            { id: "b", name: "B", temperature: 20 },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "A", mainSlot: { profileId: "m-a" } }, { id: "a" }),
            normalizeModelPreset({ name: "B", mainSlot: { profileId: "m-b" } }, { id: "b" }),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "m-a", name: "A", maxContext: 1000 }),
            normalizeModelProfile({ id: "m-b", name: "B", maxContext: 2000 }),
        ],
        personas: [
            { id: "p", name: "P", icon: "", personaPrompt: "", note: "", largePortrait: false },
            { id: "q", name: "Q", icon: "", personaPrompt: "", note: "", largePortrait: false },
        ],
        characters: [
            {
                chaId: "a",
                type: "character",
                name: "Alpha",
                desc: "alpha",
                chatPage: 0,
                chats: [chat("a0"), chat("a1")],
                customscript: [],
                triggerscript: [],
                globalLore: [],
            },
            {
                chaId: "b",
                type: "character",
                name: "Beta",
                desc: "beta",
                chatPage: 0,
                chats: [chat("b0"), chat("b1", { bindedPersona: "q" }), chat("b2")],
                customscript: [],
                triggerscript: [],
                globalLore: [],
            },
        ],
        characterOrder: ["a", "b"],
        plugins: [],
        modules: [],
        enabledModules: [],
        pluginCustomStorage: undefined,
        theme: "",
        customCSS: "",
        useStreaming: false,
        genTime: 1,
        requestRetrys: 0,
        banCharacterset: [],
    };
    installFlatDatabaseWithChats(raw);
}

let counter = 0;

async function makeApi(name = `context-test-${++counter}`): Promise<CapturedApi> {
    const before = captured.apis.length;
    await executePluginV3({ name, script: `script of ${name}`, version: "3.0" } as any);
    expect(captured.apis.length).toBe(before + 1);
    return captured.apis[before];
}

function deferred<T = unknown>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Registers `fn` as a `chatOutput` listener of `api` and returns the wrapper the runner would call. */
async function listenerOf(api: CapturedApi, fn: Function) {
    const before = new Set(pluginHooks.chatOutput);
    await api.addRisuChatListener("output", fn);
    const added = [...pluginHooks.chatOutput].filter((entry) => !before.has(entry));
    expect(added).toHaveLength(1);
    return added[0];
}

/** What the selection-dependent getters answer now: [character index, chat index]. */
const where = (api: CapturedApi): [number, number] => [api.getCurrentCharacterIndex(), api.getCurrentChatIndex()];

/**
 * Binds a chat to prompt and model preset `a` and `persona` (`docs/plan/chat-binding.md`): a request
 * for a chat runs only on the chat's complete binding, so the cases that send bind their chat first.
 */
const bind = (ref: { chaId: string; chatId: string }, personaId: string) =>
    chatBindingPatch(ref, { modelPresetId: "a", promptPresetId: "a", personaId });

const listenerArg = { char: {}, chat: {}, characterIndex: 0, chatIndex: 0, messageIndex: 0 };

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    liveDatabase();
    selectCharacterAt(0);
    doingChat.set(false);
    sends.length = 0;
    transforms.length = 0;
    // No chat is saved on the server unless a test says so.
    chatStore.seedChats([], []);
    grants.value = true;
    alerts.confirm.mockReset();
    alerts.confirm.mockResolvedValue(true);
    clearPluginHooks();
    pluginHooks.replacerbeforeRequest.clear();
    pluginHooks.replacerafterRequest.clear();
    vi.mocked(requestChatDataMain).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

// The context carries its chat's owner lifetime (`chatOwnerToken`, Phase 6 slice 9b): the token as the
// chat module holds it now, never an incidental literal.
const ownerA = () => chatStore.chatOwnerToken("a");
const ownerB = () => chatStore.chatOwnerToken("b");

describe("capturePluginContext", () => {
    it("captures the chat ref, the selected preset, and the chat's bound persona, else the selected persona", () => {
        expect(capturePluginContext(refB1)).toEqual({
            chatRef: refB1,
            presetId: "a",
            modelPresetId: "a",
            personaId: "q",
            owner: ownerB(),
        });
        expect(capturePluginContext(refA1)).toEqual({
            chatRef: refA1,
            presetId: "a",
            modelPresetId: "a",
            personaId: "p",
            owner: ownerA(),
        });
        selectPreset("b");
        expect(capturePluginContext(refA1)!.presetId).toBe("b");
        // The model preset is captured independently (`docs/plan/split-preset.md`).
        expect(capturePluginContext(refA1)!.modelPresetId).toBe("a");
        selectModelPreset("b");
        expect(capturePluginContext(refA1)).toMatchObject({ presetId: "b", modelPresetId: "b" });
        expect(capturePluginContext(null)).toBeUndefined();
        expect(capturePluginContext(undefined)).toBeUndefined();
    });

    it("resolves through the settings views (Phase 6 slice 7): a bound persona that is gone, and a selection naming no record, fall back as before", () => {
        expect(capturePluginContext(refB1)).toEqual({
            chatRef: refB1,
            presetId: "a",
            modelPresetId: "a",
            personaId: "q",
            owner: ownerB(),
        });
        selectPersona("q");
        expect(capturePluginContext(refA1)!.personaId).toBe("q");
        // The bound persona `q` deleted: the chat's binding names no record, so the selected persona
        // is captured (the selection, which named `q`, falls back to the first persona and selects it).
        settings.personas.splice(1, 1);
        expect(capturePluginContext(refB1)).toEqual({
            chatRef: refB1,
            presetId: "a",
            modelPresetId: "a",
            personaId: "p",
            owner: ownerB(),
        });
        expect(selection.personaId).toBe("p");
        // A preset selection naming no record: the first preset, which becomes the selection.
        selectPreset("gone");
        expect(capturePluginContext(refA1)!.presetId).toBe("a");
        expect(selection.presetId).toBe("a");
        selectModelPreset("gone");
        expect(capturePluginContext(refA1)!.modelPresetId).toBe("a");
        expect(selection.modelPresetId).toBe("a");
    });

    it("is a copy: the runner's ref object is not shared", () => {
        const ref = { chaId: "b", chatId: "b1" };
        const context = capturePluginContext(ref)!;
        ref.chatId = "changed";
        expect(context.chatRef).toEqual(refB1);
    });
});

describe("a chatOutput listener for a chat that is not selected", () => {
    it("reads and writes its own character and chat while the selection is unchanged", async () => {
        const api = await makeApi();
        const seen: Record<string, unknown> = {};
        const listener = await listenerOf(api, async () => {
            const character = await api.getCharacter();
            seen.chaId = character.chaId;
            seen.chatPage = character.chatPage;
            seen.chatId = character.chats[character.chatPage].id;
            seen.where = where(api);
            seen.legacy = (await api.getChar()).chaId;
            await api.setCharacter({ ...character, desc: "listener wrote" });
            // Async since Phase 6 slice 9b (it loads the hook's chat first).
            seen.lore = await api.getCurrentLorebookEntries();
        });
        const context = capturePluginContext(refB1);
        selectCharacterAt(0);

        await invokeHook(listener, context, listenerArg);

        expect(seen).toEqual({ chaId: "b", chatPage: 1, chatId: "b1", where: [1, 1], legacy: "b", lore: [] });
        expect(characterOf("b").desc).toBe("listener wrote");
        expect(characterOf("a").desc).toBe("alpha");
        // The user's chat selection of the hook's character and the tab's selection are unchanged.
        expect(characterOf("b").chatPage).toBe(0);
        expect(selectedIndex()).toBe(0);
        expect(characterOf("a").chatPage).toBe(0);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("getCharacter reports the hook's chat as chatPage, and setCharacter with that page keeps the user's page; another page selects", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => {
            const got = await api.getCharacter();
            expect(got.chats.map((entry: any) => entry.id)).toEqual(["b0", "b1", "b2"]);
            expect(got.chatPage).toBe(1);
            // A get, edit, set round trip: the reported page is not a selection change.
            await api.setCharacter({ ...got, name: "Beta 2" });
            expect(characterOf("b").chatPage).toBe(0);
            expect(characterOf("b").name).toBe("Beta 2");
            // An explicit other page is the plugin's selection change, as outside a hook.
            await api.setCharacter({ ...got, chatPage: 2 });
            expect(characterOf("b").chatPage).toBe(2);
            // The legacy name reports the same.
            expect((await api.getChar()).chatPage).toBe(1);
        });
        await invokeHook(listener, capturePluginContext(refB1), listenerArg);
        expect(characterOf("b").chatPage).toBe(2);
        expect(selectedIndex()).toBe(0);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("a round trip with a chat switch of the same character edits the hook's chat, not the newly selected one", async () => {
        const api = await makeApi();
        selectCharacterAt(1);
        const listener = await listenerOf(api, async () => {
            const got = await api.getCharacter();
            const target = got.chats[got.chatPage];
            target.note = "noted by the hook";
            await api.setCharacter(got);
        });
        const context = capturePluginContext(refB1);
        // The user switches to another chat of the same character while the send runs.
        chatStore.selectChat("b", 2);
        expect(characterOf("b").chatPage).toBe(2);

        await invokeHook(listener, context, listenerArg);

        expect(chatStore.findChat(refB1)!.note).toBe("noted by the hook");
        expect(chatStore.findChat({ chaId: "b", chatId: "b2" })!.note).toBe("");
        expect(characterOf("b").chatPage).toBe(2);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("without a context the same functions act on the selection, as before", async () => {
        const api = await makeApi();
        selectCharacterAt(1);
        chatStore.selectChat("b", 2);
        const listener = await listenerOf(api, async () => {
            expect(where(api)).toEqual([1, 2]);
            expect((await api.getCharacter()).chatPage).toBe(2);
        });
        await invokeHook(listener, undefined, listenerArg);
        expect(where(api)).toEqual([1, 2]);
    });
});

describe("attribution", () => {
    it("a host call from the second plugin during the first plugin's hook resolves to the selection", async () => {
        const first = await makeApi();
        const second = await makeApi();
        const gate = deferred<void>();
        const listener = await listenerOf(first, () => gate.promise);
        const running = invokeHook(listener, capturePluginContext(refB1), listenerArg);

        expect(where(first)).toEqual([1, 1]);
        expect(where(second)).toEqual([0, 0]);
        expect((await second.getDatabase(["temperature"])).temperature).toBe(10);
        selectPreset("b");
        expect((await first.getDatabase(["temperature"])).temperature).toBe(10);
        expect((await second.getDatabase(["temperature"])).temperature).toBe(20);

        gate.resolve();
        await running;
        expect(where(first)).toEqual([0, 0]);
    });

    it("two hooks of one plugin in flight resolve to the innermost, and out-of-order completion pops the right entry", async () => {
        const api = await makeApi();
        const outerGate = deferred<void>();
        const innerGate = deferred<void>();
        const outer = await listenerOf(api, () => outerGate.promise);
        const inner = await listenerOf(api, () => innerGate.promise);

        const outerRun = invokeHook(outer, capturePluginContext(refB1), listenerArg);
        expect(where(api)).toEqual([1, 1]);
        const innerRun = invokeHook(inner, capturePluginContext(refA1), listenerArg);
        // The recorded limit: the innermost hook's context answers, whichever hook is calling.
        expect(where(api)).toEqual([0, 1]);

        // The outer hook settles first: the inner entry is the one left.
        outerGate.resolve();
        await outerRun;
        expect(where(api)).toEqual([0, 1]);

        innerGate.resolve();
        await innerRun;
        expect(where(api)).toEqual([0, 0]);
    });

    it("a hook that throws synchronously pops its entry, and so does one that rejects", async () => {
        const api = await makeApi();
        let seenInside: [number, number] | null = null;
        const throwing = await listenerOf(api, () => {
            seenInside = where(api);
            throw new Error("boom");
        });
        expect(() => invokeHook(throwing, capturePluginContext(refB1), listenerArg)).toThrow("boom");
        expect(seenInside).toEqual([1, 1]);
        expect(where(api)).toEqual([0, 0]);

        const rejecting = await listenerOf(api, async () => {
            seenInside = where(api);
            throw new Error("later");
        });
        seenInside = null;
        await expect(invokeHook(rejecting, capturePluginContext(refA1), listenerArg)).rejects.toThrow("later");
        expect(seenInside).toEqual([0, 1]);
        expect(where(api)).toEqual([0, 0]);
    });

    it("a call after the hook settled resolves to the selection, and the handoff slot is restored", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => where(api));
        expect(await invokeHook(listener, capturePluginContext(refB1), listenerArg)).toEqual([1, 1]);
        expect(where(api)).toEqual([0, 0]);
        // A function that is not a registered wrapper leaves the handed-over context unconsumed; the
        // slot is restored, so the next registered hook invoked without a context has none.
        invokeHook(() => undefined, capturePluginContext(refB1));
        expect(await invokeHook(listener, undefined, listenerArg)).toEqual([0, 0]);
    });
});

describe("settings inside a hook", () => {
    it("setDatabase and setDatabaseLite land in the hook's presets of each owner after a switch of both, and getDatabase reads them", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => {
            expect((await api.getDatabase(["temperature", "theme"])).temperature).toBe(10);
            await api.setDatabase({ temperature: 33 });
            await api.setDatabaseLite({ maxContext: 3333, theme: "hooked" });
            expect(await api.getDatabase(["temperature", "maxContext"])).toEqual({ temperature: 33, maxContext: 3333 });
        });
        const context = capturePluginContext(refB1);
        selectPreset("b");
        selectModelPreset("b");

        await invokeHook(listener, context, listenerArg);

        // `temperature` is the prompt preset's, `maxContext` the model preset's main profile's
        // (`docs/plan/split-preset.md`, `docs/plan/model-profiles.md` O8).
        expect(preset("a")).toMatchObject({ temperature: 33 });
        expect(preset("b")).toMatchObject({ temperature: 20 });
        expect(mainProfile("a")).toMatchObject({ maxContext: 3333 });
        expect(mainProfile("b")).toMatchObject({ maxContext: 2000 });
        // The views still serve the selected presets; the section key landed in its record.
        expect(activePreset.temperature).toBe(20);
        expect(activeMainProfile.maxContext).toBe(2000);
        expect(settings.ui.theme).toBe("hooked");
        expect(selection.presetId).toBe("b");
        expect(selection.modelPresetId).toBe("b");
        // After the hook, the same calls act on the selection.
        expect((await api.getDatabase(["temperature"])).temperature).toBe(20);
        await api.setDatabaseLite({ temperature: 44 });
        expect(preset("b").temperature).toBe(44);
        expect(preset("a").temperature).toBe(33);
    });

    it("a read and a write keep the hook's preset across the database consent and the install prompt", async () => {
        const api = await makeApi();
        const read = deferred<unknown>();
        const written = deferred<void>();
        const listener = await listenerOf(api, async () => {
            read.resolve(await api.getDatabase(["temperature"]));
            await api.setDatabase({
                plugins: [{ name: "installed-by-hook", script: "x", version: "3.0" }],
                temperature: 55,
            });
            written.resolve();
        });
        // From here on the permissions are asked for (the listener was registered under a grant).
        grants.value = false;
        const prompts: ((value: boolean) => void)[] = [];
        alerts.confirm.mockImplementation(() => new Promise<boolean>((resolve) => prompts.push(resolve)));
        const running = invokeHook(listener, capturePluginContext(refB1), listenerArg);

        // The consent for the read is pending; the user switches presets meanwhile.
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        selectPreset("b");
        prompts[0](true);
        expect(await read.promise).toEqual({ temperature: 10 });

        // The install prompt is pending; the write still goes to the hook's preset when answered.
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        preset("b").temperature = 21;
        prompts[1](true);
        await written.promise;
        await running;
        expect(preset("a").temperature).toBe(55);
        expect(preset("b").temperature).toBe(21);
        expect(settings.plugins.map((plugin: any) => plugin.name)).toEqual(["installed-by-hook"]);
    });
});

describe("the theme getters (Phase 6 slice 7)", () => {
    // `getColorScheme`/`getTextTheme` read the ui record through the settings views, as it is at
    // each call, and hand the plugin a detached copy: a change the plugin makes to it reaches nothing.
    it("answer the ui record at each call with detached copies", async () => {
        const api = await makeApi();
        const scheme = { type: "dark", bgcolor: "#101010", textcolor: "#202020" };
        settings.ui.colorSchemeName = "custom";
        settings.ui.colorScheme = scheme as any;
        settings.ui.textTheme = "custom";
        settings.ui.customTextTheme = { FontColorStandard: "#303030" } as any;

        const colors = api.getColorScheme();
        expect(colors).toEqual({ name: "custom", scheme });
        const text = api.getTextTheme();
        expect(text).toEqual({ name: "custom", customTheme: { FontColorStandard: "#303030" } });
        colors.scheme.bgcolor = "#ffffff";
        text.customTheme.FontColorStandard = "#ffffff";
        expect(settings.ui.colorScheme.bgcolor).toBe("#101010");
        expect(settings.ui.customTextTheme.FontColorStandard).toBe("#303030");

        settings.ui.colorScheme = { ...scheme, bgcolor: "#404040" } as any;
        settings.ui.textTheme = "standard";
        expect(api.getColorScheme().scheme.bgcolor).toBe("#404040");
        expect(api.getTextTheme().name).toBe("standard");
    });
});

describe("gone targets", () => {
    it("a deleted chat or character throws PluginTargetGoneError from every chat-bound function, never a redirect", async () => {
        const api = await makeApi();
        const errors: string[] = [];
        const attempt = async (name: string, call: () => unknown) => {
            try {
                await call();
                errors.push(`${name}: no error`);
            } catch (error) {
                errors.push(`${name}: ${error instanceof PluginTargetGoneError ? error.message : String(error)}`);
            }
        };
        const listener = await listenerOf(api, async () => {
            chatStore.deleteChat(refB1);
            await attempt("getCharacter", () => api.getCharacter());
            await attempt("getChar", () => api.getChar());
            await attempt("setCharacter", () => api.setCharacter({ chaId: "b", name: "x" }));
            await attempt("getCurrentCharacterIndex", () => api.getCurrentCharacterIndex());
            await attempt("getCurrentChatIndex", () => api.getCurrentChatIndex());
            await attempt("getCurrentLorebookEntries", () => api.getCurrentLorebookEntries());
            await attempt("parseRisuChat", () => api.parseRisuChat("text"));
            await attempt("runLLMModel", () =>
                api.runLLMModel({ mode: "model", messages: [{ role: "user", content: "hi" }] }),
            );
            await attempt("sendChat", () => api.sendChat("hello"));
            removeCharacter("b");
            await attempt("getCurrentCharacterIndex", () => api.getCurrentCharacterIndex());
            await attempt("getCharacter", () => api.getCharacter());
        });
        await invokeHook(listener, capturePluginContext(refB1), listenerArg);

        const chatGone = "The chat this plugin hook runs for no longer exists";
        const characterGone = "The character this plugin hook runs for no longer exists";
        expect(errors).toEqual([
            `getCharacter: ${chatGone}`,
            `getChar: ${chatGone}`,
            `setCharacter: ${chatGone}`,
            `getCurrentCharacterIndex: ${chatGone}`,
            `getCurrentChatIndex: ${chatGone}`,
            `getCurrentLorebookEntries: ${chatGone}`,
            `parseRisuChat: ${chatGone}`,
            `runLLMModel: ${chatGone}`,
            `sendChat: ${chatGone}`,
            `getCurrentCharacterIndex: ${characterGone}`,
            `getCharacter: ${characterGone}`,
        ]);
        expect(requestChatDataMain).not.toHaveBeenCalled();
        expect(sends).toEqual([]);
        // The selected character was not touched by the refused setCharacter.
        expect(characterOf("a").name).toBe("Alpha");
        expect(texts({ chaId: "a", chatId: "a0" })).toEqual(["hello from a0"]);
    });

    it("a gone preset refuses only the calls that need it, before anything is applied; a gone model preset likewise for the model keys", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => {
            expect(await api.getDatabase(["theme"])).toEqual({ theme: "" });
            await expect(api.getDatabase(["temperature"])).rejects.toBeInstanceOf(PluginTargetGoneError);
            await expect(api.setDatabaseLite({ theme: "first", temperature: 1 })).rejects.toBeInstanceOf(
                PluginTargetGoneError,
            );
            // The hook's model preset `a` still exists: a model key alone lands there.
            expect(await api.getDatabase(["maxContext"])).toEqual({ maxContext: 1000 });
            await api.setDatabase({ maxContext: 5 });
            // A UI key alone, and a custom key that shares a forwarded root name, still land.
            await api.setDatabaseLite({ theme: "ok", aiModel: "custom value" });
            // Then the model preset goes too: the model keys are refused, the prompt key as before.
            settings.modelPresets = settings.modelPresets.filter((entry: { id: string }) => entry.id !== "a");
            await expect(api.getDatabase(["maxContext"])).rejects.toBeInstanceOf(PluginTargetGoneError);
            await expect(api.setDatabase({ theme: "second", maxContext: 6 })).rejects.toBeInstanceOf(
                PluginTargetGoneError,
            );
            expect(await api.getDatabase(["theme"])).toEqual({ theme: "ok" });
        });
        const context = capturePluginContext(refB1);
        settings.presets = settings.presets.filter((entry: { id: string }) => entry.id !== "a");
        selectPreset("b");
        selectModelPreset("b");
        const model = readSettingsRoot("aiModel");

        await invokeHook(listener, context, listenerArg);

        expect(settings.ui.theme).toBe("ok");
        expect(plain(settings.pluginStorage)).toEqual({ aiModel: "custom value" });
        // The forwarded `aiModel` of the selected model preset is not what the plugin wrote.
        expect(readSettingsRoot("aiModel")).toBe(model);
        expect(mainProfile("b")).toMatchObject({ modelId: model, maxContext: 2000 });
        expect(preset("b")).toMatchObject({ temperature: 20 });
        expect(settings.modelPresets.map((entry: { id: string }) => entry.id)).toEqual(["b"]);
        expect(console.warn).not.toHaveBeenCalled();
    });
});

describe("the runners", () => {
    it("a script handler run by the server transform's continuation gets the context the caller passes, else one captured at entry", async () => {
        const api = await makeApi();
        api.addRisuScriptHandler("process", async (data: string) => {
            const { temperature } = await api.getDatabase(["temperature"]);
            await api.setDatabaseLite({ temperature: temperature + 1 });
            return `${data}:${temperature}:${where(api).join("/")}`;
        });
        saved(refB1);
        const beta = characterList()[1];
        const context = capturePluginContext(refB1);
        selectPreset("b");

        const withContext = captureTransform(-1, { chatRef: refB1, pluginContext: context })!;
        const passed = await serverProcessScript(beta, "t", "editprocess", -1, {}, withContext, "text");
        expect(passed.data).toBe("t:10:1/1");
        expect(preset("a").temperature).toBe(11);
        expect(preset("b").temperature).toBe(20);

        const atEntry = captureTransform(-1, { chatRef: refB1 })!;
        const captured = await serverProcessScript(beta, "t", "editprocess", -1, {}, atEntry, "text");
        expect(captured.data).toBe("t:20:1/1");
        expect(preset("b").temperature).toBe(21);
        expect(preset("a").temperature).toBe(11);
        expect(where(api)).toEqual([0, 0]);
    });

    it("the replacers and the provider of a request get the request's context, the provider before its permission wait", async () => {
        const api = await makeApi();
        const seen: string[] = [];
        api.addProvider("ctx", async (arg: any) => {
            const { temperature } = await api.getDatabase(["temperature"]);
            seen.push(`provider ${where(api).join("/")} ${temperature} ${arg.prompt_chat[0].content}`);
            return { success: true, content: "reply" };
        });
        await api.addRisuReplacer("beforeRequest", async (formated: any[]) => {
            seen.push(`before ${where(api).join("/")}`);
            return formated;
        });
        await api.addRisuReplacer("afterRequest", async (content: string) => {
            seen.push(`after ${where(api).join("/")}`);
            return `${content}!`;
        });
        // From here on the permissions are asked for: the provider's, then the read's.
        grants.value = false;
        const prompts: ((value: boolean) => void)[] = [];
        alerts.confirm.mockImplementation(() => new Promise<boolean>((resolve) => prompts.push(resolve)));
        // `aiModel` is the model id of the model preset's main profile (`docs/plan/model-profiles.md`):
        // the request reads it from the model preset of its captured context, else the selected one.
        mainProfile("a").modelId = "pluginmodel:::ctx";
        mainProfile("b").modelId = "pluginmodel:::ctx";
        bind(refB1, "q");
        bind(refA1, "p");
        const context = capturePluginContext(refB1);
        selectPreset("b");

        const running = requestChatData(
            { formated: [{ role: "user", content: "hi" }], bias: {}, chatRef: refB1, pluginContext: context },
            "model",
        );
        // The provider permission prompt is pending; its context was taken before the wait.
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        expect(where(api)).toEqual([1, 1]);
        prompts[0](true);
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        prompts[1](true);
        const response = await running;

        expect(response).toMatchObject({ type: "success", result: "reply!" });
        expect(seen).toEqual(["before 1/1", "provider 1/1 10 hi", "after 1/1"]);
        expect(where(api)).toEqual([0, 0]);

        // Without a passed context, the request captures one at its entry: the chat's binding (preset
        // `a`), not the selection (`b`).
        seen.length = 0;
        const captured = await requestChatData(
            { formated: [{ role: "user", content: "again" }], bias: {}, chatRef: refA1 },
            "model",
        );
        expect(captured).toMatchObject({ type: "success", result: "reply!" });
        expect(seen).toEqual(["before 0/1", "provider 0/1 10 again", "after 0/1"]);
    });
});

describe("the host functions that forward the hook's target", () => {
    it("parseRisuChat parses with the hook's character and chat, and with processRegex its server transform and script handlers run with the hook's context", async () => {
        const api = await makeApi();
        const other = await makeApi();
        const seen: string[] = [];
        // Another plugin's `process` handler: it sees the context only if `parseRisuChat` passed it on.
        other.addRisuScriptHandler("process", async (data: string) => {
            const { temperature } = await other.getDatabase(["temperature"]);
            seen.push(`process ${where(other).join("/")} ${temperature} ${data}`);
            return `${data}+`;
        });
        const results: string[] = [];
        const listener = await listenerOf(api, async () => {
            results.push(await api.parseRisuChat("plain", { messageIndex: 0, role: "char" }));
            results.push(await api.parseRisuChat("scripted", { processRegex: true }));
        });
        saved(refB1);
        bind(refB1, "q");
        const context = capturePluginContext(refB1);
        selectCharacterAt(0);
        chatStore.selectChat("b", 2);
        selectPreset("b");
        vi.mocked(risuChatParser).mockClear();
        vi.mocked(risuChatParserScoped).mockClear();

        await invokeHook(listener, context, listenerArg);

        expect(results).toEqual(["plain", "scripted+"]);
        expect(seen).toEqual(["process 1/1 10 scripted"]);
        // Inside a hook the direct parses are scoped to the hook's frozen preset and persona (Phase 5
        // slice 7a), not the tab's selection (`b` was selected after the context was captured).
        const scope = {
            presetId: context!.presetId,
            modelPresetId: context!.modelPresetId,
            personaId: context!.personaId,
        };
        const scoped = vi.mocked(risuChatParserScoped).mock.calls;
        expect(scoped).toHaveLength(2);
        // The plain parse: the hook's character and chat, the message index and role as given.
        expect(scoped[0][0]).toBe("plain");
        expect((scoped[0][1] as any).chara.chaId).toBe("b");
        expect(scoped[0][1]).toMatchObject({
            chatRef: refB1,
            chatID: 0,
            role: "char",
            cbsConditions: { chatRole: "char" },
        });
        expect(scoped[0][2]).toEqual(scope);
        // The script path: the scoped parse before the stage, then the server transform of the hook's
        // chat with that chat's binding (`docs/plan/chat-binding.md`, the display rule; here the hook's
        // preset and persona, not the selected `b`), whose continuation ran the handlers above.
        expect(scoped[1][0]).toBe("scripted");
        expect((scoped[1][1] as any).chara.chaId).toBe("b");
        expect(scoped[1][1]).toMatchObject({ chatRef: refB1, chatID: -1 });
        expect(scoped[1][2]).toEqual(scope);
        expect(transforms.map((call) => call.path)).toEqual(["/api/transform", "/api/transform/continue"]);
        expect(transforms[0].body).toMatchObject({
            mode: "editprocess",
            context: {
                characterId: "b",
                chatId: "b1",
                presetId: "a",
                modelPresetId: "a",
                personaId: "q",
                selectedPersonaId: "q",
            },
            targets: [{ kind: "text", sourceId: "b", chatIndex: -1, source: "scripted" }],
        });
        expect(transforms[0].body.handlers).toEqual(expect.any(String));
        // No parse of this hook fell back to the selected chat, and none ran unscoped.
        expect(scoped.every((call) => (call[1] as any)?.chatRef?.chatId === "b1")).toBe(true);
        expect(vi.mocked(risuChatParser)).not.toHaveBeenCalled();
        expect(where(other)).toEqual([0, 0]);
        expect(where(api)).toEqual([0, 0]);

        // Outside a hook the same call parses the selected character, unscoped, with the chat selected
        // when the call came as its chat ref (Phase 6 slice 9a, "After the challenge" point 2).
        vi.mocked(risuChatParser).mockClear();
        vi.mocked(risuChatParserScoped).mockClear();
        expect(await api.parseRisuChat("outside")).toBe("outside");
        expect(vi.mocked(risuChatParserScoped)).not.toHaveBeenCalled();
        expect((vi.mocked(risuChatParser).mock.calls[0][1] as any).chara.chaId).toBe("a");
        expect((vi.mocked(risuChatParser).mock.calls[0][1] as any).chatRef).toEqual({ chaId: "a", chatId: "a0" });

        // Without a transform context (the selected chat `a0` is not saved on the server) the script
        // stage is skipped: the parsed text comes back, and no handler and no transform run.
        transforms.length = 0;
        seen.length = 0;
        expect(await api.parseRisuChat("unsaved", { processRegex: true })).toBe("unsaved");
        expect(seen).toEqual([]);
        expect(transforms).toEqual([]);
    });

    it("runLLMModel requests for the hook's chat with the hook's context, and blocks a plugin model unless allowed", async () => {
        const api = await makeApi();
        const provider = await makeApi();
        const seen: string[] = [];
        // Another plugin's provider: it sees the hook's chat and preset only if the request carried them.
        provider.addProvider("target", async (arg: any) => {
            const { temperature } = await provider.getDatabase(["temperature"]);
            seen.push(`provider ${where(provider).join("/")} ${temperature} ${arg.prompt_chat[0].content}`);
            return { success: true, content: "reply" };
        });
        mainProfile("a").modelId = "pluginmodel:::target";
        mainProfile("b").modelId = "pluginmodel:::target";
        bind(refB1, "q");
        const results: unknown[] = [];
        const listener = await listenerOf(api, async () => {
            results.push(await api.runLLMModel({ mode: "model", messages: [{ role: "user", content: "blocked" }] }));
            results.push(
                await api.runLLMModel({
                    mode: "model",
                    messages: [{ role: "user", content: "allowed" }],
                    allowPlugins: true,
                }),
            );
        });
        const context = capturePluginContext(refB1);
        selectCharacterAt(0);
        selectPreset("b");

        await invokeHook(listener, context, listenerArg);

        expect(results[0]).toMatchObject({ type: "fail", result: "Plugin calls are blocked by the caller." });
        expect(results[1]).toMatchObject({ type: "success", result: "reply" });
        // The provider ran once, for the hook's chat, reading the hook's preset (not the selected one).
        expect(seen).toEqual(["provider 1/1 10 allowed"]);
        const calls = vi.mocked(requestChatDataMain).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0][0]).toMatchObject({ chatRef: refB1, pluginContext: context, blockPlugins: true });
        expect(calls[0][1]).toBe("model");
        expect(calls[1][0]).toMatchObject({ chatRef: refB1, pluginContext: context, blockPlugins: false });
        expect(calls[1][0].formated).toEqual([{ role: "user", content: "allowed" }]);
        expect(where(provider)).toEqual([0, 0]);

        // Outside a hook: no chat ref or context is attached, and the provider sees the selection.
        seen.length = 0;
        const outside = await api.runLLMModel({
            mode: "model",
            messages: [{ role: "user", content: "outside" }],
            allowPlugins: true,
        });
        expect(outside).toMatchObject({ type: "success", result: "reply" });
        expect(seen).toEqual(["provider 0/0 20 outside"]);
        expect(calls[2][0]).not.toHaveProperty("chatRef");
        expect(calls[2][0]).not.toHaveProperty("pluginContext");
    });

    it("getCurrentLorebookEntries answers the hook's character, chat, and module lore, not the selection's", async () => {
        const api = await makeApi();
        characterOf("a").globalLore = [{ comment: "a global" }];
        characterOf("b").globalLore = [{ comment: "b global" }];
        chatStore.setChatMeta({ chaId: "a", chatId: "a0" }, { localLore: [{ comment: "a0 local" }] });
        chatStore.setChatMeta(refB1, { localLore: [{ comment: "b1 local" }] });
        chatStore.setChatMeta({ chaId: "b", chatId: "b2" }, { localLore: [{ comment: "b2 local" }] });
        vi.mocked(getModuleLorebooks).mockImplementation(
            (ref?: { chaId: string; chatId: string }) =>
                (ref
                    ? [{ comment: `module for ${ref.chaId}/${ref.chatId}` }]
                    : [{ comment: "module for the selection" }]) as any,
        );
        try {
            const seen: unknown[] = [];
            const listener = await listenerOf(api, async () => {
                seen.push(await api.getCurrentLorebookEntries());
            });
            const context = capturePluginContext(refB1);
            selectCharacterAt(0);
            chatStore.selectChat("b", 2);

            await invokeHook(listener, context, listenerArg);

            expect(seen).toEqual([[{ comment: "b global" }, { comment: "b1 local" }, { comment: "module for b/b1" }]]);
            expect(getModuleLorebooks).toHaveBeenLastCalledWith(refB1);

            // Outside the hook: the selected character's lore, its selected chat, and that chat's
            // modules. The selected chat is captured as the call's target before its load (Phase 6
            // slice 9b), so the module lookup names it instead of reading the selection afterwards.
            expect(await api.getCurrentLorebookEntries()).toEqual([
                { comment: "a global" },
                { comment: "a0 local" },
                { comment: "module for a/a0" },
            ]);
            expect(getModuleLorebooks).toHaveBeenLastCalledWith({ chaId: "a", chatId: "a0" });
        } finally {
            vi.mocked(getModuleLorebooks).mockImplementation(() => []);
        }
    });
});

describe("sendChat inside a hook", () => {
    it("appends to the hook's chat and sends that chat with the context; outside a hook the selected chat", async () => {
        const api = await makeApi();
        const context = capturePluginContext(refB1)!;
        const listener = await listenerOf(api, async () => {
            expect(await api.sendChat("from the hook")).toBe(true);
        });
        selectPreset("b");
        await invokeHook(listener, context, listenerArg);

        expect(texts(refB1)).toEqual(["hello from b1", "from the hook"]);
        expect(texts({ chaId: "a", chatId: "a0" })).toEqual(["hello from a0"]);
        expect(sends).toEqual([{ index: -1, arg: { target: refB1, pluginContext: context } }]);
        expect(sends[0].arg.pluginContext).toMatchObject({ presetId: "a", modelPresetId: "a" });
        expect(get(doingChat)).toBe(false);

        expect(await api.sendChat("from outside")).toBe(true);
        expect(texts({ chaId: "a", chatId: "a0" })).toEqual(["hello from a0", "from outside"]);
        // The selected chat, captured when the call came (Phase 6 slice 9a, "After the challenge" point 2).
        expect(sends[1]).toEqual({ index: -1, arg: { target: { chaId: "a", chatId: "a0" } } });
    });

    it("keeps its busy refusal: while a chat is in progress nothing is appended and nothing is sent", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => {
            await expect(api.sendChat("busy")).rejects.toThrow("A chat is already in progress");
        });
        doingChat.set(true);
        await invokeHook(listener, capturePluginContext(refB1), listenerArg);
        expect(texts(refB1)).toEqual(["hello from b1"]);
        expect(sends).toEqual([]);
        // The refusal does not release the flag of the send in progress.
        expect(get(doingChat)).toBe(true);
    });
});

describe("unload and reload", () => {
    /** `loadV3Plugins` can skip every other running instance (recorded in `plugins-mcp.md`); repeat until ours is gone. */
    async function reload(plugin: any) {
        for (let attempt = 0; attempt < 10 && getV3PluginInstance(plugin.name); attempt += 1) {
            await loadV3Plugins([]);
        }
        expect(getV3PluginInstance(plugin.name)).toBeUndefined();
        const before = captured.apis.length;
        await executePluginV3(plugin);
        return captured.apis[before];
    }

    it("removes the old instance's script handler, replacers, and listener, and the reloaded instance has its own stack", async () => {
        const plugin = { name: `context-reload-${++counter}`, script: "s", version: "3.0" };
        settings.plugins = [plugin as any];
        const old = await reload(plugin);
        const gate = deferred<void>();
        const oldListener = await listenerOf(old, () => gate.promise);
        old.addRisuScriptHandler("output", async (data: string) => data);
        await old.addRisuReplacer("beforeRequest", async (formated: any[]) => formated);
        await old.addRisuReplacer("afterRequest", async (content: string) => content);
        expect(pluginHooks.editoutput.size).toBe(1);
        expect(pluginHooks.replacerbeforeRequest.size).toBe(1);
        expect(pluginHooks.replacerafterRequest.size).toBe(1);
        expect(pluginHooks.chatOutput.size).toBe(1);
        const oldRun = invokeHook(oldListener, capturePluginContext(refB1), listenerArg);
        expect(where(old)).toEqual([1, 1]);

        const fresh = await reload(plugin);
        expect(fresh).not.toBe(old);
        expect(pluginHooks.editoutput.size).toBe(0);
        expect(pluginHooks.replacerbeforeRequest.size).toBe(0);
        expect(pluginHooks.replacerafterRequest.size).toBe(0);
        expect(pluginHooks.chatOutput.size).toBe(0);

        // The old hook is still in flight: its context is the old instance's, not the new one's.
        expect(where(old)).toEqual([1, 1]);
        expect(where(fresh)).toEqual([0, 0]);
        // A stale wrapper invoked with a context (a runner that still held it) stays on the old stack.
        const staleRun = invokeHook(oldListener, capturePluginContext(refA1), listenerArg);
        expect(where(fresh)).toEqual([0, 0]);
        expect(where(old)).toEqual([0, 1]);
        gate.resolve();
        await Promise.all([oldRun, staleRun]);
        expect(where(old)).toEqual([0, 0]);
    });

    it("SandboxHost.terminate rejects a pending callback, so a runner awaiting the hook settles and its entry pops", async () => {
        const { SandboxHost } = await vi.importActual<typeof import("./factory")>("./factory");
        const host: any = new SandboxHost({});
        // An iframe whose window is gone: the invocation is posted nowhere and stays pending.
        host.iframe = { contentWindow: null, remove() {} };
        const [callback] = host.deserializeArgs([{ __type: "CALLBACK_REF", id: "cb-1" }]);
        const api = await makeApi();
        const listener = await listenerOf(api, callback);

        const running = invokeHook(listener, capturePluginContext(refB1), listenerArg);
        expect(where(api)).toEqual([1, 1]);
        host.terminate();
        await expect(running).rejects.toThrow("The plugin was unloaded");
        expect(where(api)).toEqual([0, 0]);
        // A second termination is harmless.
        host.terminate();
    });
});
