import { settings } from "./storage/settingsViews.svelte";
import { get, readonly, writable } from "svelte/store";
import { language } from "../lang";
import type { Message, MessageGenerationInfo } from "./storage/database.svelte";
import { alertStore as alertStoreImported } from "./stores.svelte";
import type { AlertDialog } from "./alertQueue";
import type { DeepReadonly } from "../../shared/readonly.ts";
import type { GenerationTerminalEvent } from "../../shared/jobs.ts";
import type { UpstreamImportReport } from "../../shared/upstreamBackup.ts";

/** A server job's failure as the tab received it, for the error alert's debug actions. */
export type JobFailureInfo = {
    jobId: string;
    /** When the tab received the job's end (ms). */
    at: number;
    end: Extract<GenerationTerminalEvent, { type: "error" }>;
};

export interface alertData {
    type:
        | "error"
        | "normal"
        | "none"
        | "ask"
        | "wait"
        | "selectChar"
        | "input"
        | "toast"
        | "wait2"
        | "markdown"
        | "select"
        | "cardexport"
        | "requestdata"
        | "addchar"
        | "hypaV2"
        | "selectModule"
        | "chatOptions"
        | "pukmakkurit"
        | "branches"
        | "progress"
        | "pluginconfirm"
        | "requestlogs"
        | "upstreamImportReport";
    msg: string;
    submsg?: string;
    datalist?: [string, string][];
    stackTrace?: string;
    defaultValue?: string;
    /** `error`: a server job's failure (`alertJobError`): "Copy debug info" and "Open in request history". */
    jobFailure?: JobFailureInfo;
    /** `requestlogs`: the job the request history opens filtered to. */
    jobId?: string;
    /** `requestdata`: the generation and the message it shows, captured when it was opened. */
    generationInfo?: AlertGenerationInfo;
    /** `none` between two dialogs: the next one is queued and shows after the gap (`alertQueue.ts`). */
    dialogPending?: boolean;
}

type AlertGenerationInfo = {
    genInfo: MessageGenerationInfo;
    idx: number;
    /**
     * The message as it was when the dialog was opened (a plain copy): the dialog may wait behind
     * another one, and the chat may change or unload meanwhile.
     */
    message?: DeepReadonly<Message>;
};
/**
 * Writes to the alert slot (`stores.svelte.ts`): status types (`wait`, `progress`, `toast`) replace
 * the status, other types queue a dialog, and `none` closes the dialog shown (its own close only; a
 * status writer ends its status with `alertClear`).
 */
export const alertStore = {
    set: (d: alertData) => {
        alertStoreImported.set(d);
    },
};

/** The dialog handles opened while `openAlertDialog` runs its callback. */
let capturing: AlertDialog[] | null = null;

/** Queues `data` as a dialog; resolves with the `msg` it closes with. */
function openDialog(data: alertData): Promise<string> {
    const dialog = alertStoreImported.open(data);
    capturing?.push(dialog);
    return dialog.closed;
}

/**
 * For the job channel: runs `open` (one alert helper call, which queues its dialog synchronously)
 * and returns what it returned with the handle of the dialog it opened (null when it opened none), to
 * await that dialog's own close or to cancel it (shown or queued; it closes with ""). A notice that
 * folds into an identical one queued right before it shares that dialog's handle.
 */
export function openAlertDialog<T>(open: () => T): { value: T; dialog: AlertDialog | null } {
    const outer = capturing;
    const opened: AlertDialog[] = [];
    capturing = opened;
    try {
        const value = open();
        return { value, dialog: opened[0] ?? null };
    } finally {
        capturing = outer;
    }
}

export function alertError(msg: string | Error) {
    const data = errorAlert(msg);
    if (data) {
        void openDialog(data);
    }
}

/**
 * A server job's error: the message as `alertError` shows it, with the job's failure fields for the
 * alert's debug actions. `at`: when the tab received the job's end.
 */
export function alertJobError(jobId: string, end: JobFailureInfo["end"], at: number = Date.now()) {
    const data = errorAlert(end.message);
    if (data) {
        void openDialog({ ...data, jobFailure: { jobId, at, end } });
    }
}

