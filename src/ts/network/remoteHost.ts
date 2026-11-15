import { get, readonly, writable } from "svelte/store";
import {
    MAX_REMOTE_COMMAND_BODY_BYTES,
    REMOTE_COMMAND_OPEN_DROP_MS,
    REMOTE_COMMAND_STATES,
    REMOTE_COMMANDS_PATH,
    type RemoteCommandFrameState,
    type RemoteCommandReadAnswer,
    type RemoteCommandRefusalCode,
    type RemoteCommandStateAnswer,
    type RemoteCommandStateBody,
    type RemoteSendResult,
    type SendReport,
} from "../../../shared/remoteCommands.ts";
import type { EventFeedFrame } from "../../../shared/events.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { preference } from "./handoff";

/** Device-local host preference, including changes made by another tab in this browser. */
export const hostMode = preference<boolean>("risu-remote-host", false);

export type HostCommandEntry = {
    commandId: string;
    type: string;
    state: RemoteCommandFrameState;
    code?: string;
    at: number;
};

const commands = writable<readonly HostCommandEntry[]>([]);
export const hostCommandLog = readonly(commands);

/** Keep the ten newest command statuses, replacing a command's previous entry. */
export function noteHostCommand(entry: HostCommandEntry): void {
    commands.update((current) =>
        [{ ...entry }, ...current.filter((held) => held.commandId !== entry.commandId)]
            .sort((a, b) => b.at - a.at)
            .slice(0, 10),
    );
}

/**
 * Commands contain no composer state. Each run owns its abort controller before its first await;
 * duplicate frames only stop it or repeat its latest report. HTTP bodies and state reports carry
 * the loaded epoch and the read's attempt. Plugin, send and selection modules load only inside a
 * run, keeping the feed's imports free of the send/job-channel and plugin/feed cycles.
 */
const SAVED_COMMANDS_KEY = "risu-remote-host-commands";
const REQUEST_DEADLINE_MS = 15_000;
const REPORT_MARGIN_BYTES = 4096;
type SavedCommand = { commandId: string; epoch: string; attempt: number };
type StateReport =
    | { state: "running" }
    | { state: "uncertain" | "done"; result?: RemoteSendResult }
    | { state: "refused"; code: RemoteCommandRefusalCode };
type PreparedReport = { report: StateReport; body: string };
type Transport = Awaited<ReturnType<typeof loadTransport>>;
type Reporter = {
    saved: SavedCommand;
    transport: Transport;
    controller?: AbortController;
    latest?: PreparedReport;
    queued?: PreparedReport;
    pumping?: Promise<void>;
    wake?: () => void;
    stopped: boolean;
    expiresAt: number;
};
type HostRun = {
    commandId: string;
    epoch: string;
    controller: AbortController;
    reporter?: Reporter;
};
const runs = new Map<string, HostRun>();
const recoveries = new Map<string, Promise<void>>();
const recoveredEpochs = new Set<string>();
let epochHalted = false;

async function loadTransport() {
    const [{ authFetch }, jobs] = await Promise.all([import("../storage/serverAuth"), import("./generationJobs")]);
    return { authFetch, jobs, clientId: jobs.generationClientId() };
}

function savedCommands(): SavedCommand[] {
    try {
        const entries: unknown = JSON.parse(sessionStorage.getItem(SAVED_COMMANDS_KEY) ?? "[]");
        if (!Array.isArray(entries)) return [];
        return entries.filter(
            (entry): entry is SavedCommand =>
                entry !== null &&
                typeof entry === "object" &&
                typeof entry.commandId === "string" &&
                typeof entry.epoch === "string" &&
                Number.isSafeInteger(entry.attempt) &&
                entry.attempt > 0,
        );
    } catch {
        return [];
    }
}

function writeSaved(entries: SavedCommand[]) {
    try {
        if (entries.length) sessionStorage.setItem(SAVED_COMMANDS_KEY, JSON.stringify(entries));
        else sessionStorage.removeItem(SAVED_COMMANDS_KEY);
    } catch {
        // Storage can be unavailable; the live run still reports its outcome.
        console.warn("[Remote host] Could not persist command ids");
    }
}

function rememberCommand(saved: SavedCommand) {
    writeSaved([...savedCommands().filter((entry) => entry.commandId !== saved.commandId), saved]);
}

