import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { getCharImage } from "src/ts/characters";
import { resolveChatStatus, type ChatStatus, type ChatStatusSets } from "./chatStatus";
import type { PinnedChatItem } from "./pinnedChats";

vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn(async () => "") }));

import ChatStatusBadge from "./ChatStatusBadge.svelte";
import PinnedChatsRail from "./PinnedChatsRail.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const originalObserver = globalThis.IntersectionObserver;
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
    globalThis.IntersectionObserver = originalObserver;
});

const items: PinnedChatItem[] = [
    {
        chaId: "a",
        chatId: "shared",
        chatName: "Lost reply",
        characterName: "Alice",
        characterImage: "assets/alice.png",
    },
    { chaId: "a", chatId: "working", chatName: "Working reply", characterName: "Alice", characterImage: "" },
    { chaId: "b", chatId: "shared", chatName: "New reply", characterName: "Bob", characterImage: "" },
    { chaId: "a", chatId: "idle", chatName: "Quiet chat", characterName: "Alice", characterImage: "" },
];

const statuses = new Map<string, ChatStatus>([
    ["a\u0000shared", "recovery"],
    ["a\u0000working", "generating"],
    ["b\u0000shared", "unseen"],
]);

const badgeSelector = '[role="status"][data-risu-chat-status]';

function render(statuses?: ReadonlyMap<string, ChatStatus>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const onOpen = vi.fn();
    mounted.push(
        mount(PinnedChatsRail, {
            target,
            props: {
                items,
                selectedChaId: null,
                selectedChatId: null,
                rounded: false,
                onOpen,
                ...(statuses ? { statuses } : {}),
            },
        }),
    );
    flushSync();
    return { target, onOpen, rows: [...target.querySelectorAll<HTMLElement>("[data-risu-pinned-chat]")] };
}

