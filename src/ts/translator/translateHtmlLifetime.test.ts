// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";

vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/request/request", async () =>
    (await import("src/ts/process/request/tests/requestMock")).createRequestMock(),
);

import { isTransient } from "src/ts/parser/renderErrors";
import { requestChatData } from "src/ts/process/request/request";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { LLMCacheStorage, translateHTML } from "./translator";

const provider = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.clearAllMocks();
    provider.mockReset().mockImplementation(async () => Response.json([[["Translation"]]]));
    vi.stubGlobal("fetch", provider);
    installFlatDatabase({
        characters: [],
        enabledModules: [],
        modules: [],
        translatorType: "google",
        translator: "ko",
        translatorInputLanguage: "en",
        useExperimentalGoogleTranslator: false,
        combineTranslation: false,
        translatorPresets: [createTranslatorPreset("Translate", { id: "translate", prompt: "{{slot::content}}" })],
        translatorPresetId: "translate",
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("translateHTML render lifetime", () => {
    it("requests no provider work for an already aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();
        await translateHTML("<p>Never requested</p>", false, "", -1, false, null, controller.signal).catch(
            () => undefined,
        );
        expect(provider).toHaveBeenCalledTimes(0);
        expect(requestChatData).toHaveBeenCalledTimes(0);
    });

    it("takes no further translation job after aborting at the first provider answer", async () => {
        const controller = new AbortController();
        const answers: ((response: Response) => void)[] = [];
        provider.mockImplementation(() => new Promise<Response>((resolve) => answers.push(resolve)));
        const paragraphs = Array.from({ length: 12 }, (_, i) => `<p>Queued paragraph ${i}</p>`);
        const translating = translateHTML(paragraphs.join(""), false, "", -1, false, null, controller.signal);
        const settled = translating.catch(() => undefined);
        // Workers take their shared slots asynchronously; let the first requests go out.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = provider.mock.calls.length;
        // Hold all in-flight answers so there is still queued work when the first one arrives.
        expect(started).toBeGreaterThan(0);
        expect(started).toBeLessThan(paragraphs.length);
        provider.mockImplementation(async () => Response.json([[["Later answer"]]]));
        answers[0](Response.json([[["First answer"]]]));
        controller.abort();
        for (const answer of answers.slice(1)) answer(Response.json([[["In-flight answer"]]]));
        await settled;
        expect(provider).toHaveBeenCalledTimes(started);
        expect(requestChatData).toHaveBeenCalledTimes(0);
    });

    it("marks a rejected direct Google fetch as transient", async () => {
        provider.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await expect(translateHTML("<p>Google failure</p>", false, "", -1, false, null)).rejects.toSatisfy(isTransient);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(String(provider.mock.calls[0][0])).toMatch(/^https:\/\/translate.googleapis.com\//);
        expect(requestChatData).toHaveBeenCalledTimes(0);
    });

    it("marks a rejected LLM cache read as transient before any provider request", async () => {
        settings.memoryTranslateMedia.translatorType = "llm";
        const read = vi.spyOn(LLMCacheStorage, "getItem").mockRejectedValueOnce(new Error("Cache unavailable"));
        await expect(translateHTML("<p>LLM cache failure</p>", false, "", -1, false, null)).rejects.toSatisfy(
            isTransient,
        );
        expect(read).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledTimes(0);
        expect(requestChatData).toHaveBeenCalledTimes(0);
    });
});
