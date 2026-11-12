import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createFakeLockManager } from "./fakeLockManager";
import type { Chat } from "../../../../shared/database.ts";
import type { ChatOp } from "../../../../shared/chats.ts";
import { sealHypaV3Data } from "../../../../shared/structuredMemory.ts";
import { decideChatRecovery, decideRecordRecovery, replayedHypaV3Data } from "../journalRecovery";
import type { JournalChatOp, RecordLayerValues, StoredLayers } from "../draftJournal";

const A = JSON.stringify({ name: "sent" });
const B = JSON.stringify({ name: "newer" });
const BASE = JSON.stringify({ name: "server base" });
const server = { revision: "base", text: BASE };
const latest = (text: string | null, baseRevision: string | null = "base"): RecordLayerValues["latest"] => ({
    op: text === null ? "delete" : baseRevision === null ? "create" : "update",
    text,
    baseRevision,
});
const sent = (text: string | null, baseRevision: string | null = "base"): RecordLayerValues["sent"] => ({
    ...latest(text, baseRevision),
    dispatched: true,
    inDoubt: true,
});
const layer = <T>(value: T, version = 1) => ({ version, value });

describe("record recovery decisions", () => {
    it("preserves ordered intent across sent updates, deletes, re-adds and refusals", () => {
        const cases: {
            name: string;
            layers: StoredLayers<"record">;
            server: typeof server | null;
            expected: ReturnType<typeof decideRecordRecovery>;
        }[] = [
            {
                name: "unresolved sent update before newer text, regardless of storage versions",
                layers: { sent: layer(sent(A), 9), latest: layer(latest(B), 2) },
                server,
                expected: { action: "replay", text: B, unresolvedSent: sent(A) },
            },
            {
                name: "a revert must wait behind an update that can still land",
                layers: { sent: layer(sent(A)), latest: layer(latest(BASE), 2) },
                server,
                expected: { action: "replay", text: BASE, unresolvedSent: sent(A) },
            },
            {
                name: "landed sent text allows newer text on the current revision",
                layers: { sent: layer(sent(A)), latest: layer(latest(B), 2) },
                server: { revision: "advanced", text: A },
                expected: { action: "replay", text: B },
            },
            {
                name: "a moved base that matches neither sent nor latest is a draft",
                layers: { sent: layer(sent(A)), latest: layer(latest(B), 2) },
                server: { revision: "advanced", text: BASE },
                expected: { action: "draft" },
            },
            {
                name: "latest-only delete on its base",
                layers: { latest: layer(latest(null)) },
                server,
                expected: { action: "replay", text: null },
            },
            {
                name: "a delete already absent is satisfied",
                layers: { sent: layer(sent(null)) },
                server: null,
                expected: { action: "satisfied" },
            },
            {
                name: "a sent delete with a re-add must not resurrect an absent target",
                layers: { sent: layer(sent(null)), latest: layer(latest(B), 2) },
                server: null,
                expected: { action: "draft" },
            },
            {
                name: "a matching re-add cannot protect against the unanswered delete",
                layers: { sent: layer(sent(null)), latest: layer(latest(BASE), 2) },
                server,
                expected: { action: "draft" },
            },
            {
                name: "refused intent remains a draft even when a latest layer is replayable",
                layers: { latest: layer(latest(B)), refused: layer({ op: "update", text: B, reason: "validation" }) },
                server,
                expected: { action: "draft" },
            },
            {
                name: "an incoherent newer base is a draft",
                layers: { sent: layer(sent(A)), latest: layer(latest(B, "unrelated"), 2) },
                server,
                expected: { action: "draft" },
            },
        ];
        for (const item of cases) {
            expect(decideRecordRecovery(item.layers, item.server), item.name).toEqual(item.expected);
        }
    });
});

describe("whole-chat recovery decisions", () => {
    const snapshot = {
        id: "chat",
        name: "Local replacement",
        note: "",
        localLore: [],
        message: [{ chatId: "m", role: "user" as const, data: "local" }],
    };
    it.each([
        { name: "replace", op: { op: "replace" as const, chat: snapshot } },
        { name: "delete", op: { op: "delete" as const } },
        { name: "multi-id remove", op: { op: "remove" as const, ids: ["m", "n"] } },
    ])("replays $name only on its unchanged revision, without requesting message data", ({ op }) => {
        const layers: StoredLayers<"chat"> = {
            pending: layer({ baseRevision: "original-base", groupId: "original-group", ops: [{ op }] }),
        };
        const context = { parent: true, chatId: "chat", canDelete: true };
        expect(decideChatRecovery(layers, { revision: "original-base" }, context)).toMatchObject({
            action: "replay",
            ops: [op],
            baseRevision: "original-base",
            groupId: "original-group",
        });
        expect(decideChatRecovery(layers, { revision: "remote-base" }, context)).toEqual({ action: "draft" });
    });
});

