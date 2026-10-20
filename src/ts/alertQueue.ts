import { writable, type Readable } from "svelte/store";
import type { alertData } from "./alert";

/** Loading, progress and toast: one status slot, the newest replaces it. */
const STATUS_TYPES: ReadonlySet<alertData["type"]> = new Set(["wait", "progress", "toast"]);
/** Notices without an answer, where an identical copy right behind adds nothing. */
const REPEATABLE_TYPES: ReadonlySet<alertData["type"]> = new Set(["normal", "error", "markdown", "wait2"]);
/**
 * After a dialog closes, the next one waits this long (also one opened after the close, such as a job's
 * next question), so a double click or a repeated key cannot answer it unseen.
 */
export const NEXT_DIALOG_GAP_MS = 150;

/** One queued dialog: `closed` resolves with the `msg` it closes with ("" when cancelled). */
export interface AlertDialog {
    closed: Promise<string>;
    /** Removes the dialog whether shown or queued, closing it with ""; nothing once it closed. */
    cancel(): void;
}

export interface AlertQueue extends Readable<alertData> {
    /**
     * Status types replace the status; `none` closes the shown dialog with its `msg` (the dialog's own
     * close, kept for compatibility) or, with no dialog shown, clears the status; other types queue a dialog.
     */
    set(value: alertData): void;
    update(change: (value: alertData) => alertData): void;
    /** Queues a dialog. An identical notice right behind the last queued one returns that one's handle. */
    open(value: alertData): AlertDialog;
    /** Closes the shown dialog with `msg`, only while `expected` (when given) is the one shown. */
    answer(msg: string, expected?: alertData): void;
    /** Clears the status slot, only while `expected` (when given) is the status. A dialog stays. */
    clearStatus(expected?: alertData): void;
    /** The status slot (`wait`, `progress`, `toast`), shown or held behind a dialog, or null. */
    status(): alertData | null;
    /** Resolves once no dialog is shown or queued. */
    idle(): Promise<void>;
    dialogVisible(): boolean;
    /** A dialog is shown, or queued (waiting for the gap). */
    hasDialogs(): boolean;
}

type Entry = { data: alertData; handle: AlertDialog; settle(msg: string): void };

function sameNotice(a: alertData, b: alertData): boolean {
    return (
        a.type === b.type &&
        a.msg === b.msg &&
        (a.submsg ?? "") === (b.submsg ?? "") &&
        // Two job failures with the same message carry different debug data.
        a.jobFailure === undefined &&
        b.jobFailure === undefined
    );
}

/**
 * The alert screen slot. Loading, progress and toast form a status that the next status replaces;
 * every other alert is a dialog that waits its turn (first in, first out) and answers only its own
 * caller. A dialog supersedes the status set before it, not one set after it. Ported from RisuNest's
 * `alertQueue.ts`, with a cancel per dialog and the gap also before a dialog opened after the close.
 */