function forgetCommand(saved: SavedCommand) {
    writeSaved(
        savedCommands().filter(
            (entry) =>
                entry.commandId !== saved.commandId || entry.epoch !== saved.epoch || entry.attempt !== saved.attempt,
        ),
    );
}

function noteState(commandId: string, state: RemoteCommandFrameState, code?: string) {
    noteHostCommand({ commandId, type: "send", state, ...(code ? { code } : {}), at: Date.now() });
}

function reporterFor(saved: SavedCommand, transport: Transport, controller?: AbortController): Reporter {
    return { saved, transport, controller, stopped: false, expiresAt: Date.now() + REMOTE_COMMAND_OPEN_DROP_MS };
}

/** A stop cancels the send, never the read or the state report needed to account for it. */
async function relayRequest(transport: Transport, epoch: string, path: string, body?: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
    try {
        const response = await transport.authFetch(path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                [RESOURCE_EPOCH_HEADER]: epoch,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            cache: "no-store",
            signal: controller.signal,
            ...(body === undefined ? {} : { body }),
        });
        const answer = await response.json().catch(() => null);
        if (response.status === 412) {
            epochHalted = true;
            for (const run of runs.values()) run.controller.abort();
            throw epochMismatch(typeof answer?.epoch === "string" ? answer.epoch : "");
        }
        return { response, answer };
    } finally {
        clearTimeout(timeout);
    }
}

/** Keep all outcome fields and report kinds; only report text can be shortened. */
function prepareReport(reporter: Reporter, report: StateReport): PreparedReport | null {
    const copy = structuredClone(report);
    const body: RemoteCommandStateBody = {
        clientId: reporter.transport.clientId,
        attempt: reporter.saved.attempt,
        ...copy,
    };
    const encoder = new TextEncoder();
    const limit = MAX_REMOTE_COMMAND_BODY_BYTES - REPORT_MARGIN_BYTES;
    let json = JSON.stringify(body);
    while (encoder.encode(json).byteLength > limit) {
        const result = "result" in copy ? copy.result : undefined;
        if (!result) return null;
        result.truncated = true;
        const longest = result.reports.reduce<SendReport | undefined>(
            (held, report) =>
                !held || encoder.encode(report.text).byteLength > encoder.encode(held.text).byteLength ? report : held,
            undefined,
        );
        if (!longest?.text.length) return null;
        longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2));
        json = JSON.stringify(body);
    }
    return { report: copy, body: json };
}

function queueReport(reporter: Reporter, report: StateReport) {
    if (reporter.stopped || epochHalted) return;
    const prepared = prepareReport(reporter, report);
    if (!prepared) {
        // Even empty report texts cannot fit: keep the saved attempt for reload recovery.
        console.warn("[Remote host] Outcome exceeds command body limit", reporter.saved.commandId);
        reporter.stopped = true;
        reporter.queued = undefined;
        reporter.wake?.();
        return;
    }
    reporter.latest = prepared;
    repeatReport(reporter);
}

function repeatReport(reporter: Reporter) {
    if (!reporter.latest || reporter.stopped || epochHalted) return;
    reporter.queued = reporter.latest;
    reporter.wake?.();
    reporter.pumping ??= pumpReports(reporter).finally(() => {
        reporter.pumping = undefined;
        // A state can arrive after the pump's last iteration but before this microtask.
        if (reporter.queued) repeatReport(reporter);
    });
}

async function finishReports(reporter: Reporter) {
    while (reporter.pumping) await reporter.pumping;
}

function retryWait(reporter: Reporter, delay: number): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            reporter.wake = undefined;
            resolve();
        };
        const timer = setTimeout(finish, delay);
        reporter.wake = finish;
    });
}

