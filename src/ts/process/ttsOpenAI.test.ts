import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`): the OpenAI TTS routing of `sayTTS`. The
// stored OpenAI key is write-only and only reaches `api.openai.com`, through the server's
// `openai-tts` operation (`auxFetch`); a character's own key goes with the character's request as
// before, to any base URL; a custom base URL with the stored key but no key of its own is refused
// with `ttsCustomUrlNeedsKey` (recorded in the slice); a keyless custom endpoint is called as before.

const { deps } = vi.hoisted(() => ({
    deps: {
        auxFetch: vi.fn(),
        globalFetch: vi.fn(),
        isSecretSet: vi.fn(),
        alertError: vi.fn(),
        db: {} as Record<string, unknown>,
    },
}));

vi.mock("../network/auxFetch", () => ({ auxFetch: (...args: unknown[]) => deps.auxFetch(...args) }));
vi.mock("../globalApi.svelte", () => ({
    globalFetch: (...args: unknown[]) => deps.globalFetch(...args),
    loadAsset: vi.fn(),
}));
vi.mock("../storage/llmSecrets.svelte", () => ({ isSecretSet: (path: unknown) => deps.isSecretSet(path) }));
vi.mock("../alert", () => ({ alertError: (message: string) => deps.alertError(message) }));
vi.mock("../storage/database.svelte", () => ({
    getDatabase: () => deps.db,
    getCurrentCharacter: () => null,
}));
vi.mock("../translator/translator", () => ({ runTranslator: vi.fn(), translateVox: vi.fn() }));
vi.mock("../util", () => ({ sleep: vi.fn() }));
vi.mock("./transformers", () => ({ runVITS: vi.fn() }));
vi.mock("src/lang", () => ({
    language: { ttsCustomUrlNeedsKey: "custom-url-needs-key", errors: { httpError: "HTTP error: " } },
}));

import { sayTTS } from "./tts";

const OFFICIAL = "https://api.openai.com/v1";
const CUSTOM = "https://tts.example.test/v1";

function character(config: { baseURL?: string; apiKey?: string } = {}) {
    return {
        chaId: "c1",
        ttsMode: "openai",
        oaiTTSConfig: {
            enabled: true,
            baseURL: config.baseURL ?? "",
            apiKey: config.apiKey ?? "",
            model: "tts-1",
            voice: "nova",
            format: "mp3",
        },
    } as never;
}

/** A refused answer, so the call ends in an alert and never reaches the audio pipeline. */
const refused = (body: unknown) => ({ ok: false, data: body });

beforeEach(() => {
    deps.db = {};
    deps.isSecretSet.mockReturnValue(true);
    deps.auxFetch.mockResolvedValue(Response.json({ error: { message: "nope" } }, { status: 401 }));
    deps.globalFetch.mockResolvedValue(refused({ error: { message: "nope" } }));
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("sayTTS with the OpenAI provider", () => {
    it("uses the stored key through the server for the official endpoint, without the key in the request", async () => {
        await sayTTS(character(), "Hello *world*");
        expect(deps.auxFetch).toHaveBeenCalledTimes(1);
        const [op, url, init] = deps.auxFetch.mock.calls[0] as [string, string, Record<string, unknown>];
        expect(op).toBe("openai-tts");
        expect(url).toBe(`${OFFICIAL}/audio/speech`);
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({ "Content-Type": "application/json" });
        expect(init.body).toEqual({ model: "tts-1", input: "Hello world", voice: "nova", response_format: "mp3" });
        expect(deps.globalFetch).not.toHaveBeenCalled();
        expect(deps.isSecretSet).toHaveBeenCalledWith({ kind: "flat", field: "openAIKey" });
        // The same for the official URL with a trailing slash, and a blank key of its own.
        await sayTTS(character({ baseURL: `${OFFICIAL}/`, apiKey: "   " }), "again");
        expect(deps.auxFetch).toHaveBeenCalledTimes(2);
        expect(deps.globalFetch).not.toHaveBeenCalled();
    });

    it("refuses a custom base URL with the stored key and no key of its own, sending nothing", async () => {
        await sayTTS(character({ baseURL: CUSTOM }), "Hello");
        expect(deps.alertError).toHaveBeenCalledWith("custom-url-needs-key");
        expect(deps.auxFetch).not.toHaveBeenCalled();
        expect(deps.globalFetch).not.toHaveBeenCalled();
    });

    it("sends a character's own key with the character's request, to any base URL, never through the server", async () => {
        await sayTTS(character({ baseURL: CUSTOM, apiKey: "own-key" }), "Hello");
        expect(deps.auxFetch).not.toHaveBeenCalled();
        expect(deps.globalFetch).toHaveBeenCalledTimes(1);
        const [url, init] = deps.globalFetch.mock.calls[0] as [string, Record<string, any>];
        expect(url).toBe(`${CUSTOM}/audio/speech`);
        expect(init.headers.Authorization).toBe("Bearer own-key");
        expect(init.rawResponse).toBe(true);
        expect(init.body).toMatchObject({ input: "Hello" });
        await sayTTS(character({ baseURL: OFFICIAL, apiKey: " own-key " }), "Hello");
        expect(deps.auxFetch).not.toHaveBeenCalled();
        expect(deps.globalFetch).toHaveBeenCalledTimes(2);
        expect((deps.globalFetch.mock.calls[1][1] as Record<string, any>).headers.Authorization).toBe("Bearer own-key");
    });

    it("calls a keyless endpoint without any Authorization header when no key is stored", async () => {
        deps.isSecretSet.mockReturnValue(false);
        await sayTTS(character({ baseURL: CUSTOM }), "Hello");
        await sayTTS(character(), "Hello");
        expect(deps.auxFetch).not.toHaveBeenCalled();
        expect(deps.globalFetch).toHaveBeenCalledTimes(2);
        for (const call of deps.globalFetch.mock.calls as [string, Record<string, any>][]) {
            expect(call[1].headers).toEqual({ "Content-Type": "application/json" });
        }
        expect(deps.globalFetch.mock.calls.map(([url]) => url)).toEqual([
            `${CUSTOM}/audio/speech`,
            `${OFFICIAL}/audio/speech`,
        ]);
        expect(deps.alertError).not.toHaveBeenCalledWith("custom-url-needs-key");
    });
});
