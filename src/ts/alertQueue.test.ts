import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { alertData } from "./alert";
import { createAlertQueue, createDialogKeyGate, NEXT_DIALOG_GAP_MS, type AlertQueue } from "./alertQueue";

// The alert queue (`alertQueue.ts`), the dialog key gate, and the `alert.ts` helpers over the queue.
// One status slot (`wait`, `progress`, `toast`) that the newest replaces; every other alert is a
// dialog that waits its turn and answers only its own caller; after a dialog closes the next one
// shows `NEXT_DIALOG_GAP_MS` later (also one opened after the close), so a held key or a double
// click cannot answer it unseen. The helpers (third block) run the real `alert.ts` over a fresh
// queue per test (`stores.svelte` mocked to it).

/** The queue `alert.ts` writes to in this file: a fresh one per helper test. */
const holder = vi.hoisted(() => ({ queue: null as unknown as AlertQueue }));

vi.mock("./stores.svelte", () => ({
    // The helpers resolve the queue at each call, so every test starts from an empty one.
    alertStore: new Proxy({} as AlertQueue, { get: (_target, key) => Reflect.get(holder.queue, key) }),
}));
vi.mock("./storage/database.svelte", () => ({ getDatabase: () => ({}) }));
vi.mock("../lang", () => ({ language: { errors: {}, addCharacter: "add", chatOptions: "options" } }));

import {
    alertCardExport,
    alertChatOptions,
    alertClear,
    alertConfirm,
    alertError,
    alertErrorWait,
    alertInput,
    alertJobError,
    alertNormal,
    alertNormalWait,
    alertRequestData,
    alertSelect,
    alertToast,
    alertWait,
    doingAlert,
    openAlertDialog,
    waitAlert,
} from "./alert";

const none = { type: "none", msg: "" } as const;

