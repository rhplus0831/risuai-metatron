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
import { globalFetch } from "src/ts/globalApi.svelte";
import { globalFetchFromResponse } from "src/ts/tests/globalApiMock";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { translate, translateHTML } from "./translator";

const provider = vi.fn<typeof fetch>();
const open = new Set<{ text: string; answer: (response?: Response) => void }>();
const renders: Promise<void>[] = [];
let peak = 0;
let draining = false;

const paragraphs = (prefix: string, count = 20) => Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
const html = (texts: string[]) => texts.map((text) => `<p>${text}</p>`).join("");
const translated = (texts: string[]) => html(texts.map((text) => `Translated ${text}`));
const requestedTexts = () => provider.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"));
const quotaError = () => Response.json({ error: { code: 429, message: "Quota exceeded" } }, { status: 429 });

function observe(work: Promise<string>) {
    const view: { value?: string; error?: unknown } = {};
    renders.push(
        work.then(
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

function render(texts: string[], signal?: AbortSignal) {
    return observe(translateHTML(html(texts), false, "", -1, false, null, signal));
}

function installTranslationSettings(overrides: object = {}) {
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
        ...overrides,
    });
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
                answer: (response = Response.json([[[`Translated ${text}`]]])) => {
                    if (open.delete(request)) resolve(response);
                },
            };
            open.add(request);
            peak = Math.max(peak, open.size);
            if (draining) request.answer();
        });
    });
    // The direct Google adapter goes through `globalFetch`; `provider` stands in for its transport.
    vi.mocked(globalFetch)
        .mockReset()
        .mockImplementation((url, arg) => globalFetchFromResponse(provider, url, arg));
    installTranslationSettings();
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

