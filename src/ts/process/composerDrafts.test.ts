import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createDraftJournal,
    composerKey,
    JOURNAL_DB_NAME,
    type ComposerEntry,
    type DraftJournal,
} from "../storage/draftJournal";
import { createFakeLockManager } from "../storage/tests/fakeLockManager";
import { installFlatDatabaseWithChats } from "../storage/tests/installFlatDatabase";
import {
    acceptRemoteChat,
    applyRemoteCollection,
    deleteChat,
    forgetCharacter,
    seedChats,
} from "../storage/chatStore.svelte";
import { composerSendText, createSendDrafts } from "./sendDraft";
import { createComposer } from "./composerDrafts.svelte";

// The chat screen's per-chat composer (`composerDrafts.svelte.ts`): the text, the translation
// draft, and the queued attachments stay with the chat they were typed in across chat switches,
// and a write that lands after an await (a slash command, a pasted image, the file button, a send
// recovery) goes to the chat captured before it, wherever that chat's draft lives now. Before, one
// component state served every chat: typed text carried over to the next chat, and a late write
// landed in whichever chat was selected then.

const a = "c\u0000a";
const b = "c\u0000b";

describe("createComposer", () => {
    it("keeps each chat's text, translation draft, and attachments across switches; a chat not typed in starts empty", () => {
        const composer = createComposer();
        composer.switchTo(a);
        composer.input = "typed in A";
        composer.translate = "A's translation";
        composer.files.push("asset-a");

        composer.switchTo(b);
        expect([composer.input, composer.translate, composer.files]).toEqual(["", "", []]);
        composer.input = "typed in B";

        composer.switchTo(a);
        expect([composer.input, composer.translate, composer.files]).toEqual([
            "typed in A",
            "A's translation",
            ["asset-a"],
        ]);
        // Edits after the return belong to A alone.
        composer.files.splice(0, 1);
        composer.switchTo(b);
        expect([composer.input, composer.files]).toEqual(["typed in B", []]);
        composer.switchTo(a);
        expect(composer.files).toEqual([]);
    });

    it("leaving a chat (to another, or to none) stashes its draft; switching to the shown chat again changes nothing", () => {
        const composer = createComposer();
        composer.switchTo(a);
        composer.input = "kept while away";
        composer.switchTo(null);
        expect(composer.input).toBe("");
        composer.input = "typed with no chat";
        composer.switchTo(a);
        expect(composer.input).toBe("kept while away");
        composer.switchTo(a);
        expect(composer.input).toBe("kept while away");
        // The draft typed with no chat shown is stashed under no chat: gone.
        composer.switchTo(null);
        expect(composer.input).toBe("");
    });

    it("at(key) is the live composer while that chat is shown, and its stashed draft after a switch", () => {
        const composer = createComposer();
        composer.switchTo(a);
        const draft = composer.at(a);
        draft.input = "/command";
        expect(composer.input).toBe("/command");

        // The chat switched while A's send awaited its command: A's late clear and B's composer are apart.
        composer.switchTo(b);
        composer.input = "typed in B";
        expect(draft.input).toBe("/command");
        draft.input = "";
        draft.files.push("pasted-into-a");
        draft.translate = "late translation";
        expect([composer.input, composer.translate, composer.files]).toEqual(["typed in B", "", []]);

        composer.switchTo(a);
        expect([composer.input, composer.translate, composer.files]).toEqual([
            "",
            "late translation",
            ["pasted-into-a"],
        ]);
        // The view follows the draft back into the live composer.
        draft.input += " more";
        expect(composer.input).toBe(" more");
        draft.files = [];
        expect(composer.files).toEqual([]);
    });

    it("a write to a chat never shown yet creates its draft, shown when that chat is", () => {
        const composer = createComposer();
        composer.switchTo(a);
        expect(composer.at(b).input).toBe("");
        composer.at(b).input = "restored into B";
        composer.at(b).files.push("b-asset");
        expect(composer.input).toBe("");
        composer.switchTo(b);
        expect([composer.input, composer.files]).toEqual(["restored into B", ["b-asset"]]);
    });
});

