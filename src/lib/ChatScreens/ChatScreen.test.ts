// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// The chat screen's root is its own stacking context (crosscheck row 12,
// `docs/research/pocketrisu-fix-crosscheck.md`): bot HTML with `position: fixed` and a high
// z-index stays inside it, under the app's popups and alerts (its siblings in `App.svelte`), in
// every theme. The screen's children are stubs; only the root is read.

const ui = vi.hoisted(() => ({ theme: "classic" }));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({
    settings: {
        get ui() {
            return { theme: ui.theme, waifuWidth: 100, waifuWidth2: 100, customBackground: "" };
        },
    },
}));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ selectedCharacter: () => undefined }));
vi.mock("../../ts/util", () => ({ getCustomBackground: async () => "", getEmotion: () => "" }));
vi.mock("../../ts/stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({
        CharEmotion: (await import("svelte/store")).writable({}),
    }),
);
for (const child of [
    "./ResizeBox.svelte",
    "./DefaultChatScreen.svelte",
    "../Others/ChatList.svelte",
    "./TransitionImage.svelte",
    "./BackgroundDom.svelte",
    "../UI/GUI/SideBarArrow.svelte",
    "../Setting/Pages/Module/ModuleChatMenu.svelte",
]) {
    vi.doMock(child, () => ({ default: () => {} }));
}

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    for (const instance of mounted.splice(0)) {
        await unmount(instance);
    }
    document.body.innerHTML = "";
});

describe("the chat screen root", () => {
    it.each(["metatron", "mobilechat", "waifu"])("isolates its stacking context in the %s theme", async (theme) => {
        ui.theme = theme;
        const { default: ChatScreen } = await import("./ChatScreen.svelte");
        const target = document.createElement("div");
        document.body.appendChild(target);
        mounted.push(mount(ChatScreen, { target }));
        flushSync();
        const root = target.firstElementChild as HTMLElement;
        expect(root.classList.contains("grow")).toBe(true);
        expect(root.classList.contains("isolate")).toBe(true);
    });
});
