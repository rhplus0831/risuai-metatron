// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `ChatBody` shows the last parsed body while a newer render is pending. Only the newest render
// writes that body: an older render that settles after a newer one must not put its text back.
// This file is `.svelte.test.ts` so the props can be `$state` and change on the mounted body.

type Deferred = { text: string; resolve: (html: string) => void };
const hoisted = vi.hoisted(() => ({
    parses: [] as Deferred[],
    settings: {
        ui: { showTranslationLoading: true },
        memoryTranslateMedia: {} as Partial<
            typeof import("src/ts/storage/settingsViews.svelte").settings.memoryTranslateMedia
        >,
    },
}));

vi.mock("src/ts/parser/parser.svelte", () => ({
    ParseMarkdown: vi.fn(
        (text: string) =>
            new Promise<string>((resolve) => {
                hoisted.parses.push({ text, resolve });
            }),
    ),
    trimMarkdown: vi.fn((html: string) => html),
    addMetadataToElement: vi.fn((html: string) => html),
    postTranslationParse: vi.fn(async (html: string) => html),
    getDistance: vi.fn(() => 0),
}));
vi.mock("src/ts/translator/translator", () => ({
    applyEdittransToStoredTranslation: vi.fn((text: string) => text),
    getLLMCache: vi.fn(async () => null),
    llmTranslationCacheKey: vi.fn((source: string) => `llm:k:${source}`),
    translateHTML: vi.fn(async (html: string) => html),
}));
vi.mock("src/ts/parser/transformClient", () => ({ captureTransform: vi.fn(() => null) }));
vi.mock("src/ts/process/modules", () => ({ getModuleAssets: vi.fn(() => []) }));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());
vi.mock("src/ts/storage/characterStore.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/storage/characterStore.svelte")>()),
    selectedCharacter: vi.fn(),
}));
vi.mock("src/ts/storage/settingsViews.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/storage/settingsViews.svelte")>()),
    settings: hoisted.settings,
}));

import { alertError } from "src/ts/alert";
import { ParseMarkdown, trimMarkdown } from "src/ts/parser/parser.svelte";
import { markTransient } from "src/ts/parser/renderErrors";
import { getLLMCache, llmTranslationCacheKey, translateHTML } from "src/ts/translator/translator";
import ChatBody from "./ChatBody.svelte";

