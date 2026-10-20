// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { character } from "../storage/database.svelte";
import type { ChannelAnswer } from "../../../shared/jobs.ts";

const deps = vi.hoisted(() => ({
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    fetch: vi.fn(),
    auxFetchJson: vi.fn(),
    request: vi.fn(),
    zip: vi.fn(),
    alert: vi.fn(),
}));
vi.mock("../globalApi.svelte", () => ({
    globalFetch: deps.globalFetch,
    fetchNative: deps.fetchNative,
    readImage: vi.fn(),
    saveAsset: vi.fn(),
}));
vi.mock("../network/auxFetch", () => ({ auxFetchJson: deps.auxFetchJson }));
vi.mock("./request/request", () => ({ requestChatData: deps.request }));
vi.mock("./processzip", () => ({ processZip: deps.zip }));
vi.mock("../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: deps.alert,
    }),
);
vi.mock("./modules", () => ({ moduleUpdate: vi.fn() }));
vi.mock("../parser/transformClient", () => ({ resetTransformEffects: vi.fn() }));
vi.mock("../parser/parser.svelte", () => ({
    risuChatParser: (text: string) => text,
    risuChatParserScoped: (text: string) => text,
}));

import { CharEmotion } from "../stores.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { installFlatDatabase } from "../storage/tests/installFlatDatabase";
import * as resourceSync from "../storage/resourceSync.svelte";
import { endJobChannel, handleChannelEvent } from "../network/jobChannel";
import { generateAIImage, stableDiff } from "./stableDiff";

