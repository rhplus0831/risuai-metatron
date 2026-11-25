// @vitest-environment node
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChatTrashAnswer } from "../../../shared/chats.ts";
import type { ResourceBatchResult, ResourceReadRefsResult } from "../../../shared/resources.ts";
import { createChangeFeed, type ChangeFeed } from "../data/changeFeed.ts";
import { createChatTrashPurge } from "../data/chatTrashPurge.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createResourceTestClient } from "./testSupport.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 1);
const characterId = "c";
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const ui = kinds.get("ui")!;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW });
});
afterEach(() => vi.useRealTimers());

function createChat(chatId: string) {
    return {
        characterId,
        chatId,
        baseRevision: null,
        ops: [{ op: "create" as const, chat: { name: chatId, note: "", localLore: [], message: [] } }],
    };
}

async function answer<T>(response: Response): Promise<T> {
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(200);
    return data as T;
}

async function serverWithChats(...chatIds: string[]) {
    const client = await createResourceTestClient();
    onTestFinished(() => client.close());
    const created = await answer<ResourceBatchResult>(
        await client.json("/api/resources/batch", {
            ops: [{ kind: "characters", id: characterId, baseRevision: null, data: { chaId: characterId } }],
            chats: ["active", ...chatIds].map(createChat),
        }),
    );
    const revisions = new Map(created.chats!.map((chat) => [chat.id, chat.revision]));
    return {
        ...client,
        async trash(chatId: string, at: number) {
            vi.setSystemTime(at);
            const trashed = await answer<ChatTrashAnswer>(
                await client.chatTrash("trash", { characterId, chatId, revision: revisions.get(chatId) }),
            );
            expect(trashed.trashedAt).toBe(at);
        },
        async setRetention(days: number) {
            const { revision } = await answer<{ revision: string }>(await client.get("ui", "main"));
            await answer(await client.put("ui", "main", { baseRevision: revision, data: { chatTrashDays: days } }));
        },
        async readChat(chatId: string) {
            const read = await answer<ResourceReadRefsResult>(
                await client.json("/api/resources/read", { chats: [{ characterId, id: chatId }] }),
            );
            return read.chats![0];
        },
    };
}

function storeWithChats(chatIds: string[], chatHeld: (characterId: string, id: string) => boolean = () => false) {
    const feed = createChangeFeed();
    const store = createResourceStore({ file: ":memory:", kinds, feed });
    const purge = createChatTrashPurge({ store, gate: { active: false }, uiKind: ui, chatHeld, now: () => NOW });
    onTestFinished(async () => {
        await purge.close();
        store.close();
    });
    const characters = kinds.get("characters")!;
    store.put(characters, characterId, { chaId: characterId }, null);
    store.applyChanges({ chats: ["active", ...chatIds].map(createChat) });
    store.put(ui, "main", { chatTrashDays: 1 }, store.get(ui, "main")!.revision);
    return {
        feed,
        store,
        purge,
        changeTrash(action: "trash" | "restore", chatId: string, at: number) {
            vi.setSystemTime(at);
            const result = store.changeChatTrash(
                action,
                { characterId, chatId, revision: store.chatRevision(characterId, chatId)! },
                store.epoch(),
                () => false,
            );
            if ("error" in result) throw new Error(`${action} ${chatId}: ${result.error}`);
        },
    };
}

function onDeletion(feed: ChangeFeed, chatId: string, listener: () => void) {
    return feed.subscribe((event) => {
        if (
            event.type === "change" &&
            event.changes.chats.some(
                (chat) => chat.characterId === characterId && chat.id === chatId && chat.revision === null,
            )
        ) {
            listener();
        }
    });
}

it("deletes chats at the retention cutoff and applies a lowered setting on the next run", async () => {
    const server = await serverWithChats("at-cutoff", "just-inside");
    await server.setRetention(4);
    const cutoff = NOW - 4 * DAY;
    await server.trash("at-cutoff", cutoff);
    await server.trash("just-inside", cutoff + 1);
    vi.setSystemTime(NOW);

    await server.context.chatTrashPurge.run();

    expect(await server.readChat("at-cutoff")).toEqual({
        characterId,
        id: "at-cutoff",
        revision: null,
        data: null,
    });
    expect(await server.readChat("just-inside")).toMatchObject({ trashedAt: cutoff + 1 });
    expect(await server.readChat("active")).toMatchObject({ trashedAt: null });
    const listing = await answer<ResourceReadRefsResult>(
        await server.json("/api/resources/read", { chatSummaryCollections: [characterId] }),
    );
    expect(listing.chatSummaryCollections![0].order!.ids).toEqual(["active", "just-inside"]);

    await server.setRetention(2);
    await server.context.chatTrashPurge.run();

    expect(await server.readChat("just-inside")).toEqual({
        characterId,
        id: "just-inside",
        revision: null,
        data: null,
    });
    expect(await server.readChat("active")).toMatchObject({ trashedAt: null });
});

