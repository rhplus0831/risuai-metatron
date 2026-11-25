// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertToast } from "src/ts/alert";
import { alertStore } from "src/ts/stores.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import AlertComp from "./AlertComp.svelte";
import { TOAST_DURATION_MS, TOAST_FADE_MS } from "./AlertToast.svelte";

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

async function showToast(msg: string) {
    alertToast(msg);
    flushSync();
    await tick();
    return toastElement()!;
}

function toastElement() {
    return target.querySelector<HTMLDivElement>("div.toast");
}

/** Whether the alert slot still holds the toast; the closing transition is only cosmetic. */
function toastShown() {
    return get(alertStore).type === "toast";
}

async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installFlatDatabase({ characters: [] });
    target = document.createElement("div");
    document.body.append(target);
    component = mount(AlertComp, { target });
    flushSync();
});

afterEach(async () => {
    alertStore.clearStatus();
    if (component) await unmount(component);
    component = undefined;
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe("toast lifetime", () => {
    it("stays for the full duration, fades, then clears the status", async () => {
        const toast = await showToast("Request failed");
        expect(toast.textContent).toContain("Request failed");

        await advance(TOAST_DURATION_MS - 1);
        expect(toastShown()).toBe(true);
        expect(toast.classList.contains("leaving")).toBe(false);

        await advance(1);
        expect(toast.classList.contains("leaving")).toBe(true);
        expect(toastShown()).toBe(true);

        await advance(TOAST_FADE_MS);
        expect(toastShown()).toBe(false);
        expect(toastElement()).toBeNull();
    });

    it("is held while hovered and counts a full duration again after the pointer leaves", async () => {
        const toast = await showToast("Request failed");
        await advance(TOAST_DURATION_MS - 1000);

        toast.dispatchEvent(new MouseEvent("mouseenter"));
        await advance(TOAST_DURATION_MS * 5);
        expect(toastShown()).toBe(true);

        toast.dispatchEvent(new MouseEvent("mouseleave"));
        await advance(TOAST_DURATION_MS + TOAST_FADE_MS - 1);
        expect(toastShown()).toBe(true);
        await advance(1);
        expect(toastShown()).toBe(false);
    });

    it("is held while focused and counts a full duration again after focus leaves", async () => {
        const toast = await showToast("Request failed");
        await advance(TOAST_DURATION_MS - 1000);

        toast.focus();
        await advance(TOAST_DURATION_MS * 5);
        expect(toastShown()).toBe(true);

        toast.blur();
        await advance(TOAST_DURATION_MS + TOAST_FADE_MS - 1);
        expect(toastShown()).toBe(true);
        await advance(1);
        expect(toastShown()).toBe(false);
    });

    it("stays held while focus remains after the pointer leaves", async () => {
        const toast = await showToast("Request failed");
        toast.focus();
        toast.dispatchEvent(new MouseEvent("mouseenter"));
        toast.dispatchEvent(new MouseEvent("mouseleave"));

        await advance(TOAST_DURATION_MS * 5);
        expect(toastShown()).toBe(true);
    });

    it("is kept when the pointer returns during the fade", async () => {
        const toast = await showToast("Request failed");
        await advance(TOAST_DURATION_MS);
        expect(toast.classList.contains("leaving")).toBe(true);

        toast.dispatchEvent(new MouseEvent("mouseenter"));
        flushSync();
        expect(toast.classList.contains("leaving")).toBe(false);
        await advance(TOAST_DURATION_MS * 5);
        expect(toastShown()).toBe(true);
    });
});

describe("toast dismissal", () => {
    it("closes on click, even while hovered", async () => {
        const toast = await showToast("Request failed");
        toast.dispatchEvent(new MouseEvent("mouseenter"));
        toast.click();
        flushSync();
        expect(toastShown()).toBe(false);
        expect(toastElement()).toBeNull();
    });

    it("closes on Enter while focused", async () => {
        const toast = await showToast("Request failed");
        toast.focus();
        toast.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        flushSync();
        expect(toastShown()).toBe(false);
    });

    it("stays when the click ends a text selection inside it", async () => {
        const toast = await showToast("Request failed: upstream 502");
        const range = document.createRange();
        range.selectNodeContents(toast);
        window.getSelection()!.addRange(range);

        toast.click();
        flushSync();
        expect(toastShown()).toBe(true);
    });

    it("does not clear a newer toast when the older one's timer would have run out", async () => {
        await showToast("first");
        await advance(TOAST_DURATION_MS - 1000);
        const second = await showToast("second");

        await advance(TOAST_DURATION_MS - 1);
        expect(toastShown()).toBe(true);
        expect(second.textContent).toContain("second");
    });
});
