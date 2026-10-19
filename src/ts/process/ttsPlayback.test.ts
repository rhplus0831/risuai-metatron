// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCharacter } from "../storage/characterStore.svelte";

const deps = vi.hoisted(() => ({
    fetch: vi.fn(),
    globalFetch: vi.fn(),
    translateVox: vi.fn(),
    alert: vi.fn(),
    settings: { memoryTranslateMedia: { voicevoxUrl: "https://voicevox.test/" }, secrets: { elevenLabKey: "test" } },
}));
vi.mock("../storage/settingsViews.svelte", () => ({ settings: deps.settings }));
vi.mock("../storage/characterStore.svelte", () => ({ selectedCharacter: () => null }));
vi.mock("../storage/database.svelte", () => ({}));
vi.mock("../network/auxFetch", () => ({ auxFetch: vi.fn() }));
vi.mock("../storage/llmSecrets.svelte", () => ({ isSecretSet: () => false }));
vi.mock("../alert", () => ({ alertError: deps.alert }));
vi.mock("../translator/translator", () => ({ runTranslator: vi.fn(), translateVox: deps.translateVox }));
vi.mock("../globalApi.svelte", () => ({ globalFetch: deps.globalFetch, loadAsset: async () => new Uint8Array([1]) }));
vi.mock("../util", () => ({ sleep: vi.fn() }));
vi.mock("./transformers", () => ({ runVITS: vi.fn() }));
vi.mock("src/lang", () => ({ language: { errors: { httpError: "HTTP error: " } } }));

import { sayTTS, stopTTS } from "./tts";
import { runVITS } from "./transformers";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
class Source {
    buffer: unknown = null;
    connect = vi.fn();
    start = vi.fn();
    onended: (() => void) | null = null;
    stop = vi.fn(() => this.onended?.());
}
const contexts: AudioContextMock[] = [];
const sources: Source[] = [];
const decode = vi.fn();
const cancel = vi.fn();
class AudioContextMock {
    destination = {};
    close = vi.fn(async () => undefined);
    decodeAudioData = decode;
    gain = { gain: { value: 1 }, connect: vi.fn() };
    createGain = vi.fn(() => this.gain);
    constructor() {
        contexts.push(this);
    }
    createBufferSource() {
        const source = new Source();
        sources.push(source);
        return source;
    }
}
function character(ttsMode: string) {
    return {
        chaId: "speaker",
        ttsMode,
        ttsSpeech: "42",
        voicevoxConfig: { SPEED_SCALE: 1, PITCH_SCALE: 0, VOLUME_SCALE: 1, INTONATION_SCALE: 1 },
        gptSoVitsConfig: {
            url: "https://sovits.test",
            ref_audio_data: { assetId: "reference", fileName: "ref.wav" },
            ref_audio_path: "/reference",
            use_auto_path: false,
            volume: 0.5,
        },
    } as ClientCharacter;
}
const audioResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } });
const globalResponse = () => ({ ok: true, data: new Uint8Array([1, 2, 3]) });

