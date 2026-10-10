import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `docs/plan/chat-binding.md`, slice 3: the send guard of a chat's request (`chatRequestRefusal` in
// `request.ts`). A request for a chat (its `chatRef`, else its plugin context's chat) runs only while
// that chat's binding is complete, never on the tab's selection: refused up front in `requestChatData`
// (before the tools, the hooks, and the chat pin) and again where `requestChatDataMain` is entered
// (the plugin LLM API's direct call), so a tab-run model (a plugin provider here) never sees it. The
// refusal is the localized problem list and is not retried. A request without a chat is not checked.
// The request that runs captures the chat's binding as its context, whatever is selected.

const stubs = vi.hoisted(() => ({
    readRefs: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getTools: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
    getModelInfo: vi.fn<(id: string, scope?: unknown, profile?: unknown) => unknown>(),
    requestServer: vi.fn(),
    hooks: {
        replacerbeforeRequest: new Set<(formated: unknown, mode: string) => Promise<unknown>>(),
        replacerafterRequest: new Set<(result: string, mode: string) => Promise<string>>(),
        providers: new Map<string, (params: unknown, abortSignal: unknown) => Promise<unknown>>(),
        providerOptions: new Map<string, unknown>(),
    },
}));

vi.mock("src/ts/storage/serverAuth", () => ({ authFetch: vi.fn(), getNodeServerProxyAuth: async () => "" }));
vi.mock("src/ts/storage/resourceClient", () => ({
    readRefs: (...args: unknown[]) => stubs.readRefs(...args),
    getResourceEpoch: () => "epoch-1",
    epochMismatch: (epoch: string) => new Error(`replaced ${epoch}`),
}));
vi.mock("src/ts/process/request/transport", () => ({ requestServer: stubs.requestServer }));
vi.mock("src/ts/process/mcp/mcp", () => ({ getTools: (...args: unknown[]) => stubs.getTools(...args) }));
vi.mock("src/ts/plugins/pluginHooks", () => ({ pluginHooks: stubs.hooks }));
vi.mock("src/ts/parser/parser.svelte", () => ({
    risuEscape: (text: string) => text,
    risuUnescape: (text: string) => text,
    risuChatParser: (text: string) => text,
}));
vi.mock("src/ts/process/transformers", () => ({ runTransformers: vi.fn() }));
vi.mock("src/ts/process/templates/chatTemplate", () => ({ applyChatTemplate: vi.fn() }));
vi.mock("src/ts/process/stringlize", () => ({ unstringlizeChat: vi.fn() }));
vi.mock("src/ts/model/modellist", async () => {
    const types = await import("src/ts/model/types");
    return {
        ...types,
        getModelInfo: (id: string, scope?: unknown, profile?: unknown) => stubs.getModelInfo(id, scope, profile),
    };
});
vi.mock("src/ts/process/request/shared", () => ({
    applyAdditionalParameters: vi.fn(),
    applyParameters: (params: unknown) => params,
    getAdditionalParameters: vi.fn(),
}));
vi.mock("src/ts/util", () => ({ sleep: async () => {}, checkPersonaBinded: () => null }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

import { language } from "src/lang";
import { LLMFlags, LLMFormat } from "src/ts/model/types";
import { setChannelCallSource } from "src/ts/network/channelCallSource";
import { chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import { selectModelPreset, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../../shared/presets";
import { requestChatData, requestChatDataMain } from "../request";

const refBound = { chaId: "a", chatId: "bound" };
const refLoose = { chaId: "a", chatId: "loose" };
const refStale = { chaId: "a", chatId: "stale" };
const chat = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: id,
    note: "",
    localLore: [],
    message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
    ...fields,
});

/**
 * Prompt presets `pp-1`/`pp-2`, model presets `mp-1`/`mp-2` on the plugin model `custom` through the
 * providers `prov-1`/`prov-2`, personas `p1`/`p2`; the `2` records are selected. Character `a` holds
 * `bound` (bound to the `1` records), `loose` (no binding), and `stale` (bound to records that do not exist).
 */
function boot() {
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "a",
                type: "character",
                name: "A",
                chatPage: 0,
                chats: [
                    chat("bound", { modelPresetId: "mp-1", promptPresetId: "pp-1", bindedPersona: "p1" }),
                    chat("loose"),
                    chat("stale", { modelPresetId: "mp-gone", promptPresetId: "pp-1", bindedPersona: "p-gone" }),
                ],
            },
        ],
        botPresets: [
            { id: "pp-1", name: "PP 1" },
            { id: "pp-2", name: "PP 2" },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "MP 1", mainSlot: { profileId: "prof-1" } }, { id: "mp-1" }),
            normalizeModelPreset({ name: "MP 2", mainSlot: { profileId: "prof-2" } }, { id: "mp-2" }),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "prof-1", name: "Prof 1", modelId: "custom", currentPluginProvider: "prov-1" }),
            normalizeModelProfile({ id: "prof-2", name: "Prof 2", modelId: "custom", currentPluginProvider: "prov-2" }),
        ],
        personas: [
            { id: "p1", name: "U1" },
            { id: "p2", name: "U2" },
        ],
        useStreaming: false,
        requestRetrys: 0,
        genTime: 1,
        banCharacterset: [],
    });
    selectPreset("pp-2");
    selectModelPreset("mp-2");
    selectPersona("p2");
}

