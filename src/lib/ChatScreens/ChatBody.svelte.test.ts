// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// `ChatBody` shows the last parsed body while a newer render is pending. Only the newest render
// writes that body: an older render that settles after a newer one must not put its text back.
// This file is `.svelte.test.ts` so the props can be `$state` and change on the mounted body.

type Deferred = { text: string; resolve: (html: string) => void };
const hoisted = vi.hoisted(() => ({ parses: [] as Deferred[] }));

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
    translateHTML: vi.fn(async (html: string) => html),
}));
vi.mock("src/ts/parser/transformClient", () => ({ captureTransform: vi.fn(() => null) }));
vi.mock("src/ts/process/modules", () => ({ getModuleAssets: vi.fn(() => []) }));
vi.mock("src/ts/globalApi.svelte", () => ({ getFileSrc: vi.fn(async (path: string) => path) }));
vi.mock("src/ts/alert", () => ({ alertError: vi.fn() }));
vi.mock("src/ts/util", () => ({ sleep: async () => undefined }));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ selectedCharacter: vi.fn() }));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({
    settings: { ui: {}, memoryTranslateMedia: {} },
}));

import ChatBody from "./ChatBody.svelte";

const mounted: ReturnType<typeof mount>[] = [];

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    hoisted.parses.length = 0;
    document.body.innerHTML = "";
    vi.useRealTimers();
});

/** Settles the parse of `text` and lets its `{#await}` render. */
async function settle(text: string) {
    const parse = hoisted.parses.find((entry) => entry.text === text);
    expect(parse).toBeDefined();
    parse!.resolve(`<p>${text}</p>`);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
});