beforeEach(() => {
    vi.clearAllMocks();
    contexts.length = 0;
    sources.length = 0;
    decode.mockResolvedValue({ decoded: true });
    deps.fetch.mockImplementation(async (input: string | URL) => {
        if (new URL(input).pathname === "/audio_query") {
            return Response.json({
                accent_phrases: [],
                prePhonemeLength: 0,
                postPhonemeLength: 0,
                outputSamplingRate: 24000,
                outputStereo: false,
                kana: "",
            });
        }
        return audioResponse();
    });
    deps.globalFetch.mockImplementation(async () => globalResponse());
    vi.mocked(runVITS).mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    deps.translateVox.mockResolvedValue("こんにちは &speaker=99 # + 100% 日本語");
    vi.stubGlobal("fetch", deps.fetch);
    vi.stubGlobal("AudioContext", AudioContextMock);
    vi.stubGlobal("speechSynthesis", { cancel });
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
    stopTTS();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("sayTTS and stopTTS", () => {
    it("encodes the entire translated VOICEVOX audio_query text and one speaker without a doubled slash", async () => {
        await sayTTS(character("VOICEVOX"), "English source");
        expect(deps.translateVox).toHaveBeenCalledWith("English source");
        const query = new URL(deps.fetch.mock.calls[0][0]);
        expect(query.origin + query.pathname).toBe("https://voicevox.test/audio_query");
        expect(query.searchParams.getAll("text")).toEqual(["こんにちは &speaker=99 # + 100% 日本語"]);
        expect(query.searchParams.getAll("speaker")).toEqual(["42"]);
        expect(query.hash).toBe("");
        expect(deps.fetch).toHaveBeenCalledTimes(2);
        expect(sources[0].start).toHaveBeenCalledOnce();
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("sends VOICEVOX synthesis with one speaker, no doubled slash, and the audio query plus voice configuration in its JSON body", async () => {
        const queryReply = {
            accent_phrases: [
                {
                    moras: [
                        {
                            text: "ア",
                            consonant: null,
                            consonant_length: null,
                            vowel: "a",
                            vowel_length: 0.2,
                            pitch: 5,
                        },
                    ],
                    accent: 1,
                    pause_mora: null,
                    is_interrogative: false,
                },
            ],
            prePhonemeLength: 0.15,
            postPhonemeLength: 0.25,
            outputSamplingRate: 24000,
            outputStereo: true,
            kana: "ア",
        };
        deps.fetch.mockResolvedValueOnce(Response.json(queryReply));
        const speaker = character("VOICEVOX");
        speaker.voicevoxConfig = { SPEED_SCALE: 1.2, PITCH_SCALE: 0.1, VOLUME_SCALE: 0.8, INTONATION_SCALE: 1.3 };
        await sayTTS(speaker, "English source");
        expect(deps.fetch).toHaveBeenCalledTimes(2);
        const [url, init] = deps.fetch.mock.calls[1];
        const synthesis = new URL(url);
        expect(synthesis.origin + synthesis.pathname).toBe("https://voicevox.test/synthesis");
        expect(synthesis.searchParams.getAll("speaker")).toEqual(["42"]);
        expect(synthesis.searchParams.has("text")).toBe(false);
        expect(synthesis.hash).toBe("");
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({ "Content-Type": "application/json" });
        expect(JSON.parse(init.body)).toEqual({
            ...queryReply,
            speedScale: 1.2,
            pitchScale: 0.1,
            volumeScale: 0.8,
            intonationScale: 1.3,
        });
    });

    it("stops every overlapping buffered source, including gain playback, and closes their contexts", async () => {
        await Promise.all([sayTTS(character("elevenlab"), "first"), sayTTS(character("gptsovits"), "second")]);
        expect(sources).toHaveLength(2);
        expect(contexts.some((context) => context.createGain.mock.calls.length === 1)).toBe(true);
        for (const source of sources) expect(source.start).toHaveBeenCalledOnce();
        stopTTS();
        for (const source of sources) expect(source.stop).toHaveBeenCalledOnce();
        for (const context of contexts) expect(context.close).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
        stopTTS();
        for (const source of sources) expect(source.stop).toHaveBeenCalledOnce();
        for (const context of contexts) expect(context.close).toHaveBeenCalledOnce();
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("retires a naturally ended source and closes it without stopping it again", async () => {
        await sayTTS(character("elevenlab"), "finished");
        expect(sources[0].onended).toEqual(expect.any(Function));
        sources[0].onended!();
        expect(contexts[0].close).toHaveBeenCalledOnce();
        await sayTTS(character("elevenlab"), "still playing");
        stopTTS();
        expect(sources[0].stop).not.toHaveBeenCalled();
        expect(contexts[0].close).toHaveBeenCalledOnce();
        expect(sources[1].stop).toHaveBeenCalledOnce();
        expect(contexts[1].close).toHaveBeenCalledOnce();
    });

    it("prevents provider requests pending at Stop from starting audio, while allowing later speech", async () => {
        const normal = deferred<Response>();
        const gain = deferred<ReturnType<typeof globalResponse>>();
        deps.fetch.mockReturnValueOnce(normal.promise);
        deps.globalFetch.mockReturnValueOnce(gain.promise);
        const work = Promise.all([
            sayTTS(character("elevenlab"), "pending"),
            sayTTS(character("gptsovits"), "pending gain"),
        ]);
        await vi.waitFor(() => expect(deps.globalFetch).toHaveBeenCalledOnce());
        expect(deps.fetch).toHaveBeenCalledOnce();
        stopTTS();
        normal.resolve(audioResponse());
        gain.resolve(globalResponse());
        await work;
        expect(sources.filter((source) => source.start.mock.calls.length)).toHaveLength(0);
        for (const context of contexts) expect(context.close).toHaveBeenCalledOnce();
        await sayTTS(character("elevenlab"), "after stop");
        expect(sources.filter((source) => source.start.mock.calls.length)).toHaveLength(1);
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("prevents decodes pending at Stop from starting audio and closes both unused contexts", async () => {
        const pending = deferred<unknown>();
        decode.mockReturnValue(pending.promise);
        const work = Promise.all([
            sayTTS(character("elevenlab"), "decoding"),
            sayTTS(character("gptsovits"), "decoding gain"),
        ]);
        await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
        stopTTS();
        pending.resolve({ decoded: true });
        await work;
        expect(sources.filter((source) => source.start.mock.calls.length)).toHaveLength(0);
        expect(contexts).toHaveLength(2);
        for (const context of contexts) expect(context.close).toHaveBeenCalledOnce();
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("plays VITS through the shared registry so Stop ends it and leaves no context open", async () => {
        await sayTTS(character("vits"), "vits speech");
        expect(runVITS).toHaveBeenCalledWith("vits speech", undefined);
        expect(contexts).toHaveLength(1);
        expect(sources[0].start).toHaveBeenCalledOnce();
        stopTTS();
        expect(sources[0].stop).toHaveBeenCalledOnce();
        expect(contexts[0].close).toHaveBeenCalledOnce();
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("plays nothing for a VITS synthesis still running when Stop bumps the generation", async () => {
        const synthesis = deferred<ArrayBuffer>();
        vi.mocked(runVITS).mockReturnValueOnce(synthesis.promise);
        const work = sayTTS(character("vits"), "slow model");
        await vi.waitFor(() => expect(runVITS).toHaveBeenCalledOnce());
        stopTTS();
        synthesis.resolve(new Uint8Array([1, 2, 3]).buffer);
        await work;
        expect(contexts).toHaveLength(0);
        expect(sources).toHaveLength(0);
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("closes a VITS context still decoding at Stop at once, and alerts nothing when that decode rejects", async () => {
        const pending = deferred<unknown>();
        decode.mockReturnValueOnce(pending.promise.then(() => Promise.reject(new Error("context closed"))));
        const work = sayTTS(character("vits"), "decoding");
        await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
        stopTTS();
        expect(contexts).toHaveLength(1);
        expect(contexts[0].close).toHaveBeenCalledOnce();
        pending.resolve(undefined);
        await work;
        expect(sources.filter((source) => source.start.mock.calls.length)).toHaveLength(0);
        expect(contexts[0].close).toHaveBeenCalledOnce();
        expect(deps.alert).not.toHaveBeenCalled();
    });

    it("still alerts a VITS decode failure without Stop and closes its context", async () => {
        decode.mockRejectedValueOnce(new Error("bad wav"));
        await sayTTS(character("vits"), "broken");
        expect(contexts[0].close).toHaveBeenCalledOnce();
        expect(sources).toHaveLength(0);
        expect(deps.alert).toHaveBeenCalledOnce();
    });
});
