import { createHash } from "node:crypto";
import type { EventFeedFrame, FeedClient } from "../../shared/events.ts";
import {
    MAX_OPEN_COMMANDS_PER_TARGET,
    MAX_REMOTE_COMMAND_BODY_BYTES,
    REMOTE_COMMAND_CLOSED_KEEP_MS,
    REMOTE_COMMAND_OPEN_DROP_MS,
    REMOTE_COMMAND_PICKUP_MS,
    REMOTE_COMMAND_ERRORS,
    remoteCommandAction,
} from "../../shared/remoteCommands.ts";
import type {
    RemoteCommand,
    RemoteCommandFrameState,
    RemoteCommandPostBody,
    RemoteCommandReadAnswer,
    RemoteCommandRefusalCode,
    RemoteCommandResult,
    RemoteCommandState,
    RemoteCommandStateAnswer,
    RemoteCommandStateBody,
    RemoteCommandStatusAnswer,
} from "../../shared/remoteCommands.ts";
import type { DiagnosticsRecorder } from "./diagnostics/log.ts";

export type RemoteCommandLimits = {
    maxOpenPerTarget: number;
    bodyBytes: number;
    pickupMs: number;
    closedKeepMs: number;
    openDropMs: number;
};

export type RemoteCommandOutcome<T> =
    | { ok: true; body: T }
    | { ok: false; status: 404 | 409 | 410 | 413 | 503; body: { error: string; state?: RemoteCommandState } };

type Entry = {
    commandId: string;
    epoch: string;
    sender: string;
    target: string;
    command?: RemoteCommand;
    identity: string;
    commandType: RemoteCommand["type"];
    bodyBytes: number;
    state: RemoteCommandState;
    attempt: number;
    lastReportedAttempt: number;
    attempted: boolean;
    stopRequested: boolean;
    code?: RemoteCommandRefusalCode;
    result?: RemoteCommandResult;
    changedAt: number;
    pickupAt: number;
};

function isOpen(entry: Entry): boolean {
    return ["queued", "delivered", "running", "uncertain"].includes(entry.state);
}