describe("pending by-id recovery revisions", () => {
    const original: Chat = {
        id: "chat",
        name: "Chat",
        note: "",
        localLore: [],
        message: [{ chatId: "m", role: "user", data: "Before" }],
    };
    const context = { parent: true, chatId: "chat", canDelete: true };

    it("requires the recorded base for matching before-values but recognizes final coalesced text on a later revision", () => {
        // Coalescing persists the first before-value and the final text, with no history marker.
        const op = { op: "setText", id: "m", text: "Final local edit" } satisfies ChatOp;
        const layers: StoredLayers<"chat"> = {
            pending: layer(
                { baseRevision: "base", groupId: "pending-group", ops: [{ op, before: { value: "Before" } }] },
                99,
            ),
        };
        const server = (revision: string, data = original) => ({ revision, data });

        expect(decideChatRecovery(layers, { revision: "later" }, context)).toEqual({ action: "load" });
        expect(decideChatRecovery(layers, server("base"), context)).toEqual({
            action: "replay",
            ops: [op],
            baseRevision: "base",
            groupId: "pending-group",
            splitPending: false,
        });
        const moved = { ...original, note: "Unrelated remote change" };
        expect(decideChatRecovery(layers, server("later", moved), context)).toEqual({ action: "draft" });
        expect(
            decideChatRecovery(
                layers,
                server("later", { ...moved, message: [{ ...original.message[0], data: op.text }] }),
                context,
            ),
        ).toEqual({ action: "satisfied" });
        expect(
            decideChatRecovery(
                { pending: layer({ ...layers.pending!.value, baseRevision: null }) },
                server("base"),
                context,
            ),
        ).toEqual({ action: "draft" });
        // An empty base is unknown/invalid, rather than evidence that the revision is unchanged.
        expect(
            decideChatRecovery(
                { pending: layer({ ...layers.pending!.value, baseRevision: "" }) },
                server("base"),
                context,
            ),
        ).toEqual({ action: "draft" });
        expect(original.message[0].data).toBe("Before");
    });

    it("replays a never-sent append only on its recorded revision and satisfies an exact landed append on a later revision", () => {
        const appended = { chatId: "new", role: "char" as const, data: "Unsent reply" };
        const op = { op: "append", anchor: { after: "m" }, messages: [appended] } satisfies ChatOp;
        const journalOp: JournalChatOp = { op, before: { absent: true } };
        const pending = { baseRevision: "base", groupId: "append-group", ops: [journalOp] };
        const layers: StoredLayers<"chat"> = { pending: layer(pending) };

        expect(decideChatRecovery(layers, { revision: "base", data: original }, context)).toEqual({
            action: "replay",
            ops: [op],
            baseRevision: "base",
            groupId: "append-group",
            splitPending: false,
        });
        expect(decideChatRecovery(layers, { revision: "later", data: original }, context)).toEqual({ action: "draft" });
        expect(
            decideChatRecovery(
                layers,
                { revision: "later", data: { ...original, message: [...original.message, appended] } },
                context,
            ),
        ).toEqual({ action: "satisfied" });
        expect(
            decideChatRecovery(
                { pending: layer({ ...pending, baseRevision: null }) },
                { revision: "base", data: original },
                context,
            ),
        ).toEqual({ action: "draft" });
        expect(decideChatRecovery(layers, { revision: "base", data: { ...original, message: [] } }, context)).toEqual({
            action: "draft",
        });
        expect(original.message).toHaveLength(1);
    });
});

describe("replayed HypaV3 memory", () => {
    it("lists each real unsealed hypaV3Data a replay may lose under Structured Memory", () => {
        const real = { summaries: [{ text: "Kept", chatMemos: [], isImportant: false }] };
        const later = { summaries: [{ text: "Later", chatMemos: [], isImportant: false }] };
        const chat = { name: "chat", message: [] } as unknown as Chat;
        // A chat not held: whether its field is the projection's is unknown, so every real value is at risk.
        const structured = { settings: { memoryAlgorithmType: "structuredMemory" } };
        const at = (ops: ChatOp[]) => replayedHypaV3Data(ops, structured);
        expect(at([{ op: "meta", set: { hypaV3Data: real } }])).toEqual([real]);
        expect(
            at([
                { op: "meta", set: { hypaV3Data: real } },
                { op: "replace", chat: { ...chat, hypaV3Data: later } },
            ]),
        ).toEqual([real, later]);
        // A later unset does not bring back a value the earlier op lost.
        expect(
            at([
                { op: "meta", set: { hypaV3Data: real } },
                { op: "meta", unset: ["hypaV3Data"] },
            ]),
        ).toEqual([real]);
        expect(at([{ op: "meta", set: { hypaV3Data: sealHypaV3Data(real) } }])).toEqual([]);
        expect(at([{ op: "meta", set: { hypaV3Data: { summaries: [] } } }])).toEqual([]);
        expect(at([{ op: "create", chat: { ...chat, hypaV3Data: real } }])).toEqual([]);
        expect(at([{ op: "meta", set: { name: "Renamed" } }])).toEqual([]);
        // Under HypaV3 nothing is at risk.
        expect(
            replayedHypaV3Data([{ op: "meta", set: { hypaV3Data: real } }], {
                settings: { memoryAlgorithmType: "hypaMemoryV3", hypaV3: true },
            }),
        ).toEqual([]);
    });
});

