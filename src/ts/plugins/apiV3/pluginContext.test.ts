import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 4, slice 3 (`plugin-call-context`): a plugin hook runs with a captured call context (the
// chat, the preset, and the persona id), and the selection-dependent host functions the plugin
// calls inside the hook act on the hook's chat and preset instead of the tab's selection. Two fake
// plugins are registered through the real API object (`SandboxHost` mocked, as in
// `hostApiRouting.test.ts`), and the hooks are invoked as the runners invoke them: through
// `invokeHook` (the output-listener runner), `processScriptFull` (the script-handler runner), and
// `requestChatData` (the replacer and provider runners). Pinned here:
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
//   send passes (a preset selected later is not recaptured), else one captured at entry;
// - the forwarding host functions: `parseRisuChat` parses with the hook's character and chat, scoped
//   to the hook's preset and persona (`risuChatParserScoped`), and, with `processRegex`, its script
//   path runs with the hook's context; `runLLMModel` sends the
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

const { captured, alerts, grants, sends } = vi.hoisted(() => ({
    captured: { apis: [] as CapturedApi[] },
    alerts: { confirm: vi.fn(async (_text: string) => true) },
    grants: { value: true },
    sends: [] as { index: number; arg: any }[],
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

vi.mock("src/ts/storage/database.svelte", async () => {
    // The live database (the mutations write `DBState.db`); resolved here because the factory runs
    // before this file's own imports are initialized.
    const stores = await vi.importActual<typeof import("src/ts/stores.svelte")>("src/ts/stores.svelte");
    const { get } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    const plain = (value: unknown) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
    return {
        getDatabase: () => stores.DBState.db,
        setDatabase: vi.fn(),
        getCurrentCharacter: vi.fn((options?: { snapshot?: boolean }) => {
            const character = stores.DBState.db.characters?.[get(stores.selectedCharID)];
            return options?.snapshot ? plain(character) : character;
        }),
        getCurrentChat: vi.fn(() => {
            const character = stores.DBState.db.characters?.[get(stores.selectedCharID)];
            return character?.chats?.[character.chatPage];
        }),
        setCurrentChat: vi.fn(),
    };
});

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: { getItem: vi.fn(), setItem: vi.fn(), keys: vi.fn(async () => []) },
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

// The real parser module installs a module-level `$effect.root` over `selIdState`, which is still
// uninitialized here because the two modules import each other. Nothing under test parses CBS.
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

// The request trigger and the tools of `requestChatData` are stand-ins; the plugin provider is real.
vi.mock("src/ts/process/triggers", () => ({
    runTrigger: vi.fn(async (_char: unknown, _mode: string, arg: any) => ({ displayData: arg.displayData })),
}));
vi.mock("src/ts/process/mcp/mcp", () => ({ getTools: vi.fn(async () => []) }));

// `requestChatDataMain` is spied on so a refused `runLLMModel` can be shown not to dispatch.
vi.mock("src/ts/process/request/request", async (importOriginal) => {
    const actual = await importOriginal<typeof import("src/ts/process/request/request")>();
    return { ...actual, requestChatDataMain: vi.fn(actual.requestChatDataMain) };
});

import { DBState, selectedCharID } from "src/ts/stores.svelte";
import * as chatStore from "src/ts/storage/chatStore.svelte";
import { removeCharacter } from "src/ts/storage/characterStore.svelte";
import { installForwarding } from "src/ts/storage/forwarding.svelte";
import { selection, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { doingChat } from "src/ts/process/index.svelte";
import { requestChatData, requestChatDataMain } from "src/ts/process/request/request";
import { processScriptFull } from "src/ts/process/scripts";
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

const db = () => DBState.db as any;
const preset = (id: string) => db().botPresets.find((entry: { id: string }) => entry.id === id);
const characterOf = (chaId: string) => db().characters.find((entry: any) => entry?.chaId === chaId);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const texts = (ref: chatStore.ChatRef) => chatStore.findChat(ref)!.message.map((message) => message.data);

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

function liveDatabase() {
    selectPreset("a");
    selectPersona("p");
    return installForwarding({
        botPresets: [
            { id: "a", name: "A", temperature: 10, maxContext: 1000 },
            { id: "b", name: "B", temperature: 20, maxContext: 2000 },
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
        aiModel: "gpt-4o",
        useStreaming: false,
        genTime: 1,
        requestRetrys: 0,
        fallbackModels: {},
        banCharacterset: [],
    }) as any;
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

const listenerArg = { char: {}, chat: {}, characterIndex: 0, chatIndex: 0, messageIndex: 0 };

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    DBState.db = liveDatabase();
    selectedCharID.set(0);
    doingChat.set(false);
    sends.length = 0;
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

describe("capturePluginContext", () => {
    it("captures the chat ref, the selected preset, and the chat's bound persona, else the selected persona", () => {
        expect(capturePluginContext(refB1)).toEqual({ chatRef: refB1, presetId: "a", personaId: "q" });
        expect(capturePluginContext(refA1)).toEqual({ chatRef: refA1, presetId: "a", personaId: "p" });
        selectPreset("b");
        expect(capturePluginContext(refA1)!.presetId).toBe("b");
        expect(capturePluginContext(null)).toBeUndefined();
        expect(capturePluginContext(undefined)).toBeUndefined();
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
            const character = api.getCharacter();
            seen.chaId = character.chaId;
            seen.chatPage = character.chatPage;
            seen.chatId = character.chats[character.chatPage].id;
            seen.where = where(api);
            seen.legacy = api.getChar().chaId;
            api.setCharacter({ ...character, desc: "listener wrote" });
            seen.lore = api.getCurrentLorebookEntries();
        });
        const context = capturePluginContext(refB1);
        selectedCharID.set(0);

        await invokeHook(listener, context, listenerArg);

        expect(seen).toEqual({ chaId: "b", chatPage: 1, chatId: "b1", where: [1, 1], legacy: "b", lore: [] });
        expect(characterOf("b").desc).toBe("listener wrote");
        expect(characterOf("a").desc).toBe("alpha");
        // The user's chat selection of the hook's character and the tab's selection are unchanged.
        expect(characterOf("b").chatPage).toBe(0);
        expect(get(selectedCharID)).toBe(0);
        expect(characterOf("a").chatPage).toBe(0);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("getCharacter reports the hook's chat as chatPage, and setCharacter with that page keeps the user's page; another page selects", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => {
            const got = api.getCharacter();
            expect(got.chats.map((entry: any) => entry.id)).toEqual(["b0", "b1", "b2"]);
            expect(got.chatPage).toBe(1);
            // A get, edit, set round trip: the reported page is not a selection change.
            api.setCharacter({ ...got, name: "Beta 2" });
            expect(characterOf("b").chatPage).toBe(0);
            expect(characterOf("b").name).toBe("Beta 2");
            // An explicit other page is the plugin's selection change, as outside a hook.
            api.setCharacter({ ...got, chatPage: 2 });
            expect(characterOf("b").chatPage).toBe(2);
            // The legacy name reports the same.
            expect(api.getChar().chatPage).toBe(1);
        });
        await invokeHook(listener, capturePluginContext(refB1), listenerArg);
        expect(characterOf("b").chatPage).toBe(2);
        expect(get(selectedCharID)).toBe(0);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("a round trip with a chat switch of the same character edits the hook's chat, not the newly selected one", async () => {
        const api = await makeApi();
        selectedCharID.set(1);
        const listener = await listenerOf(api, async () => {
            const got = api.getCharacter();
            const target = got.chats[got.chatPage];
            target.note = "noted by the hook";
            api.setCharacter(got);
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
        selectedCharID.set(1);
        chatStore.selectChat("b", 2);
        const listener = await listenerOf(api, async () => {
            expect(where(api)).toEqual([1, 2]);
            expect(api.getCharacter().chatPage).toBe(2);
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
    it("setDatabase and setDatabaseLite land in the hook's preset after a preset switch, and getDatabase reads it", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => {
            expect((await api.getDatabase(["temperature", "theme"])).temperature).toBe(10);
            await api.setDatabase({ temperature: 33 });
            api.setDatabaseLite({ maxContext: 3333, theme: "hooked" });
            expect(await api.getDatabase(["temperature", "maxContext"])).toEqual({ temperature: 33, maxContext: 3333 });
        });
        const context = capturePluginContext(refB1);
        selectPreset("b");

        await invokeHook(listener, context, listenerArg);

        expect(preset("a")).toMatchObject({ temperature: 33, maxContext: 3333 });
        expect(preset("b")).toMatchObject({ temperature: 20, maxContext: 2000 });
        // The accessors still serve the selected preset; the section key landed at the root.
        expect(db().temperature).toBe(20);
        expect(db().theme).toBe("hooked");
        expect(selection.presetId).toBe("b");
        // After the hook, the same calls act on the selection.
        expect((await api.getDatabase(["temperature"])).temperature).toBe(20);
        api.setDatabaseLite({ temperature: 44 });
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
        expect(db().plugins.map((plugin: any) => plugin.name)).toEqual(["installed-by-hook"]);
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

    it("a gone preset refuses only the calls that need it, before anything is applied", async () => {
        const api = await makeApi();
        const listener = await listenerOf(api, async () => {
            expect(await api.getDatabase(["theme"])).toEqual({ theme: "" });
            await expect(api.getDatabase(["temperature"])).rejects.toBeInstanceOf(PluginTargetGoneError);
            expect(() => api.setDatabaseLite({ theme: "first", temperature: 1 })).toThrow(PluginTargetGoneError);
            await expect(api.setDatabase({ maxContext: 5 })).rejects.toBeInstanceOf(PluginTargetGoneError);
            // A UI key alone, and a custom key that shares a forwarded root name, still land.
            api.setDatabaseLite({ theme: "ok", aiModel: "custom value" });
        });
        const context = capturePluginContext(refB1);
        db().botPresets = db().botPresets.filter((entry: { id: string }) => entry.id !== "a");
        selectPreset("b");
        const model = db().aiModel;

        await invokeHook(listener, context, listenerArg);

        expect(db().theme).toBe("ok");
        expect(plain(db().pluginCustomStorage)).toEqual({ aiModel: "custom value" });
        // The forwarded `aiModel` of the selected preset is not what the plugin wrote.
        expect(db().aiModel).toBe(model);
        expect("aiModel" in preset("b")).toBe(false);
        expect(preset("b")).toMatchObject({ temperature: 20, maxContext: 2000 });
        expect(console.warn).not.toHaveBeenCalled();
    });
});

describe("the runners", () => {
    it("a script handler gets the context the send passes to processScriptFull, else one captured at entry", async () => {
        const api = await makeApi();
        api.addRisuScriptHandler("output", async (data: string) => {
            const { temperature } = await api.getDatabase(["temperature"]);
            api.setDatabaseLite({ temperature: temperature + 1 });
            return `${data}:${temperature}:${where(api).join("/")}`;
        });
        const beta = db().characters[1];
        const context = capturePluginContext(refB1);
        selectPreset("b");

        const passed = await processScriptFull(beta, "t", "editoutput", -1, {}, refB1, context);
        expect(passed.data).toBe("t:10:1/1");
        expect(preset("a").temperature).toBe(11);
        expect(preset("b").temperature).toBe(20);

        const captured = await processScriptFull(beta, "t", "editoutput", -1, {}, refB1);
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
        // `aiModel` is a preset field: the request reads it from the preset selected when it dispatches.
        preset("a").aiModel = "pluginmodel:::ctx";
        preset("b").aiModel = "pluginmodel:::ctx";
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

        // Without a passed context, the request captures one at its entry: the selection then.
        seen.length = 0;
        const captured = await requestChatData(
            { formated: [{ role: "user", content: "again" }], bias: {}, chatRef: refA1 },
            "model",
        );
        expect(captured).toMatchObject({ type: "success", result: "reply!" });
        expect(seen).toEqual(["before 0/1", "provider 0/1 20 again", "after 0/1"]);
    });
});

describe("the host functions that forward the hook's target", () => {
    it("parseRisuChat parses with the hook's character and chat, and with processRegex its script handlers run with the hook's context", async () => {
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
        const context = capturePluginContext(refB1);
        selectedCharID.set(0);
        chatStore.selectChat("b", 2);
        selectPreset("b");
        vi.mocked(risuChatParser).mockClear();
        vi.mocked(risuChatParserScoped).mockClear();

        await invokeHook(listener, context, listenerArg);

        expect(results).toEqual(["plain", "scripted+"]);
        expect(seen).toEqual(["process 1/1 10 scripted"]);
        // Inside a hook the direct parses are scoped to the hook's frozen preset and persona (Phase 5
        // slice 7a), not the tab's selection (`b` was selected after the context was captured).
        const scope = { presetId: context!.presetId, personaId: context!.personaId };
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
        // The script path: the scoped parse before the handlers, then the one `processScriptFull`
        // does after them, which still goes through `risuChatParser`.
        expect(scoped[1][0]).toBe("scripted");
        expect((scoped[1][1] as any).chara.chaId).toBe("b");
        expect(scoped[1][1]).toMatchObject({ chatRef: refB1, chatID: -1 });
        expect(scoped[1][2]).toEqual(scope);
        const parses = vi.mocked(risuChatParser).mock.calls;
        expect(parses.length).toBeGreaterThanOrEqual(1);
        expect(parses[0][0]).toBe("scripted+");
        expect(parses[0][1]).toMatchObject({ chatRef: refB1 });
        // No parse of this hook fell back to the selected chat.
        expect([...scoped, ...parses].every((call) => (call[1] as any)?.chatRef?.chatId === "b1")).toBe(true);
        expect(where(other)).toEqual([0, 0]);
        expect(where(api)).toEqual([0, 0]);

        // Outside a hook the same call parses the selected character without a chat ref, unscoped.
        vi.mocked(risuChatParser).mockClear();
        vi.mocked(risuChatParserScoped).mockClear();
        expect(await api.parseRisuChat("outside")).toBe("outside");
        expect(vi.mocked(risuChatParserScoped)).not.toHaveBeenCalled();
        expect((vi.mocked(risuChatParser).mock.calls[0][1] as any).chara.chaId).toBe("a");
        expect(vi.mocked(risuChatParser).mock.calls[0][1]).not.toHaveProperty("chatRef");
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
        preset("a").aiModel = "pluginmodel:::target";
        preset("b").aiModel = "pluginmodel:::target";
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
        selectedCharID.set(0);
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
                seen.push(api.getCurrentLorebookEntries());
            });
            const context = capturePluginContext(refB1);
            selectedCharID.set(0);
            chatStore.selectChat("b", 2);

            await invokeHook(listener, context, listenerArg);

            expect(seen).toEqual([[{ comment: "b global" }, { comment: "b1 local" }, { comment: "module for b/b1" }]]);
            expect(getModuleLorebooks).toHaveBeenLastCalledWith(refB1);

            // Outside the hook: the selected character's lore, its selected chat, and the selection's modules.
            expect(api.getCurrentLorebookEntries()).toEqual([
                { comment: "a global" },
                { comment: "a0 local" },
                { comment: "module for the selection" },
            ]);
            expect(getModuleLorebooks).toHaveBeenLastCalledWith();
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
        expect(sends[0].arg.pluginContext.presetId).toBe("a");
        expect(get(doingChat)).toBe(false);

        expect(await api.sendChat("from outside")).toBe(true);
        expect(texts({ chaId: "a", chatId: "a0" })).toEqual(["hello from a0", "from outside"]);
        expect(sends[1]).toEqual({ index: -1, arg: {} });
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
        db().plugins = [plugin];
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
