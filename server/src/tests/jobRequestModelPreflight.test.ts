// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { CallbackResult } from "../../../shared/jobs.ts";
import { LLMFlags, LLMFormat, type LLMModel, LLMProvider, LLMTokenizer } from "../../../shared/llm.ts";
import type { ModelModeExtended } from "../../../shared/llm/request.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { RequestContext } from "../llm/context.ts";
import { messages } from "../llm/messages.ts";
import { requestChatDataMain, requestModelLookup, resolveJobRequestModel } from "../llm/request.ts";
import { createLlmRequests, type JobRequestSpec } from "../llm/requests.ts";
import { loadRequestDb, type RequestDb, tokenScopeFor } from "../llm/settings.ts";

// `resolveJobRequestModel` (`server/src/llm/request.ts`), the model a job's own request would
// dispatch to, against the dispatch `runInJob` (`server/src/llm/requests.ts`) actually makes over the
// same settings: where the request went (the upstream URL and wire model, the tab's `provider`
// callback, the server's local generation, or a refusal before any of them) must be what the
// preflight's `modelInfo`, `db`, and `aiModel` say. The cases are the slot mechanics (an auxiliary
// slot's own profile, the sub slot when the mode's slot is unset, a named profile) and the formats
// the memory slot can resolve to: a custom model, the legacy plugin definition (profiled, and bare,
// which refuses), an admitted `pluginmodel:::` descriptor (also one declaring another format, and one
// not admitted at all: the job forces Plugin either way), a reverse proxy's `customAPIFormat` (a
// server format, and the browser-only Plugin and WebLLM, which the guard now sees after the
// override), and a local `hf:::` model (WebLLM, run on the server: never a tab dispatch).

const URLS = {
    main: "https://main.test/v1/chat/completions",
    sub: "https://sub.test/v1/chat/completions",
    memory: "https://memory.test/v1/chat/completions",
    named: "https://named.test/v1/chat/completions",
    instruct: "https://instruct.test/v1/completions",
    custom: "https://custom.test/v1/chat/completions",
};

/** A reverse proxy profile dispatching to its own URL and wire model; `fields` override. */
const proxy = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: id,
    modelId: "reverse_proxy",
    forceReplaceUrl: URLS[id as keyof typeof URLS] ?? URLS.main,
    customProxyRequestModel: `${id}-model`,
    customAPIFormat: LLMFormat.OpenAICompatible,
    ...fields,
});

/** A provider descriptor as the tab registers it, admitted for the job (`db.pluginModels`). */
const descriptor = (name: string, format: LLMFormat = LLMFormat.Plugin): LLMModel => ({
    id: `pluginmodel:::${name}`,
    name,
    shortName: name,
    fullName: name,
    internalID: `pluginmodel:::${name}`,
    provider: LLMProvider.AsIs,
    format,
    flags: [LLMFlags.hasFullSystemPrompt],
    parameters: ["temperature"],
    tokenizer: LLMTokenizer.Unknown,
});

/** The settings: the model preset `m` whose `memory` slot is `memory` (a profile id or a bare model id). */
function records(memory: { profileId: string } | { modelId: string } = { profileId: "memory" }) {
    return {
        providers: normalizeProviders({ requestRetrys: 0 }),
        llmSecrets: normalizeLlmSecrets({}),
        ui: { autoSuggestPrefix: "" },
        customModels: [
            {
                id: "xcustom:::mine",
                name: "Mine",
                internalId: "mine-1",
                url: URLS.custom,
                format: LLMFormat.OpenAICompatible,
                flags: [LLMFlags.hasFullSystemPrompt],
                tokenizer: LLMTokenizer.Unknown,
                params: "",
            },
        ],
        credentials: [],
        presets: normalizePresets([{ id: "p", name: "p" }]),
        modelProfiles: normalizeModelProfiles([
            proxy("main"),
            proxy("sub"),
            proxy("memory"),
            proxy("named"),
            proxy("instruct", { customAPIFormat: LLMFormat.OpenAILegacyInstruct }),
            proxy("proxyPlugin", { customAPIFormat: LLMFormat.Plugin, currentPluginProvider: "proxy-provider" }),
            proxy("proxyLocal", { customAPIFormat: LLMFormat.WebLLM }),
            { id: "legacy", name: "legacy", modelId: "custom", currentPluginProvider: "legacy-provider" },
            { id: "xc", name: "xc", modelId: "xcustom:::mine" },
            { id: "prov", name: "prov", modelId: "pluginmodel:::prov" },
            { id: "ghost", name: "ghost", modelId: "pluginmodel:::ghost" },
            { id: "local", name: "local", modelId: "hf:::tiny" },
            { id: "catalogueLocal", name: "catalogueLocal", modelId: "hf:::Xenova/opt-350m" },
        ]),
        modelPresets: normalizeModelPresets([
            {
                id: "m",
                name: "m",
                mainSlot: { profileId: "main" },
                subSlot: { profileId: "sub" },
                auxSlots: { memory },
                seperateModelsForAxModels: true,
            },
        ]),
        personas: normalizePersonas([{ id: "u", name: "Uma" }]),
    };
}

