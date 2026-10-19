import { settings } from "./storage/settingsViews.svelte";
import { get, readonly, writable } from "svelte/store";
import { sleep } from "./util";
import { language } from "../lang";
import { type MessageGenerationInfo } from "./storage/database.svelte";
import { alertStore as alertStoreImported } from "./stores.svelte";
import type { GenerationTerminalEvent } from "../../shared/jobs.ts";

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
        | "requestlogs";
    msg: string;
    submsg?: string;
    datalist?: [string, string][];
    stackTrace?: string;
    defaultValue?: string;
    /** `error`: a server job's failure (`alertJobError`): "Copy debug info" and "Open in request history". */
    jobFailure?: JobFailureInfo;
    /** `requestlogs`: the job the request history opens filtered to. */
    jobId?: string;
}

type AlertGenerationInfoStoreData = {
    genInfo: MessageGenerationInfo;
    idx: number;
};
export const alertGenerationInfoStore = writable<AlertGenerationInfoStoreData>(null);
export const alertStore = {
    set: (d: alertData) => {
        alertStoreImported.set(d);
    },
};

export function alertError(msg: string | Error) {
    const data = errorAlert(msg);
    if (data) {
        alertStoreImported.set(data);
    }
}

/**
 * A server job's error (`docs/plan/request-history-diagnostics.md` slice 6): the message as
 * `alertError` shows it, with the job's failure fields for the alert's debug actions. `at`: when the
 * tab received the job's end.
 */
export function alertJobError(jobId: string, end: JobFailureInfo["end"], at: number = Date.now()) {
    const data = errorAlert(end.message);
    if (data) {
        alertStoreImported.set({ ...data, jobFailure: { jobId, at, end } });
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

export async function waitAlert() {
    while (true) {
        if (get(alertStoreImported).type === "none") {
            break;
        }
        await sleep(10);
    }
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
    alertStoreImported.set({
        type: "normal",
        msg: msg,
    });
}

export async function alertNormalWait(msg: string) {
    alertStoreImported.set({
        type: "normal",
        msg: msg,
    });
    await waitAlert();
}

export async function alertAddCharacter() {
    alertStoreImported.set({
        type: "addchar",
        msg: language.addCharacter,
    });
    await waitAlert();

    return get(alertStoreImported).msg;
}

export async function alertChatOptions() {
    alertStoreImported.set({
        type: "chatOptions",
        msg: language.chatOptions,
    });
    await waitAlert();

    return parseInt(get(alertStoreImported).msg);
}

export async function alertSelect(msg: string[], display?: string) {
    const message = display !== undefined ? `__DISPLAY__${display}||${msg.join("||")}` : msg.join("||");
    alertStoreImported.set({
        type: "select",
        msg: message,
    });

    await waitAlert();

    return get(alertStoreImported).msg;
}

export async function alertErrorWait(msg: string) {
    alertStoreImported.set({
        type: "wait2",
        msg: msg,
    });
    await waitAlert();
}

export function alertMd(msg: string) {
    alertStoreImported.set({
        type: "markdown",
        msg: msg,
    });
}

export function doingAlert() {
    return (
        get(alertStoreImported).type !== "none" &&
        get(alertStoreImported).type !== "toast" &&
        get(alertStoreImported).type !== "wait"
    );
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

export function alertClear() {
    alertStoreImported.set({
        type: "none",
        msg: "",
    });
}

export async function alertSelectChar() {
    alertStoreImported.set({
        type: "selectChar",
        msg: "",
    });

    await waitAlert();

    return get(alertStoreImported).msg;
}

export async function alertConfirm(msg: string) {
    alertStoreImported.set({
        type: "ask",
        msg: msg,
    });

    await waitAlert();

    return get(alertStoreImported).msg === "yes";
}

export async function alertPluginConfirm(msg: string) {
    alertStoreImported.set({
        type: "pluginconfirm",
        msg: msg,
    });

    await waitAlert();

    return get(alertStoreImported).msg === "yes";
}

export async function alertCardExport() {
    alertStoreImported.set({
        type: "cardexport",
        msg: "",
    });

    await waitAlert();

    return JSON.parse(get(alertStoreImported).msg) as {
        type: string;
        type2: string;
    };
}

export async function alertInput(msg: string, datalist?: [string, string][], defaultValue?: string) {
    alertStoreImported.set({
        type: "input",
        msg: msg,
        datalist: datalist ?? [],
        defaultValue: defaultValue ?? "",
    });

    await waitAlert();

    return get(alertStoreImported).msg;
}

export async function alertModuleSelect() {
    alertStoreImported.set({
        type: "selectModule",
        msg: "",
    });

    while (true) {
        if (get(alertStoreImported).type === "none") {
            break;
        }
        await sleep(20);
    }

    return get(alertStoreImported).msg;
}

export function alertRequestData(info: AlertGenerationInfoStoreData) {
    alertGenerationInfoStore.set(info);
    alertStoreImported.set({
        type: "requestdata",
        msg: info.genInfo.generationId ?? "none",
    });
}

export function showHypaV2Alert() {
    alertStoreImported.set({
        type: "hypaV2",
        msg: "",
    });
}

/** The request logs popup; `filter.jobId` opens the server's history filtered to that job. */
export function alertRequestLogs(filter: { jobId?: string | null } = {}) {
    alertStoreImported.set({
        type: "requestlogs",
        msg: "",
        ...(filter.jobId ? { jobId: filter.jobId } : {}),
    });
}
