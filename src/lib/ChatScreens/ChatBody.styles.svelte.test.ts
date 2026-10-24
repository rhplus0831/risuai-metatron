// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `ChatBody` under a chat screen's `ChatStyleRegistry`: the rows' `<style>`s are placeholders, one
// shared sheet per distinct CSS sits in the provider's container, ordered as the rows' copies were,
// retained across a row's re-render and released at its unmount. Without a registry a row keeps its
// own `<style>`. The parser is real: `ParseMarkdown` decodes the styles. This file is
// `.svelte.test.ts` so the props can be `$state` and change on the mounted rows.

vi.mock("src/ts/storage/database.svelte", () => ({ appVer: "1234.5.67" }));
vi.mock("src/ts/globalApi.svelte", () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: async (path: string) => path,
}));
// `stores.svelte` runs module effects over the selection and the chat; nothing under test reads it.
vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock({}));
vi.mock("src/ts/translator/translator", () => ({
    applyEdittransToStoredTranslation: (text: string) => text,
    getLLMCache: async () => null,
    translateHTML: async (html: string) => html,
}));
vi.mock("src/ts/parser/transformClient", () => ({ captureTransform: () => null }));
// The parser imports from `alert` and `util` too: partial and real, so a decode never trips on a mock.
vi.mock("src/ts/alert", async (original) => ({
    ...(await original<typeof import("src/ts/alert")>()),
    alertError: vi.fn(),
}));

import ChatBody from "./ChatBody.svelte";
import ChatStyleProviderFixture from "./tests/ChatStyleProviderFixture.svelte";
import { ChatStyleRegistry } from "src/ts/parser/chatStyles";

type Body = { id: string; idx: number; msgDisplay: string };

const RED = ".chattext .x-risu-probe{color:red;}";
const BLUE = ".chattext .x-risu-probe{color:blue;}";
const styled = (css: string, text: string) => `<style>${css}</style>\n\n<p class="probe">${text}</p>`;

const mounted: ReturnType<typeof mount>[] = [];
let registry: ChatStyleRegistry;

// The decode's CBS budget (`CLIENT_CBS_LIMITS`) allows 2 s of `performance.now()` per parse; a
// starved test worker could reach it and get the decoder's fallback instead of the sheet. A stopped
// clock leaves only the work limit, which these small sheets never reach.
beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    registry?.destroy();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

/** Waits (timer by timer, so the parser's awaits settle) until `ready` holds. */
async function until(ready: () => boolean) {
    for (let round = 0; round < 50; round++) {
        flushSync();
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    flushSync();
    expect(ready()).toBe(true);
}

const sheets = () => Array.from(registry.container.children).map((sheet) => sheet.textContent);
const rowStyles = (target: Element, id: string) =>
    Array.from(target.querySelectorAll(`[data-body="${id}"] style`)).map((style) => style.textContent);
const rendered = (target: Element, id: string) => target.querySelector(`[data-body="${id}"] p.x-risu-probe`) !== null;

function render(bodies: Body[]) {
    registry = new ChatStyleRegistry();
    const target = document.createElement("div");
    document.body.append(target);
    const props = $state({ registry, bodies });
    mounted.push(mount(ChatStyleProviderFixture, { target, props }));
    flushSync();
    return { target, props };
}

describe("ChatBody under a chat style registry", () => {
    it("shares one sheet between rows of the same style and leaves placeholders in the rows", async () => {
        const { target } = render([
            { id: "b", idx: 1, msgDisplay: styled(".probe{color:red}", "newer") },
            { id: "a", idx: 0, msgDisplay: styled(".probe{color:red}", "older") },
        ]);
        await until(() => rendered(target, "a") && rendered(target, "b"));
        expect(sheets()).toEqual([RED]);
        expect(rowStyles(target, "a")).toEqual(["/**/"]);
        expect(rowStyles(target, "b")).toEqual(["/**/"]);
        expect(target.querySelector("[data-rows]")?.textContent).not.toContain("color");
        expect(target.lastElementChild?.lastElementChild).toBe(registry.container);
    });

    it("orders distinct sheets as the rows' copies were: newest message first, the greeting last", async () => {
        const { target } = render([
            { id: "n", idx: 2, msgDisplay: styled(".probe{color:red}", "newest") },
            { id: "o", idx: 0, msgDisplay: styled(".probe{color:blue}", "oldest") },
            { id: "g", idx: -1, msgDisplay: styled(".probe{color:green}", "greeting") },
        ]);
        await until(() => ["n", "o", "g"].every((id) => rendered(target, id)));
        await Promise.resolve();
        expect(sheets()).toEqual([RED, BLUE, ".chattext .x-risu-probe{color:green;}"]);
    });

    it("keeps the same sheet element across a row's re-render with the same style", async () => {
        const { target, props } = render([{ id: "a", idx: 0, msgDisplay: styled(".probe{color:red}", "one") }]);
        await until(() => rendered(target, "a"));
        const element = registry.container.firstElementChild;
        expect(element?.textContent).toBe(RED);

        props.bodies = [{ id: "a", idx: 0, msgDisplay: styled(".probe{color:red}", "two") }];
        await until(() => target.querySelector('[data-body="a"] p.x-risu-probe')?.textContent === "two");
        await Promise.resolve();
        expect(Array.from(registry.container.children)).toEqual([element]);
    });

    it("replaces the sheet when the row's style changes, and releases it at the row's unmount", async () => {
        const { target, props } = render([
            { id: "a", idx: 0, msgDisplay: styled(".probe{color:red}", "red") },
            { id: "b", idx: 1, msgDisplay: styled(".probe{color:red}", "red too") },
        ]);
        await until(() => rendered(target, "a") && rendered(target, "b"));
        expect(sheets()).toEqual([RED]);

        props.bodies = [
            { id: "a", idx: 0, msgDisplay: styled(".probe{color:blue}", "blue") },
            { id: "b", idx: 1, msgDisplay: styled(".probe{color:red}", "red too") },
        ];
        await until(() => target.querySelector('[data-body="a"] p.x-risu-probe')?.textContent === "blue");
        await Promise.resolve();
        expect(sheets()).toEqual([RED, BLUE]);

        props.bodies = [{ id: "a", idx: 0, msgDisplay: styled(".probe{color:blue}", "blue") }];
        flushSync();
        await Promise.resolve();
        expect(sheets()).toEqual([BLUE]);

        props.bodies = [];
        flushSync();
        await Promise.resolve();
        expect(sheets()).toEqual([]);
    });

    it("keeps a row's own <style> without a registry", async () => {
        const target = document.createElement("div");
        document.body.append(target);
        const props = $state({
            msgDisplay: styled(".probe{color:red}", "alone"),
            role: "char",
            translated: false,
            translating: false,
            retranslate: false,
            modelShortName: "",
        });
        mounted.push(mount(ChatBody, { target, props }));
        await until(() => target.querySelector("p.x-risu-probe") !== null);
        expect(Array.from(target.querySelectorAll("style")).map((style) => style.textContent)).toEqual([RED]);
    });
});
