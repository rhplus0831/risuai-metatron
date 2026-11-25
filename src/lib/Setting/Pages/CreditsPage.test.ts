// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import { language } from "src/lang";
import CreditsPage from "./CreditsPage.svelte";

// The page lists the original project, this fork, and the projects the fork learned from. Each group has a title of
// its own, and a project opens its repository in a new tab that gets no `window.opener`.

const mounted: ReturnType<typeof mount>[] = [];

function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(CreditsPage, { target }));
    flushSync();
    return target;
}

afterEach(() => {
    for (const instance of mounted.splice(0)) unmount(instance);
    document.body.replaceChildren();
});

describe("CreditsPage", () => {
    it("gives every group a title and at least one project", () => {
        const page = render();
        const groups = [...page.querySelectorAll<HTMLElement>("[data-credits-group]")];
        expect(groups.map((group) => group.dataset.creditsGroup)).toEqual(["original", "fork", "references"]);
        expect(groups.map((group) => group.querySelector("h3")?.textContent?.trim())).toEqual([
            language.creditsPage.original.title,
            language.creditsPage.fork.title,
            language.creditsPage.references.title,
        ]);
        for (const group of groups) {
            expect(group.querySelectorAll("li").length, group.dataset.creditsGroup).toBeGreaterThan(0);
            // The title names the group for assistive technology.
            expect(group.getAttribute("aria-labelledby")).toBe(group.querySelector("h3")?.id);
        }
    });

    it("links the original project and this fork to their repositories", () => {
        const page = render();
        const href = (group: string) =>
            page.querySelector<HTMLAnchorElement>(`[data-credits-group="${group}"] a`)?.getAttribute("href");
        expect(href("original")).toBe("https://github.com/kwaroran/Risuai");
        expect(href("fork")).toBe("https://github.com/rhplus0831/risuai-metatron");
    });

    it("opens every repository in a new tab without an opener", () => {
        const page = render();
        const links = [...page.querySelectorAll<HTMLAnchorElement>("a")];
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
            expect(link.getAttribute("href"), link.textContent ?? "").toMatch(
                /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/,
            );
            expect(link.target).toBe("_blank");
            expect(link.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
        }
    });

    it("lists a project with no public repository without a link", () => {
        const page = render();
        const rows = [...page.querySelectorAll('[data-credits-group="references"] li')];
        const row = rows.find((item) => item.textContent?.includes("HypaPlus-R"));
        expect(row).toBeDefined();
        expect(row?.querySelector("a")).toBeNull();
        expect(row?.textContent).toContain(language.creditsPage.references.memorySystem);
    });
});
