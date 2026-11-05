// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";

vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/request/request", async () =>
    (await import("src/ts/process/request/tests/requestMock")).createRequestMock(),
);

import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { translateHTML } from "./translator";

const provider = vi.fn<typeof fetch>();
const open = new Set<{ text: string; answer: () => void }>();
const renders: Promise<void>[] = [];
let peak = 0;
let draining = false;

const paragraphs = (prefix: string, count = 20) => Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
const html = (texts: string[]) => texts.map((text) => `<p>${text}</p>`).join("");
const translated = (texts: string[]) => html(texts.map((text) => `Translated ${text}`));

function render(texts: string[], signal?: AbortSignal) {
    const view: { value?: string; error?: unknown } = {};
    renders.push(
        translateHTML(html(texts), false, "", -1, false, null, signal).then(
            (value) => {
                view.value = value;
            },
            (error) => {
                view.error = error;
            },
        ),
    );
    return view;
}

beforeEach(() => {
    vi.useFakeTimers();
    open.clear();
    renders.length = 0;
    peak = 0;
    draining = false;
    provider.mockReset().mockImplementation((input) => {
        const text = new URL(String(input)).searchParams.get("q")!;
        return new Promise<Response>((resolve) => {
            const request = {
                text,
                answer: () => {
                    if (open.delete(request)) resolve(Response.json([[[`Translated ${text}`]]]));
                },
            };
            open.add(request);
            peak = Math.max(peak, open.size);
            if (draining) request.answer();
        });
    });
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

afterEach(async () => {
    // Even a failed assertion must release every shared worker permit before the next test.
    draining = true;
    for (const request of [...open]) request.answer();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(renders);
    await vi.advanceTimersByTimeAsync(0);
    expect(open.size).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("rendered provider worker limit", () => {
    it("shares ten provider slots across three concurrent translations of twenty paragraphs", async () => {
        const sources = ["First render", "Second render", "Third render"].map((prefix) => paragraphs(prefix));
        const callers = sources.map((source) => render(source));
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(10);
        expect(open.size).toBe(10);
        expect(peak).toBe(10);

        // Each wave is held at the provider so the peak is observed before any answer can hide it.
        for (let wave = 0; wave < 6; wave += 1) {
            for (const request of [...open]) request.answer();
            await vi.advanceTimersByTimeAsync(0);
            expect(open.size).toBeLessThanOrEqual(10);
        }
        expect(peak).toBe(10);
        expect(provider).toHaveBeenCalledTimes(60);
        expect(callers).toEqual(sources.map((source) => ({ value: translated(source) })));
        expect(open.size).toBe(0);
    });

    it("keeps aborted callers' requested jobs in their slots until answers warm the pair cache", async () => {
        const sources = ["Abandoned first", "Abandoned second", "Abandoned third"].map((prefix) => paragraphs(prefix));
        const controllers = sources.map(() => new AbortController());
        const callers = sources.map((source, index) => render(source, controllers[index].signal));
        await vi.advanceTimersByTimeAsync(0);
        expect(open.size).toBe(10);
        const requested = [...open];
        expect(requested.map((request) => request.text)).toEqual(sources[0].slice(0, 10));
        controllers.forEach((controller) => controller.abort());
        await vi.advanceTimersByTimeAsync(0);
        const fourthSources = paragraphs("Fourth render", 2);
        const fourth = render(fourthSources);
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(10);
        expect(open.size).toBe(10);
        expect(fourth).toEqual({});

        requested[0].answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(11);
        expect([...open].map((request) => request.text)).toContain("Fourth render 0");
        expect(open.size).toBe(10);
        expect(peak).toBe(10);
        requested[1].answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(12);
        expect([...open].map((request) => request.text)).toContain("Fourth render 1");
        expect(open.size).toBe(10);
        for (const request of [...open]) request.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(callers).toEqual(controllers.map((controller) => ({ error: controller.signal.reason })));
        expect(fourth).toEqual({ value: translated(fourthSources) });
        expect(provider).toHaveBeenCalledTimes(12);
        expect(open.size).toBe(0);

        const cached = render(requested.map((request) => request.text));
        await vi.advanceTimersByTimeAsync(0);
        expect(cached).toEqual({ value: translated(sources[0].slice(0, 10)) });
        expect(provider).toHaveBeenCalledTimes(12);
    });
});
