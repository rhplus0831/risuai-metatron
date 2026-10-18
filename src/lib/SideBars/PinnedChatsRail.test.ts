import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinnedChatItem } from "./pinnedChats";

vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn(async () => "") }));

import PinnedChatsRail from "./PinnedChatsRail.svelte";

const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

function render(items: PinnedChatItem[], onOpen = vi.fn()) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
        mount(PinnedChatsRail, {
            target,
            props: { items, selectedChaId: "c", selectedChatId: "same", rounded: false, onOpen },
        }),
    );
    flushSync();
    return { target, onOpen };
}

describe("PinnedChatsRail", () => {
    it("renders nothing with no pinned chats", () => {
        const { target } = render([]);
        expect(target.querySelector("[data-risu-pinned-chats]")).toBeNull();
        expect(target.children).toHaveLength(0);
        expect(target.textContent).toBe("");
    });

    it("marks only the selected character and chat, and opens items by click and Enter", () => {
        const items: PinnedChatItem[] = [
            { chaId: "d", chatId: "same", chatName: "Other character", characterName: "D", characterImage: "" },
            { chaId: "c", chatId: "same", chatName: "Current chat", characterName: "C", characterImage: "" },
            { chaId: "c", chatId: "other", chatName: "Other chat", characterName: "C", characterImage: "" },
        ];
        const { target, onOpen } = render(items);
        const nav = target.querySelector("nav[data-risu-pinned-chats]")!;
        expect(nav).not.toBeNull();
        const rows = [...nav.querySelectorAll<HTMLElement>("[data-risu-pinned-chat]")];
        expect(rows.map((row) => row.dataset.risuPinnedChat)).toEqual(["same", "same", "other"]);
        expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual([null, "page", null]);
        expect(rows.map((row) => row.textContent?.trim())).toEqual(["Other character", "Current chat", "Other chat"]);
        rows[0].click();
        rows[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(onOpen.mock.calls).toEqual([[items[0]], [items[2]]]);
    });
});