/** One exchange at a time. A newer queued state always replaces a failed older report. */
async function pumpReports(reporter: Reporter) {
    let failures = 0;
    while (reporter.queued && !reporter.stopped && !epochHalted && reporter.saved.epoch === getResourceEpoch()) {
        if (Date.now() >= reporter.expiresAt) break;
        const current = reporter.queued;
        reporter.queued = undefined;
        try {
            const { response, answer } = await relayRequest(
                reporter.transport,
                reporter.saved.epoch,
                `${REMOTE_COMMANDS_PATH}/${encodeURIComponent(reporter.saved.commandId)}/state`,
                current.body,
            );
            if (answer?.stopRequested) reporter.controller?.abort();
            if (response.ok && answer && REMOTE_COMMAND_STATES.includes(answer.state)) {
                const accepted = answer as RemoteCommandStateAnswer;
                noteState(
                    reporter.saved.commandId,
                    accepted.state,
                    current.report.state === "refused" ? current.report.code : undefined,
                );
                if (accepted.superseded || ["done", "uncertain", "refused"].includes(accepted.state)) {
                    forgetCommand(reporter.saved);
                    reporter.stopped = true;
                }
                failures = 0;
                continue;
            }
            if (!response.ok && response.status !== 429 && response.status < 500) {
                const state = REMOTE_COMMAND_STATES.includes(answer?.state) ? answer.state : undefined;
                if (state) noteState(reporter.saved.commandId, state);
                else if (response.status === 404 || response.status === 410)
                    noteState(reporter.saved.commandId, "forgotten");
                console.info("[Remote host] State report refused", reporter.saved.commandId, response.status);
                if (
                    response.status === 404 ||
                    response.status === 410 ||
                    (response.status === 409 && ["done", "refused", "expired", "cancelled"].includes(state))
                ) {
                    forgetCommand(reporter.saved);
                }
                // Includes 413: never retry an unchanged body rejected for its size.
                reporter.stopped = true;
                break;
            }
        } catch {
            if (epochHalted) break;
        }
        if (reporter.stopped || epochHalted) break;
        if (reporter.latest !== current) continue;
        reporter.queued = current;
        const delay = Math.min(1000 * 2 ** Math.min(failures++, 6), 30_000, reporter.expiresAt - Date.now());
        if (delay > 0) await retryWait(reporter, delay);
    }
    reporter.queued = undefined;
}

/** First same-epoch hello recovers saved attempts even with host mode now off, before registration. */
export function recoverHostCommands(epoch: string): void {
    if (epoch !== getResourceEpoch() || recoveredEpochs.has(epoch) || epochHalted) return;
    recoveredEpochs.add(epoch);
    const saved = savedCommands().filter((entry) => entry.epoch === epoch);
    writeSaved(saved);
    for (const entry of saved) {
        const recovery = (async () => {
            const transport = await loadTransport();
            const reporter = reporterFor(entry, transport);
            queueReport(reporter, { state: "uncertain" });
            await finishReports(reporter);
        })()
            .catch(() => {
                console.warn("[Remote host] Could not recover command", entry.commandId);
            })
            .finally(() => {
                recoveries.delete(entry.commandId);
            });
        recoveries.set(entry.commandId, recovery);
    }
}

/** A frame is only a wakeup; the command body is read through the authenticated HTTP relay. */
export function receiveHostCommand(frame: Extract<EventFeedFrame, { type: "remoteCommand" }>): void {
    if (!get(hostMode) || epochHalted || frame.epoch !== getResourceEpoch()) return;
    const existing = runs.get(frame.commandId);
    if (existing) {
        if (frame.stop) existing.controller.abort();
        if (existing.reporter) repeatReport(existing.reporter);
        return;
    }
    const run: HostRun = { commandId: frame.commandId, epoch: frame.epoch, controller: new AbortController() };
    runs.set(frame.commandId, run);
    if (frame.stop) run.controller.abort();
    void runHostCommand(run)
        .catch(() => {
            console.warn("[Remote host] Could not read command", run.commandId);
        })
        .finally(() => {
            runs.delete(run.commandId);
        });
}

/** Resolves promptly on stop without leaving a signal listener on the page's startup promise. */
async function pluginsReady(started: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let stop!: () => void;
    const aborted = new Promise<void>((resolve) => {
        stop = resolve;
    });
    signal.addEventListener("abort", stop, { once: true });
    try {
        await Promise.race([started(), aborted]);
    } finally {
        signal.removeEventListener("abort", stop);
    }
}