/** Canonical JSON of the scalar action fields, retaining only its SHA-256 after closing. */
function fingerprint(command: RemoteCommand): string {
    const action = remoteCommandAction(command);
    const canonical = JSON.stringify(
        Object.fromEntries(Object.entries(action).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    );
    return createHash("sha256").update(canonical).digest("hex");
}

function failure(
    status: 404 | 409 | 410 | 413 | 503,
    error: string,
    state?: RemoteCommandState,
): RemoteCommandOutcome<never> {
    return { ok: false, status, body: { error, ...(state ? { state } : {}) } };
}

/**
 * Synchronous, process-local relay. Only a target's HTTP read delivers a command. Closing removes
 * the body but keeps its content-free identity; absence never certifies that no job ran. Every
 * access sweeps obsolete epochs and deadlines. One unref'd timer handles the next deadline even
 * when no client polls. A new attempt's first report renews the deadline even with the same state;
 * reads and repeated reports of the same attempt and state do not.
 */
export function createRemoteCommands(options: {
    epoch: () => string;
    isHost: (clientId: string) => boolean;
    notify: (clientId: string, frame: EventFeedFrame) => unknown;
    diagnostics?: DiagnosticsRecorder;
    now?: () => number;
    limits?: Partial<RemoteCommandLimits>;
    timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}) {
    const now = options.now ?? (() => Date.now());
    const timers = options.timers ?? { setTimeout, clearTimeout };
    const limits: RemoteCommandLimits = {
        maxOpenPerTarget: MAX_OPEN_COMMANDS_PER_TARGET,
        bodyBytes: MAX_REMOTE_COMMAND_BODY_BYTES,
        pickupMs: REMOTE_COMMAND_PICKUP_MS,
        closedKeepMs: REMOTE_COMMAND_CLOSED_KEEP_MS,
        openDropMs: REMOTE_COMMAND_OPEN_DROP_MS,
        ...options.limits,
    };
    const entries = new Map<string, Entry>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    function record(entry: Entry, state: RemoteCommandFrameState = entry.state) {
        options.diagnostics?.record({
            kind: "remoteCommand",
            commandId: entry.commandId,
            command: entry.commandType,
            state,
            bytes: entry.bodyBytes,
        });
    }

    function notifyTarget(entry: Entry) {
        options.notify(entry.target, {
            type: "remoteCommand",
            epoch: entry.epoch,
            commandId: entry.commandId,
            ...(entry.stopRequested ? { stop: true } : {}),
        });
    }

    function notifySender(entry: Entry, state: RemoteCommandFrameState = entry.state) {
        options.notify(entry.sender, {
            type: "remoteCommandState",
            epoch: entry.epoch,
            commandId: entry.commandId,
            state,
            ...(entry.code ? { code: entry.code } : {}),
        });
    }

    function transition(entry: Entry, state: RemoteCommandState, at = now(), newAttempt = false) {
        if (entry.state === state && !newAttempt) return;
        entry.state = state;
        entry.changedAt = at;
        if (!isOpen(entry)) entry.command = undefined;
        record(entry);
        notifySender(entry);
    }

    function deadline(entry: Entry): number {
        return isOpen(entry)
            ? Math.min(entry.changedAt + limits.openDropMs, entry.state === "queued" ? entry.pickupAt : Infinity)
            : entry.changedAt + limits.closedKeepMs;
    }

    function schedule() {
        if (timer !== undefined) timers.clearTimeout(timer);
        timer = undefined;
        if (closed || entries.size === 0) return;
        let next = Infinity;
        for (const entry of entries.values()) next = Math.min(next, deadline(entry));
        timer = timers.setTimeout(sweep, Math.max(0, next - now()));
        timer.unref?.();
    }

    function sweep() {
        if (closed) return;
        const epoch = options.epoch();
        const at = now();
        for (const [id, entry] of entries) {
            if (entry.epoch !== epoch) {
                entries.delete(id);
                continue;
            }
            if (
                entry.state === "queued" &&
                entry.pickupAt <= at &&
                entry.pickupAt <= entry.changedAt + limits.openDropMs
            ) {
                transition(entry, "expired", entry.pickupAt);
            }
            if (isOpen(entry) && entry.changedAt + limits.openDropMs <= at) {
                entries.delete(id);
                record(entry, "forgotten");
                notifySender(entry, "forgotten");
            } else if (!isOpen(entry) && entry.changedAt + limits.closedKeepMs <= at) {
                entries.delete(id);
            }
        }
        schedule();
    }

    function stateAnswer(entry: Entry): RemoteCommandStateAnswer {
        return { state: entry.state, stopRequested: entry.stopRequested, attempt: entry.attempt };
    }

    function statusAnswer(entry: Entry): RemoteCommandStatusAnswer {
        return {
            ...stateAnswer(entry),
            attempted: entry.attempted,
            ...(entry.code ? { code: entry.code } : {}),
            ...(entry.result !== undefined ? { result: structuredClone(entry.result) } : {}),
        };
    }

    function full(target: string): boolean {
        let count = 0;
        for (const entry of entries.values()) if (entry.target === target && isOpen(entry)) count++;
        return count >= limits.maxOpenPerTarget;
    }

    return {
        sweep,
        /** Immutable retry identity and sender are checked before looking at target availability. */
        post(body: RemoteCommandPostBody): RemoteCommandOutcome<RemoteCommandStatusAnswer> {
            if (closed) return failure(503, "The server is shutting down");
            sweep();
            const identity = fingerprint(body.command);
            const existing = entries.get(body.commandId);
            if (existing && (existing.identity !== identity || existing.sender !== body.clientId)) {
                return failure(409, REMOTE_COMMAND_ERRORS.commandChanged);
            }
            if (existing?.state === "done") return { ok: true, body: statusAnswer(existing) };
            if (existing && isOpen(existing)) {
                const move =
                    !options.isHost(existing.target) && options.isHost(body.target) && existing.target !== body.target;
                if (move && full(body.target)) return failure(409, REMOTE_COMMAND_ERRORS.targetFull);
                existing.stopRequested = false;
                if (body.uncertain) existing.attempted = true;
                if (move) {
                    existing.target = body.target;
                    if (existing.state === "queued") existing.pickupAt = now() + limits.pickupMs;
                }
                if (move || existing.state !== "queued") notifyTarget(existing);
                schedule();
                return { ok: true, body: statusAnswer(existing) };
            }
            if (!options.isHost(body.target)) return failure(404, REMOTE_COMMAND_ERRORS.targetUnavailable);
            if (full(body.target)) return failure(409, REMOTE_COMMAND_ERRORS.targetFull);
            const bodyBytes = Buffer.byteLength(JSON.stringify(body.command));
            if (bodyBytes > limits.bodyBytes) return failure(413, "Request body too large");
            const at = now();
            const entry: Entry = {
                commandId: body.commandId,
                epoch: options.epoch(),
                sender: body.clientId,
                target: body.target,
                command: structuredClone(body.command),
                identity,
                commandType: body.command.type,
                bodyBytes,
                state: "queued",
                attempt: 0,
                lastReportedAttempt: 0,
                attempted: body.uncertain === true,
                stopRequested: false,
                changedAt: at,
                pickupAt: at + limits.pickupMs,
            };
            entries.set(body.commandId, entry);
            record(entry);
            notifyTarget(entry);
            schedule();
            return { ok: true, body: statusAnswer(entry) };
        },

        read(id: string, clientId: string): RemoteCommandOutcome<RemoteCommandReadAnswer> {
            sweep();
            const entry = entries.get(id);
            if (!entry || entry.target !== clientId) return failure(404, REMOTE_COMMAND_ERRORS.unknownCommand);
            if (!isOpen(entry)) return failure(410, "commandClosed", entry.state);
            entry.attempt++;
            if (entry.state === "queued") transition(entry, "delivered");
            schedule();
            return {
                ok: true,
                body: { ...stateAnswer(entry), attempted: entry.attempted, command: structuredClone(entry.command!) },
            };
        },

        report(id: string, body: RemoteCommandStateBody): RemoteCommandOutcome<RemoteCommandStateAnswer> {
            sweep();
            const entry = entries.get(id);
            if (!entry || entry.target !== body.clientId) return failure(404, REMOTE_COMMAND_ERRORS.unknownCommand);
            if (!Number.isSafeInteger(body.attempt) || body.attempt <= 0 || body.attempt > entry.attempt) {
                return failure(409, REMOTE_COMMAND_ERRORS.invalidTransition, entry.state);
            }
            if (body.attempt < entry.attempt) return { ok: true, body: { ...stateAnswer(entry), superseded: true } };
            if (!isOpen(entry)) {
                return body.state === entry.state
                    ? { ok: true, body: stateAnswer(entry) }
                    : failure(409, REMOTE_COMMAND_ERRORS.invalidTransition, entry.state);
            }
            if (entry.state === "queued") return failure(409, REMOTE_COMMAND_ERRORS.invalidTransition, entry.state);
            let state: RemoteCommandState = body.state;
            entry.code = body.state === "refused" ? body.code : undefined;
            if (body.state === "running") entry.attempted = true;
            if (body.state === "refused" && (entry.attempted || entry.state !== "delivered")) state = "uncertain";
            entry.result = "result" in body && body.result !== undefined ? structuredClone(body.result) : undefined;
            const newAttempt = body.attempt > entry.lastReportedAttempt;
            entry.lastReportedAttempt = body.attempt;
            transition(entry, state, now(), newAttempt);
            schedule();
            return { ok: true, body: stateAnswer(entry) };
        },

        cancel(id: string, clientId: string): RemoteCommandOutcome<RemoteCommandStateAnswer> {
            sweep();
            const entry = entries.get(id);
            if (!entry || entry.sender !== clientId) return failure(404, REMOTE_COMMAND_ERRORS.unknownCommand);
            if (isOpen(entry)) {
                entry.stopRequested = true;
                if (entry.state === "queued") transition(entry, "cancelled");
                else notifyTarget(entry);
            }
            schedule();
            return { ok: true, body: stateAnswer(entry) };
        },

        status(id: string, clientId: string): RemoteCommandOutcome<RemoteCommandStatusAnswer> {
            sweep();
            const entry = entries.get(id);
            return !entry || entry.sender !== clientId
                ? failure(404, REMOTE_COMMAND_ERRORS.unknownCommand)
                : { ok: true, body: statusAnswer(entry) };
        },

        onRegister(client: FeedClient) {
            sweep();
            if (client.host !== true || !options.isHost(client.clientId)) return;
            for (const entry of entries.values()) {
                if (entry.target === client.clientId && isOpen(entry)) notifyTarget(entry);
            }
        },

        close() {
            closed = true;
            entries.clear();
            if (timer !== undefined) timers.clearTimeout(timer);
            timer = undefined;
        },
    };
}

export type RemoteCommands = ReturnType<typeof createRemoteCommands>;