describe("recovery uses the mode at each summary write", () => {
    let journal: import("../draftJournal").DraftJournal;
    let originalKeyRange: PropertyDescriptor | undefined;
    const epoch = "00000000-0000-4000-8000-000000000001";
    const revision = `${epoch}:1:1`;
    const now = 1_700_000_000_000;
    const ref = { chaId: "c", chatId: "chat" };
    const summary = { summaries: [{ text: "Recovered summary", chatMemos: ["m"], isImportant: false }] };
    const memory: ChatOp = { op: "meta", set: { hypaV3Data: summary } };
    const switchMode: ChatOp = { op: "meta", set: { memoryMode: "hypaV3" } };
    const append: ChatOp = {
        op: "append",
        anchor: { after: "m" },
        messages: [{ chatId: "new", role: "char", data: "Replayed reply" }],
    };

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        vi.setSystemTime(now);
        localStorage.clear();
        sessionStorage.clear();
        originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
        Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, writable: true, value: IDBKeyRange });
        const { createDraftJournal } = await import("../draftJournal");
        journal = createDraftJournal({
            indexedDB: new IDBFactory(),
            locks: createFakeLockManager(),
            storage: () => sessionStorage,
            now: () => now,
        });
        expect(await journal.start()).toBe(true);
        const { initializeRecords, takeRecordFields } = await import("../records.svelte");
        const { characterList } = await import("../characterStore.svelte");
        const { setResourceEpoch } = await import("../resourceClient");
        const chats = await import("../chatStore.svelte");
        initializeRecords(
            takeRecordFields({
                characters: [{ chaId: "c", name: "C" }],
                memoryAlgorithmType: "structuredMemory",
            }),
        );
        setResourceEpoch(epoch);
        // Boot has only the summary: ownership of any stored HypaV3 data is unknown.
        const entries = [
            {
                characterId: "c",
                id: "chat",
                revision,
                name: "Chat",
                fmIndex: -1,
                memoryMode: "structuredMemory" as const,
            },
        ];
        const orders = [{ characterId: "c", revision, ids: ["chat"] }];
        chats.seedChats(entries, orders);
        chats.assembleChats(characterList(), entries, orders);
    });

    afterEach(async () => {
        await journal.close();
        if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
        else Reflect.deleteProperty(globalThis, "IDBKeyRange");
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it.each([
        {
            name: "keeps a summary written before the append and switch to HypaV3",
            ops: [memory, append, switchMode],
            draft: true,
        },
        {
            name: "replays a summary written after the switch to HypaV3 without a draft",
            ops: [switchMode, memory, append],
            draft: false,
        },
    ])("$name", async ({ ops, draft }) => {
        const groupId = "original-replay-group";
        expect(
            await journal.write([
                {
                    epoch,
                    scope: "chat",
                    target: "c\0chat",
                    version: journal.nextVersion(),
                    layers: { resend: { baseRevision: revision, groupId, ops, seq: 7, inDoubt: true } },
                },
            ]),
        ).toEqual(["written"]);
        const { recoverJournal } = await import("../journalRecovery");
        await recoverJournal({ journal, now: () => now });
        expect(journal.enabled).toBe(true);
        const drafts = await journal.listDrafts();
        expect(drafts).toHaveLength(draft ? 1 : 0);
        if (draft)
            expect(drafts[0]).toMatchObject({
                epoch,
                target: "c\0chat",
                scope: "chat",
                createdAt: now,
                layers: { pending: { value: { ops: [{ op: memory }] } } },
            });
        const chats = await import("../chatStore.svelte");
        const work = chats.takeChatWork(new Set());
        expect(work.groups).toHaveLength(1);
        expect(JSON.parse(chats.chatWorkBody(work).chats[0])).toEqual({
            characterId: "c",
            chatId: "chat",
            baseRevision: revision,
            groupId,
            retry: true,
            ops,
        });
        expect(chats.findChat(ref)).toBeUndefined();
    });
});