/** Whether `promise` settled, after the pending microtasks ran. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | undefined> {
    let state: { value: T } | undefined;
    void promise.then((value) => {
        state = { value };
    });
    await Promise.resolve();
    await Promise.resolve();
    return state;
}

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe("alert queue", () => {
    function queue(options: { gapMs?: number } = {}) {
        const alerts = createAlertQueue({ ...none }, options);
        const published: alertData[] = [];
        alerts.subscribe((value) => {
            published.push(value);
        });
        published.length = 0;
        return { alerts, published };
    }

    it("shows two confirms one at a time and answers each caller with its own result, in order", async () => {
        const { alerts, published } = queue();
        const first = alerts.open({ type: "ask", msg: "first?" });
        const second = alerts.open({ type: "ask", msg: "second?" });
        expect(get(alerts)).toMatchObject({ type: "ask", msg: "first?" });
        expect(alerts.dialogVisible()).toBe(true);

        alerts.answer("yes");
        await expect(first.closed).resolves.toBe("yes");
        expect(await settled(second.closed)).toBeUndefined();
        // The gap: nothing is shown, the second is pending.
        expect(get(alerts)).toEqual({ type: "none", msg: "yes", dialogPending: true });
        expect(alerts.dialogVisible()).toBe(false);
        expect(alerts.hasDialogs()).toBe(true);
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS - 1);
        expect(get(alerts)).toMatchObject({ type: "none", dialogPending: true });
        await vi.advanceTimersByTimeAsync(1);
        expect(get(alerts)).toMatchObject({ type: "ask", msg: "second?" });

        alerts.answer("no");
        await expect(second.closed).resolves.toBe("no");
        expect(get(alerts)).toEqual({ type: "none", msg: "no" });
        expect(alerts.hasDialogs()).toBe(false);
        expect(published.map((value) => `${value.type}:${value.msg}`)).toEqual([
            "ask:first?",
            "none:yes",
            "ask:second?",
            "none:no",
        ]);
    });

    it("lets a wait and a progress replace each other behind a waiting dialog, which stays shown", () => {
        const { alerts, published } = queue();
        void alerts.open({ type: "ask", msg: "sure?" });
        alerts.set({ type: "wait", msg: "Loading" });
        expect(alerts.status()).toEqual({ type: "wait", msg: "Loading" });
        alerts.set({ type: "progress", msg: "Saving", submsg: "40" });
        expect(alerts.status()).toEqual({ type: "progress", msg: "Saving", submsg: "40" });
        alerts.set({ type: "wait", msg: "Loading again" });
        expect(alerts.status()).toEqual({ type: "wait", msg: "Loading again" });
        // The dialog never left the screen, and the statuses behind it were not published.
        expect(get(alerts)).toMatchObject({ type: "ask", msg: "sure?" });
        expect(published).toHaveLength(1);

        alerts.answer("yes");
        expect(get(alerts)).toEqual({ type: "wait", msg: "Loading again" });
    });

    it("never hides a waiting dialog behind a toast, which shows once the dialog closes", async () => {
        const { alerts } = queue();
        const question = alerts.open({ type: "ask", msg: "sure?" });
        alerts.set({ type: "toast", msg: "Copied" });
        expect(get(alerts)).toMatchObject({ type: "ask", msg: "sure?" });
        expect(await settled(question.closed)).toBeUndefined();

        alerts.answer("yes");
        await expect(question.closed).resolves.toBe("yes");
        expect(get(alerts)).toEqual({ type: "toast", msg: "Copied" });
    });

    it("lets a dialog supersede the status set before it, not one set after it", async () => {
        const { alerts } = queue();
        alerts.set({ type: "wait", msg: "Loading" });
        void alerts.open({ type: "normal", msg: "Done" });
        expect(alerts.status()).toBeNull();
        alerts.answer("");
        expect(get(alerts)).toEqual(none);
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);

        void alerts.open({ type: "normal", msg: "Again" });
        alerts.set({ type: "wait", msg: "Later" });
        expect(get(alerts)).toMatchObject({ type: "normal", msg: "Again" });
        alerts.answer("");
        expect(get(alerts)).toEqual({ type: "wait", msg: "Later" });
    });

    it("folds an identical notice into the last queued one, never a different one or a job failure", async () => {
        const { alerts } = queue({ gapMs: 0 });
        const failed = { message: "Network failed" } as never;
        const first = alerts.open({ type: "error", msg: "Network failed", submsg: "Check proxy" });
        const repeat = alerts.open({ type: "error", msg: "Network failed", submsg: "Check proxy", stackTrace: "x" });
        expect(repeat).toBe(first);
        const different = alerts.open({ type: "error", msg: "Network failed" });
        expect(different).not.toBe(first);
        // Only the tail folds: A, B, A stays three.
        const again = alerts.open({ type: "error", msg: "Network failed", submsg: "Check proxy" });
        expect(again).not.toBe(first);
        // Two job failures carry different debug data: neither folds, on either side.
        const job1 = alerts.open({ type: "error", msg: "Job", jobFailure: { jobId: "j1", at: 1, end: failed } });
        const job2 = alerts.open({ type: "error", msg: "Job", jobFailure: { jobId: "j2", at: 2, end: failed } });
        expect(job2).not.toBe(job1);
        const plain = alerts.open({ type: "error", msg: "Job" });
        expect(plain).not.toBe(job2);
        const jobAfterPlain = alerts.open({
            type: "error",
            msg: "Job",
            jobFailure: { jobId: "j3", at: 3, end: failed },
        });
        expect(jobAfterPlain).not.toBe(plain);
        // A question never folds.
        const ask1 = alerts.open({ type: "ask", msg: "Delete?" });
        const ask2 = alerts.open({ type: "ask", msg: "Delete?" });
        expect(ask2).not.toBe(ask1);

        const seen: string[] = [];
        while (alerts.hasDialogs()) {
            await vi.advanceTimersByTimeAsync(0);
            const value = get(alerts);
            seen.push(`${value.type}:${value.msg}:${value.submsg ?? ""}:${value.jobFailure?.jobId ?? ""}`);
            alerts.answer("");
        }
        expect(seen).toEqual([
            "error:Network failed:Check proxy:",
            "error:Network failed::",
            "error:Network failed:Check proxy:",
            "error:Job::j1",
            "error:Job::j2",
            "error:Job::",
            "error:Job::j3",
            "ask:Delete?::",
            "ask:Delete?::",
        ]);
        await expect(first.closed).resolves.toBe("");
    });

    it("removes a queued dialog on cancel without showing it, closing it with an empty answer", async () => {
        const { alerts, published } = queue();
        const first = alerts.open({ type: "ask", msg: "first?" });
        const second = alerts.open({ type: "ask", msg: "second?" });
        const third = alerts.open({ type: "normal", msg: "third" });
        second.cancel();
        await expect(second.closed).resolves.toBe("");
        expect(get(alerts)).toMatchObject({ type: "ask", msg: "first?" });
        // Cancelling it again, or after it closed, changes nothing.
        second.cancel();
        alerts.answer("yes");
        await expect(first.closed).resolves.toBe("yes");
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        expect(get(alerts)).toMatchObject({ type: "normal", msg: "third" });
        expect(published.map((value) => value.msg)).not.toContain("second?");
        third.cancel();
        await expect(third.closed).resolves.toBe("");
        expect(alerts.hasDialogs()).toBe(false);
        expect(get(alerts)).toEqual(none);
    });

    it("cancels the shown dialog like a close (the gap follows), and the last pending one during the gap at once", async () => {
        const { alerts, published } = queue();
        const first = alerts.open({ type: "ask", msg: "first?" });
        first.cancel();
        await expect(first.closed).resolves.toBe("");
        // A dialog opened during the gap after a cancel waits for it too.
        const second = alerts.open({ type: "ask", msg: "second?" });
        expect(get(alerts)).toEqual({ type: "none", msg: "", dialogPending: true });
        let idle = false;
        void alerts.idle().then(() => {
            idle = true;
        });
        second.cancel();
        await expect(second.closed).resolves.toBe("");
        // Nothing pending any more: published as such, and the idle waiters are released.
        expect(get(alerts)).toEqual(none);
        expect(alerts.hasDialogs()).toBe(false);
        expect(idle).toBe(true);
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        expect(get(alerts)).toEqual(none);
        expect(published.map((value) => `${value.type}:${!!value.dialogPending}`)).toEqual([
            "ask:false",
            "none:false",
            "none:true",
            "none:false",
        ]);
    });

    it("keeps a shown confirm unanswered when a status writer clears the status, and clears only that status", async () => {
        const { alerts } = queue();
        const question = alerts.open({ type: "ask", msg: "Overwrite?" });
        alerts.set({ type: "wait", msg: "Saving" });
        alerts.clearStatus();
        expect(get(alerts)).toMatchObject({ type: "ask", msg: "Overwrite?" });
        expect(alerts.status()).toBeNull();
        expect(await settled(question.closed)).toBeUndefined();
        // `none` with a dialog shown is that dialog's close; with none shown it clears the status.
        alerts.set({ type: "none", msg: "yes" });
        await expect(question.closed).resolves.toBe("yes");
        alerts.set({ type: "wait", msg: "Loading" });
        expect(get(alerts)).toEqual({ type: "wait", msg: "Loading" });
        alerts.set({ type: "none", msg: "" });
        expect(get(alerts)).toEqual(none);
        expect(alerts.hasDialogs()).toBe(false);
    });

    it("answers and clears by identity: a stale close or an old toast's end touches nothing newer", async () => {
        const { alerts } = queue();
        const popup = { type: "requestlogs", msg: "" } as const;
        const question = alerts.open(popup);
        const stale = { type: "ask", msg: "earlier" } as const;
        alerts.answer("", stale);
        expect(await settled(question.closed)).toBeUndefined();
        alerts.answer("", popup);
        await expect(question.closed).resolves.toBe("");

        const oldToast = { type: "toast", msg: "Copied" } as const;
        const newToast = { type: "toast", msg: "Saved" } as const;
        alerts.set(oldToast);
        alerts.set(newToast);
        // The old toast's animation ends after the new one replaced it.
        alerts.clearStatus(oldToast);
        expect(alerts.status()).toBe(newToast);
        expect(get(alerts)).toBe(newToast);
        alerts.clearStatus(newToast);
        expect(get(alerts)).toEqual(none);
    });

    it("waits the gap after every close, also for a dialog opened after the queue emptied", async () => {
        const { alerts } = queue();
        const first = alerts.open({ type: "ask", msg: "first?" });
        alerts.answer("yes");
        await first.closed;
        await vi.advanceTimersByTimeAsync(100);
        void alerts.open({ type: "select", msg: "a||b" });
        expect(get(alerts)).toMatchObject({ type: "none", dialogPending: true });
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS - 100 - 1);
        expect(alerts.dialogVisible()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(get(alerts)).toMatchObject({ type: "select", msg: "a||b" });
        // Once the gap passed with nothing queued, the next dialog shows at once.
        alerts.answer("1");
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        void alerts.open({ type: "normal", msg: "now" });
        expect(get(alerts)).toMatchObject({ type: "normal", msg: "now" });
    });

    it("resolves idle once no dialog is shown or queued; statuses do not count", async () => {
        const { alerts } = queue();
        expect(await settled(alerts.idle())).toEqual({ value: undefined });
        alerts.set({ type: "wait", msg: "Loading" });
        expect(await settled(alerts.idle())).toEqual({ value: undefined });

        void alerts.open({ type: "normal", msg: "one" });
        void alerts.open({ type: "normal", msg: "two" });
        const idle = alerts.idle();
        alerts.answer("");
        expect(await settled(idle)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        alerts.answer("");
        expect(await settled(idle)).toEqual({ value: undefined });
    });

    it("queues dialogs written with set and update, and update reads the published value", async () => {
        const { alerts } = queue({ gapMs: 0 });
        alerts.set({ type: "normal", msg: "one" });
        alerts.update((value) => ({ type: "normal", msg: `${value.msg} two` }));
        expect(get(alerts)).toMatchObject({ msg: "one" });
        alerts.update(() => ({ type: "none", msg: "" }));
        await vi.advanceTimersByTimeAsync(0);
        expect(get(alerts)).toMatchObject({ msg: "one two" });
    });
});

describe("dialog key gate", () => {
    const enter = { key: "Enter", repeat: false };
    const repeatedEnter = { key: "Enter", repeat: true };

    function gated(options: { gapMs?: number } = {}) {
        const alerts = createAlertQueue({ ...none }, options);
        return { alerts, gate: createDialogKeyGate(alerts) };
    }

    it("accepts the first Enter on a dialog shown with no key held, and nothing while no dialog is shown", () => {
        const { alerts, gate } = gated();
        expect(gate.accepts(enter)).toBe(false);
        void alerts.open({ type: "ask", msg: "sure?" });
        gate.keydown(enter);
        expect(gate.accepts(enter)).toBe(true);
        // A toast behind the dialog is no new dialog: the stroke stays accepted.
        alerts.set({ type: "toast", msg: "Copied" });
        expect(gate.accepts(enter)).toBe(true);
        // The same stroke's auto-repeat is never taken, even on a dialog shown with no key held.
        gate.keydown(repeatedEnter);
        expect(gate.accepts(repeatedEnter)).toBe(false);
        gate.keyup(enter);
        alerts.answer("yes");
        expect(gate.accepts(enter)).toBe(false);
    });

    it("rejects Enter during the gap and a held Enter's repeats on the next dialog; a new stroke answers it", async () => {
        const { alerts, gate } = gated();
        void alerts.open({ type: "ask", msg: "first?" });
        void alerts.open({ type: "ask", msg: "second?" });
        gate.keydown(enter);
        expect(gate.accepts(enter)).toBe(true);
        alerts.answer("yes");
        // The gap: the key is still down, Enter repeats.
        gate.keydown(repeatedEnter);
        expect(gate.accepts(repeatedEnter)).toBe(false);
        expect(gate.accepts(enter)).toBe(false);
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        expect(get(alerts)).toMatchObject({ type: "ask", msg: "second?" });
        // Shown while Enter was held: its repeats are rejected until the key is released.
        gate.keydown(repeatedEnter);
        expect(gate.accepts(repeatedEnter)).toBe(false);
        gate.keyup(enter);
        gate.keydown(enter);
        expect(gate.accepts(enter)).toBe(true);
    });

    it("rejects the stroke a dialog appeared during, including the keydown that opened it, and recovers from a lost keyup", () => {
        const { alerts, gate } = gated();
        // The keydown that opens the dialog (a hotkey): the dialog must not take that same event.
        gate.keydown(enter);
        void alerts.open({ type: "normal", msg: "opened by Enter" });
        expect(gate.accepts(enter)).toBe(false);
        // No keyup was seen (lost), but a later non-repeated keydown is a new stroke.
        gate.keydown(enter);
        expect(gate.accepts(enter)).toBe(true);
    });

    it("treats Escape like Enter, ignores composing keys, and forgets held keys on blur", async () => {
        const { alerts, gate } = gated();
        const escape = { key: "Escape", repeat: false };
        gate.keydown(escape);
        void alerts.open({ type: "ask", msg: "first?" });
        expect(gate.accepts(escape)).toBe(false);
        // Enter was not held when the dialog appeared: its stroke is independent of Escape's.
        gate.keydown(enter);
        expect(gate.accepts(enter)).toBe(true);
        expect(gate.accepts({ ...enter, isComposing: true })).toBe(false);
        gate.keyup(escape);
        gate.keyup(enter);
        alerts.answer("");
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);

        // Held when the window lost focus: the blur reset means the next dialog sees no key held.
        gate.keydown(escape);
        gate.reset();
        void alerts.open({ type: "ask", msg: "second?" });
        gate.keydown(escape);
        expect(gate.accepts(escape)).toBe(true);
    });
});

describe("alert helpers over the queue", () => {
    const current = () => get(holder.queue);
    /** The user answers the shown dialog as `AlertComp` does, and the gap passes. */
    async function answer(msg: string) {
        holder.queue.answer(msg);
        await vi.advanceTimersByTimeAsync(0);
    }

    beforeEach(() => {
        holder.queue = createAlertQueue({ ...none }, { gapMs: 0 });
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("resolves each awaited helper with its own dialog's answer, parsed as before, in order", async () => {
        const confirm = alertConfirm("Delete?");
        const refused = alertConfirm("Really?");
        const select = alertSelect(["Keep", "Replace"], "Which?");
        const options = alertChatOptions();
        const card = alertCardExport();
        const input = alertInput("Name?", [["a", "b"]], "default");
        const normal = alertNormalWait("Saved");
        const error = alertErrorWait("Failed");
        expect(current()).toMatchObject({ type: "ask", msg: "Delete?" });
        await answer("yes");
        expect(current()).toMatchObject({ type: "ask", msg: "Really?" });
        await answer("no");
        expect(current()).toMatchObject({ type: "select", msg: "__DISPLAY__Which?||Keep||Replace" });
        await answer("1");
        expect(current()).toMatchObject({ type: "chatOptions" });
        await answer("2");
        expect(current()).toMatchObject({ type: "cardexport" });
        await answer(JSON.stringify({ type: "png", type2: "charxJpeg" }));
        expect(current()).toMatchObject({
            type: "input",
            msg: "Name?",
            datalist: [["a", "b"]],
            defaultValue: "default",
        });
        await answer("typed");
        expect(current()).toMatchObject({ type: "normal", msg: "Saved" });
        await answer("");
        expect(current()).toMatchObject({ type: "wait2", msg: "Failed" });
        await answer("");
        await expect(confirm).resolves.toBe(true);
        await expect(refused).resolves.toBe(false);
        await expect(select).resolves.toBe("1");
        await expect(options).resolves.toBe(2);
        await expect(card).resolves.toEqual({ type: "png", type2: "charxJpeg" });
        await expect(input).resolves.toBe("typed");
        await expect(normal).resolves.toBeUndefined();
        await expect(error).resolves.toBeUndefined();
        expect(current()).toEqual(none);
    });

    it("keeps a shown confirm unanswered through a status writer's wait and alertClear", async () => {
        alertWait("Loading");
        const question = alertConfirm("Overwrite?");
        alertWait("Saving");
        alertClear();
        expect(current()).toMatchObject({ type: "ask", msg: "Overwrite?" });
        expect(await settled(question)).toBeUndefined();
        await answer("yes");
        await expect(question).resolves.toBe(true);
        expect(current()).toEqual(none);
    });

    it("counts a shown or pending dialog and a progress overlay in doingAlert, not a wait or a toast", async () => {
        expect(doingAlert()).toBe(false);
        alertWait("Loading");
        expect(doingAlert()).toBe(false);
        alertToast("Copied");
        expect(doingAlert()).toBe(false);
        holder.queue.set({ type: "progress", msg: "Saving", submsg: "10" });
        expect(doingAlert()).toBe(true);
        alertClear();
        expect(doingAlert()).toBe(false);
        void alertConfirm("One?");
        void alertConfirm("Two?");
        expect(doingAlert()).toBe(true);
        holder.queue.answer("yes");
        // The gap: no dialog is shown, one is pending.
        expect(current().type).toBe("none");
        expect(doingAlert()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(current()).toMatchObject({ type: "ask", msg: "Two?" });
        await answer("yes");
        expect(doingAlert()).toBe(false);
    });

    it("waits in waitAlert for every queued dialog", async () => {
        void alertConfirm("One?");
        void alertConfirm("Two?");
        let done = false;
        void waitAlert().then(() => {
            done = true;
        });
        await answer("yes");
        expect(done).toBe(false);
        await answer("yes");
        expect(done).toBe(true);
    });

    it("shows each queued requestdata dialog with its own generation info and message copy", async () => {
        const info = (id: string) => ({
            genInfo: { generationId: id, model: `model-${id}` } as never,
            idx: Number(id.slice(-1)),
            message: { chatId: `message-${id}`, data: `text ${id}`, role: "char" } as never,
        });
        alertRequestData(info("gen1"));
        alertRequestData(info("gen2"));
        expect(current()).toMatchObject({
            type: "requestdata",
            msg: "gen1",
            generationInfo: { idx: 1, genInfo: { generationId: "gen1" }, message: { chatId: "message-gen1" } },
        });
        await answer("");
        expect(current()).toMatchObject({
            type: "requestdata",
            msg: "gen2",
            generationInfo: { idx: 2, genInfo: { generationId: "gen2" }, message: { chatId: "message-gen2" } },
        });
        await answer("");
        expect(current()).toEqual(none);
    });

    it("hands the job channel the handle of the dialog a helper opened, none for a status, the shared one for a fold", async () => {
        const toast = openAlertDialog(() => alertToast("now"));
        expect(toast).toEqual({ value: undefined, dialog: null });
        const confirm = openAlertDialog(() => alertConfirm("sure?"));
        expect(confirm.dialog).not.toBeNull();
        expect(current()).toMatchObject({ type: "ask", msg: "sure?" });
        // A nested capture does not leak into the outer one.
        const error = openAlertDialog(() => alertError("broke"));
        const folded = openAlertDialog(() => alertError("broke"));
        expect(folded.dialog).toBe(error.dialog);
        // Two job failures with the same message are two dialogs.
        const job = openAlertDialog(() => alertJobError("j1", { message: "broke" } as never, 1));
        const otherJob = openAlertDialog(() => alertJobError("j2", { message: "broke" } as never, 2));
        expect(job.dialog).not.toBe(otherJob.dialog);
        expect(job.dialog).not.toBe(error.dialog);

        confirm.dialog!.cancel();
        await expect(confirm.dialog!.closed).resolves.toBe("");
        await expect(confirm.value).resolves.toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(current()).toMatchObject({ type: "error", msg: "broke" });
        await answer("");
        await expect(error.dialog!.closed).resolves.toBe("");
        expect(current()).toMatchObject({ type: "error", msg: "broke", jobFailure: { jobId: "j1" } });
        await answer("");
        expect(current()).toMatchObject({ type: "error", msg: "broke", jobFailure: { jobId: "j2" } });
        await answer("");
        expect(current()).toEqual(none);
        // A helper outside a capture opens its dialog all the same.
        alertNormal("plain");
        expect(current()).toMatchObject({ type: "normal", msg: "plain" });
    });
});
