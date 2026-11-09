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
import type { CapturedTransform } from "src/ts/parser/transformClient";
import * as transformClient from "src/ts/parser/transformClient";
import { globalFetch } from "src/ts/globalApi.svelte";
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

    it("rejects a direct Google HTTP 429 as transient and retries the same text without caching the error", async () => {
        const source = "<p>Google quota retry</p>";
        provider.mockResolvedValueOnce(
            Response.json({ error: { code: 429, message: "Quota exceeded" } }, { status: 429 }),
        );

        await expect(translateHTML(source, false, "", -1, false, null)).rejects.toSatisfy(isTransient);
        expect(provider).toHaveBeenCalledTimes(1);

        await expect(translateHTML(source, false, "", -1, false, null)).resolves.toBe("<p>Translation</p>");
        expect(provider).toHaveBeenCalledTimes(2);
        expect(new URL(String(provider.mock.calls[1][0])).searchParams.get("q")).toBe("Google quota retry");
    });

    it("uses the direct Google adapter after an experimental HTTP 429 page containing a result", async () => {
        settings.memoryTranslateMedia.useExperimentalGoogleTranslator = true;
        vi.mocked(globalFetch).mockResolvedValueOnce({
            ok: false,
            status: 429,
            headers: {},
            data: new TextEncoder().encode('<div class="result-container">Quota page text</div>'),
        });

        await expect(translateHTML("<p>Google experimental fallback</p>", false, "", -1, false, null)).resolves.toBe(
            "<p>Translation</p>",
        );
        expect(globalFetch).toHaveBeenCalledExactlyOnceWith(
            "https://translate.google.com/m?tl=ko&sl=en&q=Google%20experimental%20fallback",
            expect.objectContaining({ rawResponse: true }),
        );
        expect(provider).toHaveBeenCalledTimes(1);
        const directURL = new URL(String(provider.mock.calls[0][0]));
        expect(directURL.host).toBe("translate.googleapis.com");
        expect(directURL.searchParams.get("q")).toBe("Google experimental fallback");
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

describe("translateHTML document ownership", () => {
    it("replaces an editdisplay-rewritten combined paragraph in the parsed document", async () => {
        settings.memoryTranslateMedia.combineTranslation = true;
        const source = "<p>Paragraph rewritten after translation</p>";
        const dom = new DOMParser().parseFromString(source, "text/html");
        const originalParagraph = dom.body.firstElementChild;
        vi.spyOn(DOMParser.prototype, "parseFromString").mockReturnValueOnce(dom);
        const createElement = vi.spyOn(dom, "createElement");
        // Inserting a live-document element would adopt it, hiding where its markup was parsed.
        vi.spyOn(document, "createElement").mockImplementation(() => {
            throw new Error("Translation must create elements in the parsed document");
        });
        const transform: CapturedTransform = {
            chatRef: { chaId: "simple", chatId: "chat" },
            context: {
                characterId: "simple",
                chatId: "chat",
                presetId: "preset",
                modelPresetId: "model-preset",
                personaId: "persona",
                selectedPersonaId: "persona",
            },
            pluginContext: undefined,
            generation: 0,
            cacheGeneration: 0,
            noCache: false,
            locked: false,
            installVersion: 0,
            hadUnackedWork: false,
            mixedDisplay: false,
        };
        vi.spyOn(transformClient, "serverProcessScript").mockResolvedValueOnce({
            data: '<strong data-editdisplay="rewritten">Processed translation</strong>',
            emoChanged: false,
        });

        const result = await translateHTML(source, false, "", 7, false, transform);

        expect(transformClient.serverProcessScript).toHaveBeenCalledOnce();
        const replacement = dom.body.firstElementChild;
        expect(replacement).not.toBe(originalParagraph);
        expect(createElement.mock.results.map(({ value }) => value)).toContain(replacement);
        expect(replacement?.ownerDocument).toBe(dom);
        const rendered = new DOMParser().parseFromString(result, "text/html");
        expect(rendered.querySelector("p > strong[data-editdisplay='rewritten']")?.textContent?.trim()).toBe(
            "Processed translation",
        );
    });

    it("rebuilds combined paragraph lines with spans and breaks from the parsed document", async () => {
        settings.memoryTranslateMedia.combineTranslation = true;
        const translations = new Map([
            ["First combined line", "First translated line"],
            ["Second combined line", "Second translated line"],
            ["Third combined line", "Third translated line"],
        ]);
        provider.mockImplementation(async (input) => {
            const text = new URL(String(input)).searchParams.get("q");
            return Response.json([[[translations.get(text!)]]]);
        });
        const source = "<p>First combined line<br>Second combined line<br>Third combined line</p>";
        const dom = new DOMParser().parseFromString(source, "text/html");
        vi.spyOn(DOMParser.prototype, "parseFromString").mockReturnValueOnce(dom);
        const createElement = vi.spyOn(dom, "createElement");
        vi.spyOn(document, "createElement").mockImplementation(() => {
            throw new Error("Translation must create elements in the parsed document");
        });

        const result = await translateHTML(source, false, "", -1, false, null);

        const rendered = new DOMParser().parseFromString(result, "text/html");
        const lines = [...rendered.querySelectorAll("p > span")];
        expect(lines.map((line) => line.textContent?.trim())).toEqual([
            "First translated line",
            "Second translated line",
            "Third translated line",
        ]);
        for (const line of lines.slice(0, -1)) {
            expect(line.nextElementSibling?.tagName).toBe("BR");
        }
        const createdElements = createElement.mock.results.map(({ value }) => value);
        for (const node of dom.querySelectorAll("p > span, p > br")) {
            expect(createdElements).toContain(node);
            expect(node.ownerDocument).toBe(dom);
        }
    });
});
