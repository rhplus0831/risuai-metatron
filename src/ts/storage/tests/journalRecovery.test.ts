import { describe, expect, it } from "vitest";
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
    it("finds the last real unsealed hypaV3Data a replay would store", () => {
        const real = { summaries: [{ text: "Kept", chatMemos: [], isImportant: false }] };
        const later = { summaries: [{ text: "Later", chatMemos: [], isImportant: false }] };
        const chat = { name: "chat", message: [] } as unknown as Chat;
        expect(replayedHypaV3Data([{ op: "meta", set: { hypaV3Data: real } }])).toEqual(real);
        expect(
            replayedHypaV3Data([
                { op: "meta", set: { hypaV3Data: real } },
                { op: "replace", chat: { ...chat, hypaV3Data: later } },
            ]),
        ).toEqual(later);
        expect(
            replayedHypaV3Data([
                { op: "meta", set: { hypaV3Data: real } },
                { op: "meta", unset: ["hypaV3Data"] },
            ]),
        ).toBeUndefined();
        expect(replayedHypaV3Data([{ op: "meta", set: { hypaV3Data: sealHypaV3Data(real) } }])).toBeUndefined();
        expect(replayedHypaV3Data([{ op: "meta", set: { hypaV3Data: { summaries: [] } } }])).toBeUndefined();
        expect(replayedHypaV3Data([{ op: "create", chat: { ...chat, hypaV3Data: real } }])).toBeUndefined();
        expect(replayedHypaV3Data([{ op: "meta", set: { name: "Renamed" } }])).toBeUndefined();
    });
});