const argOf = (extra: Record<string, unknown> = {}) =>
    ({ formated: [{ role: "user", content: "hi" }], bias: {}, useStreaming: false, ...extra }) as never;
const strings = language.chatBinding;
const unset = (field: "modelPresetId" | "promptPresetId" | "personaId") => `${strings.fields[field]}: ${strings.unset}`;
const gone = (field: "modelPresetId" | "promptPresetId" | "personaId") => `${strings.fields[field]}: ${strings.gone}`;
const refusal = (lines: string[]) => ({ type: "fail", noRetry: true, result: [strings.refused, ...lines].join("\n") });

const provider1 = vi.fn(async () => ({ success: true, content: "from prov-1" }));
const provider2 = vi.fn(async () => ({ success: true, content: "from prov-2" }));

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubs.getTools.mockReset().mockResolvedValue([]);
    stubs.requestServer.mockReset();
    stubs.getModelInfo.mockReset().mockImplementation((id: string) => ({
        id,
        format: LLMFormat.Plugin,
        flags: [LLMFlags.hasFullSystemPrompt],
        tokenizer: 0,
    }));
    provider1.mockClear();
    provider2.mockClear();
    stubs.hooks.replacerbeforeRequest.clear();
    stubs.hooks.replacerafterRequest.clear();
    stubs.hooks.providers.clear();
    stubs.hooks.providers.set("prov-1", provider1);
    stubs.hooks.providers.set("prov-2", provider2);
    boot();
});

afterEach(() => {
    setChannelCallSource(() => null);
    vi.restoreAllMocks();
});

const mismatch = { type: "fail", noRetry: true, result: strings.mismatch };
const chatGone = { type: "fail", result: "The chat this request is for no longer exists" };
/** The context a job callback of `bound` runs with; `pick` is its `presetChain` prompt preset. */
const boundContext = (ids: Partial<Record<"presetId" | "modelPresetId" | "personaId", string>> = {}) => ({
    chatRef: refBound,
    presetId: "pp-1",
    modelPresetId: "mp-1",
    personaId: "p1",
    ...ids,
});
const nothingRan = () => {
    expect(stubs.getTools).not.toHaveBeenCalled();
    expect(stubs.getModelInfo).not.toHaveBeenCalled();
    expect(provider1).not.toHaveBeenCalled();
    expect(provider2).not.toHaveBeenCalled();
    expect(stubs.requestServer).not.toHaveBeenCalled();
};

