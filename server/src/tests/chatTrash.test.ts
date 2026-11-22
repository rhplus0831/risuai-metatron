// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOp, ChatTrashAnswer } from "../../../shared/chats.ts";
import type {
    ResourceBatchResult,
    ResourceBootResult,
    ResourceReadKindsResult,
    ResourceReadRefsResult,
    ResourceRevisionListing,
} from "../../../shared/resources.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

const stamp = Date.UTC(2026, 4, 1);
const ref = { characterId: "c", chatId: "story" };
const identity = { characterId: "c", id: "story" };
const message = { chatId: "m", role: "user", data: "Keep this line" } as const;
const story = { name: "Story", folderId: "folder", pinned: true, message: [message] };
const clients: ResourceTestClient[] = [];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: stamp });
});
afterEach(async () => {
    vi.useRealTimers();
    for (const client of clients.splice(0)) await client.close();
});

async function body<T>(response: Response, status = 200): Promise<T> {
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data as T;
}

async function setup() {
    const client = await createResourceTestClient();
    clients.push(client);
    const created = await body<ResourceBatchResult>(
        await client.json("/api/resources/batch", {
            ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c" } }],
            chats: [
                { ...ref, baseRevision: null, ops: [{ op: "create", chat: story }] },
                { ...ref, chatId: "sibling", baseRevision: null, ops: [{ op: "create", chat: { name: "Sibling" } }] },
            ],
        }),
    );
    return { client, revision: created.chats![0].revision!, sibling: created.chats![1].revision! };
}

const read = async (client: ResourceTestClient) =>
    body<ResourceReadRefsResult>(
        await client.json("/api/resources/read", { chats: [identity], chatSummaryCollections: ["c"] }),
    );