export function createAlertQueue(initial: alertData, options: { gapMs?: number } = {}): AlertQueue {
    const gapMs = options.gapMs ?? NEXT_DIALOG_GAP_MS;
    const dialogs: Entry[] = [];
    let status: alertData | null = null;
    let headVisible = false;
    let gapTimer: ReturnType<typeof setTimeout> | null = null;
    let idleWaiters: (() => void)[] = [];
    let current = initial;
    const store = writable(initial);

    function show(value: alertData) {
        if (value === current) {
            return;
        }
        if (
            value.type === "none" &&
            current.type === "none" &&
            !!value.dialogPending === !!current.dialogPending &&
            value.msg === current.msg
        ) {
            return;
        }
        current = value;
        store.set(value);
    }
    function publish(closedMsg = "") {
        if (headVisible) {
            show(dialogs[0].data);
        } else if (gapTimer && dialogs.length > 0) {
            show({ type: "none", msg: closedMsg, dialogPending: true });
        } else {
            show(status ?? { type: "none", msg: closedMsg });
        }
    }
    function endGap() {
        gapTimer = null;
        headVisible = dialogs.length > 0;
        publish();
    }
    function releaseIdle() {
        if (dialogs.length > 0) {
            return;
        }
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }
    /** Removes `entry` (the shown head or a queued one) and settles it with `msg`. */
    function remove(entry: Entry, msg: string) {
        const index = dialogs.indexOf(entry);
        if (index === -1) {
            return;
        }
        const wasShown = index === 0 && headVisible;
        dialogs.splice(index, 1);
        if (wasShown) {
            headVisible = false;
            if (gapTimer) {
                clearTimeout(gapTimer);
            }
            gapTimer = setTimeout(endGap, gapMs);
        }
        releaseIdle();
        publish(msg);
        entry.settle(msg);
    }
    function open(value: alertData): AlertDialog {
        // A dialog supersedes the status set before it, as a result replaces its loading overlay.
        status = null;
        const last = dialogs.at(-1);
        if (last && REPEATABLE_TYPES.has(value.type) && sameNotice(last.data, value)) {
            publish();
            return last.handle;
        }
        let settle!: (msg: string) => void;
        const closed = new Promise<string>((resolve) => {
            settle = resolve;
        });
        const entry: Entry = {
            data: value,
            settle,
            handle: { closed, cancel: () => remove(entry, "") },
        };
        dialogs.push(entry);
        if (!headVisible && !gapTimer) {
            headVisible = true;
        }
        publish();
        return entry.handle;
    }
    function answer(msg: string, expected?: alertData) {
        if (!headVisible || (expected !== undefined && dialogs[0].data !== expected)) {
            return;
        }
        remove(dialogs[0], msg);
    }
    function set(value: alertData) {
        if (value.type === "none") {
            if (headVisible) {
                answer(value.msg);
            } else {
                status = null;
                publish(value.msg);
            }
        } else if (STATUS_TYPES.has(value.type)) {
            status = value;
            publish();
        } else {
            open(value);
        }
    }

    return {
        subscribe: store.subscribe,
        set,
        update: (change) => set(change(current)),
        open,
        answer,
        clearStatus(expected?: alertData) {
            if (expected !== undefined && status !== expected) {
                return;
            }
            status = null;
            publish();
        },
        status: () => status,
        idle: () =>
            dialogs.length === 0
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                      idleWaiters.push(resolve);
                  }),
        dialogVisible: () => headVisible,
        hasDialogs: () => dialogs.length > 0,
    };
}

type DialogKeyEvent = { key: string; repeat: boolean; isComposing?: boolean };

/** The keys `hotkey.ts` answers a dialog with. */
const DIALOG_KEYS = new Set(["Enter", "Escape"]);

/**
 * Keeps a held key from answering a dialog it did not see appear. Feed it every keydown and keyup
 * (window, capture phase, so no element's `stopPropagation` hides one) and a reset on blur. A dialog
 * takes Enter or Escape only from a stroke that began after it appeared: never a repeat, and never
 * the stroke that was down when it appeared (including the keydown that opened it). A later
 * non-repeated keydown is a new stroke even if its keyup was lost.
 */
export function createDialogKeyGate(queue: AlertQueue) {
    const strokes = new Map<string, number>();
    const down = new Set<string>();
    let shown: alertData | null = null;
    let heldWhenShown = new Map<string, number>();
    queue.subscribe((value) => {
        const head = queue.dialogVisible() ? value : null;
        if (head === shown) {
            return;
        }
        shown = head;
        heldWhenShown = new Map();
        if (head !== null) {
            for (const key of down) {
                heldWhenShown.set(key, strokes.get(key) ?? 0);
            }
        }
    });
    return {
        keydown(ev: DialogKeyEvent) {
            if (!DIALOG_KEYS.has(ev.key) || ev.repeat) {
                return;
            }
            strokes.set(ev.key, (strokes.get(ev.key) ?? 0) + 1);
            down.add(ev.key);
        },
        keyup(ev: { key: string }) {
            down.delete(ev.key);
        },
        reset() {
            down.clear();
        },
        /** Whether this keydown may answer the dialog shown now. */
        accepts(ev: DialogKeyEvent): boolean {
            return (
                shown !== null &&
                !ev.repeat &&
                !ev.isComposing &&
                heldWhenShown.get(ev.key) !== (strokes.get(ev.key) ?? 0)
            );
        },
    };
}
