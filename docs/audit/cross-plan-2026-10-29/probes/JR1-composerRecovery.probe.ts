import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDraftJournal, type DraftJournal } from "../storage/draftJournal";
import { createFakeLockManager } from "../storage/tests/fakeLockManager";
import { createSendDrafts } from "./sendDraft";
import { createComposer } from "./composerDrafts.svelte";

const ref = { chaId: "character", chatId: "chat" };
const key = "character\0chat";
let journal: DraftJournal;
const mounted: ReturnType<typeof createComposer>[] = [];
async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const result = promise.finally(() => {
        done = true;
    });
    for (let step = 0; !done && step < 2000; step++) await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    return result;
}
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    journal = createDraftJournal({
        indexedDB: new IDBFactory(),
        locks: createFakeLockManager(),
        storage: () => sessionStorage,
        report: () => {},
    });
    expect(await drive(journal.start())).toBe(true);
});
afterEach(async () => {
    for (const composer of mounted.splice(0)) composer.destroy();
    await drive(journal.close());
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it("keeps a newly typed identical draft when the active send succeeds", async () => {
    const drafts = createSendDrafts();
    const composer = createComposer({
        journal,
        epoch: () => "epoch",
        retryIdFor: (_, text) => drafts.retryIdFor(ref, text),
    });
    mounted.push(composer);
    composer.switchTo(key);
    composer.input = "continue";
    const attempt = { input: composer.input, ...drafts.idsFor(ref, composer.input) };
    composer.beginSend(key, { snapshot: { input: composer.input, translate: "", files: [] }, ...attempt });
    composer.input = "";
    // The user prepares the next message while generation is in progress.
    composer.input = "continue";
    await drive(composer.flush());
    console.log("newly typed draft before settlement:", JSON.stringify(await drive(journal.readComposer(key))));
    const result = drafts.settle(ref, attempt, { landed: true, ok: true, selected: true, composerEmpty: false });
    composer.settleSend(key, attempt.userMessageId, result === "drop", { requestId: attempt.requestId });
    const saved = await drive(journal.readComposer(key));
    console.log(
        "live input after successful send:",
        composer.input,
        "journal after settlement:",
        JSON.stringify(saved),
    );
    composer.destroy();
    const reloaded = createComposer({ journal });
    mounted.push(reloaded);
    reloaded.switchTo(key);
    await drive(reloaded.restore(key, { landed: async () => false, inlayExists: async () => true }));
    console.log("composer restored after remount:", JSON.stringify(reloaded.input));
    expect(reloaded.input).toBe("continue");
});