const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) {
        await unmount(instance);
    }
    hoisted.parses.length = 0;
    document.body.innerHTML = "";
    hoisted.settings.memoryTranslateMedia = {};
    vi.mocked(translateHTML)
        .mockReset()
        .mockImplementation(async (html) => html);
    vi.mocked(getLLMCache).mockReset().mockResolvedValue(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** Settles the parse of `text` and lets its `{#await}` render. */
async function settle(text: string) {
    const parse = hoisted.parses.find((entry) => entry.text === text);
    expect(parse).toBeDefined();
    parse!.resolve(`<p>${text}</p>`);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

describe("ChatBody pending body", () => {
    it("whenRendered waits for the auto-translate flip and the resulting body", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const target = document.createElement("div");
        document.body.append(target);
        const props = $state({
            msgDisplay: "Translate me",
            role: "char",
            translated: false,
            translating: false,
            retranslate: false,
            modelShortName: "",
            autoTranslate: true,
        });
        const instance = mount(ChatBody, { target, props });
        mounted.push(instance);
        flushSync();
        const rendered = vi.fn();
        const waiting = instance.whenRendered().then(() => rendered(target.textContent));
        await vi.advanceTimersByTimeAsync(9);
        flushSync();
        expect(props.translated).toBe(false);
        expect(hoisted.parses).toHaveLength(0);
        expect(target.textContent).toBe("");
        expect(rendered).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        flushSync();
        expect(props.translated).toBe(true);
        expect(hoisted.parses.map((parse) => parse.text)).toEqual(["Translate me"]);
        expect(rendered).not.toHaveBeenCalled();
        hoisted.parses[0].resolve("<p>Translated body</p>");
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
        expect(rendered).toHaveBeenCalledExactlyOnceWith("Translated body");
        await waiting;
    });

    it("keeps the newest render's body when an older render settles later", async () => {
        const target = document.createElement("div");
        document.body.appendChild(target);
        const props = $state({
            msgDisplay: "A",
            role: "char",
            translated: false,
            translating: false,
            retranslate: false,
            modelShortName: "",
        });
        mounted.push(mount(ChatBody, { target, props }));
        flushSync();
        const text = () => target.textContent?.trim() ?? "";

        props.msgDisplay = "B";
        flushSync();
        expect(hoisted.parses.map((entry) => entry.text)).toEqual(["A", "B"]);

        await settle("B");
        expect(text()).toBe("B");

        // The older render settles after the newer one.
        await settle("A");
        expect(text()).toBe("B");

        // While the next render is pending, the body shown is the newest settled one.
        props.msgDisplay = "C";
        flushSync();
        expect(text()).toBe("B");

        await settle("C");
        expect(text()).toBe("C");
    });

    it("renders streaming chunks without translation or a spinner and translates the final text once", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        vi.mocked(translateHTML).mockClear();
        const target = document.createElement("div");
        document.body.append(target);
        const props = $state({
            msgDisplay: "The",
            role: "char",
            translated: false,
            translating: false,
            retranslate: false,
            modelShortName: "",
            autoTranslate: true,
            streaming: true,
        });
        const instance = mount(ChatBody, { target, props });
        mounted.push(instance);
        flushSync();

        async function settleCurrentRender(text: string) {
            await vi.runAllTimersAsync();
            flushSync();
            const parse = hoisted.parses.find((entry) => entry.text === text);
            expect(parse).toBeDefined();
            parse!.resolve(text);
            await vi.runAllTimersAsync();
            flushSync();
            await instance.whenRendered();
        }

        await settleCurrentRender(props.msgDisplay);
        for (const chunk of ["The stream", "The streaming", "The streaming message"]) {
            props.msgDisplay = chunk;
            flushSync();
            await vi.runAllTimersAsync();
            flushSync();
            expect(target.querySelector('[style*="animation: spin"]')).toBeNull();

            await settleCurrentRender(chunk);
            expect(translateHTML).not.toHaveBeenCalled();
            expect(target.textContent?.trim()).toBe(chunk);
            expect(props.translating).toBe(false);
            expect(target.querySelector('[style*="animation: spin"]')).toBeNull();
        }

        const finalText = "The streaming message is complete.";
        const translatedText = "최종 번역 메시지.";
        vi.mocked(translateHTML).mockResolvedValueOnce(`<p>${translatedText}</p>`);
        props.msgDisplay = finalText;
        props.streaming = false;
        flushSync();
        await settleCurrentRender(finalText);

        expect(translateHTML).toHaveBeenCalledTimes(1);
        expect(vi.mocked(translateHTML).mock.calls[0][0]).toBe(finalText);
        expect(target.textContent?.trim()).toBe(translatedText);
    });
});

