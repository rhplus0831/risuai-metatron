// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { flushSync, mount, unmount } from "svelte";
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
    clickResult: vi.fn(),
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
vi.mock("src/lib/UI/GUI/Button.svelte", async (importOriginal) => {
    const actual = await importOriginal<typeof import("src/lib/UI/GUI/Button.svelte")>();
    return {
        ...actual,
        // Keep the real button and DOM click; expose the event promise so the test can handle
        // a deliberately rejected request instead of leaving an unhandled event rejection.
        default: ((anchor, props) =>
            actual.default(anchor, {
                ...props,
                onclick(event) {
                    const result = props.onclick?.(event);
                    deps.clickResult(result);
                    return result;
                },
            })) satisfies typeof actual.default,
    };
});

import { CharEmotion } from "../stores.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { installFlatDatabase } from "../storage/tests/installFlatDatabase";
import * as resourceSync from "../storage/resourceSync.svelte";
import { endJobChannel, handleChannelEvent } from "../network/jobChannel";
import { generateAIImage, stableDiff } from "./stableDiff";
import * as inlays from "./files/inlays";

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
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
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
    it("returns the Playground Generate button to idle after generation rejects and allows another run", async () => {
        const { default: PlaygroundImageGen } = await import("src/lib/Playground/PlaygroundImageGen.svelte");
        settings.memoryTranslateMedia.sdProvider = "stability";
        const pending = deferred<Response>();
        const error = new Error("Image provider unavailable");
        deps.fetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
        deps.clickResult.mockImplementation((result: Promise<void>) => result.catch(() => {}));
        const target = document.createElement("div");
        document.body.appendChild(target);
        const component = mount(PlaygroundImageGen, { target });
        try {
            flushSync();
            const button = target.querySelector("button")!;
            button.click();
            flushSync();
            expect(button.textContent.trim()).toBe("");
            expect(button.querySelector(".loadmove")).not.toBeNull();
            pending.reject(error);
            await expect(deps.clickResult.mock.lastCall![0]).rejects.toBe(error);
            flushSync();

            expect(button.textContent.trim()).toBe("Generate");
            expect(button.querySelector(".loadmove")).toBeNull();
            button.click();
            await deps.clickResult.mock.lastCall![0];
            flushSync();
            expect(deps.fetch).toHaveBeenCalledTimes(2);
            expect(target.querySelector("img")?.getAttribute("src")).toBe(uri);
        } finally {
            await unmount(component);
            target.remove();
        }
    });

    it("replaces the displayed image with Imagen through stableDiff and returns an empty string", async () => {
        const start = Date.now();
        await expect(stableDiff(char, "describe the garden")).resolves.toBe("");
        expect(deps.request).toHaveBeenCalledWith(expect.anything(), "submodel", undefined);
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
                new URL(url).pathname === "/history/generated"
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

describe("image orientation", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        settings.memoryTranslateMedia.sdProvider = "novelai";
        deps.globalFetch.mockResolvedValue({ ok: true, data: new Uint8Array([1, 2, 3]) });
        deps.zip.mockResolvedValue(uri);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        { width: 832, height: 1216 },
        { width: 1216, height: 832 },
    ])(
        "uses the requested NovelAI orientation and preserves an omitted orientation for $width×$height",
        async ({ width, height }) => {
            settings.memoryTranslateMedia.NAIImgConfig.width = width;
            settings.memoryTranslateMedia.NAIImgConfig.height = height;
            for (const [options, expected] of [
                [{ orientation: "landscape" }, { width: 1216, height: 832 }],
                [{ orientation: "portrait" }, { width: 832, height: 1216 }],
                [undefined, { width, height }],
            ] as const) {
                deps.globalFetch.mockClear();
                await expect(generateAIImage("garden", char, "blurry", "inlay", options)).resolves.toBe(uri);
                const parameters = deps.globalFetch.mock.lastCall?.[1].body.parameters;
                expect(
                    { width: parameters?.width, height: parameters?.height },
                    options?.orientation ?? "configured",
                ).toEqual(expected);
            }
        },
    );

    it("requests the callback's NovelAI orientation and keeps the configured size when the field is absent", async () => {
        settings.memoryTranslateMedia.NAIImgConfig.width = 832;
        settings.memoryTranslateMedia.NAIImgConfig.height = 1216;
        // Canvas rendering and inlay persistence are I/O boundaries after the provider request.
        vi.spyOn(inlays, "writeInlayImage").mockResolvedValue("generated-inlay");

        for (const [orientation, expected] of [
            ["landscape", { width: 1216, height: 832 }],
            [undefined, { width: 832, height: 1216 }],
        ] as const) {
            deps.globalFetch.mockClear();
            const jobId = `image-orientation-${orientation ?? "configured"}`;
            jobs.push(jobId);
            const sent = deferred<ChannelAnswer>();
            handleChannelEvent(
                jobId,
                {
                    type: "callback",
                    epoch: "test",
                    id: jobId,
                    jobId,
                    name: "generateImage",
                    targets: {
                        chatRef: { chaId: char.chaId, chatId: "image-chat" },
                        presetId: "fixture-preset",
                        modelPresetId: "fixture-preset",
                        personaId: "",
                    },
                    revisions: [],
                    deadline: Date.now() + 10_000,
                    payload: {
                        characterId: char.chaId,
                        prompt: "garden",
                        negative: "blurry",
                        ...(orientation === undefined ? {} : { orientation }),
                    },
                },
                {
                    send: (message) => {
                        sent.resolve(message as ChannelAnswer);
                        return true;
                    },
                },
            );
            await expect(sent.promise).resolves.toMatchObject({ outcome: "answered" });
            const parameters = deps.globalFetch.mock.lastCall?.[1].body.parameters;
            expect({ width: parameters?.width, height: parameters?.height }, orientation ?? "configured").toEqual(
                expected,
            );
        }
    });

    it("keeps WebUI's configured dimensions for either orientation", async () => {
        settings.memoryTranslateMedia.sdProvider = "webui";
        settings.memoryTranslateMedia.sdConfig.width = 832;
        settings.memoryTranslateMedia.sdConfig.height = 1216;
        deps.globalFetch.mockResolvedValue({ ok: true, data: { images: ["AQID"] } });
        for (const orientation of ["landscape", "portrait"] as const) {
            deps.globalFetch.mockClear();
            await expect(generateAIImage("garden", char, "blurry", "inlay", { orientation })).resolves.toBe(uri);
            const body = deps.globalFetch.mock.lastCall?.[1].body;
            expect({ width: body?.width, height: body?.height }, orientation).toEqual({ width: 832, height: 1216 });
        }
    });
});

