// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { getCustomBackground } from "src/ts/util";

// The chat screen's root is its own stacking context (crosscheck row 12,
// `docs/research/pocketrisu-fix-crosscheck.md`): bot HTML with `position: fixed` and a high
// z-index stays inside it, under the app's popups and alerts (its siblings in `App.svelte`), in
// every theme. The screen's children are stubs; only the root is read.

vi.mock("../../ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    getCustomBackground: vi.fn(async (_path: string) => ""),
}));
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
beforeEach(() => {
    installFlatDatabase({ characters: [], theme: "classic", waifuWidth: 100, waifuWidth2: 100, customBackground: "" });
    vi.mocked(getCustomBackground).mockReset().mockResolvedValue("");
});
afterEach(async () => {
    for (const instance of mounted.splice(0)) {
        await unmount(instance);
    }
    document.body.innerHTML = "";
});

describe("the chat screen root", () => {
    it.each(["metatron", "mobilechat", "waifu"])("isolates its stacking context in the %s theme", async (theme) => {
        settings.ui.theme = theme as typeof settings.ui.theme;
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

it("loads a changed background and ignores an older background that finishes afterward", async () => {
    const pending = new Map<string, (style: string) => void>();
    vi.mocked(getCustomBackground).mockImplementation(
        (path) => new Promise<string>((resolve) => pending.set(path, resolve)),
    );
    settings.ui.customBackground = "initial";
    const { default: ChatScreen } = await import("./ChatScreen.svelte");
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(ChatScreen, { target }));
    flushSync();
    pending.get("initial")!("background: url('data:,initial')");
    await tick();
    flushSync();
    const background = () => target.querySelector<HTMLElement>(".h-full.w-full")!.style.backgroundImage;
    expect(background()).toContain("data:,initial");

    // A single change must finish even if the effect reruns during its own loading work.
    settings.ui.customBackground = "single-change";
    flushSync();
    expect(pending.has("single-change")).toBe(true);
    pending.get("single-change")!("background: url('data:,single-change')");
    await tick();
    flushSync();
    expect(background()).toContain("data:,single-change");

    settings.ui.customBackground = "older";
    flushSync();
    settings.ui.customBackground = "newer";
    flushSync();
    pending.get("newer")!("background: url('data:,newer')");
    await tick();
    flushSync();
    expect(background()).toContain("data:,newer");
    pending.get("older")!("background: url('data:,older')");
    await tick();
    flushSync();
    expect(background()).toContain("data:,newer");
});
