// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/globalApi.svelte", () => ({ openURL: vi.fn() }));

import { language } from "src/lang";
import ThanksPage from "./ThanksPage.svelte";

// Open bug fixes plan slice C8: the supporter list is fetched when the page opens; a failed fetch (offline,
// or an error status) shows a localized message instead of "Loading..." forever.

const mounted: ReturnType<typeof mount>[] = [];

async function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(ThanksPage, { target }));
    flushSync();
    // The fetch settles, then the await block renders its branch.
    for (let i = 0; i < 5; i++) await tick();
    return target;
}

afterEach(() => {
    for (const instance of mounted.splice(0)) unmount(instance);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe("ThanksPage", () => {
    it("shows the load failure message when the supporter list cannot be fetched", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
        );
        const page = await render();
        expect(page.textContent).toContain(language.supporterListLoadFailed);
        expect(page.textContent).not.toContain("Loading...");
    });

    it("shows the load failure message for an error status", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("bad gateway", { status: 502 })),
        );
        const page = await render();
        expect(page.textContent).toContain(language.supporterListLoadFailed);
    });

    it("lists the supporters by tier when the list loads", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json([
                    { amount: 60, name: "Gold Name" },
                    { amount: 3, name: "Copper Name" },
                ]),
            ),
        );
        const page = await render();
        expect(page.textContent).toContain("Gold Name");
        expect(page.textContent).toContain("Copper Name");
        expect(page.textContent).not.toContain(language.supporterListLoadFailed);
    });
});