/** The `error` alert of `msg` (known errors get their hint), or null for one that is not shown. */
function errorAlert(msg: string | Error): alertData | null {
    console.error(msg);

    let stackTrace: string | undefined = undefined;

    if (typeof msg !== "string") {
        try {
            if (msg instanceof Error) {
                stackTrace = msg.stack;
                msg = msg.message;
            } else {
                msg = JSON.stringify(msg);
            }
        } catch {
            msg = `${msg}`;
        }
    }

    msg = msg.trim();

    const ignoredErrors = ["{}"];

    if (ignoredErrors.includes(msg)) {
        return null;
    }

    let submsg = "";

    //check if it's a known error
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError when attempting to fetch resource.")) {
        submsg = settings.providers.usePlainFetch ? language.errors.networkFetchPlain : language.errors.networkFetch;
    }

    return {
        type: "error",
        msg: msg,
        submsg: submsg,
        stackTrace: stackTrace,
    };
}

/** Resolves once no dialog is shown or queued (statuses do not count). */
export async function waitAlert() {
    await alertStoreImported.idle();
}

/**
 * The notice the page ends on (a restore replaced the server data, and the page reloads once it is
 * acknowledged): a modal dialog (`TerminalNotice.svelte`) above every other alert and overlay. No
 * other alert replaces or clears it, and Escape does not close it; only its own OK acknowledges it.
 */
const terminalNoticeStore = writable<string | null>(null);
export const terminalNotice = readonly(terminalNoticeStore);
let terminalPending: Promise<void> | null = null;
let acknowledgeTerminal: (() => void) | null = null;

/**
 * Shows `msg` as the terminal notice; resolves once the user acknowledges it. Single-flight: while a
 * notice is shown, another call keeps it and returns the same promise.
 */
export function alertTerminal(msg: string): Promise<void> {
    terminalPending ??= new Promise((resolve) => {
        acknowledgeTerminal = () => {
            acknowledgeTerminal = null;
            terminalPending = null;
            terminalNoticeStore.set(null);
            resolve();
        };
        terminalNoticeStore.set(msg);
    });
    return terminalPending;
}

/**
 * Whether a terminal notice is shown (set and cleared with it, synchronously). A plugin's
 * document key listeners read it at event time: a capture-phase listener runs before the notice's
 * own `stopPropagation`, so it would otherwise see the keys typed into the notice.
 */
export function terminalNoticeShown(): boolean {
    return terminalPending !== null;
}

/** Acknowledges the terminal notice (its OK button); nothing when none is shown. */
export function acknowledgeTerminalNotice() {
    acknowledgeTerminal?.();
}

/**
 * The save adapter's "another tab or device changed this data, your change was replaced" notice: a
 * panel (`ReloadNotice.svelte`) outside `alertStore`, so no other alert (a progress `wait`, a
 * toast, an error, `alertClear`) replaces or hides it. It stays until the user dismisses it.
 */
const reloadNoticeStore = writable<string | null>(null);
export const reloadNotice = readonly(reloadNoticeStore);

/**
 * Shows `msg` as the reload notice. Latched until dismissed: while a notice is shown, another call
 * keeps it (one notice per episode on screen); after `dismissReloadNotice`, the next call shows it
 * again.
 */
export function alertReloadNotice(msg: string) {
    if (get(reloadNoticeStore) === null) {
        reloadNoticeStore.set(msg);
    }
}

/** Dismisses the reload notice (its OK button); nothing when none is shown. */
export function dismissReloadNotice() {
    reloadNoticeStore.set(null);
}

export function alertNormal(msg: string) {
    void openDialog({
        type: "normal",
        msg: msg,
    });
}

export async function alertNormalWait(msg: string) {
    await openDialog({
        type: "normal",
        msg: msg,
    });
}

export async function alertAddCharacter() {
    return await openDialog({
        type: "addchar",
        msg: language.addCharacter,
    });
}

