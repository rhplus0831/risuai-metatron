// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ copyText: vi.fn<(text: string) => Promise<boolean>>() }));
vi.mock("./requestLogView", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./requestLogView")>()),
    copyText: deps.copyText,
}));

import { language } from "src/lang";
import LogField from "./LogField.svelte";

let target: HTMLElement;
const mounted: object[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    deps.copyText.mockReset();
    target = document.createElement("div");
    document.body.appendChild(target);
});
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    target.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
});

async function advance(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
}

function open() {
    mounted.push(mount(LogField, { target, props: { label: "Response", text: "response text", highlight: false } }));
    flushSync();
    return target.querySelector("button")!;
}

describe("LogField copy feedback", () => {
    it("shows localized failure text and title without a copied check when copying resolves false, then clears after 1.5 seconds", async () => {
        deps.copyText.mockResolvedValueOnce(false);
        const button = open();
        button.click();
        await advance();

        expect(deps.copyText).toHaveBeenCalledWith("response text");
        expect(target.textContent).toContain(language.requestLogCopyFailed);
        expect(target.querySelector('[role="status"]')?.textContent).toBe(language.requestLogCopyFailed);
        expect(button.title).toBe(language.requestLogCopyFailed);
        expect(button.querySelector(".lucide-check")).toBeNull();

        await advance(1499);
        expect(target.textContent).toContain(language.requestLogCopyFailed);
        expect(button.title).toBe(language.requestLogCopyFailed);
        await advance(1);
        expect(target.textContent).not.toContain(language.requestLogCopyFailed);
        expect(button.title).toBe(language.copy);
        expect(button.querySelector(".lucide-copy")).not.toBeNull();
    });

    it("shows the copied check without failure text when copying resolves true, then clears after 1.5 seconds", async () => {
        deps.copyText.mockResolvedValueOnce(true);
        const button = open();
        button.click();
        await advance();

        expect(deps.copyText).toHaveBeenCalledWith("response text");
        expect(button.querySelector(".lucide-check")).not.toBeNull();
        expect(target.textContent).not.toContain(language.requestLogCopyFailed);
        expect(button.title).toBe(language.copy);

        await advance(1499);
        expect(button.querySelector(".lucide-check")).not.toBeNull();
        await advance(1);
        expect(button.querySelector(".lucide-check")).toBeNull();
        expect(button.querySelector(".lucide-copy")).not.toBeNull();
        expect(target.textContent).not.toContain(language.requestLogCopyFailed);
    });
});