it("publishes the deletion and skips chats restored, re-trashed, or held after the scan", async () => {
    let held = false;
    const { store, feed, purge, changeTrash } = storeWithChats(
        ["oldest", "restored", "re-trashed", "held"],
        (_characterId, id) => id === "held" && held,
    );
    const trashMark = NOW - 3 * DAY;
    changeTrash("trash", "oldest", NOW - 4 * DAY);
    for (const id of ["restored", "re-trashed", "held"]) {
        changeTrash("trash", id, trashMark);
    }
    const events: string[] = [];
    const stopListening = onDeletion(feed, "oldest", () => {
        events.push("oldest");
        changeTrash("restore", "restored", trashMark);
        changeTrash("restore", "re-trashed", trashMark);
        // Even when both trash moves share a millisecond, the scan's revision is stale.
        changeTrash("trash", "re-trashed", trashMark);
        held = true;
    });
    onTestFinished(stopListening);

    await purge.run();

    expect(store.chatRevision(characterId, "oldest")).toBeNull();
    expect(events).toEqual(["oldest"]);
    expect(store.chatTrashState(characterId, "restored")).toMatchObject({ trashedAt: null });
    expect(store.chatTrashState(characterId, "re-trashed")).toMatchObject({ trashedAt: trashMark });
    expect(store.chatTrashState(characterId, "held")).toMatchObject({ trashedAt: trashMark });

    held = false;
    await purge.run();
    expect(store.chatRevision(characterId, "re-trashed")).toBeNull();
    expect(store.chatRevision(characterId, "held")).toBeNull();
    expect(store.chatTrashState(characterId, "restored")).toMatchObject({ trashedAt: null });
});

it("leaves expired trash alone during snapshot maintenance and purges it afterward", async () => {
    const server = await serverWithChats("expired");
    await server.trash("expired", NOW - 31 * DAY);
    vi.setSystemTime(NOW);

    await server.context.snapshots.withMaintenance(async () => {
        await server.context.chatTrashPurge.run();
        expect(await server.readChat("expired")).toMatchObject({ trashedAt: NOW - 31 * DAY });
    });

    await server.context.chatTrashPurge.run();
    expect((await server.readChat("expired")).revision).toBeNull();
});

it("purges after one minute and every hour, and stops at beginShutdown", async () => {
    const firstDelay = 60_000;
    const interval = 3_600_000;
    const server = await serverWithChats("first", "hourly", "after-shutdown");
    const cutoffAtStart = NOW - 30 * DAY;
    await server.trash("first", cutoffAtStart);
    await server.trash("hourly", cutoffAtStart + firstDelay + 1);
    const shutdownMark = cutoffAtStart + firstDelay + interval + 1;
    await server.trash("after-shutdown", shutdownMark);
    vi.setSystemTime(NOW);
    server.context.startBackgroundTasks();

    await vi.advanceTimersByTimeAsync(firstDelay - 1);
    expect(await server.readChat("first")).toMatchObject({ trashedAt: cutoffAtStart });
    await vi.advanceTimersByTimeAsync(1);
    expect((await server.readChat("first")).revision).toBeNull();
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(await server.readChat("hourly")).toMatchObject({ trashedAt: cutoffAtStart + firstDelay + 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect((await server.readChat("hourly")).revision).toBeNull();
    expect(await server.readChat("after-shutdown")).toMatchObject({ trashedAt: shutdownMark });

    server.context.beginShutdown();
    await vi.advanceTimersByTimeAsync(interval);
    await server.context.chatTrashPurge.run();
    await server.context.dispose();

    const reopened = createResourceStore({ file: path.join(server.savePath, "data", "resources.sqlite"), kinds });
    try {
        expect(reopened.chatTrashState(characterId, "after-shutdown")).toMatchObject({ trashedAt: shutdownMark });
    } finally {
        reopened.close();
    }
});

it("drains an in-progress purge on close before the resource store closes", async () => {
    const { store, feed, purge, changeTrash } = storeWithChats(["oldest", "next"]);
    changeTrash("trash", "oldest", NOW - 3 * DAY);
    changeTrash("trash", "next", NOW - 2 * DAY);
    let reachedFirstDeletion!: () => void;
    const firstDeletion = new Promise<void>((resolve) => {
        reachedFirstDeletion = resolve;
    });
    onTestFinished(onDeletion(feed, "oldest", reachedFirstDeletion));

    const run = purge.run();
    await firstDeletion;
    await purge.close();

    expect(await Promise.race([run, Promise.resolve("purge still running")])).toBe(1);
    expect(store.chatTrashState(characterId, "next")).toMatchObject({ trashedAt: NOW - 2 * DAY });
});