describe("chat trash routes", () => {
    it("publishes the server stamp on reads and clears it on restore, with stable answers on repeat", async () => {
        const { client, revision, sibling } = await setup();
        // The tab acts on the revision it read before a second writer added a note.
        await body(
            await client.json("/api/resources/batch", {
                chats: [{ ...ref, baseRevision: revision, ops: [{ op: "meta", set: { note: "Keep this too" } }] }],
            }),
        );
        const before = (await read(client)).chats![0];
        const request = { ...ref, revision };
        const change = async (action: "trash" | "restore") =>
            body<ChatTrashAnswer>(await client.chatTrash(action, request));
        expect(await body(await client.chatTrash("trash", request, "old-epoch"), 412)).toMatchObject({
            error: "EpochMismatch",
            epoch: client.epoch,
        });
        const trashed = await change("trash");
        const marked = { ...identity, revision: trashed.revision, trashedAt: stamp };
        expect(trashed.revision).not.toBe(before.revision);
        expect(trashed).toMatchObject({
            ...marked,
            summary: { ...marked, name: "Story", folderId: "folder", pinned: true },
        });
        vi.setSystemTime(stamp + 60_000);
        expect(await change("trash")).toEqual(trashed);

        const loaded = await read(client);
        expect(loaded.chats).toEqual([{ ...before, ...marked }]);
        expect(loaded.chatSummaryCollections![0].chats).toContainEqual(trashed.summary);
        const listing = await body<ResourceReadKindsResult>(
            await client.request("/api/resources?kinds=characters&chatSummaries=1"),
        );
        expect(listing.chatSummaries).toContainEqual(trashed.summary);
        const boot = await body<ResourceBootResult>(
            await client.json("/api/resources/boot", { kinds: ["characters"], chatSummaries: true }),
        );
        expect(boot.chatSummaries).toContainEqual(trashed.summary);
        const revisions = await body<ResourceRevisionListing>(await client.request("/api/resources/revisions"));
        expect(revisions.chats).toEqual(
            expect.arrayContaining([marked, { characterId: "c", id: "sibling", revision: sibling, trashedAt: null }]),
        );

        // An older revision in this incarnation still names the chat the user acted on.
        const restored = await change("restore");
        expect(restored.revision).not.toBe(trashed.revision);
        expect(restored).toMatchObject({
            ...identity,
            trashedAt: null,
            summary: { ...identity, revision: restored.revision, name: "Story" },
        });
        expect(restored.summary).not.toHaveProperty("trashedAt");
        expect(await change("restore")).toEqual(restored);
        expect((await read(client)).chats).toEqual([{ ...before, revision: restored.revision, trashedAt: null }]);
    });

    it("keeps the last active chat and refuses edits and queued deletion of its trashed sibling", async () => {
        const { client, revision, sibling } = await setup();
        const { revision: marked } = await body<ChatTrashAnswer>(await client.chatTrash("trash", { ...ref, revision }));
        const before = await read(client);
        // An active chat belonging to someone else cannot stand in for this character's last chat.
        await body(
            await client.json("/api/resources/batch", {
                ops: [{ kind: "characters", id: "other", baseRevision: null, data: { chaId: "other" } }],
                chats: [
                    { characterId: "other", chatId: "another", baseRevision: null, ops: [{ op: "create", chat: {} }] },
                ],
            }),
        );
        expect(
            await body(await client.chatTrash("trash", { ...ref, chatId: "sibling", revision: sibling }), 409),
        ).toMatchObject({ error: "lastActiveChat", revision: sibling });
        const edits: ChatOp[] = [
            { op: "setText", id: "m", text: "Overwritten" },
            {
                op: "setTranslation",
                id: "m",
                translation: {
                    sourceHash: translationSourceHash(message.data),
                    text: "Translated",
                    targetLanguage: "fr",
                    translatedAt: 1,
                },
            },
            { op: "delete" },
        ];
        for (const op of edits) {
            const response = await client.json("/api/resources/batch", {
                chats: [{ ...ref, baseRevision: marked, ops: [op] }],
            });
            expect(await body(response, 409), op.op).toMatchObject({
                conflicts: [
                    {
                        kind: "chat",
                        ...identity,
                        revision: marked,
                        reason: op.op === "delete" ? "useTrash" : "chatTrashed",
                    },
                ],
            });
        }
        expect(await read(client)).toEqual(before);
    });

    it("deletes only at the marked revision and fences requests for a previous incarnation", async () => {
        const { client, revision } = await setup();
        const request = { ...ref, revision };
        expect(await body(await client.chatTrash("delete", request), 409)).toMatchObject({
            error: "notTrashed",
            revision,
        });
        const marked = await body<ChatTrashAnswer>(await client.chatTrash("trash", request));
        expect(await body(await client.chatTrash("delete", request), 409)).toMatchObject({
            error: "stale",
            revision: marked.revision,
        });
        expect(await body(await client.chatTrash("delete", { ...ref, revision: marked.revision }))).toEqual(marked);

        const retry = () =>
            client.json("/api/resources/batch", {
                chats: [
                    { ...ref, baseRevision: revision, groupId: "old-delete", retry: true, ops: [{ op: "delete" }] },
                ],
            });
        const gone = await body<{ conflicts: unknown[] }>(await retry(), 409);
        expect(gone.conflicts).toEqual([{ kind: "chat", ...identity, revision: null }]);
        const created = await body<ResourceBatchResult>(
            await client.json("/api/resources/batch", {
                chats: [{ ...ref, baseRevision: null, ops: [{ op: "create", chat: { name: "New story" } }] }],
            }),
        );
        const current = created.chats![0].revision!;
        for (const action of ["trash", "restore", "delete"] as const) {
            expect(await body(await client.chatTrash(action, request), 409), action).toMatchObject({
                error: "stale",
                revision: current,
            });
        }
        expect(await body(await retry(), 409)).toMatchObject({
            conflicts: [{ kind: "chat", ...identity, revision: current, reason: "useTrash" }],
        });
        expect((await read(client)).chats).toMatchObject([
            { ...identity, revision: current, trashedAt: null, data: { name: "New story" } },
        ]);
    });
});