describe("the send guard of a chat's request", () => {
    it("refuses a chat whose binding is incomplete before the tools, the hooks, and the model, with the problems, not retried, never on the selection", async () => {
        const hook = vi.fn(async (formated: unknown) => formated);
        stubs.hooks.replacerbeforeRequest.add(hook);
        const allUnset = refusal([unset("modelPresetId"), unset("promptPresetId"), unset("personaId")]);
        expect(await requestChatData(argOf({ chatRef: refLoose }), "model")).toEqual(allUnset);
        expect(await requestChatDataMain(argOf({ chatRef: refLoose }), "model")).toEqual(allUnset);
        // The plugin context's chat is the request's chat when the caller named none.
        const context = { chatRef: refLoose, presetId: "pp-2", modelPresetId: "mp-2", personaId: "p2" };
        expect(await requestChatData(argOf({ pluginContext: context }), "model")).toEqual(allUnset);
        expect(await requestChatDataMain(argOf({ pluginContext: context }), "model")).toEqual(allUnset);
        expect(await requestChatData(argOf({ chatRef: refStale }), "model")).toEqual(
            refusal([gone("modelPresetId"), gone("personaId")]),
        );
        expect(stubs.getTools).not.toHaveBeenCalled();
        expect(hook).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).not.toHaveBeenCalled();
        expect(provider1).not.toHaveBeenCalled();
        expect(provider2).not.toHaveBeenCalled();
        expect(stubs.requestServer).not.toHaveBeenCalled();
    });

    it("runs a chat whose binding is complete on that binding (its context), whatever is selected, and a request without a chat on the selection", async () => {
        expect(await requestChatData(argOf({ chatRef: refBound }), "model")).toEqual({
            type: "success",
            result: "from prov-1",
            model: "custom",
        });
        expect(provider1).toHaveBeenCalledTimes(1);
        expect(provider2).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).toHaveBeenCalledWith(
            "custom",
            expect.objectContaining({ chatRef: refBound, presetId: "pp-1", modelPresetId: "mp-1", personaId: "p1" }),
            expect.objectContaining({ id: "prof-1" }),
        );
        // No chat: the selection, as before (decision 10).
        expect(await requestChatData(argOf(), "model")).toMatchObject({ type: "success", result: "from prov-2" });
        expect(provider2).toHaveBeenCalledTimes(1);
    });

    it("checks again where the model is entered: a binding undone during a replacerbeforeRequest hook refuses the request before the provider", async () => {
        stubs.hooks.replacerbeforeRequest.add(async (formated: unknown) => {
            chatBindingPatch(refBound, { personaId: null });
            return formated;
        });
        expect(await requestChatData(argOf({ chatRef: refBound }), "model")).toEqual(refusal([unset("personaId")]));
        expect(stubs.getTools).toHaveBeenCalledTimes(1);
        expect(provider1).not.toHaveBeenCalled();
        expect(stubs.requestServer).not.toHaveBeenCalled();
        // Bound again: the request runs.
        chatBindingPatch(refBound, { personaId: "p1" });
        stubs.hooks.replacerbeforeRequest.clear();
        expect(await requestChatData(argOf({ chatRef: refBound }), "model")).toMatchObject({ type: "success" });
        expect(provider1).toHaveBeenCalledTimes(1);
    });

    it("refuses a context captured before the chat was rebound (a complete rebind during a hook) at the second check, as a mismatch, and a fresh request runs on the new binding", async () => {
        stubs.hooks.replacerbeforeRequest.add(async (formated: unknown) => {
            chatBindingPatch(refBound, { personaId: "p2" });
            return formated;
        });
        const arg = argOf({ chatRef: refBound }) as { pluginContext?: unknown };
        expect(await requestChatData(arg as never, "model")).toEqual(mismatch);
        // The capture named the binding as it was (`p1`); the hook ran, the model was never entered.
        expect(arg.pluginContext).toMatchObject({
            chatRef: refBound,
            presetId: "pp-1",
            modelPresetId: "mp-1",
            personaId: "p1",
        });
        expect(stubs.getTools).toHaveBeenCalledTimes(1);
        expect(stubs.getModelInfo).not.toHaveBeenCalled();
        expect(provider1).not.toHaveBeenCalled();
        expect(stubs.requestServer).not.toHaveBeenCalled();
        // A context captured before the rebind is refused up front too, not run on the old ids.
        expect(await requestChatData(argOf({ chatRef: refBound, pluginContext: boundContext() }), "model")).toEqual(
            mismatch,
        );
        expect(await requestChatDataMain(argOf({ chatRef: refBound, pluginContext: boundContext() }), "model")).toEqual(
            mismatch,
        );
        expect(provider1).not.toHaveBeenCalled();

        stubs.hooks.replacerbeforeRequest.clear();
        expect(await requestChatData(argOf({ chatRef: refBound }), "model")).toMatchObject({ type: "success" });
        expect(provider1).toHaveBeenCalledTimes(1);
        expect(stubs.getModelInfo).toHaveBeenCalledWith(
            "custom",
            expect.objectContaining({ chatRef: refBound, presetId: "pp-1", modelPresetId: "mp-1", personaId: "p2" }),
            expect.anything(),
        );
    });

    it("refuses a `chatRef` and a plugin context naming two chats, at both entries, before anything runs", async () => {
        const context = { chatRef: refLoose, presetId: "pp-1", modelPresetId: "mp-1", personaId: "p1" };
        expect(await requestChatData(argOf({ chatRef: refBound, pluginContext: context }), "model")).toEqual(mismatch);
        expect(await requestChatDataMain(argOf({ chatRef: refBound, pluginContext: context }), "model")).toEqual(
            mismatch,
        );
        // Also when the context's chat is the bound one and the `chatRef` is not.
        expect(await requestChatData(argOf({ chatRef: refLoose, pluginContext: boundContext() }), "model")).toEqual(
            mismatch,
        );
        expect(await requestChatDataMain(argOf({ chatRef: refLoose, pluginContext: boundContext() }), "model")).toEqual(
            mismatch,
        );
        nothingRan();
    });

    it("refuses a chat that is not listed as gone, at both entries, without a dispatch to the tab-run model or the server", async () => {
        const refGone = { chaId: "a", chatId: "nope" };
        const refNoChar = { chaId: "zz", chatId: "bound" };
        expect(await requestChatData(argOf({ chatRef: refGone }), "model")).toEqual(chatGone);
        expect(await requestChatDataMain(argOf({ chatRef: refGone }), "model")).toEqual(chatGone);
        expect(await requestChatDataMain(argOf({ chatRef: refNoChar }), "model")).toEqual(chatGone);
        // The plugin context's chat too.
        const context = { chatRef: refGone, presetId: "pp-2", modelPresetId: "mp-2", personaId: "p2" };
        expect(await requestChatData(argOf({ pluginContext: context }), "model")).toEqual(chatGone);
        expect(await requestChatDataMain(argOf({ pluginContext: context }), "model")).toEqual(chatGone);
        nothingRan();
    });

    it("selects the model from the chat's binding for a direct `requestChatDataMain` call with a `chatRef` and no context, capturing the binding as its context", async () => {
        const arg = argOf({ chatRef: refBound }) as { pluginContext?: unknown };
        expect(await requestChatDataMain(arg as never, "model")).toEqual({
            type: "success",
            result: "from prov-1",
            model: "custom",
        });
        // The selection (`mp-2`, `prov-2`) decided nothing.
        expect(provider1).toHaveBeenCalledTimes(1);
        expect(provider2).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).toHaveBeenCalledWith(
            "custom",
            expect.objectContaining({ chatRef: refBound, presetId: "pp-1", modelPresetId: "mp-1", personaId: "p1" }),
            expect.objectContaining({ id: "prof-1" }),
        );
        expect(arg.pluginContext).toMatchObject({
            chatRef: refBound,
            presetId: "pp-1",
            modelPresetId: "mp-1",
            personaId: "p1",
        });
        expect(stubs.requestServer).not.toHaveBeenCalled();
    });

    describe("inside a job callback", () => {
        const callbackOf = (targets: ReturnType<typeof boundContext>) =>
            setChannelCallSource(() => ({ jobId: "job", callbackId: "cb", targets }));

        it("exempts only the callback's own chat: a request for another, unbound chat is still refused on its binding, and the tab-run model is not invoked", async () => {
            callbackOf(boundContext());
            const allUnset = refusal([unset("modelPresetId"), unset("promptPresetId"), unset("personaId")]);
            expect(await requestChatData(argOf({ chatRef: refLoose }), "model")).toEqual(allUnset);
            expect(await requestChatDataMain(argOf({ chatRef: refLoose }), "model")).toEqual(allUnset);
            const context = { chatRef: refLoose, presetId: "pp-2", modelPresetId: "mp-2", personaId: "p2" };
            expect(await requestChatData(argOf({ pluginContext: context }), "model")).toEqual(allUnset);
            expect(await requestChatDataMain(argOf({ pluginContext: context }), "model")).toEqual(allUnset);
            expect(await requestChatDataMain(argOf({ chatRef: refStale }), "model")).toEqual(
                refusal([gone("modelPresetId"), gone("personaId")]),
            );
            expect(await requestChatDataMain(argOf({ chatRef: { chaId: "a", chatId: "nope" } }), "model")).toEqual(
                chatGone,
            );
            nothingRan();
        });

        it("runs a request for the callback's chat whose context names the job's targets (a `presetChain` pick included), on those targets, and refuses a context with other ids", async () => {
            // The job picked `pp-2` for its prompt preset and runs its callbacks on `mp-2` (`prov-2`).
            const targets = boundContext({ presetId: "pp-2", modelPresetId: "mp-2" });
            callbackOf(targets);
            expect(await requestChatData(argOf({ chatRef: refBound, pluginContext: targets }), "model")).toEqual({
                type: "success",
                result: "from prov-2",
                model: "custom",
            });
            expect(await requestChatDataMain(argOf({ chatRef: refBound, pluginContext: targets }), "model")).toEqual({
                type: "success",
                result: "from prov-2",
                model: "custom",
            });
            // The context's chat alone names the request's chat too.
            expect(await requestChatDataMain(argOf({ pluginContext: targets }), "model")).toMatchObject({
                type: "success",
                result: "from prov-2",
            });
            expect(provider2).toHaveBeenCalledTimes(3);
            expect(provider1).not.toHaveBeenCalled();
            // The model decisions (the scoped lookups) followed the targets, never the stored binding.
            const scoped = stubs.getModelInfo.mock.calls.filter(([, scope]) => scope !== undefined);
            expect(scoped).toHaveLength(3);
            for (const [, scope] of scoped) {
                expect(scope).toMatchObject({
                    chatRef: refBound,
                    presetId: "pp-2",
                    modelPresetId: "mp-2",
                    personaId: "p1",
                });
            }

            // The chat's stored binding (`pp-1`/`mp-1`) is not the job's: refused, as is any other id.
            stubs.getModelInfo.mockClear();
            expect(await requestChatData(argOf({ chatRef: refBound, pluginContext: boundContext() }), "model")).toEqual(
                mismatch,
            );
            expect(
                await requestChatDataMain(argOf({ chatRef: refBound, pluginContext: boundContext() }), "model"),
            ).toEqual(mismatch);
            expect(
                await requestChatDataMain(
                    argOf({
                        chatRef: refBound,
                        pluginContext: boundContext({ presetId: "pp-2", modelPresetId: "mp-2", personaId: "p2" }),
                    }),
                    "model",
                ),
            ).toEqual(mismatch);
            expect(provider2).toHaveBeenCalledTimes(3);
            expect(stubs.getModelInfo).not.toHaveBeenCalled();
            expect(stubs.requestServer).not.toHaveBeenCalled();

            // Outside the callback the same context is refused: the chat runs on its binding again.
            setChannelCallSource(() => null);
            expect(await requestChatDataMain(argOf({ chatRef: refBound, pluginContext: targets }), "model")).toEqual(
                mismatch,
            );
            expect(
                await requestChatDataMain(argOf({ chatRef: refBound, pluginContext: boundContext() }), "model"),
            ).toMatchObject({
                type: "success",
                result: "from prov-1",
            });
        });
    });
});