/** The settings singletons, and the selected character `c` (the local model's chat template names it). */
function fakeStore(data: Record<string, unknown>): ResourceStore {
    const characters: Record<string, unknown> = { c: { chaId: "c", name: "Cara" } };
    return {
        readRefs: (refs: { kind: { name: string }; id: string }[]) => ({
            items: refs.map((ref) => ({
                kind: ref.kind.name,
                id: ref.id,
                revision: null,
                data: ref.kind.name === "characters" ? (characters[ref.id] ?? null) : (data[ref.kind.name] ?? null),
            })),
        }),
    } as unknown as ResourceStore;
}

const kinds = { get: (name: string) => ({ name }) } as unknown as ResourceKindRegistry;
const ids = {
    presetId: "p",
    modelPresetId: "m",
    personaId: "u",
    selectedPersonaId: "u",
    selectedCharacterId: "c",
    speakerId: null,
};

/** The job's request settings over `records`, with the admitted provider descriptors. */
function jobDb(memory?: Parameters<typeof records>[0], admitted: LLMModel[] = []) {
    const loaded = loadRequestDb(fakeStore(records(memory)), kinds, ids);
    const db: RequestDb = { ...loaded.db, pluginModels: admitted };
    return { loaded: { ...loaded, db }, db };
}

/** Where a job's request went. */
type Dispatch =
    | { kind: "upstream"; url: string; body: Record<string, unknown> }
    | { kind: "provider"; name: string }
    | { kind: "local"; model: string }
    | { kind: "refused"; result: string }
    | { kind: "none" };

const PROVIDERS = ["legacy-provider", "prov", "proxy-provider"];