describe("PinnedChatsRail status badges", () => {
    it("requests the 256 thumbnail class for a pinned character icon", () => {
        globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
        vi.mocked(getCharImage).mockClear();
        render();
        expect(getCharImage).toHaveBeenCalledWith(items[0].characterImage, "plain", 256);
    });

    it("renders a labeled refused badge, including when the pinned chat is also unseen", () => {
        const sets: ChatStatusSets = {
            recovery: new Set(),
            refused: new Set(["b\u0000shared"]),
            generating: new Set(),
            unseen: new Set(["b\u0000shared"]),
        };
        const resolved = resolveChatStatus(sets, "b\u0000shared");
        expect(resolved).toBe("refused");
        const { rows } = render(
            new Map<string, ChatStatus>([
                ["a\u0000shared", "refused"],
                ["b\u0000shared", resolved!],
            ]),
        );
        for (const index of [0, 2]) {
            const badges = rows[index].querySelectorAll<HTMLElement>(badgeSelector);
            expect(badges).toHaveLength(1);
            expect(badges[0].dataset.risuChatStatus).toBe("refused");
            const label = language.chatStatus.refused(items[index].chatName);
            expect(badges[0].getAttribute("aria-label")).toBe(label);
            expect(rows[index].getAttribute("aria-label")).toContain(label);
        }
    });

    it("renders one badge for each chat's own status using theme colors", () => {
        const { target, rows } = render(statuses);
        const expected: [ChatStatus, string][] = [
            ["recovery", "bg-danger-500"],
            ["generating", "bg-primary-500"],
            ["unseen", "bg-success-500"],
        ];

        expect(target.querySelectorAll(badgeSelector)).toHaveLength(3);
        expected.forEach(([status, color], index) => {
            const badges = rows[index].querySelectorAll<HTMLElement>(badgeSelector);
            expect(badges).toHaveLength(1);
            expect(rows[index].dataset.risuChatStatus).toBe(status);
            expect(badges[0].dataset.risuChatStatus).toBe(status);
            expect(badges[0].getAttribute("aria-label")).toBe(language.chatStatus[status](items[index].chatName));
            // Theme tokens only (STRUCTURE.md U1): the status color token, never a raw palette class.
            expect(badges[0].classList.contains(color)).toBe(true);
            const rawPalette = [...badges[0].classList].filter((name) =>
                /^(bg|text|border)-(red|green|blue|yellow|gray|slate|zinc|black|white)/.test(name),
            );
            expect(rawPalette).toEqual([]);
            expect(badges[0].getAttribute("style")).toBeNull();
        });
    });

    it("renders just the winning badge when a pinned chat has overlapping statuses", () => {
        const sets: ChatStatusSets = {
            recovery: new Set(["a\u0000shared"]),
            generating: new Set(["a\u0000shared", "a\u0000working"]),
            unseen: new Set(["a\u0000shared", "a\u0000working", "b\u0000shared"]),
        };
        const resolved = new Map<string, ChatStatus>();
        for (const { chaId, chatId } of items) {
            const key = `${chaId}\u0000${chatId}`;
            const status = resolveChatStatus(sets, key);
            if (status) resolved.set(key, status);
        }
        const { rows } = render(resolved);

        expect(
            rows.map((row) =>
                [...row.querySelectorAll<HTMLElement>(badgeSelector)].map((badge) => badge.dataset.risuChatStatus),
            ),
        ).toEqual([["recovery"], ["generating"], ["unseen"], []]);
    });

    it("keeps the open-chat accessible name first and appends the localized status", () => {
        const { rows } = render(statuses);
        (["recovery", "generating", "unseen"] as const).forEach((status, index) => {
            const { chatName, characterName } = items[index];
            const openLabel = language.openPinnedChat(chatName, characterName);
            const label = rows[index].getAttribute("aria-label")!;
            expect(label.startsWith(openLabel)).toBe(true);
            expect(label.slice(openLabel.length)).toContain(language.chatStatus[status](chatName));
        });
    });

    it("leaves a chat without status unbadged with its original accessible name", () => {
        const { rows } = render(statuses);
        const idle = rows[3];
        expect(idle.querySelector(badgeSelector)).toBeNull();
        expect(idle.hasAttribute("data-risu-chat-status")).toBe(false);
        expect(idle.hasAttribute("title")).toBe(false);
        expect(idle.getAttribute("aria-label")).toBe(
            language.openPinnedChat(items[3].chatName, items[3].characterName),
        );

        // The optional prop's absence and an empty map keep every row unchanged.
        const withoutProp = render();
        const empty = render(new Map());
        expect(empty.rows.map((row) => row.outerHTML)).toEqual(withoutProp.rows.map((row) => row.outerHTML));
        withoutProp.rows.forEach((row, index) => {
            expect(row.querySelector(badgeSelector)).toBeNull();
            expect(row.hasAttribute("data-risu-chat-status")).toBe(false);
            expect(row.getAttribute("aria-label")).toBe(
                language.openPinnedChat(items[index].chatName, items[index].characterName),
            );
        });
    });

    it("adds no tab stops or badge handlers and preserves row and badge click and Enter opening", () => {
        const { target, rows, onOpen } = render(statuses);
        const withoutStatus = render();
        // happy-dom does not apply pointer-events or simulate Tab navigation.
        const tabStops = (root: HTMLElement) =>
            [...root.querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0);
        expect(tabStops(target)).toHaveLength(rows.length);
        expect(tabStops(target)).toEqual(rows);
        expect(tabStops(target).map((row) => row.dataset.risuPinnedChat)).toEqual(
            tabStops(withoutStatus.target).map((row) => row.dataset.risuPinnedChat),
        );

        rows.slice(0, 3).forEach((row, index) => {
            const badge = row.querySelector<HTMLElement>(badgeSelector)!;
            expect(badge.classList.contains("pointer-events-none")).toBe(true);
            for (const element of [badge, ...badge.querySelectorAll<HTMLElement>("*")]) {
                expect(element.hasAttribute("tabindex")).toBe(false);
                expect(element.tabIndex).toBeLessThan(0);
                expect(element.getAttributeNames().filter((name) => /^on/i.test(name))).toEqual([]);
                expect(element.onclick).toBeNull();
                expect(element.onkeydown).toBeNull();
            }

            for (const eventTarget of [row, badge]) {
                for (const event of [
                    new MouseEvent("click", { bubbles: true }),
                    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
                ]) {
                    onOpen.mockClear();
                    eventTarget.dispatchEvent(event);
                    expect(onOpen).toHaveBeenCalledTimes(1);
                    expect(onOpen).toHaveBeenCalledWith(items[index]);
                }
            }
        });
    });
});