export async function alertChatOptions() {
    const result = await openDialog({
        type: "chatOptions",
        msg: language.chatOptions,
    });

    return parseInt(result);
}

export async function alertSelect(msg: string[], display?: string) {
    const message = display !== undefined ? `__DISPLAY__${display}||${msg.join("||")}` : msg.join("||");
    return await openDialog({
        type: "select",
        msg: message,
    });
}

export async function alertErrorWait(msg: string) {
    await openDialog({
        type: "wait2",
        msg: msg,
    });
}

export function alertMd(msg: string) {
    void openDialog({
        type: "markdown",
        msg: msg,
    });
}

/**
 * Whether an alert blocks the screen: a dialog shown or queued (also during the gap between two),
 * or a progress overlay. A loading `wait` or a toast does not.
 */
export function doingAlert() {
    return alertStoreImported.hasDialogs() || get(alertStoreImported).type === "progress";
}

export function alertToast(msg: string) {
    alertStoreImported.set({
        type: "toast",
        msg: msg,
    });
}

export function alertWait(msg: string) {
    alertStoreImported.set({
        type: "wait",
        msg: msg,
    });
}

/** Clears the status (a `wait`, `progress` or toast); a dialog shown or queued stays. */
export function alertClear() {
    alertStoreImported.clearStatus();
}

export async function alertSelectChar() {
    return await openDialog({
        type: "selectChar",
        msg: "",
    });
}

export async function alertConfirm(msg: string) {
    const result = await openDialog({
        type: "ask",
        msg: msg,
    });

    return result === "yes";
}

export async function alertPluginConfirm(msg: string) {
    const result = await openDialog({
        type: "pluginconfirm",
        msg: msg,
    });

    return result === "yes";
}

export async function alertCardExport() {
    const result = await openDialog({
        type: "cardexport",
        msg: "",
    });

    return JSON.parse(result) as {
        type: string;
        type2: string;
    };
}

export async function alertInput(msg: string, datalist?: [string, string][], defaultValue?: string) {
    return await openDialog({
        type: "input",
        msg: msg,
        datalist: datalist ?? [],
        defaultValue: defaultValue ?? "",
    });
}

export async function alertModuleSelect() {
    return await openDialog({
        type: "selectModule",
        msg: "",
    });
}

/** The generation info of a message; the dialog renders from its own copy of `info`. */
export function alertRequestData(info: AlertGenerationInfo) {
    void openDialog({
        type: "requestdata",
        msg: info.genInfo.generationId ?? "none",
        generationInfo: info,
    });
}

export function showHypaV2Alert() {
    void openDialog({
        type: "hypaV2",
        msg: "",
    });
}

/** The report `alertUpstreamImportReport` shows (`UpstreamImportReport.svelte`), null when none is shown. */
export const upstreamImportReportStore = writable<{
    report: UpstreamImportReport;
    changedWrites: number | null;
    answer(restore: boolean): void;
} | null>(null);

/**
 * Shows a prepared upstream RisuAI import's report with its full-replace warning; resolves true when
 * the user chose Restore, false for Cancel (or any other way the dialog closed). Only the dialog's own
 * `answer` authorizes the restore; the message it closes with (another caller's "yes") never does.
 */
export async function alertUpstreamImportReport(
    report: UpstreamImportReport,
    options: { changedWrites?: number } = {},
): Promise<boolean> {
    let restore = false;
    const dialog = {
        report,
        changedWrites: options.changedWrites ?? null,
        answer: (value: boolean) => {
            restore = value;
        },
    };
    upstreamImportReportStore.set(dialog);
    try {
        await openDialog({
            type: "upstreamImportReport",
            msg: "",
        });
    } finally {
        if (get(upstreamImportReportStore) === dialog) {
            upstreamImportReportStore.set(null);
        }
    }
    return restore;
}

/** The request logs popup; `filter.jobId` opens the server's history filtered to that job. */
export function alertRequestLogs(filter: { jobId?: string | null } = {}) {
    void openDialog({
        type: "requestlogs",
        msg: "",
        ...(filter.jobId ? { jobId: filter.jobId } : {}),
    });
}
