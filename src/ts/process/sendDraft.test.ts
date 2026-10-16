import { describe, expect, it } from "vitest";
import { createSendDrafts } from "./sendDraft";

// The chat screen's send drafts (`sendDraft.ts`): audit JOB-01 (`docs/plan/audit-findings-perf.md`
// slice 2a). A send whose user message did not land and whose job did not end `done` keeps its text
// and `userMessageId`: the text goes back into the composer when the chat is still selected and the
// composer is empty, otherwise when the user returns to the chat; the id stays with the text so a
// retry is skipped by a job that already appended it. Before the fix only a refusal before the job
// put the text back, and an accepted job that failed before the append lost it.

const a = { chaId: "c", chatId: "a" };
const b = { chaId: "c", chatId: "b" };
const failed = { landed: false, ok: false, selected: true, composerEmpty: true };

describe("createSendDrafts", () => {
    it("an accepted job that failed before the append puts the text back and keeps its id for the retry", () => {
        const drafts = createSendDrafts();
        const draft = { input: "Preserve this draft", userMessageId: drafts.idFor(a, "Preserve this draft") };
        expect(drafts.settle(a, draft, failed)).toBe("restore");
        // The same text sends again under the same id; different text gets a new one.
        expect(drafts.idFor(a, draft.input)).toBe(draft.userMessageId);
        expect(drafts.idFor(a, "Something else")).not.toBe(draft.userMessageId);
    });

    it("a job that failed after the append (the user message landed) drops the draft", () => {
        const drafts = createSendDrafts();
        const draft = { input: "Sent", userMessageId: drafts.idFor(a, "Sent") };
        expect(drafts.settle(a, draft, { ...failed, landed: true })).toBe("drop");
        expect(drafts.takeUnplaced(a)).toBeUndefined();
        expect(drafts.idFor(a, "Sent")).not.toBe(draft.userMessageId);
    });

    it("a job that ended done never restores, even when the user message is gone", () => {
        const drafts = createSendDrafts();
        const draft = { input: "Removed by a script", userMessageId: drafts.idFor(a, "Removed by a script") };
        expect(drafts.settle(a, draft, { ...failed, ok: true })).toBe("drop");
        expect(drafts.takeUnplaced(a)).toBeUndefined();
    });

    it("a refusal or an ambiguous send is kept the same way: back in the box, id kept", () => {
        const drafts = createSendDrafts();
        const draft = { input: "Refused", userMessageId: drafts.idFor(a, "Refused") };
        expect(drafts.settle(a, draft, failed)).toBe("restore");
        expect(drafts.idFor(a, "Refused")).toBe(draft.userMessageId);
        // A second refusal of the retry keeps the same id again.
        expect(drafts.settle(a, draft, failed)).toBe("restore");
        expect(drafts.idFor(a, "Refused")).toBe(draft.userMessageId);
    });

    it("a draft is not placed over text the user typed meanwhile; it waits for an empty composer on that chat", () => {
        const drafts = createSendDrafts();
        const draft = { input: "Late failure", userMessageId: drafts.idFor(a, "Late failure") };
        expect(drafts.settle(a, draft, { ...failed, composerEmpty: false })).toBe("keep");
        expect(drafts.takeUnplaced(b)).toBeUndefined();
        expect(drafts.takeUnplaced(a)).toEqual(draft);
        // Placed once.
        expect(drafts.takeUnplaced(a)).toBeUndefined();
        expect(drafts.idFor(a, "Late failure")).toBe(draft.userMessageId);
    });

    it("a draft of a chat no longer selected waits until the user returns to that chat", () => {
        const drafts = createSendDrafts();
        const draft = { input: "Switched away", userMessageId: drafts.idFor(a, "Switched away") };
        expect(drafts.settle(a, draft, { ...failed, selected: false })).toBe("keep");
        expect(drafts.takeUnplaced(b)).toBeUndefined();
        expect(drafts.takeUnplaced(a)).toEqual(draft);
        expect(drafts.takeUnplaced(a)).toBeUndefined();
    });

    it("a send in flight is not handed out as unplaced when the user switches chats", () => {
        const drafts = createSendDrafts();
        drafts.idFor(a, "In flight");
        expect(drafts.takeUnplaced(a)).toBeUndefined();
    });

    it("drafts are per chat", () => {
        const drafts = createSendDrafts();
        const first = { input: "Same text", userMessageId: drafts.idFor(a, "Same text") };
        const second = { input: "Same text", userMessageId: drafts.idFor(b, "Same text") };
        expect(first.userMessageId).not.toBe(second.userMessageId);
        expect(drafts.settle(a, first, { ...failed, selected: false })).toBe("keep");
        expect(drafts.settle(b, second, { ...failed, landed: true })).toBe("drop");
        expect(drafts.takeUnplaced(b)).toBeUndefined();
        expect(drafts.takeUnplaced(a)).toEqual(first);
    });
});