describe("cancellable image generation", () => {
    const completedHistory = {
        generated: {
            outputs: { "1": { images: [{ filename: "image.png", subfolder: "", type: "output" }] } },
        },
    };
    const bytes = () => new Response(new Uint8Array([1, 2, 3]));

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("alerts on a failed ComfyUI view response without delivering its HTTP error page", async () => {
        settings.memoryTranslateMedia.sdProvider = "comfyui";
        deps.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: "generated" } });
        for (const delivery of ["", "inlay"]) {
            deps.alert.mockClear();
            deps.fetchNative.mockResolvedValueOnce(Response.json(completedHistory)).mockResolvedValueOnce(
                new Response("<html>Service unavailable</html>", {
                    status: 503,
                    headers: { "content-type": "text/html" },
                }),
            );
            const before = get(CharEmotion);

            await expect(generateAIImage("garden", char, "blurry", delivery)).resolves.toBe(false);
            expect(deps.alert).toHaveBeenCalledOnce();
            expect(get(CharEmotion)).toBe(before);
        }
    });

    it("alerts on a Stability JSON response without delivering the JSON as an image", async () => {
        settings.memoryTranslateMedia.sdProvider = "stability";
        const errorBody = JSON.stringify({ errors: ["Image generation failed"] });
        for (const delivery of ["", "inlay"]) {
            deps.alert.mockClear();
            // A successful HTTP status still does not make a JSON body an image.
            deps.fetch.mockResolvedValueOnce(
                new Response(errorBody, {
                    status: 200,
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                }),
            );
            const before = get(CharEmotion);

            await expect(generateAIImage("garden", char, "blurry", delivery)).resolves.toBe(false);
            expect(deps.alert).toHaveBeenCalledOnce();
            expect(get(CharEmotion)).toBe(before);
        }
    });

    describe("NovelAI character reference decoding", () => {
        const reference = Buffer.from("undecodable character reference").toString("base64");
        class ControlledImage {
            onload: (() => void) | null = null;
            onerror: ((error: Event) => void) | null = null;
            src = "";
            constructor() {
                image = this;
                decoding.resolve();
            }
        }
        let image: ControlledImage;
        let decoding: ReturnType<typeof deferred<void>>;
        beforeEach(() => {
            settings.memoryTranslateMedia.sdProvider = "novelai";
            settings.memoryTranslateMedia.NAIImgModel = "nai-diffusion-4-5-full";
            settings.memoryTranslateMedia.NAIImgConfig.reference_mode = "character";
            settings.memoryTranslateMedia.NAIImgConfig.character_image = "reference.png";
            settings.memoryTranslateMedia.NAIImgConfig.character_base64image = reference;
            deps.globalFetch.mockResolvedValue({ ok: true, data: new Uint8Array([1, 2, 3]) });
            deps.zip.mockResolvedValue(uri);
            vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as any);
            vi.spyOn(console, "warn").mockImplementation(() => {});
            decoding = deferred<void>();
            vi.stubGlobal("Image", ControlledImage);
        });

        it("finishes with the original NovelAI character reference when image decoding fails", async () => {
            let result: string | false | undefined;
            const work = generateAIImage("garden", char, "blurry", "inlay").then((value) => {
                result = value;
            });
            await decoding.promise;
            expect(image.src).toBe(`data:image/png;base64,${reference}`);
            image.onerror?.(new Event("error"));
            await vi.advanceTimersByTimeAsync(0);

            expect(result).toBe(uri);
            await work;
            expect(deps.globalFetch.mock.lastCall![1].body.parameters.director_reference_images).toEqual([reference]);
            expect(deps.alert).not.toHaveBeenCalled();
        });

        it("settles a cancellation while the NovelAI character reference is still decoding", async () => {
            const controller = new AbortController();
            const reason = new DOMException("Stopped", "AbortError");
            const resolved = vi.fn();
            const rejected = vi.fn();
            const before = get(CharEmotion);
            const work = generateAIImage("garden", char, "blurry", "", { signal: controller.signal }).then(
                resolved,
                rejected,
            );
            await decoding.promise;
            controller.abort(reason);
            // No load/error event arrives after Stop: cancellation itself must settle the run.
            await vi.advanceTimersByTimeAsync(0);

            expect(rejected).toHaveBeenCalledWith(reason);
            await work;
            expect(resolved).not.toHaveBeenCalled();
            expect(deps.globalFetch).not.toHaveBeenCalled();
            expect(get(CharEmotion)).toBe(before);
            expect(deps.alert).not.toHaveBeenCalled();
        });
    });

    it.each([
        ["webui", deps.globalFetch, "abortSignal", 1],
        ["novelai", deps.globalFetch, "abortSignal", 1],
        ["dalle", deps.auxFetchJson, "signal", 1],
        ["stability", deps.fetch, "signal", 1],
        ["comfy", deps.globalFetch, "abortSignal", 1],
        ["comfyui", deps.globalFetch, "abortSignal", 1],
        ["fal", deps.globalFetch, "abortSignal", 1],
        ["Imagen", deps.auxFetchJson, "signal", 1],
        ["openai-compat", deps.globalFetch, "abortSignal", 1],
        ["wavespeed", deps.globalFetch, "abortSignal", 3],
    ] as const)("passes the caller's signal to every %s request", async (provider, transport, signalKey, requests) => {
        settings.memoryTranslateMedia.sdProvider = provider;
        const { signal } = new AbortController();
        deps.globalFetch.mockImplementation(async (url: string) => {
            switch (provider) {
                case "webui":
                    return { ok: true, data: { images: ["AQID"] } };
                case "novelai":
                    return { ok: true, data: new Uint8Array([1, 2, 3]) };
                case "comfy":
                case "comfyui":
                    return { ok: true, data: { prompt_id: "generated" } };
                case "fal":
                    return { ok: true, data: { images: [{ url: "https://images.test/result.png" }] } };
                case "openai-compat":
                    return { ok: true, data: { data: [{ b64_json: "AQID" }] } };
                case "wavespeed":
                    if (url.endsWith("/image-model")) return { ok: true, data: { data: { id: "generated" } } };
                    if (url.endsWith("/result"))
                        return {
                            ok: true,
                            data: { data: { status: "completed", outputs: ["https://images.test/file"] } },
                        };
                    return { ok: true, data: new Uint8Array([1, 2, 3]), headers: { "content-type": "image/png" } };
                default:
                    throw new Error(`Unexpected transport for ${provider}`);
            }
        });
        deps.zip.mockResolvedValue(uri);
        deps.auxFetchJson.mockResolvedValue(
            provider === "Imagen" ? imagen : { ok: true, data: { data: [{ b64_json: "AQID" }] } },
        );
        deps.fetch.mockResolvedValue(bytes());
        deps.fetchNative.mockResolvedValueOnce(Response.json(completedHistory)).mockResolvedValueOnce(bytes());

        await expect(generateAIImage("garden", char, "blurry", "inlay", { signal })).resolves.toBe(
            provider === "fal" ? "https://images.test/result.png" : uri,
        );
        expect(transport).toHaveBeenCalledTimes(requests);
        const optionsIndex = transport === deps.auxFetchJson ? 2 : 1;
        for (const call of transport.mock.calls) {
            expect(call[optionsIndex][signalKey]).toBe(signal);
        }
        if (provider === "comfy" || provider === "comfyui") {
            expect(deps.fetchNative).toHaveBeenCalledTimes(2);
            for (const [, options] of deps.fetchNative.mock.calls) {
                expect(options.signal).toBe(signal);
            }
        }
    });

    it("passes the stableDiff signal to the prompt request and image generation", async () => {
        const { signal } = new AbortController();
        await expect(stableDiff(char, "describe the garden", { signal })).resolves.toBe("");
        expect(deps.request).toHaveBeenCalledOnce();
        expect(deps.request.mock.calls[0][2]).toBe(signal);
        expect(deps.auxFetchJson).toHaveBeenCalledOnce();
        expect(deps.auxFetchJson.mock.calls[0][2].signal).toBe(signal);
    });

    it("rejects an abort during ComfyUI polling without another fetch or image delivery", async () => {
        settings.memoryTranslateMedia.sdProvider = "comfyui";
        deps.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: "generated" } });
        deps.fetchNative
            .mockResolvedValueOnce(Response.json({}))
            .mockResolvedValueOnce(Response.json(completedHistory))
            .mockResolvedValueOnce(bytes());
        const controller = new AbortController();
        const reason = { message: "Image cancelled by caller" };
        const writes = vi.fn();
        const unsubscribe = CharEmotion.subscribe(writes);
        writes.mockClear();
        const delivered = vi.fn();
        const rejected = vi.fn();
        const settled = generateAIImage("garden", char, "blurry", "", { signal: controller.signal }).then(
            delivered,
            rejected,
        );
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(deps.fetchNative).toHaveBeenCalledTimes(1);

            controller.abort(reason);
            await vi.advanceTimersByTimeAsync(0);
            expect(rejected).toHaveBeenCalledOnce();
            expect(rejected.mock.calls[0][0]).toBe(reason);
            await vi.advanceTimersByTimeAsync(1000);

            expect(deps.fetchNative).toHaveBeenCalledTimes(1);
            expect(delivered).not.toHaveBeenCalled();
            expect(writes).not.toHaveBeenCalled();
            expect(deps.alert).not.toHaveBeenCalled();
        } finally {
            await vi.runAllTimersAsync();
            await settled;
            unsubscribe();
        }
    });

    it("polls only the submitted ComfyUI prompt's scoped history", async () => {
        settings.memoryTranslateMedia.sdProvider = "comfyui";
        deps.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: "generated" } });
        deps.fetchNative
            .mockResolvedValueOnce(Response.json({ unrelated: completedHistory.generated }))
            .mockResolvedValueOnce(Response.json(completedHistory))
            .mockResolvedValueOnce(bytes());

        const work = generateAIImage("garden", char, "blurry", "inlay");
        await vi.runAllTimersAsync();
        await expect(work).resolves.toBe(uri);
        expect(deps.fetchNative.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            "/history/generated",
            "/history/generated",
            "/view",
        ]);
    });

    it.each([404, 405])("keeps using unscoped ComfyUI history after a scoped %s response", async (status) => {
        settings.memoryTranslateMedia.sdProvider = "comfyui";
        deps.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: "generated" } });
        deps.fetchNative
            .mockResolvedValueOnce(new Response("Scoped history is unsupported", { status }))
            .mockResolvedValueOnce(Response.json({}))
            .mockResolvedValueOnce(Response.json(completedHistory))
            .mockResolvedValueOnce(bytes());

        const work = generateAIImage("garden", char, "blurry", "inlay");
        await vi.runAllTimersAsync();
        await expect(work).resolves.toBe(uri);
        expect(deps.fetchNative.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            "/history/generated",
            "/history",
            "/history",
            "/view",
        ]);
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("alerts and stops on a ComfyUI history failure other than unsupported scoped history", async () => {
        settings.memoryTranslateMedia.sdProvider = "comfyui";
        deps.globalFetch.mockResolvedValue({ ok: true, data: { prompt_id: "generated" } });
        deps.fetchNative
            .mockResolvedValueOnce(Response.json({}, { status: 503 }))
            .mockResolvedValueOnce(Response.json(completedHistory))
            .mockResolvedValueOnce(bytes());
        const before = get(CharEmotion);

        const work = generateAIImage("garden", char, "blurry", "");
        await vi.runAllTimersAsync();
        await work;
        expect(deps.alert).toHaveBeenCalledOnce();
        expect(deps.fetchNative).toHaveBeenCalledTimes(1);
        expect(get(CharEmotion)).toBe(before);
    });

    it.each([
        ["display", ""],
        ["inlay", "inlay"],
    ])(
        "rejects a late provider answer after abort without alerting or delivering the %s image",
        async (_, delivery) => {
            settings.memoryTranslateMedia.sdProvider = "webui";
            const answer = deferred<{ ok: boolean; data: { images: string[] } }>();
            deps.globalFetch.mockReturnValue(answer.promise);
            const controller = new AbortController();
            const reason = { message: "Image cancelled by caller" };
            const before = get(CharEmotion);
            const writes = vi.fn();
            const unsubscribe = CharEmotion.subscribe(writes);
            writes.mockClear();
            try {
                const work = generateAIImage("garden", char, "blurry", delivery, { signal: controller.signal });
                expect(deps.globalFetch).toHaveBeenCalledOnce();
                controller.abort(reason);
                answer.resolve({ ok: true, data: { images: ["AQID"] } });

                await expect(work).rejects.toBe(reason);
                expect(get(CharEmotion)).toBe(before);
                expect(writes).not.toHaveBeenCalled();
                expect(deps.alert).not.toHaveBeenCalled();
            } finally {
                unsubscribe();
            }
        },
    );
});