describe("provider request deadlines", () => {
    it("admits the eleventh render at 60 s, fails joined renders, and lets the timed-out text be retried", async () => {
        const source = "Silent rendered translation";
        const first = render([source]);
        await vi.advanceTimersByTimeAsync(1_000);
        const [held] = open;
        expect(requestedTexts()).toEqual([source]);

        const blockers = paragraphs("Deadline blockers", 9);
        render(blockers);
        const joined = render([source]);
        const controller = new AbortController();
        const cancelled = render([source], controller.signal);
        const eleventhText = "Waiting eleventh render";
        const eleventh = render([eleventhText]);
        await vi.advanceTimersByTimeAsync(0);
        const reason = new Error("Render cancelled");
        controller.abort(reason);
        await vi.advanceTimersByTimeAsync(58_999);
        expect(requestedTexts()).toEqual([source, ...blockers]);
        expect(first).toEqual({});
        expect(joined).toEqual({});
        expect(eleventh).toEqual({});
        expect(cancelled.error).toBe(reason);

        await vi.advanceTimersByTimeAsync(1);
        expect(requestedTexts()).toEqual([source, ...blockers, eleventhText]);
        expect(provider.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(first.error).toSatisfy(isTransient);
        expect(joined.error).toBe(first.error);

        // A late reply from the expired fetch must not warm the pair cache.
        held.answer();
        [...open].find((request) => request.text === eleventhText)!.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(eleventh).toEqual({ value: translated([eleventhText]) });

        const retried = render([source]);
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedTexts()).toEqual([source, ...blockers, eleventhText, source]);
        [...open].find((request) => request.text === source)!.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(retried).toEqual({ value: translated([source]) });
    });

    it("ends a composer-first DeepL flight and its joined render at 60 s", async () => {
        installTranslationSettings({ translatorType: "deepl", deeplOptions: { key: "fixture-key", freeApi: true } });
        const source = "Silent composer translation";
        const composer = observe(translate(source, false));
        await vi.advanceTimersByTimeAsync(0);
        expect(globalFetch).toHaveBeenCalledExactlyOnceWith(
            "https://api-free.deepl.com/v2/translate",
            expect.anything(),
        );
        const joined = render([source]);

        await vi.advanceTimersByTimeAsync(59_999);
        expect(globalFetch).toHaveBeenCalledOnce();
        expect(composer).toEqual({});
        expect(joined).toEqual({});

        await vi.advanceTimersByTimeAsync(1);
        expect(composer.error).toSatisfy(isTransient);
        expect(joined.error).toBe(composer.error);
        expect(provider.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it("aborts a silent experimental Google fetch at 60 s", async () => {
        installTranslationSettings({ useExperimentalGoogleTranslator: true });
        render(["Silent experimental Google translation"]);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(provider).toHaveBeenCalledOnce();
        const [[url, init]] = provider.mock.calls;
        expect(String(url)).toMatch(/^https:\/\/translate\.google\.com\/m\?/);
        expect(init?.signal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(init?.signal?.aborted).toBe(true);
    });

    it("starts the DeepLX deadline after its three-second slot wait", async () => {
        installTranslationSettings({
            translatorType: "deeplX",
            noWaitForTranslate: false,
            deeplXOptions: { url: "https://deeplx.test", token: "" },
        });
        const first = render(["First DeepLX slot"]);
        const held = render(["Second DeepLX slot"]);
        try {
            await vi.advanceTimersByTimeAsync(2_999);
            expect(provider.mock.calls.map(([url]) => url)).toEqual(["https://deeplx.test/translate"]);
            const [firstRequest] = open;
            firstRequest.answer(Response.json({ data: "Translated first DeepLX slot" }));

            await vi.advanceTimersByTimeAsync(1);
            expect(provider.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("https://deeplx.test/translate"));
            expect(first).toEqual({ value: "<p>Translated first DeepLX slot</p>" });
            const signal = provider.mock.calls[1][1]?.signal;

            await vi.advanceTimersByTimeAsync(59_999);
            expect(held).toEqual({});
            expect(signal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            expect(held.error).toSatisfy(isTransient);
            expect(signal?.aborted).toBe(true);
        } finally {
            // Let a reserved slot reach the mock even if an earlier assertion failed.
            await vi.advanceTimersByTimeAsync(3_000);
        }
    });
});

describe("rendered provider worker limit", () => {
    it("stops failed siblings from taking new paragraphs and retries on the same signal using open and cached requests", async () => {
        const source = paragraphs("Failed render retry");
        const controller = new AbortController();
        const failed = render(source, controller.signal);
        // The composer sees the producer's original error, independently of render-attempt cancellation.
        const producerError = translate(source[0], false).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        const requested = [...open];
        expect(requestedTexts()).toEqual(source.slice(0, 10));
        expect(open.size).toBe(10);

        requested[0].answer(quotaError());
        await vi.advanceTimersByTimeAsync(0);
        expect(failed.error).toBe(await producerError);
        expect(failed.error).toBeInstanceOf(Error);
        expect(isTransient(failed.error)).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect([...open]).toEqual(requested.slice(1));

        requested[1].answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedTexts()).toEqual(source.slice(0, 10));
        expect([...open]).toEqual(requested.slice(2));

        // ChatBody retries after 250 ms with this same render signal.
        await vi.advanceTimersByTimeAsync(250);
        const retry = render(source, controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedTexts()).toEqual([...source.slice(0, 10), source[0], source[10]]);
        expect(open.size).toBe(10);
        expect(retry).toEqual({});

        // The first answer warmed paragraph 1; paragraph 2 is still open and must be joined.
        requested[2].answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedTexts().filter((text) => text === source[2])).toHaveLength(1);
        for (let wave = 0; wave < 2; wave += 1) {
            for (const request of [...open]) request.answer();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(retry).toEqual({ value: translated(source) });
        expect(requestedTexts().filter((text) => text === source[0])).toHaveLength(2);
        for (const text of source.slice(1)) {
            expect(requestedTexts().filter((requestedText) => requestedText === text)).toHaveLength(1);
        }
        expect(peak).toBe(10);
        expect(open.size).toBe(0);
    });

    it("stops a pending sibling from taking the next chunk after a failure", async () => {
        const firstChunk = "Pending sibling first chunk";
        const nextChunk = "Pending sibling next chunk";
        const failed = render(["Chunk sibling failure", `${firstChunk}\n\n${nextChunk}`]);
        await vi.advanceTimersByTimeAsync(0);
        const [failure, sibling] = open;
        expect(requestedTexts()).toEqual(["Chunk sibling failure", firstChunk]);

        failure.answer(quotaError());
        await vi.advanceTimersByTimeAsync(0);
        expect(isTransient(failed.error)).toBe(true);
        expect([...open]).toEqual([sibling]);

        sibling.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedTexts()).toEqual(["Chunk sibling failure", firstChunk]);
        expect(open.size).toBe(0);
    });

    it("withdraws every unshared queued paragraph before releasing the failed producer's permit", async () => {
        const blockerSource = paragraphs("Failure ordering blockers", 8);
        const blockers = render(blockerSource);
        await vi.advanceTimersByTimeAsync(0);
        const source = paragraphs("Failure ordering paragraphs", 10);
        const failed = render(source);
        await vi.advanceTimersByTimeAsync(0);
        const requested = [...open].slice(8);
        expect(requestedTexts()).toEqual([...blockerSource, ...source.slice(0, 2)]);
        expect(open.size).toBe(10);

        const unrelatedSource = paragraphs("Failure ordering unrelated", 3);
        const unrelated = render(unrelatedSource);
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(10);

        requested[0].answer(quotaError());
        await vi.advanceTimersByTimeAsync(0);
        expect(isTransient(failed.error)).toBe(true);
        expect(requestedTexts()).toEqual([...blockerSource, ...source.slice(0, 2), unrelatedSource[0]]);
        expect(open.size).toBe(10);
        expect(open.has(requested[1])).toBe(true);

        // The admitted sibling retains its permit until it settles, despite losing its caller.
        requested[1].answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedTexts()).toEqual([...blockerSource, ...source.slice(0, 2), ...unrelatedSource.slice(0, 2)]);
        expect(open.size).toBe(10);

        for (const request of [...open]) request.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedTexts()).toEqual([...blockerSource, ...source.slice(0, 2), ...unrelatedSource]);
        for (const request of [...open]) request.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(blockers).toEqual({ value: translated(blockerSource) });
        expect(unrelated).toEqual({ value: translated(unrelatedSource) });
        expect(peak).toBe(10);
        expect(open.size).toBe(0);
    });

    it("preserves a queued paragraph shared with another render and the composer when its attempt fails", async () => {
        const blockerSource = paragraphs("Shared failure blockers", 9);
        render(blockerSource);
        await vi.advanceTimersByTimeAsync(0);
        const source = paragraphs("Shared failure paragraphs", 3);
        const failed = render(source);
        await vi.advanceTimersByTimeAsync(0);
        const failure = [...open].at(-1)!;
        expect(requestedTexts()).toEqual([...blockerSource, source[0]]);

        const joined = render([source[1]]);
        const composer: { value?: string; error?: unknown } = {};
        renders.push(
            translate(source[1], false).then(
                (value) => {
                    composer.value = value;
                },
                (error) => {
                    composer.error = error;
                },
            ),
        );
        const unrelatedSource = ["Shared failure unrelated"];
        const unrelated = render(unrelatedSource);
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(10);

        failure.answer(quotaError());
        await vi.advanceTimersByTimeAsync(0);
        expect(isTransient(failed.error)).toBe(true);
        expect(requestedTexts()).toEqual([...blockerSource, source[0], source[1]]);
        expect(joined).toEqual({});
        expect(composer).toEqual({});
        expect(open.size).toBe(10);

        const shared = [...open].find((request) => request.text === source[1])!;
        shared.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(joined).toEqual({ value: translated([source[1]]) });
        expect(composer).toEqual({ value: `Translated ${source[1]}` });
        expect(requestedTexts()).toEqual([...blockerSource, source[0], source[1], ...unrelatedSource]);
        for (const request of [...open]) request.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(unrelated).toEqual({ value: translated(unrelatedSource) });
        expect(requestedTexts().filter((text) => text === source[1])).toHaveLength(1);
        expect(peak).toBe(10);
        expect(open.size).toBe(0);
    });

    it("renders a warm pair-cache hit while ten unrelated provider requests remain open", async () => {
        const source = ["Warm cache bypass"];
        const warming = render(source);
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(1);
        for (const request of [...open]) request.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(warming).toEqual({ value: translated(source) });

        const blockers = render(paragraphs("Warm cache blockers", 10));
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(11);
        expect(open.size).toBe(10);

        const cached = render(source);
        await vi.advanceTimersByTimeAsync(0);
        expect(cached).toEqual({ value: translated(source) });
        expect(provider).toHaveBeenCalledTimes(11);
        expect(open.size).toBe(10);
        expect(blockers).toEqual({});
    });

    it("translates ten identical paragraphs with one provider request and one permit", async () => {
        const source = Array.from({ length: 10 }, () => "Identical paragraph producer");
        const repeated = render(source);
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(open.size).toBe(1);
        const [sharedRequest] = open;

        // One producer leaves nine permits free; the tenth unrelated request must wait.
        const otherSources = paragraphs("Identical paragraph blockers", 10);
        const others = render(otherSources);
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(10);
        expect(open.size).toBe(10);
        expect(repeated).toEqual({});
        expect(others).toEqual({});

        sharedRequest.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(repeated).toEqual({ value: translated(source) });
        expect(provider).toHaveBeenCalledTimes(11);
        expect(open.size).toBe(10);
        expect(peak).toBe(10);

        for (const request of [...open]) request.answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(others).toEqual({ value: translated(otherSources) });
        expect(provider).toHaveBeenCalledTimes(11);
        expect(open.size).toBe(0);
    });

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
        // Join an abandoned producer after unrelated callers have queued for its occupied slot.
        const joined = render([requested[0].text]);
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(10);
        expect(open.size).toBe(10);
        expect(fourth).toEqual({});
        expect(joined).toEqual({});

        requested[0].answer();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider).toHaveBeenCalledTimes(11);
        expect([...open].map((request) => request.text)).toContain("Fourth render 0");
        expect(open.size).toBe(10);
        expect(peak).toBe(10);
        expect(joined).toEqual({ value: translated([requested[0].text]) });
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
