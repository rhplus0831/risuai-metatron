import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A request that runs in the tab (a plugin provider model, `requestChatDataMain` → `requestPlugin`;
// WebLLM alike) never reaches the server's id check, so the tab refuses it itself once a captured
// preset (the plugin context's prompt and model preset pair) is gone: up front (`requestChatData`,
// `requestChatDataMain`, which the plugin LLM API calls directly), before every attempt, and after
// the `replacerbeforeRequest` hooks, without calling the provider. While both exist, the provider
// and the model flags come from the captured model preset's main profile, whatever is selected.

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
vi.mock("src/ts/plugins/apiV3/pluginContext", () => ({
    capturePluginContext: () => undefined,
    invokeHook: async (fn: (...args: unknown[]) => unknown, _context: unknown, ...args: unknown[]) => fn(...args),
}));
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
import { trackedRecord } from "src/ts/storage/records.svelte";
import { selectModelPreset, selectPreset, selection } from "src/ts/storage/selection.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../../shared/presets";
import { requestChatData, requestChatDataMain } from "../request";

const MODEL_PRESET_GONE = "The model preset this request runs with no longer exists";
const PRESET_GONE = "The preset this request runs with no longer exists";

/**
 * Prompt presets `pp-1`/`pp-2` and model presets `mp-1`/`mp-2`, each model preset's main profile
 * (`prof-1`/`prof-2`) on the legacy plugin model `custom` through its own provider
 * (`prov-1`/`prov-2`). The request captures the `1` pair; the `2` pair is selected.
 */
function boot() {
    installFlatDatabase({
        characters: [],
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
        personas: [{ id: "p1", name: "U" }],
        useStreaming: false,
        requestRetrys: 0,
        genTime: 1,
        banCharacterset: [],
    });
    selectPreset("pp-2");
    selectModelPreset("mp-2");
}

/** Deletes a record of `kind` by id (as a deletion elsewhere in the tab, or a live update, would). */
function deleteRecord(kind: "presets" | "modelPresets", id: string) {
    const list = trackedRecord<{ id: string }[]>(kind)!;
    const index = list.findIndex((entry) => entry.id === id);
    expect(index).toBeGreaterThanOrEqual(0);
    list.splice(index, 1);
}

const captured = () => ({ chatRef: null, presetId: "pp-1", modelPresetId: "mp-1", personaId: "p1" });
const argOf = () =>
    ({
        formated: [{ role: "user", content: "hi" }],
        bias: {},
        useStreaming: false,
        pluginContext: captured(),
    }) as never;

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
    vi.restoreAllMocks();
});

describe("a tab-run request's captured presets", () => {
    it("runs the provider and the model flags of the captured model preset's main profile, whatever is selected", async () => {
        expect(await requestChatData(argOf(), "model")).toEqual({
            type: "success",
            result: "from prov-1",
            model: "custom",
        });
        expect(provider1).toHaveBeenCalledTimes(1);
        expect(provider2).not.toHaveBeenCalled();
        expect(stubs.requestServer).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).toHaveBeenCalledWith(
            "custom",
            captured(),
            expect.objectContaining({ id: "prof-1", currentPluginProvider: "prov-1" }),
        );
        expect(selection.presetId).toBe("pp-2");
        expect(selection.modelPresetId).toBe("mp-2");
    });

    it("is refused up front, before the tools and the provider, once its captured model preset or preset is gone", async () => {
        deleteRecord("modelPresets", "mp-1");
        expect(await requestChatData(argOf(), "model")).toEqual({ type: "fail", result: MODEL_PRESET_GONE });
        expect(await requestChatDataMain(argOf(), "model")).toEqual({ type: "fail", result: MODEL_PRESET_GONE });
        deleteRecord("presets", "pp-1");
        expect(await requestChatData(argOf(), "model")).toEqual({ type: "fail", result: PRESET_GONE });
        expect(await requestChatDataMain(argOf(), "model")).toEqual({ type: "fail", result: PRESET_GONE });
        expect(stubs.getTools).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).not.toHaveBeenCalled();
        expect(provider1).not.toHaveBeenCalled();
        expect(provider2).not.toHaveBeenCalled();
        // The selected pair is untouched and still serves a request without a scope.
        const unscoped = { ...(argOf() as Record<string, unknown>), pluginContext: undefined } as never;
        expect(await requestChatData(unscoped, "model")).toMatchObject({ type: "success", result: "from prov-2" });
    });

    it("is refused, without the provider, when a captured preset is deleted while the tools load or during a replacerbeforeRequest hook", async () => {
        stubs.getTools.mockImplementationOnce(async () => {
            deleteRecord("presets", "pp-1");
            return [];
        });
        expect(await requestChatData(argOf(), "model")).toEqual({ type: "fail", result: PRESET_GONE });
        expect(provider1).not.toHaveBeenCalled();

        boot();
        const hook = vi.fn(async (formated: unknown) => {
            deleteRecord("modelPresets", "mp-1");
            return formated;
        });
        stubs.hooks.replacerbeforeRequest.add(hook);
        expect(await requestChatData(argOf(), "model")).toEqual({ type: "fail", result: MODEL_PRESET_GONE });
        expect(hook).toHaveBeenCalledTimes(1);
        expect(provider1).not.toHaveBeenCalled();
        expect(provider2).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).not.toHaveBeenCalled();
    });
});

