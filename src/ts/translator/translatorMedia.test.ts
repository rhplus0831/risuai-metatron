// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";

const deps = vi.hoisted(() => ({
    globalFetch: vi.fn(),
    fetch: vi.fn(),
    request: vi.fn(),
    alert: vi.fn(),
    script: vi.fn(),
    markdown: vi.fn(),
}));
vi.mock("localforage", () => ({
    default: { createInstance: () => ({ getItem: async () => null, setItem: async () => undefined }) },
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    globalFetch: deps.globalFetch,
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));
vi.mock("src/ts/process/request/request", () => ({ requestChatData: deps.request }));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: deps.alert,
    }),
);
vi.mock("src/ts/parser/parser.svelte", () => ({
    risuChatParser: (text: string) => text,
    applyMarkdownToNode: deps.markdown,
}));
vi.mock("src/ts/parser/transformClient", () => ({
    captureTransform: () => null,
    serverProcessScript: deps.script,
    resetTransformEffects: vi.fn(),
}));
vi.mock("src/ts/process/modules", () => ({ moduleUpdate: vi.fn(), getModuleRegexScripts: () => [] }));
vi.mock("src/ts/model/modellist", () => ({ getModelInfoForMode: () => ({ id: "gpt-test" }) }));
vi.mock("src/ts/util", () => ({
    getNodetextToSentence: (node: Node) => node.textContent,
    // On the timers, so the DeepLX spacing runs on the fake clock.
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import type { CapturedTransform } from "src/ts/parser/transformClient";
import { runTranslator, translate, translateHTML, translateVox } from "./translator";

const media = settings.memoryTranslateMedia;
function configure() {
    installFlatDatabase({
        characters: [],
        translatorType: "deeplX",
        translator: "ko",
        translatorInputLanguage: "en",
        noWaitForTranslate: true,
        combineTranslation: false,
        useExperimentalGoogleTranslator: false,
        deeplXOptions: { url: "https://deeplx.test", token: "" },
        deeplOptions: { key: "test", freeApi: true },
        translatorPresets: [createTranslatorPreset("Test", { id: "test" })],
        translatorPresetId: "test",
    });
}

function body(html: string) {
    return new DOMParser().parseFromString(html, "text/html").body;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
type Request = { body?: { text: string | string[]; target_lang: string } };
function reply(url: string, init: Request = {}) {
    if (url.startsWith("https://translate.google.com/")) {
        const query = new URL(url).searchParams;
        return {
            ok: true,
            data: `<div class="result-container">${query.get("tl").toUpperCase()}:${query.get("q")}</div>`,
        };
    }
    const { text, target_lang } = init.body;
    return Array.isArray(text)
        ? { ok: true, data: { translations: [{ text: `${target_lang}:${text[0]}` }] } }
        : {
              ok: true,
              data: {
                  data: text
                      .split("■")
                      .map((part) => `${target_lang}:${part.trim()}`)
                      .join("■"),
              },
          };
}
const calls = () => deps.globalFetch.mock.calls.length + deps.fetch.mock.calls.length;

beforeEach(() => {
    vi.clearAllMocks();
    configure();
    deps.globalFetch.mockImplementation(async (url: string, init: Request) => reply(url, init));
    deps.fetch.mockImplementation(async (url: string) => {
        const query = new URL(url).searchParams;
        return Response.json([[[`${query.get("tl").toUpperCase()}:${query.get("q")}`]]]);
    });
    vi.stubGlobal("fetch", deps.fetch);
    deps.script.mockImplementation(async (_char: unknown, text: string) => ({ data: text }));
    // A visible marker proves that the translated node, including a replacement node, was processed.
    deps.markdown.mockImplementation((node: HTMLElement) => node.setAttribute("data-markdown", "applied"));
});
afterEach(() => vi.unstubAllGlobals());

describe("translateHTML media regressions", () => {
    it("finishes blank nodes and more than eleven nodes in sequential bounded DeepLX batches, including the tail and an oversized node", async () => {
        await expect(translateHTML("<p>  </p>\n<span>\t</span>", false, "", 0)).resolves.toContain("<p>  </p>");
        expect(calls()).toBe(0);
        // The first two jobs occupy exactly 5000 characters with the join's whitespace.
        const nodes = [
            "a".repeat(2499),
            "b".repeat(2498),
            "c".repeat(5000),
            "d".repeat(5001),
            ...Array.from({ length: 12 }, (_, i) => `tail-${i}`),
        ];
        const pending: ReturnType<typeof deferred<ReturnType<typeof reply>>>[] = [];
        const sent: string[][] = [];
        let active = 0;
        let peak = 0;
        deps.globalFetch.mockImplementation(async (_url: string, init: Request) => {
            peak = Math.max(peak, ++active);
            sent.push((init.body.text as string).split("■").map((text) => text.trim()));
            const gate = deferred<ReturnType<typeof reply>>();
            pending.push(gate);
            try {
                return await gate.promise;
            } finally {
                active--;
            }
        });
        const work = translateHTML(nodes.map((text) => `<span>${text}</span> \n`).join(""), false, "", 0);
        const expected = [nodes.slice(0, 2), [nodes[2]], [nodes[3]], nodes.slice(4)];
        for (let i = 0; i < expected.length; i++) {
            await vi.waitFor(() => expect(pending.length).toBe(i + 1));
            expect(sent[i].map((text) => text.length)).toEqual(expected[i].map((text) => text.length));
            expect(sent[i].map((text) => text.slice(0, 10))).toEqual(expected[i].map((text) => text.slice(0, 10)));
            expect(peak).toBe(1);
            pending[i].resolve({
                ok: true,
                data: { data: expected[i].map((text) => `done:${nodes.indexOf(text)}`).join("■") },
            });
        }
        const rendered = body(await work);
        expect([...rendered.querySelectorAll("span")].map((node) => node.textContent)).toEqual(
            nodes.map((_, i) => `done:${i}`),
        );
        expect(calls()).toBe(4);
    });

    it.each(["missing", "extra"])(
        "retries every DeepLX node separately when the reply has %s separators",
        async (kind) => {
            const nodes = [`${kind}-one`, `${kind}-two`, `${kind}-three`];
            deps.globalFetch.mockResolvedValueOnce({
                ok: true,
                data: { data: kind === "missing" ? "lost" : "a■b■c■d" },
            });
            const rendered = body(
                await translateHTML(nodes.map((text) => `<span>${text}</span>`).join(""), false, "", 0),
            );
            expect(deps.globalFetch.mock.calls.map(([, init]) => init.body.text)).toEqual([
                nodes.join("\n■\n"),
                ...nodes,
            ]);
            expect([...rendered.querySelectorAll("span")].map((node) => node.textContent)).toEqual(
                nodes.map((text) => `KO:${text}`),
            );
        },
    );

    it.each(["deepl", "google"] as const)(
        "keeps at most ten %s nodes in flight and eventually translates all of them",
        async (provider) => {
            media.translatorType = provider;
            const gate = deferred<void>();
            let active = 0;
            let peak = 0;
            const transport = provider === "deepl" ? deps.globalFetch : deps.fetch;
            const implementation = transport.getMockImplementation()!;
            transport.mockImplementation(async (...args: unknown[]) => {
                peak = Math.max(peak, ++active);
                await gate.promise;
                try {
                    return await implementation(...args);
                } finally {
                    active--;
                }
            });
            const nodes = Array.from({ length: 23 }, (_, i) => `${provider}-limited-${i}`);
            const work = translateHTML(nodes.map((text) => `<span>${text}</span>`).join(""), false, "", 0);
            let translated: string;
            try {
                await vi.waitFor(() => expect(active).toBeGreaterThan(0));
                // Keep responses pending through a full turn, so asynchronous DOM traversal can
                // enqueue every request it is allowed to start before we measure the cap.
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                expect(active).toBeLessThanOrEqual(10);
            } finally {
                gate.resolve();
                translated = await work;
            }
            const rendered = body(translated);
            expect(peak).toBeLessThanOrEqual(10);
            expect([...rendered.querySelectorAll("span")].map((node) => node.textContent)).toEqual(
                nodes.map((text) => `KO:${text}`),
            );
            expect(calls()).toBe(23);
        },
    );

    // The LLM translator never enters the DOM traversal (it translates the whole HTML in one call).
    it.each(["deeplX", "deepl", "google"] as const)(
        "applies display scripts and Markdown to combined paragraphs with %s",
        async (provider) => {
            media.translatorType = provider;
            media.combineTranslation = true;
            const transform = {
                chatRef: { chaId: "c", chatId: "chat" },
                context: {},
                generation: 0,
            } as CapturedTransform;
            // Exercise both script outcomes: keep the existing node, or install the script's replacement.
            for (const changed of [false, true]) {
                deps.script.mockClear();
                deps.markdown.mockClear();
                const source = `combined-${provider}-${changed}`;
                const translated = `KO:${source}`;
                const processed = changed ? `<em>${translated}</em>` : translated;
                deps.request.mockResolvedValue({ type: "success", result: `<p>${translated}</p>` });
                deps.script.mockResolvedValue({ data: processed });
                const rendered = body(
                    await translateHTML(`<p><strong>${source}</strong></p>`, false, "", 7, false, transform),
                );
                expect(deps.script).toHaveBeenCalledWith(
                    expect.anything(),
                    translated,
                    "editdisplay",
                    7,
                    {},
                    transform,
                    "translation",
                );
                expect(deps.markdown).toHaveBeenCalledTimes(1);
                expect(rendered.querySelector("p")?.getAttribute("data-markdown")).toBe("applied");
                expect(rendered.querySelector("p")?.innerHTML).toBe(processed);
            }
        },
    );
});

describe("translate memory cache ownership", () => {
    it("invalidates both lookup directions when either language or a non-LLM provider option changes", async () => {
        const cases = [
            {
                name: "target",
                before: () => {},
                change: () => {
                    media.translator = "fr";
                },
                host: "deeplx.test",
                target: "FR",
            },
            {
                name: "source",
                before: () => {
                    media.translatorType = "google";
                },
                change: () => {
                    media.translatorInputLanguage = "ja";
                },
                host: "translate.googleapis.com",
                target: "KO",
            },
            {
                name: "deepl",
                before: () => {},
                change: () => {
                    media.translatorType = "deepl";
                },
                host: "api-free.deepl.com",
                target: "KO",
            },
            {
                name: "deeplX",
                before: () => {
                    media.translatorType = "deepl";
                },
                change: () => {
                    media.translatorType = "deeplX";
                },
                host: "deeplx.test",
                target: "KO",
            },
            {
                name: "google",
                before: () => {},
                change: () => {
                    media.translatorType = "google";
                },
                host: "translate.googleapis.com",
                target: "KO",
            },
            {
                name: "experimental",
                before: () => {
                    media.translatorType = "google";
                },
                change: () => {
                    media.useExperimentalGoogleTranslator = true;
                },
                host: "translate.google.com",
                target: "KO",
            },
            {
                name: "url",
                before: () => {},
                change: () => {
                    settings.secrets.deeplXOptions.url = "https://other-deeplx.test";
                },
                host: "other-deeplx.test",
                target: "KO",
            },
            {
                name: "freeApi",
                before: () => {
                    media.translatorType = "deepl";
                },
                change: () => {
                    settings.secrets.deeplOptions.freeApi = false;
                },
                host: "api.deepl.com",
                target: "KO",
            },
        ];
        for (const scenario of cases) {
            configure();
            scenario.before();
            const source = `cache-${scenario.name}`;
            const old = await translate(source, false);
            const count = calls();
            await expect(translate(source, false)).resolves.toBe(old);
            await expect(translate(old, true)).resolves.toBe(source);
            expect(calls(), scenario.name).toBe(count);
            scenario.change();
            // Check reverse before the new forward pair can replace the old translation side.
            await expect(translate(old, true)).resolves.toBe(`EN:${old}`);
            await expect(translate(source, false)).resolves.toBe(`${scenario.target}:${source}`);
            expect(calls(), scenario.name).toBe(count + 2);
            const [url] =
                scenario.host === "translate.googleapis.com"
                    ? deps.fetch.mock.lastCall!
                    : deps.globalFetch.mock.lastCall!;
            expect(new URL(url).host, scenario.name).toBe(scenario.host);
            if (scenario.name === "source") expect(new URL(url).searchParams.get("sl")).toBe("ja");
            await expect(translate(source, false)).resolves.toBe(`${scenario.target}:${source}`);
            await expect(translate(`${scenario.target}:${source}`, true)).resolves.toBe(source);
            expect(calls(), scenario.name).toBe(count + 2);
        }
    });

    it("does not put an old in-flight translation into the newly selected configuration", async () => {
        const pending = deferred<ReturnType<typeof reply>>();
        deps.globalFetch.mockReturnValueOnce(pending.promise);
        const old = translate("pending-language", false);
        await vi.waitFor(() => expect(calls()).toBe(1));
        media.translator = "fr";
        pending.resolve({ ok: true, data: { data: "old Korean result" } });
        await expect(old).resolves.toBe("old Korean result");
        await expect(translate("pending-language", false)).resolves.toBe("FR:pending-language");
        await expect(translate("old Korean result", true)).resolves.toBe("EN:old Korean result");
        expect(calls()).toBe(3);
        await expect(translate("pending-language", false)).resolves.toBe("FR:pending-language");
        expect(calls()).toBe(3);
    });

    it("keeps direct runTranslator and VOICEVOX translations out of the display cache", async () => {
        await expect(runTranslator("direct-source", false, "fr", "en")).resolves.toBe("FR:direct-source");
        await expect(translate("direct-source", false)).resolves.toBe("KO:direct-source");
        await expect(translate("FR:direct-source", true)).resolves.toBe("EN:FR:direct-source");
        await expect(translateVox("voice-source")).resolves.toBe("JA:voice-source");
        await expect(translate("voice-source", true)).resolves.toBe("EN:voice-source");
        await expect(translate("JA:voice-source", false)).resolves.toBe("KO:JA:voice-source");
        expect(calls()).toBe(6);
    });

    it("alerts and returns the source on ERR without caching the failed translation", async () => {
        deps.globalFetch.mockResolvedValueOnce({ ok: false, data: "unavailable" });
        await expect(translate("retry-source", false)).resolves.toBe("retry-source");
        expect(deps.alert).toHaveBeenCalledWith("ERR::DeepLX API Errorunavailable");
        await expect(translate("retry-source", false)).resolves.toBe("KO:retry-source");
        expect(calls()).toBe(2);
        await expect(translate("retry-source", false)).resolves.toBe("KO:retry-source");
        expect(calls()).toBe(2);
    });
});

describe("runTranslator line breaks", () => {
    it("sends the lines between two empty or asset lines as one chunk with their line breaks, as the server does", async () => {
        const text = "first\nsecond\n\nthird\n{{img::x}}\nfourth\nfifth";
        await expect(runTranslator(text, false, "ko", "en")).resolves.toBe(
            "KO:first\nsecond\n\nKO:third\n{{img::x}}\nKO:fourth\nfifth",
        );
        expect(deps.globalFetch.mock.calls.map(([, init]) => init.body.text)).toEqual([
            "first\nsecond",
            "third",
            "fourth\nfifth",
        ]);
    });

    it("keeps a DeepLX batch's asset lines protected and gives each node its text without the separator's line breaks", async () => {
        // A provider that keeps every line break of the request.
        deps.globalFetch.mockImplementation(async (_url: string, init: Request) => ({
            ok: true,
            data: { data: (init.body.text as string).toUpperCase() },
        }));
        const rendered = body(
            await translateHTML("<p>{{img::a}}</p><p>hello</p><p>{{raw::b}}</p><b>bold</b> tail", false, "", 0),
        );
        expect(deps.globalFetch.mock.calls.map(([, init]) => init.body.text)).toEqual([
            "■\nhello\n■",
            "■\nbold\n■\n tail",
        ]);
        expect([...rendered.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
            "{{img::a}}",
            "HELLO",
            "{{raw::b}}",
        ]);
        expect(rendered.querySelector("b")?.textContent).toBe("BOLD");
        expect(rendered.lastChild?.textContent).toBe(" TAIL");
    });
});

describe("DeepLX request spacing", () => {
    afterEach(() => vi.useRealTimers());

    it("gives each request the next free slot, 3 s after the one before it, and none to a request after a quiet spell", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
        vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
        media.noWaitForTranslate = false;
        const start = Date.now();
        const sentAt: number[] = [];
        deps.globalFetch.mockImplementation(async (url: string, init: Request) => {
            sentAt.push(Date.now() - start);
            return reply(url, init);
        });

        const work = Promise.all(["one", "two", "three"].map((text) => runTranslator(text, false, "ko", "en")));
        await vi.advanceTimersByTimeAsync(0);
        expect(sentAt).toEqual([0]);
        await vi.advanceTimersByTimeAsync(2999);
        expect(sentAt).toEqual([0]);
        await vi.advanceTimersByTimeAsync(1);
        expect(sentAt).toEqual([0, 3000]);
        await vi.advanceTimersByTimeAsync(3000);
        expect(sentAt).toEqual([0, 3000, 6000]);
        await expect(work).resolves.toEqual(["KO:one", "KO:two", "KO:three"]);

        // The last slot ended at 9000; a request after it goes out at once.
        await vi.advanceTimersByTimeAsync(10_000);
        const late = runTranslator("four", false, "ko", "en");
        await vi.advanceTimersByTimeAsync(0);
        expect(sentAt).toEqual([0, 3000, 6000, 16_000]);
        await expect(late).resolves.toBe("KO:four");
    });

    it("sends at once when Don't Wait for Translation is on", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
        deps.globalFetch.mockImplementation(async (url: string, init: Request) => reply(url, init));
        const work = Promise.all(["one", "two"].map((text) => runTranslator(text, false, "ko", "en")));
        await vi.advanceTimersByTimeAsync(0);
        expect(deps.globalFetch).toHaveBeenCalledTimes(2);
        await expect(work).resolves.toEqual(["KO:one", "KO:two"]);
    });
});
