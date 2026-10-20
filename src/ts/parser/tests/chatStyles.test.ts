import { afterEach, describe, expect, it } from "vitest";
import { ChatStyleRegistry, type ChatStyle } from "../chatStyles";

// The chat screen's shared row stylesheets (heap plan C2): one `<style>` per distinct CSS and
// attribute list, held by the rows that use it, ordered as the rows' own copies were (newest message
// first in the DOM, the greeting last, a sheet at its latest use), reconciled after a microtask.

const style = (css: string, attributes: ChatStyle["attributes"] = []): ChatStyle => ({ css, attributes });
const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

let registry: ChatStyleRegistry;
const sheets = () => Array.from(registry.container.children) as HTMLStyleElement[];
const texts = () => sheets().map((sheet) => sheet.textContent);

afterEach(() => {
    registry?.destroy();
    document.body.innerHTML = "";
});

describe("ChatStyleRegistry sharing", () => {
    it("keeps one sheet per distinct CSS and attribute list, removed after its last release", async () => {
        registry = new ChatStyleRegistry();
        const a1 = registry.acquire(style("a"), 3, 0);
        const a2 = registry.acquire(style("a"), 2, 0);
        const b = registry.acquire(style("a", [["media", "all"]]), 1, 0);
        expect(texts()).toEqual(["a", "a"]);
        expect(sheets()[1].getAttribute("media")).toBe("all");
        expect(sheets()[0].hasAttribute("media")).toBe(false);

        a1();
        a1();
        await microtask();
        expect(texts()).toEqual(["a", "a"]);

        a2();
        await microtask();
        expect(texts()).toEqual(["a"]);
        expect(sheets()[0].getAttribute("media")).toBe("all");

        b();
        await microtask();
        expect(texts()).toEqual([]);
    });

    it("ignores an empty CSS", () => {
        registry = new ChatStyleRegistry();
        registry.acquire(style(""), 0, 0);
        expect(texts()).toEqual([]);
    });

    it("keeps the sheet when a release and a re-acquire happen in one synchronous flush", async () => {
        registry = new ChatStyleRegistry();
        const release = registry.acquire(style("a"), 0, 0);
        const element = sheets()[0];
        release();
        registry.acquire(style("a"), 0, 0);
        await microtask();
        expect(sheets()).toEqual([element]);
    });

    it("makes a new sheet after a real gap", async () => {
        registry = new ChatStyleRegistry();
        const release = registry.acquire(style("a"), 0, 0);
        const element = sheets()[0];
        release();
        await microtask();
        expect(texts()).toEqual([]);
        registry.acquire(style("a"), 0, 0);
        expect(texts()).toEqual(["a"]);
        expect(sheets()[0]).not.toBe(element);
    });
});

describe("ChatStyleRegistry order", () => {
    it("orders sheets by their latest use: newest message first, slots in row order, the greeting last", async () => {
        registry = new ChatStyleRegistry();
        // Rows as `Chats` lays them out: message 5 (two styles), then 3, then 2 (a copy of 5's first).
        registry.acquire(style("x"), 5, 0);
        registry.acquire(style("x2"), 5, 1);
        registry.acquire(style("y"), 3, 0);
        registry.acquire(style("x"), 2, 0);
        registry.acquire(style("g"), -1, 0);
        await microtask();
        // x's last copy sat in row 2, after y's: y, then x; the greeting's sheet last of all.
        expect(texts()).toEqual(["x2", "y", "x", "g"]);
    });

    it("moves a sheet only when the order between distinct sheets changes", async () => {
        registry = new ChatStyleRegistry();
        registry.acquire(style("a"), 4, 0);
        registry.acquire(style("b"), 3, 0);
        const [a, b] = sheets();
        expect(texts()).toEqual(["a", "b"]);

        // A newer row's use of b (a lower position) changes nothing.
        registry.acquire(style("b"), 9, 0);
        await microtask();
        expect(sheets()).toEqual([a, b]);

        // An older row's use of a (a higher position) puts a after b.
        const older = registry.acquire(style("a"), 1, 0);
        await microtask();
        expect(sheets()).toEqual([b, a]);

        // Its release restores the order.
        older();
        await microtask();
        expect(sheets()).toEqual([a, b]);
    });

    it("places a new sheet at its sorted position at once", () => {
        registry = new ChatStyleRegistry();
        registry.acquire(style("a"), 4, 0);
        registry.acquire(style("c"), 1, 0);
        registry.acquire(style("b"), 2, 0);
        expect(texts()).toEqual(["a", "b", "c"]);
    });
});

describe("ChatStyleRegistry lifetime", () => {
    it("attach puts the container at the end of the host; detaching keeps the sheets for the next attach", () => {
        registry = new ChatStyleRegistry();
        const host = document.createElement("div");
        host.append(document.createElement("p"));
        document.body.append(host);
        registry.acquire(style("a"), 0, 0);

        const detach = registry.attach(host);
        expect(host.lastElementChild).toBe(registry.container);
        expect(host.querySelector("style")?.textContent).toBe("a");

        detach();
        expect(host.querySelector("style")).toBeNull();
        expect(texts()).toEqual(["a"]);

        registry.attach(host);
        expect(host.querySelector("style")?.textContent).toBe("a");
    });

    it("destroy removes every sheet; later acquires and releases do nothing", async () => {
        registry = new ChatStyleRegistry();
        const host = document.createElement("div");
        document.body.append(host);
        registry.attach(host);
        const release = registry.acquire(style("a"), 0, 0);

        registry.destroy();
        expect(host.contains(registry.container)).toBe(false);
        expect(texts()).toEqual([]);

        release();
        registry.acquire(style("b"), 0, 0);
        await microtask();
        expect(texts()).toEqual([]);
        registry.attach(host);
        expect(host.contains(registry.container)).toBe(false);
    });
});