async function runHostCommand(run: HostRun) {
    await recoveries.get(run.commandId);
    if (epochHalted || run.epoch !== getResourceEpoch()) return;
    const transport = await loadTransport();
    const { response, answer } = await relayRequest(
        transport,
        run.epoch,
        `${REMOTE_COMMANDS_PATH}/${encodeURIComponent(run.commandId)}?clientId=${encodeURIComponent(transport.clientId)}`,
    );
    if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
            noteState(run.commandId, REMOTE_COMMAND_STATES.includes(answer?.state) ? answer.state : "forgotten");
        }
        console.info("[Remote host] Command read refused", run.commandId, response.status);
        return;
    }
    const read = answer as RemoteCommandReadAnswer;
    if (!read?.command || !Number.isSafeInteger(read.attempt) || read.attempt <= 0) return;
    noteState(run.commandId, "delivered");
    if (read.stopRequested) run.controller.abort();
    const saved = { commandId: run.commandId, epoch: run.epoch, attempt: read.attempt };
    const reporter = (run.reporter = reporterFor(saved, transport, run.controller));
    const reports: SendReport[] = [];
    let releasePlugins: (() => void) | undefined;
    let releaseChat: (() => void) | undefined;
    const refuse = (code: RemoteCommandRefusalCode) =>
        queueReport(reporter, read.attempted ? { state: "uncertain" } : { state: "refused", code });
    try {
        const [{ safeBootOff }, chats, characters, { isLocalSend }] = await Promise.all([
            import("../safeBoot"),
            import("../storage/chatStore.svelte"),
            import("../storage/characterStore.svelte"),
            import("../process/localSends"),
        ]);
        const { command } = read;
        const target = { chaId: command.chaId, chatId: command.chatId };
        if (run.controller.signal.aborted) return refuse("stopped");
        if (safeBootOff("plugins")) return refuse("pluginsOff");
        if (!characters.characterList().some((char) => char?.chaId === target.chaId) || !chats.chatEntry(target)) {
            return refuse("chatMissing");
        }
        if (!read.attempted && isLocalSend(target)) return refuse("busy");
        releasePlugins = transport.jobs.holdGenerationPluginWork();
        const { pluginsStarted } = await import("../plugins/plugins.svelte");
        await pluginsReady(pluginsStarted, run.controller.signal);
        if (run.controller.signal.aborted) return refuse("stopped");
        const [selection, stores, { sendChat }] = await Promise.all([
            import("../storage/selection.svelte"),
            import("../stores.svelte"),
            import("../process/index.svelte"),
        ]);
        if (epochHalted || run.epoch !== getResourceEpoch()) return;
        if (run.controller.signal.aborted) return refuse("stopped");
        releaseChat = chats.pinChat(target);
        chats.selectChat(target.chaId, target.chatId);
        selection.selectCharacter(target.chaId);
        selection.setChatOpen(true);
        stores.settingsOpen.set(false);
        stores.gridOpenStore.set(false);
        rememberCommand(saved);
        queueReport(reporter, { state: "running" });
        let refusal: RemoteSendResult["refusal"];
        let end: Omit<RemoteSendResult, "ok" | "reports"> = {
            settled: false,
            requestUncertain: true,
            outcome: "unknown",
            blockedChats: [],
        };
        const ok = await sendChat(-1, {
            target,
            input: command.input,
            inputOriginal: command.inputOriginal,
            userMessageId: command.userMessageId,
            requestId: command.requestId,
            stopOverLoreBudget: command.stopOverLoreBudget,
            signal: run.controller.signal,
            localOnly: true,
            noHandoffPreference: true,
            reports,
            ...(read.attempted ? { requestUncertain: true } : {}),
            onServerRefused: (ambiguous) => {
                refusal = ambiguous ? "ambiguous" : "definite";
            },
            onEnd: (result) => {
                end = { ...result, blockedChats: result.blockedChats.map(({ chaId, chatId }) => ({ chaId, chatId })) };
            },
        });
        const result: RemoteSendResult = { ...end, ok, ...(refusal ? { refusal } : {}), reports };
        queueReport(reporter, { state: result.settled ? "done" : "uncertain", result });
    } catch (error) {
        if (!epochHalted && run.epoch === getResourceEpoch()) {
            reports.push({ kind: "error", text: error instanceof Error ? error.message : String(error) });
            queueReport(reporter, {
                state: "uncertain",
                result: {
                    ok: false,
                    settled: false,
                    requestUncertain: true,
                    outcome: "unknown",
                    blockedChats: [],
                    reports,
                },
            });
        }
    } finally {
        releasePlugins?.();
        try {
            await finishReports(reporter);
        } finally {
            releaseChat?.();
        }
    }
}
