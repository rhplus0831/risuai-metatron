// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import { normalizePersonas } from "../../../shared/personas.ts";
import { normalizeModelPresets, normalizeModelProfiles, normalizePresets } from "../../../shared/presets.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import type { RequestContext } from "../llm/context.ts";
import { requestChatDataMain } from "../llm/request.ts";
import { loadRequestDb } from "../llm/settings.ts";
import { createTransport } from "../llm/transport.ts";

async function run(modelId: string) {
    const records: Record<string, unknown> = {
        providers: normalizeProviders({ vertexRegion: "us-central1", requestRetrys: 0 }),
        llmSecrets: normalizeLlmSecrets({
            google: { projectId: "test-project" },
            vertexClientEmail: "svc@example.test",
            vertexPrivateKey: "fake-private-key",
        }),
        ui: { autoSuggestPrefix: "" },
        customModels: [],
        credentials: [],
        presets: normalizePresets([{ id: "p", name: "Prompt" }]),
        modelProfiles: normalizeModelProfiles([{ id: "main", name: "Connection", modelId }]),
        modelPresets: normalizeModelPresets([{ id: "m", name: "Model", mainSlot: { profileId: "main" } }]),
        personas: normalizePersonas([{ id: "u", name: "User" }]),
    };
    const loaded = loadRequestDb(
        {
            readRefs: (refs: { kind: { name: string }; id: string }[]) => ({
                items: refs.map((ref) => ({
                    kind: ref.kind.name,
                    id: ref.id,
                    revision: null,
                    data: records[ref.kind.name] ?? null,
                })),
            }),
        } as never,
        { get: (name: string) => ({ name }) } as never,
        {
            presetId: "p",
            modelPresetId: "m",
            personaId: "u",
            selectedPersonaId: "u",
            selectedCharacterId: null,
            speakerId: null,
        },
    );
    const signal = new AbortController().signal;
    const urls: string[] = [];
    const transport = createTransport({
        signal,
        log: () => {},
        fetchImpl: async (input) => {
            urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
            return Response.json({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] });
        },
    });
    const ctx: RequestContext = {
        ...loaded,
        signal,
        transport,
        alertError: (message) => {
            throw new Error(String(message));
        },
        redactText: (text) => text,
        tokenizeNum: async () => [7],
        strongBan: async (_text, bias) => bias,
        parseCbs: async (text) => text,
        tools: { call: async () => [], encode: async () => "", decode: async () => undefined },
        inlays: {
            saveSignature: async (id) => id,
            writeImage: async (image) => image.id,
            setAsset: async () => {},
        },
        intercept: async (body) => body,
        supportsInlayImage: () => false,
        getModelInfo: resolveModelInfo,
        vertexAccessToken: async () => "fake-vertex-token",
        registerClaudeObserver: () => {},
    };
    await requestChatDataMain(
        { formated: [{ role: "user", content: "Hello" }], bias: {}, useStreaming: false, tools: [] },
        "model",
        ctx,
    );
    return urls;
}

describe("Vertex model endpoints", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each([
        [
            "gemini-4-argon-vertex",
            "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-4-argon:generateContent",
        ],
        [
            "gemini-flash-latest-vertex",
            "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-flash-latest:generateContent",
        ],
    ])("sends %s to global when the configured region is us-central1", async (modelId, url) => {
        expect(await run(modelId)).toEqual([url]);
    });

    it("sends gemini-2.5-flash-vertex to the configured us-central1 region", async () => {
        expect(await run("gemini-2.5-flash-vertex")).toEqual([
            "https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
        ]);
    });
});
