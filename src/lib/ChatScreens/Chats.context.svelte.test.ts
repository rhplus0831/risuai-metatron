// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";

// `Chats` mounts its rows by hand (`mount(Chat)`), and passes them its own contexts (the chat
// screen's `ChatStyleRegistry` reaches `ChatBody` that way). The row component is a stub
// that records the context it was mounted with.

const hoisted = vi.hoisted(() => ({ seen: [] as unknown[] }));

vi.mock("./Chat.svelte", async () => {
    const { getContext } = await import("svelte");
    return {
        // A component function: `mount` calls it with the row's contexts in place.
        default: (_anchor: unknown, _props: unknown) => {
            hoisted.seen.push(getContext("probe"));
            return {};
        },
    };
});
vi.mock("src/ts/storage/settingsViews.svelte", () => ({ settings: { ui: {} } }));
vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn(() => "") }));
vi.mock("src/ts/stores.svelte", () => ({
    createSimpleCharacter: vi.fn(() => ({})),
    ReloadChatPointer: writable({}),
    reloadChatKey: (messageId: string | undefined, idx: number) =>
        messageId !== undefined ? `m:${messageId}` : `i:${idx}`,
}));
vi.mock("src/ts/storage/chatStore.svelte", () => ({
    currentChatRef: () => ({ chaId: "c", chatId: "chat" }),
    selectedChatId: () => "chat",
    streamingState: { chaId: null, chatId: null, messageId: null },
}));
vi.mock("src/ts/globalApi.svelte", () => ({ chatFoldedStateMessageIndex: { index: -1 } }));

import Chats from "./Chats.svelte";

const mounted: ReturnType<typeof mount>[] = [];

afterEach(() => {
    for (const instance of mounted.splice(0)) unmount(instance);
    hoisted.seen.length = 0;
    document.body.innerHTML = "";
    vi.spyOn(console, "log").mockRestore();
});

describe("Chats row contexts", () => {
    it("mounts each row with the contexts Chats was mounted under", () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        const probe = { registry: true };
        const props = $state({
            messages: [
                { role: "char", data: "first", chatId: "m1" },
                { role: "user", data: "second", chatId: "m2" },
            ],
            currentCharacter: { chaId: "c", name: "Char", image: "", type: "character" },
            onReroll: () => {},
            unReroll: () => {},
            currentUsername: "User",
            userIcon: "",
            loadPages: 30,
        });
        const target = document.createElement("div");
        document.body.appendChild(target);
        mounted.push(mount(Chats, { target, props: props as never, context: new Map([["probe", probe]]) }));
        flushSync();
        expect(hoisted.seen).toEqual([probe, probe]);
    });
});
