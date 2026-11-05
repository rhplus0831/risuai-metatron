import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { popupStore } from "src/ts/stores.svelte";
import PopupButton from "./PopupButton.svelte";
import PopupList from "./PopupList.svelte";

let target: HTMLDivElement;
let buttonA: HTMLButtonElement;
let buttonB: HTMLButtonElement;
let outside: HTMLButtonElement;
let popupHost: ReturnType<typeof mount> | undefined;
const buttons: ReturnType<typeof mount>[] = [];

// App mounts the host only while a menu is open. In particular, a document click
// must unmount the old host before the button's deferred toggle opens the next one.
async function syncPopupHost() {
    if (!popupStore.children && popupHost) {
        await unmount(popupHost);
        popupHost = undefined;
    }
    if (popupStore.children && !popupHost) {
        popupHost = mount(PopupList, { target });
    }
    flushSync();
}

async function click(element: HTMLElement) {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await syncPopupHost();
    await vi.runOnlyPendingTimersAsync(); // PopupButton's zero-delay toggle.
    await syncPopupHost();
    await vi.runOnlyPendingTimersAsync(); // PopupList's zero-delay document listener.
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    target = document.createElement("div");
    outside = document.createElement("button");
    outside.textContent = "Elsewhere on the page";
    document.body.append(target, outside);
    for (const name of ["A", "B"]) {
        buttons.push(
            mount(PopupButton, {
                target,
                props: {
                    children: createRawSnippet(() => ({ render: () => `<p>Menu ${name} action</p>` })),
                },
            }),
        );
    }
    flushSync();
    [buttonA, buttonB] = Array.from(target.querySelectorAll("button"));
});

afterEach(async () => {
    if (popupHost) await unmount(popupHost);
    popupHost = undefined;
    for (const button of buttons.splice(0)) await unmount(button);
    popupStore.children = null;
    popupStore.openId = 0;
    popupStore.mouseX = 0;
    popupStore.mouseY = 0;
    target.remove();
    outside.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("popup menu clicks", () => {
    it("reopens with one click after an outside click closes the menu", async () => {
        await click(buttonA);
        expect(target.textContent).toContain("Menu A action");

        await click(outside);
        expect(popupStore.children).toBeNull();
        expect(target.textContent).not.toContain("Menu A action");

        await click(buttonA);
        expect(popupStore.children).not.toBeNull();
        expect(target.textContent).toContain("Menu A action");
    });

    it("closes the open menu when its own button is clicked", async () => {
        await click(buttonA);
        expect(target.textContent).toContain("Menu A action");

        await click(buttonA);
        expect(popupStore.children).toBeNull();
        expect(target.textContent).not.toContain("Menu A action");
    });

    it("opens the other button's menu with one click while a menu is open", async () => {
        await click(buttonA);
        expect(target.textContent).toContain("Menu A action");

        await click(buttonB);
        expect(popupStore.children).not.toBeNull();
        expect(target.textContent).toContain("Menu B action");
        expect(target.textContent).not.toContain("Menu A action");
    });
});
