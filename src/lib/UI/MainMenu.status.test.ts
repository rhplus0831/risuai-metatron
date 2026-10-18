import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the records, status stores/derivation, collector, and badge real. Isolate unrelated
// home panels, navigation side effects, asset loading, and the application-wide UI effects.
vi.mock("./Realm/RealmMain.svelte", () => ({ default: () => {} }));
vi.mock("./Title.svelte", () => ({ default: () => {} }));
vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn(async () => "/avatar.png"), changeChar: vi.fn() }));
vi.mock("src/ts/globalApi.svelte", () => ({ getVersionString: () => "test", openPinnedChat: vi.fn() }));
vi.mock("src/ts/alert", () => ({ alertError: vi.fn(), alertJobError: vi.fn() }));
vi.mock("src/ts/util", () => ({ sleep: vi.fn() }));
vi.mock("src/ts/stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { gridOpenStore: writable(false), OpenRealmStore: writable(false) };
});

import { language } from "src/lang";
import { openPinnedChat } from "src/ts/globalApi.svelte";
import { recoveryChatKeys, resetChatStatusForTests, unseenChatKeys } from "src/ts/process/chatStatus.svelte";
import { followedJobs } from "src/ts/process/serverCommands";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import type { PinnedChatItem } from "../SideBars/pinnedChats";
import MainMenu from "./MainMenu.svelte";

const items: PinnedChatItem[] = [
    { chaId: "alice", chatId: "shared", chatName: "Lost reply", characterName: "Alice", characterImage: "alice.png" },
    {
        chaId: "alice",
        chatId: "working",
        chatName: "Working reply",
        characterName: "Alice",
        characterImage: "alice.png",
    },
    { chaId: "bob", chatId: "shared", chatName: "New reply", characterName: "Bob", characterImage: "bob.png" },
    { chaId: "bob", chatId: "idle", chatName: "Quiet chat", characterName: "Bob", characterImage: "bob.png" },
];
const badgeSelector = '[role="status"]';
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    resetChatStatusForTests();
    followedJobs.set(new Map());
    installFlatDatabaseWithChats({
        characterOrder: ["alice", "bob"],
        hideRealm: true,
        characters: ["alice", "bob"].map((chaId) => {
            const pins = items.filter((item) => item.chaId === chaId);
            return {
                chaId,
                type: "character",
                name: pins[0].characterName,
                image: pins[0].characterImage,
                chatPage: 0,
                chats: pins.map((item) => ({
                    id: item.chatId,
                    name: item.chatName,
                    pinned: true,
                    note: "",
                    localLore: [],
                    message: [],
                })),
            };
        }),
    });
    selectCharacter(null);
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    if (instance) await unmount(instance);
    instance = undefined;
    target.remove();
    resetChatStatusForTests();
    followedJobs.set(new Map());
    installFlatDatabaseWithChats({ characters: [] });
});

async function render() {
    instance = mount(MainMenu, { target });
    flushSync();
    await tick();
    return [...target.querySelectorAll<HTMLButtonElement>("[data-risu-home-pinned-chat]")];
}

function setStatuses() {
    // Disjoint sources exercise the home's wiring, not resolveChatStatus's already-tested priority.
    recoveryChatKeys.set(new Map([["alice\u0000shared", "lost-job"]]));
    followedJobs.set(new Map([["working-job", "alice\u0000working"]]));
    unseenChatKeys.set(new Set(["bob\u0000shared"]));
    flushSync();
}

function expectIdle(card: HTMLButtonElement, item: PinnedChatItem) {
    expect(card.querySelector(badgeSelector)).toBeNull();
    expect(card.hasAttribute("data-risu-chat-status")).toBe(false);
    expect(card.hasAttribute("title")).toBe(false);
    expect(card.getAttribute("aria-label")).toBe(language.openPinnedChat(item.chatName, item.characterName));
}

describe("MainMenu pinned-chat statuses", () => {
    it("renders each chat's live badge, open-first accessible name, and matching title", async () => {
        const cards = await render();
        expect(cards).toHaveLength(items.length);
        setStatuses();

        expect(target.querySelectorAll(badgeSelector)).toHaveLength(3);
        (["recovery", "generating", "unseen"] as const).forEach((status, index) => {
            const card = cards[index];
            const item = items[index];
            const statusLabel = language.chatStatus[status](item.chatName);
            const label = `${language.openPinnedChat(item.chatName, item.characterName)} · ${statusLabel}`;
            const badges = card.querySelectorAll<HTMLElement>(badgeSelector);
            expect(badges).toHaveLength(1);
            expect(badges[0].getAttribute("data-risu-chat-status")).toBe(status);
            expect(badges[0].getAttribute("aria-label")).toBe(statusLabel);
            expect(card.getAttribute("data-risu-chat-status")).toBe(status);
            expect(card.getAttribute("aria-label")).toBe(label);
            expect(card.getAttribute("title")).toBe(label);
        });
    });

    it("leaves idle chats unchanged and removes status attributes when a live status clears", async () => {
        const cards = await render();
        cards.forEach((card, index) => expectIdle(card, items[index]));

        unseenChatKeys.set(new Set(["bob\u0000shared"]));
        flushSync();
        expect(cards[2].querySelectorAll(badgeSelector)).toHaveLength(1);
        // The other character has the same chat id; the other chat belongs to the same character.
        expectIdle(cards[0], items[0]);
        expectIdle(cards[3], items[3]);

        unseenChatKeys.set(new Set());
        flushSync();
        cards.forEach((card, index) => expectIdle(card, items[index]));
    });

    it("keeps the badge inside the icon box without adding focus targets or intercepting card clicks", async () => {
        const cards = await render();
        setStatuses();

        cards.slice(0, 3).forEach((card, index) => {
            const badge = card.querySelector<HTMLElement>(badgeSelector);
            expect(badge).not.toBeNull();
            const icon = card.querySelector("img")!;
            const iconBox = icon.parentElement!;
            expect(iconBox.contains(badge)).toBe(true);
            expect(card.tabIndex).toBe(0);
            expect([...card.querySelectorAll<HTMLElement>("*")].filter((node) => node.tabIndex >= 0)).toEqual([]);

            for (const clickTarget of [card, badge!]) {
                vi.mocked(openPinnedChat).mockClear();
                clickTarget.click();
                expect(openPinnedChat).toHaveBeenCalledTimes(1);
                expect(openPinnedChat).toHaveBeenCalledWith(items[index]);
            }
        });
    });
});
