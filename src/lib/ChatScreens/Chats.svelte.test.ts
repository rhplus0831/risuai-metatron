// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";

// `Chats` keeps a mounted row while what mounts it (the text unless it streams, the portrait, the
// disabled state, the reload pointer) is unchanged, and sends a reused row its new position or
// streamed text through `updateRow`. The row component is a stub that records both.
// This file is `.svelte.test.ts` so the props can be `$state` and change on the mounted list.

type RowProps = { message: string; idx: number };
const hoisted = vi.hoisted(() => ({
    mounts: [] as { props: RowProps; updates: Record<string, unknown>[] }[],
    // Chat key → the message that chat shows as streaming (`streamingEntry`).
    streaming: new Map<string, string>(),
}));

vi.mock("./Chat.svelte", () => ({
    // A component function: `mount` calls it and takes its return value as the instance.
    default: (_anchor: unknown, props: RowProps) => {
        const record = { props, updates: [] as Record<string, unknown>[] };
        hoisted.mounts.push(record);
        return { updateRow: (update: Record<string, unknown>) => record.updates.push(update) };
    },
}));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({ settings: { ui: {} } }));
vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn(() => "") }));
vi.mock("src/ts/stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({
        createSimpleCharacter: vi.fn(() => ({ type: "simple" as const, chaId: "c", customscript: [] })),
        ReloadChatPointer: writable({}),
        reloadChatKey: (messageId: string | undefined, idx: number) =>
            messageId !== undefined ? `m:${messageId}` : `i:${idx}`,
    }),
);
vi.mock("src/ts/storage/chatStore.svelte", () => ({
    currentChatRef: () => ({ chaId: "c", chatId: "chat" }),
    selectedChatId: () => "chat",
    streamingEntry: (ref: { chaId: string; chatId: string } | null) => {
        const messageId = ref === null ? undefined : hoisted.streaming.get(`${ref.chaId}/${ref.chatId}`);
        return messageId === undefined ? null : { messageId, mode: undefined };
    },
}));
vi.mock("src/ts/globalApi.svelte", () => ({ chatFoldedStateMessageIndex: { index: -1 } }));

import Chats from "./Chats.svelte";

type TestMessage = { role: "user" | "char"; data: string; chatId: string; disabled?: unknown };

const mounted: ReturnType<typeof mount>[] = [];

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    hoisted.mounts.length = 0;
    hoisted.streaming.clear();
    document.body.innerHTML = "";
    vi.spyOn(console, "log").mockRestore();
});

function render(messages: TestMessage[]) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const props = $state({
        messages,
        currentCharacter: { chaId: "c", name: "Char", image: "", type: "character" },
        onReroll: () => {},
        unReroll: () => {},
        currentUsername: "User",
        userIcon: "",
        loadPages: 30,
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(Chats, { target, props: props as never }));
    flushSync();
    return props;
}

/** A deep copy, as a chat reload gives: equal strings and values, none of them the same objects. */
const reloaded = (messages: TestMessage[]): TestMessage[] => JSON.parse(JSON.stringify(messages));

describe("Chats row reuse", () => {
    it("keeps rows across a reload of equal text, cloned values included, and moves them by updateRow", () => {
        const messages: TestMessage[] = [
            { role: "char", data: "first ".repeat(1000), chatId: "m1", disabled: { legacy: true } },
            { role: "user", data: "second", chatId: "m2" },
        ];
        const props = render(messages);
        expect(hoisted.mounts.map((row) => row.props.message)).toEqual([messages[1].data, messages[0].data]);

        props.messages = reloaded(messages);
        flushSync();
        expect(hoisted.mounts).toHaveLength(2);
        expect(hoisted.mounts.flatMap((row) => row.updates)).toEqual([]);

        // A message added before both shifts their positions without mounting them again.
        props.messages = [{ role: "user", data: "zero", chatId: "m0" }, ...reloaded(messages)];
        flushSync();
        expect(hoisted.mounts).toHaveLength(3);
        expect(hoisted.mounts[0].updates).toEqual([{ idx: 2 }]);
        expect(hoisted.mounts[1].updates).toEqual([{ idx: 1 }]);
    });

    it("mounts a row again when its text or disabled state changes", () => {
        const messages: TestMessage[] = [{ role: "char", data: "hello", chatId: "m1" }];
        const props = render(messages);
        expect(hoisted.mounts).toHaveLength(1);

        props.messages = [{ ...messages[0], data: "hello, edited" }];
        flushSync();
        expect(hoisted.mounts.map((row) => row.props.message)).toEqual(["hello", "hello, edited"]);

        props.messages = [{ ...messages[0], data: "hello, edited", disabled: true }];
        flushSync();
        expect(hoisted.mounts).toHaveLength(3);
    });

    it("sends a streaming message's text through updateRow instead of mounting it again", () => {
        hoisted.streaming.set("c/chat", "m1");
        const props = render([{ role: "char", data: "Hel", chatId: "m1" }]);
        props.messages = [{ role: "char", data: "Hello", chatId: "m1" }];
        flushSync();
        expect(hoisted.mounts).toHaveLength(1);
        expect(hoisted.mounts[0].updates).toEqual([{ message: "Hello", rawStreamingText: "Hello" }]);
    });

    it("does not treat a row as streaming for another chat's streaming entry with the same message id", () => {
        hoisted.streaming.set("c/other", "m1");
        const props = render([{ role: "char", data: "Hel", chatId: "m1" }]);
        props.messages = [{ role: "char", data: "Hello", chatId: "m1" }];
        flushSync();
        // A text change of a row that is not streaming mounts it again.
        expect(hoisted.mounts).toHaveLength(2);
        expect(hoisted.mounts[1].props.message).toBe("Hello");
    });
});