// A summarizing chat's badge (`memory`): the count `k/n` as text instead of the icon, the icon
// without a count, and a count passed with another status ignored; the label carries the count.
describe("PinnedChatsRail memory badges", () => {
    const memoryStatuses = new Map<string, ChatStatus>([
        ["a\u0000shared", "memory"],
        ["a\u0000working", "memory"],
        ["b\u0000shared", "generating"],
    ]);
    const memoryCounts = new Map<string, { done: number; total: number } | null>([
        ["a\u0000shared", { done: 2, total: 5 }],
        ["a\u0000working", null],
        ["b\u0000shared", { done: 1, total: 1 }],
    ]);

    it("shows the count of a running task as text, the icon for a queued one, and no count under another status", () => {
        const target = document.createElement("div");
        document.body.appendChild(target);
        mounted.push(
            mount(PinnedChatsRail, {
                target,
                props: {
                    items,
                    selectedChaId: null,
                    selectedChatId: null,
                    rounded: false,
                    onOpen: vi.fn(),
                    statuses: memoryStatuses,
                    memoryCounts,
                },
            }),
        );
        flushSync();
        const rows = [...target.querySelectorAll<HTMLElement>("[data-risu-pinned-chat]")];
        const badge = (index: number) => rows[index].querySelector<HTMLElement>(badgeSelector)!;

        expect(badge(0).dataset.risuChatStatus).toBe("memory");
        expect(badge(0).classList.contains("bg-secondary-500")).toBe(true);
        expect(badge(0).textContent?.trim()).toBe("2/5");
        expect(badge(0).querySelector("svg")).toBeNull();
        expect(badge(0).getAttribute("aria-label")).toBe(language.chatStatus.memory(items[0].chatName, "2/5"));
        expect(rows[0].getAttribute("aria-label")).toContain("2/5");

        expect(badge(1).dataset.risuChatStatus).toBe("memory");
        expect(badge(1).textContent?.trim()).toBe("");
        expect(badge(1).querySelector("svg")).not.toBeNull();
        expect(badge(1).getAttribute("aria-label")).toBe(language.chatStatus.memory(items[1].chatName));

        expect(badge(2).dataset.risuChatStatus).toBe("generating");
        expect(badge(2).textContent?.trim()).toBe("");
        expect(badge(2).getAttribute("aria-label")).toBe(language.chatStatus.generating(items[2].chatName));
        expect(rows[3].querySelector(badgeSelector)).toBeNull();

        // The badge itself ignores a count passed with another status (the callers filter too): the
        // icon at the fixed width, not the widened count badge.
        const alone = document.createElement("div");
        document.body.appendChild(alone);
        mounted.push(
            mount(ChatStatusBadge, {
                target: alone,
                props: { status: "generating", label: "busy", count: { done: 1, total: 1 } },
            }),
        );
        flushSync();
        const lone = alone.querySelector<HTMLElement>(badgeSelector)!;
        expect(lone.textContent?.trim()).toBe("");
        expect(lone.querySelector("svg")).not.toBeNull();
        expect(lone.classList.contains("w-5")).toBe(true);
        expect(lone.classList.contains("px-1")).toBe(false);
        // The widened count badge, for comparison.
        expect(badge(0).classList.contains("w-5")).toBe(false);
        expect(badge(0).classList.contains("px-1")).toBe(true);
    });
});