describe("ChatBody parse errors", () => {
    it("renders and alerts a deterministic parse error once with its original stack", async () => {
        const originalError = new Error("Malformed chat markup");
        originalError.stack = "Error: Malformed chat markup\n    at ParseMarkdown (chat-parser.ts:42:7)";
        vi.mocked(alertError).mockClear();

        await vi.mocked(ParseMarkdown).withImplementation(
            async () => {
                throw originalError;
            },
            async () => {
                const target = document.createElement("div");
                document.body.append(target);
                const instance = mount(ChatBody, {
                    target,
                    props: {
                        msgDisplay: "A message that cannot be parsed",
                        role: "char",
                        translated: false,
                        translating: false,
                        retranslate: false,
                        modelShortName: "",
                    },
                });
                mounted.push(instance);
                flushSync();
                await vi.runAllTimersAsync();
                await instance.whenRendered();

                expect(ParseMarkdown).toHaveBeenCalledTimes(1);
                expect(target.textContent).toBe("A message that cannot be parsed");
                expect(alertError).toHaveBeenCalledTimes(1);
                const alert = vi.mocked(alertError).mock.calls[0][0] as Error;
                expect(alert).toBeInstanceOf(Error);
                expect(alert.message).toBe(`Error while parsing chat message: ${originalError.message}`);
                expect(alert.stack).toBe(originalError.stack);
            },
        );
    });
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function bodyProps() {
    return {
        msgDisplay: "Old text",
        character: "character-a",
        role: "char",
        translated: false,
        translating: false,
        retranslate: false,
        modelShortName: "",
        renderRevision: 0,
        autoTranslate: false,
    };
}

function mountBody(props: ReturnType<typeof bodyProps>) {
    const target = document.createElement("div");
    document.body.append(target);
    const instance = mount(ChatBody, { target, props });
    mounted.push(instance);
    flushSync();
    return { target, instance };
}

async function drain() {
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

const callsFor = (text: string) => vi.mocked(ParseMarkdown).mock.calls.filter(([source]) => source === text);

describe("ChatBody render lifetime", () => {
    it("aborts a pending parse on raw streaming entry and renders unchanged text with a fresh run", async () => {
        const props = $state({ ...bodyProps(), renderRawStreaming: false, rawStreamingText: "Old text" });
        const { target, instance } = mountBody(props);
        const interrupted = hoisted.parses.find((parse) => parse.text === props.msgDisplay)!;
        const signal = callsFor(props.msgDisplay)[0][6];
        expect(signal?.aborted).toBe(false);

        props.renderRawStreaming = true;
        flushSync();
        // Check before resolving any parse or asking whenRendered to evaluate the rendered path.
        expect(signal?.aborted).toBe(true);
        expect(target.textContent).toBe("Old text");

        props.renderRawStreaming = false;
        flushSync();
        const parses = hoisted.parses.filter((parse) => parse.text === props.msgDisplay);
        expect(parses).toHaveLength(2);
        parses[1].resolve("<p>Fresh body</p>");
        await drain();
        await instance.whenRendered();
        expect(target.textContent).toBe("Fresh body");

        interrupted.resolve("<p>Aborted body</p>");
        await drain();
        expect(target.textContent).toBe("Fresh body");
    });

    it("keeps the last completed body when an aborted parse settles during raw streaming", async () => {
        const props = $state({ ...bodyProps(), renderRawStreaming: false, rawStreamingText: "Current text" });
        const { target, instance } = mountBody(props);
        hoisted.parses.find((parse) => parse.text === "Old text")!.resolve("<p>Previous body</p>");
        await drain();
        await instance.whenRendered();
        expect(target.textContent).toBe("Previous body");

        props.msgDisplay = "Current text";
        flushSync();
        const interrupted = hoisted.parses.find((parse) => parse.text === "Current text")!;
        const signal = callsFor("Current text")[0][6];
        props.renderRawStreaming = true;
        flushSync();
        expect(signal?.aborted).toBe(true);

        interrupted.resolve("<p>Aborted body</p>");
        await drain();
        expect(target.textContent).toBe("Current text");

        props.renderRawStreaming = false;
        flushSync();
        const parses = hoisted.parses.filter((parse) => parse.text === "Current text");
        expect(parses).toHaveLength(2);
        expect(target.textContent).toBe("Previous body");

        parses[1].resolve("<p>Current body</p>");
        await drain();
        await instance.whenRendered();
        expect(target.textContent).toBe("Current body");
    });

    it("aborts pretranslation on text, character and revision changes and keeps the newest body", async () => {
        const props = $state({ ...bodyProps(), translated: true, autoTranslate: true });
        const { target, instance } = mountBody(props);
        props.msgDisplay = "New text";
        flushSync();
        props.character = "character-b";
        flushSync();
        props.renderRevision++;
        flushSync();

        expect(ParseMarkdown).toHaveBeenCalledTimes(4);
        const signals = vi.mocked(ParseMarkdown).mock.calls.map((call) => call[6]);
        expect(new Set(signals).size).toBe(4);
        expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
        expect(signals.map((signal) => signal!.aborted)).toEqual([true, true, true, false]);
        expect(vi.mocked(ParseMarkdown).mock.calls.every((call) => call[2] === "pretranslate")).toBe(true);

        vi.mocked(translateHTML).mockResolvedValueOnce("<p>Newest translation</p>");
        hoisted.parses[3].resolve("<p>New source</p>");
        await drain();
        await instance.whenRendered();
        for (const parse of hoisted.parses.slice(0, 3)) parse.resolve("<p>Obsolete source</p>");
        await drain();

        expect(ParseMarkdown).toHaveBeenCalledTimes(4);
        expect(callsFor("Old text")).toHaveLength(1);
        expect(translateHTML).toHaveBeenCalledTimes(1);
        expect(vi.mocked(translateHTML).mock.calls[0][0]).toBe("<p>New source</p>");
        expect(vi.mocked(translateHTML).mock.calls[0][6]).toBe(signals[3]);
        expect(target.textContent).toBe("Newest translation");
        expect(alertError).toHaveBeenCalledTimes(0);
    });

    it("aborts an unmounted row during pretranslation without starting more work", async () => {
        const props = $state({ ...bodyProps(), translated: true, autoTranslate: true });
        const { instance, target } = mountBody(props);
        expect(ParseMarkdown).toHaveBeenCalledTimes(1);
        const signal = vi.mocked(ParseMarkdown).mock.calls[0][6];
        await unmount(instance);
        mounted.splice(mounted.indexOf(instance), 1);
        expect(signal?.aborted).toBe(true);
        hoisted.parses[0].resolve("<p>Late source</p>");
        await drain();
        expect(ParseMarkdown).toHaveBeenCalledTimes(1);
        expect(translateHTML).toHaveBeenCalledTimes(0);
        expect(alertError).toHaveBeenCalledTimes(0);
        expect(target.textContent).toBe("");
    });

    it("retries transient failures at 250 and 1250 ms and alerts once after the third failure", async () => {
        const failure = new TypeError("Asset read failed");
        await vi.mocked(ParseMarkdown).withImplementation(
            async () => {
                throw markTransient(failure);
            },
            async () => {
                const { instance, target } = mountBody(bodyProps());
                await drain();
                expect(ParseMarkdown).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(249);
                expect(ParseMarkdown).toHaveBeenCalledTimes(1);
                expect(alertError).toHaveBeenCalledTimes(0);
                await vi.advanceTimersByTimeAsync(1);
                expect(ParseMarkdown).toHaveBeenCalledTimes(2);
                await vi.advanceTimersByTimeAsync(999);
                expect(ParseMarkdown).toHaveBeenCalledTimes(2);
                expect(alertError).toHaveBeenCalledTimes(0);
                await vi.advanceTimersByTimeAsync(1);
                expect(ParseMarkdown).toHaveBeenCalledTimes(3);
                expect(alertError).toHaveBeenCalledTimes(1);
                expect(vi.mocked(alertError).mock.calls[0][0]).toMatchObject({
                    message: "Error while parsing chat message: Asset read failed",
                    stack: failure.stack,
                });
                await instance.whenRendered();
                expect(target.textContent).toBe("Old text");
                const signals = vi.mocked(ParseMarkdown).mock.calls.map((call) => call[6]);
                expect(new Set(signals).size).toBe(1);
                expect(signals[0]?.aborted).toBe(false);
                await vi.runAllTimersAsync();
                expect(ParseMarkdown).toHaveBeenCalledTimes(3);
                expect(alertError).toHaveBeenCalledTimes(1);
            },
        );
    });

    it("cancels a transient retry when its text changes during the first delay", async () => {
        await vi.mocked(ParseMarkdown).withImplementation(
            async (text) => {
                if (text === "Old text") throw markTransient(new TypeError("Offline"));
                return "<p>New body</p>";
            },
            async () => {
                const props = $state(bodyProps());
                const { instance, target } = mountBody(props);
                await vi.advanceTimersByTimeAsync(249);
                expect(callsFor("Old text")).toHaveLength(1);
                props.msgDisplay = "New text";
                flushSync();
                await drain();
                await instance.whenRendered();
                await vi.runAllTimersAsync();
                expect(callsFor("Old text")).toHaveLength(1);
                expect(callsFor("New text")).toHaveLength(1);
                expect(alertError).toHaveBeenCalledTimes(0);
                expect(target.textContent).toBe("New body");
            },
        );
    });

    it.each(["before the cache answers", "before the delayed flip"])(
        "reprobes a same-character text change %s and finishes translated without stale work",
        async (supersedeAt) => {
            hoisted.settings.memoryTranslateMedia = { autoTranslateCachedOnly: true, translatorType: "llm" };
            const logged = vi.spyOn(console, "error").mockImplementation(() => {});
            const oldCache = deferred<string | null>();
            vi.mocked(getLLMCache)
                .mockReturnValueOnce(oldCache.promise)
                .mockResolvedValueOnce("New cached translation");
            const props = $state({ ...bodyProps(), autoTranslate: true });
            const { instance, target } = mountBody(props);
            const rendered = vi.fn();
            const waiting = instance.whenRendered().then(rendered);
            hoisted.parses[0].resolve("Old parsed source");
            await drain();
            expect(getLLMCache).toHaveBeenCalledTimes(1);
            if (supersedeAt === "before the delayed flip") {
                oldCache.resolve("Old cached translation");
                await drain();
                await vi.advanceTimersByTimeAsync(9);
                expect(props.translated).toBe(false);
            }
            props.msgDisplay = "New text";
            flushSync();
            expect(callsFor("New text")).toHaveLength(1);
            oldCache.resolve(supersedeAt === "before the cache answers" ? null : "Old cached translation");
            await drain();
            expect(callsFor("Old text")).toHaveLength(1);
            expect(translateHTML).toHaveBeenCalledTimes(0);
            expect(logged).toHaveBeenCalledTimes(0);
            expect(rendered).toHaveBeenCalledTimes(0);

            hoisted.parses[1].resolve("New parsed source");
            await drain();
            expect(getLLMCache).toHaveBeenCalledTimes(2);
            expect(vi.mocked(getLLMCache).mock.calls.map(([source]) => source)).toEqual([
                "Old parsed source",
                "New parsed source",
            ]);
            await vi.advanceTimersByTimeAsync(10);
            flushSync();
            expect(props.translated).toBe(true);
            expect(callsFor("New text")).toHaveLength(2);
            vi.mocked(translateHTML).mockResolvedValueOnce("<p>New translated body</p>");
            hoisted.parses[2].resolve("New parsed source");
            await drain();
            expect(rendered).toHaveBeenCalledTimes(1);
            await waiting;
            expect(target.textContent).toBe("New translated body");
            expect(translateHTML).toHaveBeenCalledTimes(1);
            expect(vi.mocked(translateHTML).mock.calls[0][0]).toBe("New parsed source");
            expect(callsFor("Old text")).toHaveLength(1);
            expect(logged).toHaveBeenCalledTimes(0);
            expect(alertError).toHaveBeenCalledTimes(0);
        },
    );

    it("reprobes a settled cached row after a text change and leaves an uncached replacement untranslated", async () => {
        hoisted.settings.memoryTranslateMedia = { autoTranslateCachedOnly: true, translatorType: "llm" };
        vi.mocked(getLLMCache).mockImplementation(async (source) =>
            source === "<p>Old text</p>" ? "Old cached translation" : null,
        );
        vi.mocked(translateHTML).mockResolvedValue("<p>Old translated body</p>");

        await vi.mocked(ParseMarkdown).withImplementation(
            async (text) => `<p>${text}</p>`,
            async () => {
                const props = $state({ ...bodyProps(), idx: 7, autoTranslate: true });
                const { instance, target } = mountBody(props);
                await vi.runAllTimersAsync();
                flushSync();
                await instance.whenRendered();
                expect(props.translated).toBe(true);
                expect(target.textContent).toBe("Old translated body");
                expect(getLLMCache).toHaveBeenCalledExactlyOnceWith("<p>Old text</p>");
                expect(translateHTML).toHaveBeenCalledTimes(1);

                props.msgDisplay = "New text";
                flushSync();
                await vi.runAllTimersAsync();
                flushSync();
                await instance.whenRendered();

                expect(getLLMCache).toHaveBeenCalledTimes(2);
                expect(vi.mocked(getLLMCache).mock.calls.map(([source]) => source)).toEqual([
                    "<p>Old text</p>",
                    "<p>New text</p>",
                ]);
                expect(translateHTML).toHaveBeenCalledTimes(1);
                expect(vi.mocked(translateHTML).mock.calls[0][0]).toBe("<p>Old text</p>");
                expect(props.translated).toBe(false);
                expect(target.textContent).toBe("New text");
            },
        );
    });

    it("reprobes a settled cached row when the translation key prefix changes", async () => {
        hoisted.settings.memoryTranslateMedia = { autoTranslateCachedOnly: true, translatorType: "llm" };
        const configuration = $state({ prefix: "llm:cached:" });
        vi.mocked(getLLMCache).mockImplementation(async () =>
            configuration.prefix === "llm:cached:" ? "Old cached translation" : null,
        );
        vi.mocked(translateHTML).mockResolvedValue("<p>Old translated body</p>");

        await vi.mocked(llmTranslationCacheKey).withImplementation(
            (source) => `${configuration.prefix}${source}`,
            async () => {
                await vi.mocked(ParseMarkdown).withImplementation(
                    async (text) => `<p>${text}</p>`,
                    async () => {
                        const props = $state({ ...bodyProps(), autoTranslate: true });
                        const { instance, target } = mountBody(props);
                        await vi.runAllTimersAsync();
                        flushSync();
                        await instance.whenRendered();
                        expect(props.translated).toBe(true);
                        expect(target.textContent).toBe("Old translated body");
                        expect(getLLMCache).toHaveBeenCalledExactlyOnceWith("<p>Old text</p>");
                        expect(translateHTML).toHaveBeenCalledTimes(1);

                        configuration.prefix = "llm:uncached:";
                        flushSync();
                        await vi.runAllTimersAsync();
                        flushSync();
                        await instance.whenRendered();

                        expect(getLLMCache).toHaveBeenCalledTimes(2);
                        expect(vi.mocked(getLLMCache).mock.calls.map(([source]) => source)).toEqual([
                            "<p>Old text</p>",
                            "<p>Old text</p>",
                        ]);
                        expect(translateHTML).toHaveBeenCalledTimes(1);
                        expect(vi.mocked(translateHTML).mock.calls[0][0]).toBe("<p>Old text</p>");
                        expect(props.translated).toBe(false);
                        expect(target.textContent).toBe("Old text");
                    },
                );
            },
        );
    });

    it("keeps an explicit translation toggle across text changes without checking the cache key", async () => {
        hoisted.settings.memoryTranslateMedia = { autoTranslateCachedOnly: true, translatorType: "llm" };
        vi.mocked(getLLMCache).mockResolvedValue(null);
        vi.mocked(translateHTML)
            .mockResolvedValueOnce("<p>Old requested translation</p>")
            .mockResolvedValueOnce("<p>New requested translation</p>");

        await vi.mocked(ParseMarkdown).withImplementation(
            async (text) => `<p>${text}</p>`,
            async () => {
                const props = $state({ ...bodyProps(), autoTranslate: true });
                const { instance, target } = mountBody(props);
                await vi.runAllTimersAsync();
                flushSync();
                await instance.whenRendered();
                expect(props.translated).toBe(false);
                expect(target.textContent).toBe("Old text");
                expect(getLLMCache).toHaveBeenCalledExactlyOnceWith("<p>Old text</p>");
                expect(translateHTML).not.toHaveBeenCalled();

                props.translated = true;
                flushSync();
                await vi.runAllTimersAsync();
                flushSync();
                await instance.whenRendered();
                expect(props.translated).toBe(true);
                expect(target.textContent).toBe("Old requested translation");
                expect(translateHTML).toHaveBeenCalledTimes(1);

                props.msgDisplay = "New text";
                flushSync();
                await vi.runAllTimersAsync();
                flushSync();
                await instance.whenRendered();

                expect(getLLMCache).toHaveBeenCalledTimes(1);
                expect(translateHTML).toHaveBeenCalledTimes(2);
                expect(vi.mocked(translateHTML).mock.calls.map(([source]) => source)).toEqual([
                    "<p>Old text</p>",
                    "<p>New text</p>",
                ]);
                expect(props.translated).toBe(true);
                expect(target.textContent).toBe("New requested translation");
            },
        );
    });

    it("clears translating when translation is turned off during a request", async () => {
        const oldTranslation = deferred<string>();
        vi.mocked(translateHTML).mockReturnValueOnce(oldTranslation.promise);
        const props = $state({ ...bodyProps(), translated: true, autoTranslate: true });
        const { instance, target } = mountBody(props);
        hoisted.parses[0].resolve("Old source");
        await drain();
        expect(translateHTML).toHaveBeenCalledTimes(1);
        expect(props.translating).toBe(true);
        props.translated = false;
        flushSync();
        expect(vi.mocked(translateHTML).mock.calls[0][6]?.aborted).toBe(true);
        hoisted.parses[1].resolve("<p>Original body</p>");
        await drain();
        await instance.whenRendered();
        oldTranslation.resolve("<p>Obsolete translation</p>");
        await drain();
        expect(props.translating).toBe(false);
        expect(ParseMarkdown).toHaveBeenCalledTimes(2);
        expect(translateHTML).toHaveBeenCalledTimes(1);
        expect(target.textContent).toBe("Original body");
    });

    it("keeps translating true when an older request settles during a newer translation", async () => {
        const oldTranslation = deferred<string>();
        const newTranslation = deferred<string>();
        vi.mocked(translateHTML)
            .mockReturnValueOnce(oldTranslation.promise)
            .mockReturnValueOnce(newTranslation.promise);
        const props = $state({ ...bodyProps(), translated: true, autoTranslate: true });
        const { instance, target } = mountBody(props);
        hoisted.parses[0].resolve("Old source");
        await drain();
        expect(translateHTML).toHaveBeenCalledTimes(1);
        expect(props.translating).toBe(true);
        props.msgDisplay = "New text";
        flushSync();
        hoisted.parses[1].resolve("New source");
        await drain();
        expect(translateHTML).toHaveBeenCalledTimes(2);
        oldTranslation.resolve("<p>Old translation</p>");
        await drain();
        expect(props.translating).toBe(true);
        newTranslation.resolve("<p>Newest translation</p>");
        await drain();
        await instance.whenRendered();
        expect(props.translating).toBe(false);
        expect(ParseMarkdown).toHaveBeenCalledTimes(2);
        expect(translateHTML).toHaveBeenCalledTimes(2);
        expect(target.textContent).toBe("Newest translation");
    });

    it("reuses a pending body for the same source and prepares it again when the model name changes", async () => {
        const props = $state(bodyProps());
        const { instance, target } = mountBody(props);
        hoisted.parses[0].resolve("<p>Settled body</p>");
        await drain();
        await instance.whenRendered();
        vi.mocked(trimMarkdown).mockClear();

        // The settled branch primed reuse. A new model makes the first pending render prepare once.
        props.modelShortName = "model-a";
        props.renderRevision++;
        flushSync();
        expect(trimMarkdown).toHaveBeenCalledExactlyOnceWith("<p>Settled body</p>");
        props.renderRevision++;
        flushSync();
        expect(ParseMarkdown).toHaveBeenCalledTimes(3);
        expect(trimMarkdown).toHaveBeenCalledTimes(1);
        expect(target.textContent).toBe("Settled body");

        props.modelShortName = "model-b";
        flushSync();
        expect(trimMarkdown).toHaveBeenCalledTimes(2);
        expect(vi.mocked(trimMarkdown).mock.calls.map(([source]) => source)).toEqual([
            "<p>Settled body</p>",
            "<p>Settled body</p>",
        ]);
        expect(target.textContent).toBe("Settled body");
    });
});