// A chatless caller that sends several requests as one run (the tab's translator pipeline) captures
// the ids a chatless request would read (`requestIds`), and a request may name the profile it runs
// on (`profileId`) instead of its mode's slot.
describe("a chatless request's captured ids and named profile", () => {
    const requestIds = () => ({ presetId: "pp-1", modelPresetId: "mp-1", personaId: "p1" });
    const chatless = (extra: Record<string, unknown> = {}) =>
        ({
            formated: [{ role: "user", content: "hi" }],
            bias: {},
            useStreaming: false,
            requestIds: requestIds(),
            ...extra,
        }) as never;

    it("runs on the captured model preset's main profile, whatever is selected, and never sends the ids to the provider", async () => {
        expect(await requestChatData(chatless(), "model")).toEqual({
            type: "success",
            result: "from prov-1",
            model: "custom",
        });
        expect(provider1).toHaveBeenCalledTimes(1);
        expect(provider2).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).toHaveBeenCalledWith(
            "custom",
            requestIds(),
            expect.objectContaining({ id: "prof-1", currentPluginProvider: "prov-1" }),
        );
        // Without captured ids the selection serves, as before.
        expect(await requestChatData(chatless({ requestIds: undefined }), "model")).toMatchObject({
            result: "from prov-2",
        });
        expect(selection.presetId).toBe("pp-2");
        expect(selection.modelPresetId).toBe("mp-2");
    });

    it("is refused once a captured preset is gone: up front, or while the tools load, without the provider", async () => {
        deleteRecord("modelPresets", "mp-1");
        expect(await requestChatData(chatless(), "model")).toEqual({ type: "fail", result: MODEL_PRESET_GONE });
        expect(await requestChatDataMain(chatless(), "model")).toEqual({
            type: "fail",
            result: MODEL_PRESET_GONE,
        });
        expect(stubs.getTools).not.toHaveBeenCalled();
        boot();
        deleteRecord("presets", "pp-1");
        expect(await requestChatData(chatless(), "model")).toEqual({ type: "fail", result: PRESET_GONE });
        boot();
        stubs.getTools.mockImplementationOnce(async () => {
            deleteRecord("modelPresets", "mp-1");
            return [];
        });
        expect(await requestChatData(chatless(), "model")).toEqual({ type: "fail", result: MODEL_PRESET_GONE });
        expect(provider1).not.toHaveBeenCalled();
        expect(provider2).not.toHaveBeenCalled();
    });

    it("runs on the named profile over the captured model preset's slot, and refuses a missing named profile without a retry or a fallback", async () => {
        // The captured model preset's main profile is prof-1; the request names prof-2. The fixture's
        // sub slot (the `translate` route) names no existing profile, which a named profile makes moot.
        expect(await requestChatData(chatless({ profileId: "prof-2" }), "translate")).toEqual({
            type: "success",
            result: "from prov-2",
            model: "custom",
        });
        expect(provider2).toHaveBeenCalledTimes(1);
        expect(provider1).not.toHaveBeenCalled();
        expect(stubs.getModelInfo).toHaveBeenCalledWith(
            "custom",
            requestIds(),
            expect.objectContaining({ id: "prof-2", currentPluginProvider: "prov-2" }),
        );
        // A deleted profile: its own refusal, `noRetry`, and no provider (the slot is not consulted).
        for (const mode of ["translate", "model"] as const) {
            expect(await requestChatData(chatless({ profileId: "gone" }), mode)).toEqual({
                type: "fail",
                noRetry: true,
                result: language.modelProfiles.missingNamedRequest,
            });
        }
        expect(await requestChatDataMain(chatless({ profileId: "gone", staticModel: "custom" }), "model")).toEqual({
            type: "fail",
            noRetry: true,
            result: language.modelProfiles.missingNamedRequest,
        });
        expect(provider1).not.toHaveBeenCalled();
        expect(provider2).toHaveBeenCalledTimes(1);
        expect(stubs.requestServer).not.toHaveBeenCalled();
    });
});