const T0 = 1_700_000_000_000;
const checks = { landed: async () => false, inlayExists: async () => true };
const snapshot = (composer: ReturnType<typeof createComposer>) => ({
    input: composer.input,
    translate: composer.translate,
    files: [...composer.files],
});

// Only fake time advances: fake-indexeddb's tasks and the journal's deadlines use this clock.
async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const result = promise.finally(() => {
        done = true;
    });
    for (let step = 0; !done && step < 2000; step++) await vi.advanceTimersByTimeAsync(1);
    expect(done, "IndexedDB operation settled under the controlled clock").toBe(true);
    return result;
}

async function row(factory: IDBFactory, key: string): Promise<ComposerEntry | undefined> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = factory.open(JOURNAL_DB_NAME);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
    try {
        return await new Promise((resolve, reject) => {
            const request = db.transaction("entries").objectStore("entries").get(composerKey(key));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

describe("durable composers", () => {
    let factory: IDBFactory;
    let journal: DraftJournal;
    let now: number;
    const mounted: ReturnType<typeof createComposer>[] = [];
    function composer(retryIdFor?: NonNullable<Parameters<typeof createComposer>[0]>["retryIdFor"]) {
        const value = createComposer({ journal, retryIdFor });
        mounted.push(value);
        return value;
    }
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.stubGlobal("IDBKeyRange", IDBKeyRange);
        factory = new IDBFactory();
        now = T0;
        journal = createDraftJournal({
            indexedDB: factory,
            locks: createFakeLockManager(),
            storage: () => sessionStorage,
            now: () => now,
            newId: () => "composer-test-tab",
            report: () => {},
        });
        expect(await drive(journal.start())).toBe(true);
    });
    afterEach(async () => {
        for (const value of mounted.splice(0)) value.destroy();
        await drive(journal.close());
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("persists shown and stashed edits after 500 ms of quiet and restores them", async () => {
        const first = composer();
        first.switchTo(a);
        first.input = "shown draft";
        const editAt = Date.now();
        await vi.advanceTimersByTimeAsync(400);
        first.translate = "translation draft";
        first.addFile("keep");
        first.addFile("remove");
        first.removeFileAt(1);
        await vi.advanceTimersByTimeAsync(90);
        expect(await drive(journal.readComposer(a))).toBeNull();
        // A second edit resets the deadline; the initial edit's deadline is insufficient.
        await vi.advanceTimersByTimeAsync(800 - (Date.now() - editAt));
        expect(await drive(journal.readComposer(a))).toBeNull();
        first.switchTo(b);
        first.input = "B draft";
        first.at(a).input = "written while stashed";
        const lastEdit = Date.now();
        await vi.advanceTimersByTimeAsync(490);
        expect(await drive(journal.readComposer(a))).toBeNull();
        await vi.advanceTimersByTimeAsync(500 - (Date.now() - lastEdit));
        expect(await drive(journal.readComposer(a))).toEqual({
            input: "written while stashed",
            translate: "translation draft",
            files: ["keep"],
        });
        expect(await drive(journal.readComposer(b))).toEqual({ input: "B draft", translate: "", files: [] });
        first.destroy();

        const reloaded = composer();
        reloaded.switchTo(b);
        await drive(reloaded.restore(b, checks));
        expect(snapshot(reloaded)).toEqual({ input: "B draft", translate: "", files: [] });
        reloaded.switchTo(a);
        await drive(reloaded.restore(a, checks));
        expect(snapshot(reloaded)).toEqual({
            input: "written while stashed",
            translate: "translation draft",
            files: ["keep"],
        });
    });

    it("hands off a send immediately, fences remount recovery, and deletes it on success", async () => {
        const first = composer();
        first.switchTo(a);
        first.input = "send this";
        first.translate = "translation";
        first.addFile("attachment");
        first.beginSend(a, { snapshot: snapshot(first), userMessageId: "sending-id" });
        first.input = "";
        first.translate = "";
        first.files = [];
        await drive(first.flush());
        expect(await drive(journal.readComposer(a))).toBeNull();
        expect(await drive(journal.readComposerSend(a))).toEqual({
            state: "sending",
            input: "send this",
            translate: "translation",
            files: ["attachment"],
            userMessageId: "sending-id",
        });
        first.destroy();
        const remounted = composer();
        remounted.switchTo(a);
        await drive(remounted.restore(a, checks));
        expect(snapshot(remounted)).toEqual({ input: "", translate: "", files: [] });
        first.settleSend(a, "sending-id", true);
        expect(await drive(journal.readComposerSend(a))).toBeNull();
    });

    it.each([
        { landed: true, row: "hand-off" },
        { landed: false, row: "hand-off" },
        // An older page kept the hand-off in the draft row.
        { landed: true, row: "draft" },
        { landed: false, row: "draft" },
    ])(
        "restores an unlanded send with its retry id and drops a landed send (landed: $landed, $row row)",
        async ({ landed, row: kind }) => {
            const saved = {
                input: "unconfirmed",
                translate: "translation",
                files: ["attachment"],
                state: "sending" as const,
                userMessageId: "recovered-id",
            };
            if (kind === "hand-off") await drive(journal.putComposerSend(a, saved));
            else await drive(journal.putComposer(a, saved));
            const drafts = createSendDrafts();
            const reloaded = composer((_, text) => drafts.retryIdFor({ chaId: "c", chatId: "a" }, text));
            reloaded.switchTo(a);
            const recovery = await drive(
                reloaded.restore(a, {
                    ...checks,
                    landed: async (id) => {
                        expect(id).toBe("recovered-id");
                        return landed;
                    },
                }),
            );
            if (landed) {
                expect(recovery).toBeUndefined();
                expect(reloaded.input).toBe("");
                expect(await drive(row(factory, a))).toBeUndefined();
                expect(await drive(journal.readComposerSend(a))).toBeNull();
            } else {
                expect(await drive(journal.readComposerSend(a))).toBeNull();
                expect(snapshot(reloaded)).toEqual({
                    input: "unconfirmed",
                    translate: "translation",
                    files: ["attachment"],
                });
                expect(recovery).toEqual({ text: "unconfirmed{{inlayed::attachment}}", userMessageId: "recovered-id" });
                drafts.adopt(
                    { chaId: "c", chatId: "a" },
                    { input: recovery!.text, userMessageId: recovery!.userMessageId },
                );
                expect(drafts.takeUnplaced({ chaId: "c", chatId: "a" })).toBeUndefined();
                reloaded.translate = "edited translation";
                await drive(reloaded.flush());
                expect(await drive(journal.readComposer(a))).toEqual({
                    input: "unconfirmed",
                    translate: "edited translation",
                    files: ["attachment"],
                    userMessageId: "recovered-id",
                });
                expect(drafts.idFor({ chaId: "c", chatId: "a" }, composerSendText(reloaded))).toBe("recovered-id");
            }
        },
    );

    it("keeps a send's hand-off apart from a follow-up typed and cleared during it, and restores it into an empty composer", async () => {
        const first = composer();
        first.switchTo(a);
        first.input = "original";
        first.beginSend(a, { snapshot: snapshot(first), userMessageId: "original-id" });
        first.input = "";
        first.input = "follow-up";
        await drive(first.flush());
        expect(await drive(journal.readComposer(a))).toEqual({ input: "follow-up", translate: "", files: [] });
        first.input = "";
        await drive(first.flush());
        expect(await drive(journal.readComposer(a))).toBeNull();
        expect(await drive(journal.readComposerSend(a))).toMatchObject({
            input: "original",
            userMessageId: "original-id",
        });
        first.input = "follow-up";
        await drive(first.flush());
        first.settleSend(a, "original-id", false);
        first.destroy();

        // The draft typed later comes back first; the hand-off waits for an empty composer.
        const reloaded = composer();
        reloaded.switchTo(a);
        expect(await drive(reloaded.restore(a, checks))).toBeUndefined();
        expect(reloaded.input).toBe("follow-up");
        reloaded.input = "";
        await drive(reloaded.flush());
        expect(await drive(journal.readComposerSend(a))).toMatchObject({ userMessageId: "original-id" });
        reloaded.switchTo(b);
        reloaded.switchTo(a);
        expect(await drive(reloaded.restore(a, checks))).toEqual({ text: "original", userMessageId: "original-id" });
        expect(reloaded.input).toBe("original");
        // The restored draft took over the hand-off, so clearing it cannot bring the text back.
        expect(await drive(journal.readComposerSend(a))).toBeNull();
        expect(await drive(journal.readComposer(a))).toEqual({
            input: "original",
            translate: "",
            files: [],
            userMessageId: "original-id",
        });
    });

    it("replaces a failed send's hand-off once its text is placed, also beside a file queued during the send", async () => {
        const ref = { chaId: "c", chatId: "a" };
        const drafts = createSendDrafts();
        const first = composer((_, text) => drafts.retryIdFor(ref, text));
        first.switchTo(a);
        first.input = "original";
        first.addFile("old-file");
        const attempt = { input: composerSendText(first), ...drafts.idsFor(ref, composerSendText(first)) };
        first.beginSend(a, { snapshot: snapshot(first), userMessageId: attempt.userMessageId });
        first.input = "";
        first.files = ["new-file"];
        drafts.settle(ref, attempt, { landed: false, ok: false, selected: true, composerEmpty: true });
        first.settleSend(a, attempt.userMessageId, false);
        first.placeSend(a, attempt.input, attempt.userMessageId);
        expect(await drive(journal.readComposerSend(a))).toBeNull();
        // The queued file makes it another input: the draft keeps both, without the send's ids.
        expect(await drive(journal.readComposer(a))).toEqual({
            input: "original{{inlayed::old-file}}",
            translate: "",
            files: ["new-file"],
        });
        first.input = "";
        first.files = [];
        await drive(first.flush());
        first.switchTo(b);
        first.switchTo(a);
        await drive(first.restore(a, checks));
        expect(snapshot(first)).toEqual({ input: "", translate: "", files: [] });
    });

    it("keeps a draft typed again during a send, without that send's id, when the send lands", async () => {
        const ref = { chaId: "c", chatId: "a" };
        const drafts = createSendDrafts();
        const first = composer((_, text) => drafts.retryIdFor(ref, text));
        first.switchTo(a);
        first.input = "continue";
        const attempt = { input: "continue", ...drafts.idsFor(ref, "continue") };
        first.beginSend(a, { snapshot: snapshot(first), userMessageId: attempt.userMessageId });
        first.input = "";
        first.input = "continue";
        await drive(first.flush());
        expect(await drive(journal.readComposer(a))).toMatchObject({ userMessageId: attempt.userMessageId });
        drafts.settle(ref, attempt, { landed: true, ok: true, selected: true, composerEmpty: false });
        first.settleSend(a, attempt.userMessageId, true);
        expect(await drive(journal.readComposerSend(a))).toBeNull();
        expect(await drive(journal.readComposer(a))).toEqual({ input: "continue", translate: "", files: [] });
        first.destroy();
        const reloaded = composer();
        reloaded.switchTo(a);
        await drive(reloaded.restore(a, { ...checks, landed: async () => true }));
        expect(reloaded.input).toBe("continue");
    });

    it.each(["switch away and back", "type and clear"])("ignores a late restore after %s", async (action) => {
        await drive(journal.putComposer(a, { input: "old journal text", translate: "old translation", files: [] }));
        const reloaded = composer();
        reloaded.switchTo(a);
        const reading = reloaded.restore(a, checks);
        if (action === "switch away and back") {
            reloaded.switchTo(b);
            reloaded.switchTo(a);
        } else {
            reloaded.input = "new typing";
            reloaded.input = "";
        }
        await drive(reading);
        expect(snapshot(reloaded)).toEqual({ input: "", translate: "", files: [] });
    });

    it("drops missing inlays and clears edited drafts without deleting untouched rows", async () => {
        await drive(
            journal.putComposer(a, {
                input: "saved",
                translate: "translation",
                files: ["gone", "present"],
            }),
        );
        const reloaded = composer();
        reloaded.switchTo(a);
        // These are also the empty assignments made by Continue with nothing typed.
        reloaded.input = "";
        reloaded.translate = "";
        reloaded.files = [];
        await drive(reloaded.flush());
        expect(await drive(row(factory, a))).toBeDefined();
        await drive(reloaded.restore(a, { ...checks, inlayExists: async (id) => id === "present" }));
        expect(snapshot(reloaded)).toEqual({ input: "saved", translate: "translation", files: ["present"] });
        await drive(reloaded.flush());
        expect(await drive(journal.readComposer(a))).toEqual({
            input: "saved",
            translate: "translation",
            files: ["present"],
        });
        reloaded.input = "";
        reloaded.translate = "";
        reloaded.removeFileAt(0);
        await drive(reloaded.flush());
        expect(await drive(row(factory, a))).toBeUndefined();
    });

    it.each(["local chat", "remote chat", "remote collection", "remote character"])(
        "purges %s drafts and rejects queued or late edits",
        async (kind) => {
            const chat = (id: string) => ({ id, name: id, message: [], note: "", localLore: [] });
            installFlatDatabaseWithChats({
                characters: [{ chaId: "c", type: "character", name: "C", chats: [chat("a"), chat("b")] }],
            });
            seedChats(
                ["a", "b"].map((id) => ({ characterId: "c", id, revision: "r1", data: chat(id) })),
                [{ characterId: "c", revision: "o1", ids: ["a", "b"] }],
            );
            const first = composer();
            first.switchTo(a);
            first.input = "saved A";
            first.at(b).input = "saved B";
            first.at("other\u0000a").input = "unrelated character";
            await drive(first.flush());
            first.input = "queued edit";
            const pendingWrite = first.flush();
            if (kind === "local chat") deleteChat({ chaId: "c", chatId: "a" });
            if (kind === "remote chat") acceptRemoteChat({ characterId: "c", id: "a", revision: null, data: null });
            if (kind === "remote collection")
                expect(
                    applyRemoteCollection({
                        characterId: "c",
                        order: { characterId: "c", revision: "o2", ids: ["b"] },
                        chats: [{ characterId: "c", id: "b", revision: "r1", data: chat("b") }],
                    }),
                ).toBe(true);
            if (kind === "remote character") forgetCharacter("c", { discard: true });
            first.at(a).input = "late async result";
            first.at(a).addFile("late attachment");
            await drive(pendingWrite);
            await vi.advanceTimersByTimeAsync(500);
            await drive(first.flush());
            expect(await drive(row(factory, a))).toBeUndefined();
            if (kind === "remote character") expect(await drive(row(factory, b))).toBeUndefined();
            else expect(await drive(journal.readComposer(b))).toMatchObject({ input: "saved B" });
            expect(await drive(journal.readComposer("other\u0000a"))).toMatchObject({ input: "unrelated character" });
            first.switchTo(b);
            first.switchTo(a);
            expect(snapshot(first)).toEqual({ input: "", translate: "", files: [] });
        },
    );

    it("preserves createdAt until 48-hour expiry and starts a fresh lifetime", async () => {
        const saved = { input: "first", translate: "", files: [] };
        await drive(journal.putComposer(a, saved));
        expect((await drive(row(factory, a)))?.createdAt).toBe(T0);
        now = T0 + 47 * 60 * 60 * 1000;
        await drive(journal.putComposer(a, { ...saved, input: "edited" }));
        expect(await drive(row(factory, a))).toMatchObject({ createdAt: T0, updatedAt: now });
        now = T0 + 48 * 60 * 60 * 1000 - 1;
        expect(await drive(journal.readComposer(a))).toMatchObject({ input: "edited" });
        now++;
        expect(await drive(journal.readComposer(a))).toBeNull();
        await drive(journal.putComposer(a, { ...saved, input: "fresh" }));
        expect(await drive(row(factory, a))).toMatchObject({
            createdAt: now,
            updatedAt: now,
            value: { input: "fresh" },
        });
    });
});