const char = {
    chaId: "image-character",
    type: "character",
    name: "Image character",
    newGenData: { instructions: "Describe the scene.", prompt: "Illustrate {{slot}}", negative: "blurry" },
} as character;
const uri = "data:image/png;base64,AQID";
const original = { [char.chaId]: [["old", "old.png", 1]] as [string, string, number][] };
const newer = { other: [["newer", "newer.png", 2]] as [string, string, number][] };
const imagen = {
    ok: true,
    status: 200,
    data: { predictions: [{ bytesBase64Encoded: "AQID", mimeType: "image/png" }] },
};
const jobs: string[] = [];
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.resetAllMocks();
    installFlatDatabase({
        characters: [structuredClone(char)],
        sdProvider: "Imagen",
        ImagenModel: "imagen-4.0-generate-001",
        ImagenImageSize: "1K",
        ImagenAspectRatio: "1:1",
        ImagenPersonGeneration: "allow_all",
        webUiUrl: "https://webui.test/",
        sdConfig: { width: 512, height: 512 },
        NAIImgModel: "nai-diffusion-3",
        NAIImgConfig: {},
        NAIImgUrl: "https://novelai.test",
        stabilityModel: "core",
        stabilityKey: "test",
        falModel: "fal-ai/flux-pro",
        comfyUiUrl: "https://comfy.test",
        comfyConfig: {
            workflow: JSON.stringify({
                "1": { inputs: { text: "{{risu_prompt}}" } },
                "2": { inputs: { text: "{{risu_neg}}" } },
            }),
            posNodeID: "1",
            posInputName: "text",
            negNodeID: "2",
            negInputName: "text",
            timeout: 10,
        },
        openaiCompatImage: { url: "https://compat.test" },
        wavespeedImage: { key: "test", model: "image-model" },
    });
    deps.request.mockResolvedValue({ type: "success", result: "a quiet garden" });
    deps.auxFetchJson.mockResolvedValue(imagen);
    CharEmotion.set(structuredClone(original));
    vi.spyOn(resourceSync, "flushResources").mockResolvedValue({ discarded: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", deps.fetch);
});
afterEach(() => {
    jobs.splice(0).forEach(endJobChannel);
    CharEmotion.set({});
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("generated image delivery", () => {
    it("replaces the displayed image with Imagen through stableDiff and returns an empty string", async () => {
        const start = Date.now();
        await expect(stableDiff(char, "describe the garden")).resolves.toBe("");
        expect(deps.request).toHaveBeenCalledWith(expect.anything(), "submodel");
        expect(deps.auxFetchJson).toHaveBeenCalledWith(
            "google-imagen",
            "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict",
            expect.objectContaining({
                body: expect.objectContaining({ instances: [{ prompt: "Illustrate a quiet garden" }] }),
            }),
        );
        expect(get(CharEmotion)[char.chaId]).toEqual([[uri, uri, expect.any(Number)]]);
        expect(get(CharEmotion)[char.chaId][0][2]).toBeGreaterThanOrEqual(start);
        expect(get(CharEmotion)[char.chaId][0][2]).toBeLessThanOrEqual(Date.now());
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("returns an Imagen inlay URI without writing to CharEmotion", async () => {
        const before = get(CharEmotion);
        const writes = vi.fn();
        const unsubscribe = CharEmotion.subscribe(writes);
        writes.mockClear();
        try {
            await expect(generateAIImage("garden", char, "blurry", "inlay")).resolves.toBe(uri);
            expect(get(CharEmotion)).toBe(before);
            expect(writes).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
        }
    });

    it("answers the imggen job callback true only after Imagen has reached the real display store", async () => {
        const jobId = "image-delivery-job";
        jobs.push(jobId);
        const sent = deferred<ChannelAnswer>();
        let displayedAtAnswer: Record<string, [string, string, number][]>;
        handleChannelEvent(
            jobId,
            {
                type: "callback",
                epoch: "test",
                id: "image-callback",
                jobId,
                name: "imggen",
                targets: {
                    chatRef: { chaId: char.chaId, chatId: "image-chat" },
                    presetId: "fixture-preset",
                    modelPresetId: "fixture-preset",
                    personaId: "",
                },
                revisions: [],
                deadline: Date.now() + 10_000,
                payload: { characterId: char.chaId, text: "garden conversation" },
            },
            {
                send: (message) => {
                    displayedAtAnswer = get(CharEmotion);
                    sent.resolve(message as ChannelAnswer);
                    return true;
                },
            },
        );
        await expect(sent.promise).resolves.toMatchObject({
            type: "answer",
            id: "image-callback",
            outcome: "answered",
            value: true,
        });
        expect(displayedAtAnswer[char.chaId]).toEqual([[uri, uri, expect.any(Number)]]);
        expect(deps.request).toHaveBeenCalledOnce();
        expect(deps.auxFetchJson).toHaveBeenCalledOnce();
    });

    it("preserves newer CharEmotion writes while every backend awaits its image, including NovelAI ZIP processing", async () => {
        for (const provider of [
            "webui",
            "novelai",
            "dalle",
            "stability",
            "comfy",
            "comfyui",
            "fal",
            "Imagen",
            "openai-compat",
            "wavespeed",
        ]) {
            settings.memoryTranslateMedia.sdProvider = provider;
            CharEmotion.set(structuredClone(original));
            let reached = false;
            const release = deferred<void>();
            async function delayed<T>(result: T) {
                reached = true;
                await release.promise;
                return result;
            }
            const bytes = () => new Response(new Uint8Array([1, 2, 3]));
            deps.globalFetch.mockImplementation(async (url: string) => {
                switch (provider) {
                    case "webui":
                        return delayed({ ok: true, data: { images: ["AQID"] } });
                    case "novelai":
                        return { ok: true, data: new Uint8Array([1, 2, 3]) };
                    case "comfy":
                    case "comfyui":
                        return { ok: true, data: { prompt_id: "generated" } };
                    case "fal":
                        return delayed({ ok: true, data: { images: [{ url: "https://images.test/result.png" }] } });
                    case "openai-compat":
                        return delayed({ ok: true, data: { data: [{ b64_json: "AQID" }] } });
                    case "wavespeed":
                        if (url.endsWith("/image-model")) return { ok: true, data: { data: { id: "generated" } } };
                        if (url.endsWith("/result"))
                            return {
                                ok: true,
                                data: { data: { status: "completed", outputs: ["https://images.test/file"] } },
                            };
                        return delayed({
                            ok: true,
                            data: new Uint8Array([1, 2, 3]),
                            headers: { "content-type": "image/png" },
                        });
                    default:
                        throw new Error(`Unexpected transport for ${provider}`);
                }
            });
            deps.zip.mockImplementation(() => delayed(uri));
            deps.auxFetchJson.mockImplementation(() =>
                delayed(provider === "Imagen" ? imagen : { ok: true, data: { data: [{ b64_json: "AQID" }] } }),
            );
            deps.fetch.mockImplementation(() => delayed(bytes()));
            deps.fetchNative.mockImplementation(async (url: string) =>
                url.endsWith("/history")
                    ? Response.json({
                          generated: {
                              outputs: { "1": { images: [{ filename: "image.png", subfolder: "", type: "output" }] } },
                          },
                      })
                    : delayed(bytes()),
            );
            const work = generateAIImage("garden", char, "blurry", "");
            await vi.waitFor(() => {
                expect(deps.alert, provider).not.toHaveBeenCalled();
                expect(reached, provider).toBe(true);
            });
            // A different character's image arrives after generation (and, for NovelAI, ZIP decoding) began.
            CharEmotion.set({ ...get(CharEmotion), ...newer });
            release.resolve();
            await expect(work, provider).resolves.toBe("");
            const expectedUri = provider === "fal" ? "https://images.test/result.png" : uri;
            expect(get(CharEmotion), provider).toEqual({
                ...newer,
                [char.chaId]: [[expectedUri, expectedUri, expect.any(Number)]],
            });
            expect(deps.alert, provider).not.toHaveBeenCalled();
        }
    });
});