/** A registry over `records` whose upstream, tab callback, and local generation are recorded. */
function harness(options: { localGeneration?: boolean } = {}) {
    const dispatches: Dispatch[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const text =
            typeof init.body === "string"
                ? init.body
                : init.body
                  ? new TextDecoder().decode(init.body as Uint8Array)
                  : "{}";
        dispatches.push({ kind: "upstream", url, body: JSON.parse(text) as Record<string, unknown> });
        return new Response(
            JSON.stringify({
                choices: [{ message: { role: "assistant", content: "upstream answer" }, text: "upstream answer" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as typeof fetch;
    const registry = createLlmRequests({
        store: fakeStore(records()),
        kinds,
        tokens: { encode: async () => [7], count: async () => 1 } as never,
        vertexTokens: { get: async () => "vertex-token", clear() {} } as never,
        claudeObserver: { register() {}, reset() {}, dispose() {} } as never,
        parentCallback: () => null,
        fetchImpl,
        ...(options.localGeneration === false
            ? {}
            : {
                  localGeneration: async (_text: string, model: string) => {
                      dispatches.push({ kind: "local", model });
                      return "local answer";
                  },
              }),
    });
    /** The job's own request for `mode`: its one dispatch, or the refusal it ended with. */
    async function dispatch(
        loaded: ReturnType<typeof jobDb>["loaded"],
        mode: ModelModeExtended,
        select: { profileId?: string } = {},
    ): Promise<Dispatch> {
        const spec: JobRequestSpec = {
            jobId: "job",
            loaded,
            mode,
            arg: { formated: [{ role: "user", content: "hi" }], bias: {}, useStreaming: false, ...select },
            source: "lua",
            chatRef: null,
            tokenScope: tokenScopeFor(loaded.db),
            mainModelImageInput: false,
            channel: {
                notice() {},
                ask: async () => ({ outcome: "aborted" }),
                callback: async (name, payload): Promise<CallbackResult> => {
                    if (name !== "provider") {
                        return { outcome: "refused", refusal: "unregistered", error: "none" };
                    }
                    const provider = (payload as { name: string }).name;
                    dispatches.push({ kind: "provider", name: provider });
                    return PROVIDERS.includes(provider)
                        ? { outcome: "answered", value: { success: true, content: "plugin answer" } }
                        : { outcome: "refused", refusal: "unregistered", error: "not registered" };
                },
            },
            parseCbs: (text) => text,
            inlays: {
                saveSignature: async (id) => id,
                writeImage: async (image) => image.id,
                setAsset: async () => {},
            },
            alertError: () => {},
            endJob: () => {},
            tools: { descriptors: [], charge: () => true, limit: 64, call: async () => [] },
            toolCalls: { read: () => undefined, write: () => {} },
            signal: new AbortController().signal,
        };
        const before = dispatches.length;
        const response = await registry.runInJob(spec);
        const made = dispatches.slice(before);
        expect(made.length, JSON.stringify(response)).toBeLessThanOrEqual(1);
        if (made.length === 1) {
            return made[0];
        }
        return response.type === "fail" ? { kind: "refused", result: response.result } : { kind: "none" };
    }
    return { registry, dispatch };
}

const registries: ReturnType<typeof createLlmRequests>[] = [];
afterEach(async () => {
    for (const registry of registries.splice(0)) {
        await registry.dispose();
    }
});

describe("the job request model preflight against the job's dispatch", () => {
    it("resolves the slot as the dispatch does: the auxiliary slot's profile, the sub slot when the mode's slot is unset, and a named profile over the slot", async () => {
        const { registry, dispatch } = harness();
        registries.push(registry);
        const { loaded, db } = jobDb();
        for (const [mode, select, profileId] of [
            ["memory", {}, "memory"],
            ["translate", {}, "sub"],
            ["model", {}, "main"],
            ["memory", { profileId: "named" }, "named"],
        ] as [ModelModeExtended, { profileId?: string }, string][]) {
            const resolved = resolveJobRequestModel(db, mode, select);
            expect(resolved.kind, mode).toBe("resolved");
            if (resolved.kind !== "resolved") {
                return;
            }
            expect(resolved.profile?.id).toBe(profileId);
            expect(resolved.aiModel).toBe("reverse_proxy");
            expect(resolved.modelInfo.format).toBe(LLMFormat.OpenAICompatible);
            expect(await dispatch(loaded, mode, select)).toEqual({
                kind: "upstream",
                url: resolved.db.forceReplaceUrl,
                body: expect.objectContaining({ model: resolved.modelInfo.internalID }),
            });
            expect(resolved.db.forceReplaceUrl).toBe(URLS[profileId as keyof typeof URLS]);
        }
    });

    it("resolves a custom model's format, URL, and wire model as the dispatch does", async () => {
        const { registry, dispatch } = harness();
        registries.push(registry);
        const { loaded, db } = jobDb({ profileId: "xc" });
        const resolved = resolveJobRequestModel(db, "memory");
        expect(resolved).toMatchObject({
            kind: "resolved",
            aiModel: "xcustom:::mine",
            modelInfo: { format: LLMFormat.OpenAICompatible, internalID: "mine-1" },
        });
        expect(await dispatch(loaded, "memory")).toEqual({
            kind: "upstream",
            url: URLS.custom,
            body: expect.objectContaining({ model: "mine-1" }),
        });
    });

    it("tells a tab dispatch (`LLMFormat.Plugin`) for the legacy plugin definition on a profile and for a `pluginmodel:::` id whatever its admitted descriptor says, and refuses the bare legacy definition as the dispatch does", async () => {
        const { registry, dispatch } = harness();
        registries.push(registry);
        for (const [memory, admitted, provider] of [
            [{ profileId: "legacy" }, [], "legacy-provider"],
            [{ profileId: "prov" }, [descriptor("prov")], "prov"],
            // A descriptor declaring a server format: the job's lookup still forces Plugin.
            [{ profileId: "prov" }, [descriptor("prov", LLMFormat.OpenAICompatible)], "prov"],
            // No admitted descriptor at all: the tab is asked, and answers that it has no such provider.
            [{ profileId: "ghost" }, [], "ghost"],
        ] as [Parameters<typeof records>[0], LLMModel[], string][]) {
            const { loaded, db } = jobDb(memory, admitted);
            const resolved = resolveJobRequestModel(db, "memory");
            expect(resolved, provider).toMatchObject({ kind: "resolved", modelInfo: { format: LLMFormat.Plugin } });
            expect(await dispatch(loaded, "memory"), provider).toEqual({ kind: "provider", name: provider });
        }
        const bare = jobDb({ modelId: "custom" });
        const refused = resolveJobRequestModel(bare.db, "memory");
        expect(refused).toEqual({ kind: "refused", result: messages.errors.modelProfileRequired("custom") });
        expect(await dispatch(bare.loaded, "memory")).toEqual({
            kind: "refused",
            result: (refused as { result: string }).result,
        });
    });

    it("applies a reverse proxy's `customAPIFormat` before deciding: a server format dispatches upstream, Plugin goes to the tab, WebLLM to the local model, and without the callback both are refused", async () => {
        const { registry, dispatch } = harness();
        registries.push(registry);
        const instruct = jobDb({ profileId: "instruct" });
        expect(resolveJobRequestModel(instruct.db, "memory")).toMatchObject({
            kind: "resolved",
            modelInfo: { format: LLMFormat.OpenAILegacyInstruct, internalID: "instruct-model" },
        });
        expect(await dispatch(instruct.loaded, "memory")).toEqual({
            kind: "upstream",
            url: URLS.instruct,
            body: expect.objectContaining({ prompt: expect.any(String) }),
        });

        const plugin = jobDb({ profileId: "proxyPlugin" });
        expect(resolveJobRequestModel(plugin.db, "memory")).toMatchObject({
            kind: "resolved",
            aiModel: "reverse_proxy",
            modelInfo: { format: LLMFormat.Plugin },
        });
        expect(await dispatch(plugin.loaded, "memory")).toEqual({ kind: "provider", name: "proxy-provider" });

        const local = jobDb({ profileId: "proxyLocal" });
        expect(resolveJobRequestModel(local.db, "memory")).toMatchObject({
            kind: "resolved",
            modelInfo: { format: LLMFormat.WebLLM },
        });
        // WebLLM runs the reverse proxy profile's configured request model.
        expect(await dispatch(local.loaded, "memory")).toEqual({ kind: "local", model: "proxyLocal-model" });

        // A request without the tab callback or the local models (a tab's own request, a registry
        // without local generation): the guard refuses on the overridden format, before any adapter.
        const refusal = `Custom API runs in the browser, not on the server.`;
        for (const { db } of [plugin, local]) {
            const ctx = {
                db,
                getModelInfo: requestModelLookup(db, () => []),
                signal: new AbortController().signal,
            } as unknown as RequestContext;
            const arg = {
                formated: [{ role: "user" as const, content: "hi" }],
                bias: {},
                useStreaming: false,
                tools: [],
            };
            expect(await requestChatDataMain(arg, "memory", ctx)).toEqual({
                type: "fail",
                result: refusal,
                noRetry: true,
            });
        }
        const serverOnly = harness({ localGeneration: false });
        registries.push(serverOnly.registry);
        expect(await serverOnly.dispatch(local.loaded, "memory")).toEqual({ kind: "refused", result: refusal });
    });

    it("tells a server dispatch for dynamic and catalogue `hf:::` models (`LLMFormat.WebLLM`, never Plugin), as the dispatch runs them", async () => {
        const { registry, dispatch } = harness();
        registries.push(registry);
        const { loaded, db } = jobDb({ profileId: "local" });
        const resolved = resolveJobRequestModel(db, "memory");
        expect(resolved).toMatchObject({
            kind: "resolved",
            aiModel: "hf:::tiny",
            modelInfo: { format: LLMFormat.WebLLM },
        });
        expect((resolved as { modelInfo: LLMModel }).modelInfo.format).not.toBe(LLMFormat.Plugin);
        expect(await dispatch(loaded, "memory")).toEqual({ kind: "local", model: "tiny" });

        const catalogue = jobDb({ profileId: "catalogueLocal" });
        expect(await dispatch(catalogue.loaded, "memory")).toEqual({ kind: "local", model: "Xenova/opt-350m" });
    });
});
