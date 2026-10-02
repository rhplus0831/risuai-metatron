import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { type MessagePort, parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";
import type { customscript } from "../../../shared/database.ts";
import { runRegexScripts, type RegexScriptMode } from "../../../shared/scripts/regex.ts";
import {
    createLuaRuntime,
    type HostAccess,
    type LuaRunInput,
    type LuaRunOutput,
    MAX_HOST_ARG_CHARS,
    MAX_RESULT_JSON_CHARS,
} from "../lua/runtime.ts";

/**
 * A script worker: one wasm Lua module (`createLuaRuntime`) and the regex executor. The pool sends
 * it one top-level task at a time, plus the regex tasks that task's own host calls spawn; those
 * run while the Lua thread awaits, since the worker's event loop is free then.
 */
export type ScriptWorkerData = { jsonLuaPath: string; syncPort: MessagePort; syncFlag: Int32Array };

/**
 * `syncFlag[0]` counts the main thread's synchronous replies (and abort wake-ups); `syncFlag[1]`
 * holds the id of the task the main thread aborted, which the Lua hook and a blocked synchronous
 * call read without waiting for the abort message.
 */
export const SYNC_REPLIES = 0;
export const ABORTED_TASK = 1;

/**
 * A `lua` task whose `mode` is this runs the regex script engine (`runRegexScripts`) instead of Lua
 * (Phase 5 slice 9): `data` is a `RegexScriptsInput`, and the engine's `parse`, `repeatBackSource`,
 * and `applyEffect` are the synchronous host functions `parse`, `repeatBack`, and `effect` (an
 * effect crosses as JSON), so CBS runs on the main thread and an effect lands where its script
 * matched. `res` is the output text. It shares the Lua task's watchdog, abort, and host plumbing.
 */
export const REGEX_SCRIPTS_MODE = "\u0000regexScripts";

export type RegexScriptsInput = { data: string; scripts: customscript[]; mode: RegexScriptMode; chatID: number };

/** A single user regex: `test`, `exec` (the first match), `split`, or `matches` (what `replace` visits). */
export type RegexOp = { op: "test" | "exec" | "split" | "matches"; pattern: string; flags: string; input: string };
export type RegexMatch = {
    index: number;
    match: string;
    groups: Array<string | undefined>;
    named: Record<string, string> | null;
};
export type RegexOpResult =
    { value: boolean | RegexMatch | null | string[] | RegexMatch[] } | { error: string; timedOut?: boolean };

export type ToWorker =
    | { type: "lua"; taskId: number; input: LuaRunInput }
    | { type: "regex"; taskId: number; op: RegexOp }
    | { type: "abort"; taskId: number }
    | { type: "hostResult"; callId: number; ok: true; value: unknown }
    | { type: "hostResult"; callId: number; ok: false; error: string };

export type FromWorker =
    | { type: "ready" }
    | { type: "luaDone"; taskId: number; result: LuaRunOutput }
    | { type: "regexDone"; taskId: number; result: RegexOpResult; ms: number }
    | { type: "host"; taskId: number; callId: number; name: string; args: unknown[]; access: HostAccess }
    | { type: "log"; taskId: number; value: string };

export type SyncHostRequest = { seq: number; taskId: number; name: string; args: unknown[]; access: HostAccess };
export type SyncHostReply = { seq: number } & ({ ok: true; value: unknown } | { ok: false; error: string });

/** A synchronous host call blocks the worker; a main thread that does not answer fails it. */
export const SYNC_HOST_TIMEOUT_MS = 10_000;
export const MAX_REGEX_MATCHES = 100_000;
/** Characters a regex result may carry back (matches, groups, and parts). */
export const MAX_REGEX_OUTPUT_CHARS = 16 * 1024 * 1024;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toMatch(m: RegExpExecArray | RegExpMatchArray): RegexMatch {
    return { index: m.index ?? 0, match: m[0], groups: m.slice(1), named: m.groups ? { ...m.groups } : null };
}

function matchChars(m: RegexMatch): number {
    let chars = m.match.length;
    for (const group of m.groups) {
        chars += group?.length ?? 0;
    }
    for (const value of Object.values(m.named ?? {})) {
        chars += value?.length ?? 0;
    }
    return chars;
}

export function runRegexOp(op: RegexOp): RegexOpResult {
    let regex: RegExp;
    try {
        regex = new RegExp(op.pattern, op.flags);
    } catch (error) {
        return { error: errorMessage(error) };
    }
    const tooLarge = { error: `Regex result larger than ${MAX_REGEX_OUTPUT_CHARS} characters` };
    switch (op.op) {
        case "test":
            return { value: regex.test(op.input) };
        case "exec": {
            const m = regex.exec(op.input);
            const match = m ? toMatch(m) : null;
            return match && matchChars(match) > MAX_REGEX_OUTPUT_CHARS ? tooLarge : { value: match };
        }
        case "split": {
            // A result crosses back to the main thread, so it is capped like `matches`.
            const parts = op.input.split(regex, MAX_REGEX_MATCHES + 1);
            if (parts.length > MAX_REGEX_MATCHES) {
                return { error: `More than ${MAX_REGEX_MATCHES} parts` };
            }
            let chars = 0;
            for (const part of parts) {
                chars += part?.length ?? 0;
            }
            return chars > MAX_REGEX_OUTPUT_CHARS ? tooLarge : { value: parts };
        }
        case "matches": {
            if (!regex.global) {
                const m = regex.exec(op.input);
                const match = m ? toMatch(m) : null;
                return match && matchChars(match) > MAX_REGEX_OUTPUT_CHARS ? tooLarge : { value: match ? [match] : [] };
            }
            const matches: RegexMatch[] = [];
            let chars = 0;
            for (const m of op.input.matchAll(regex)) {
                if (matches.length >= MAX_REGEX_MATCHES) {
                    return { error: `More than ${MAX_REGEX_MATCHES} matches` };
                }
                const match = toMatch(m);
                chars += matchChars(match);
                if (chars > MAX_REGEX_OUTPUT_CHARS) {
                    return tooLarge;
                }
                matches.push(match);
            }
            return { value: matches };
        }
    }
}

if (parentPort) {
    const port = parentPort;
    const { jsonLuaPath, syncPort, syncFlag } = workerData as ScriptWorkerData;
    const runtime = createLuaRuntime({ jsonLua: readFileSync(jsonLuaPath, "utf8") });
    const runs = new Map<number, { controller: AbortController; callIds: Set<number> }>();
    const hostCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextCallId = 1;
    let syncSeq = 0;
    const post = (message: FromWorker) => port.postMessage(message);
    const abortedByMain = (taskId: number) => Atomics.load(syncFlag, ABORTED_TASK) === taskId;

    // A wasmoon `async` step that errors (the budget, an abort) throws from a promise callback,
    // outside the run's awaits; it belongs to the active run. Anything else is a worker fault.
    process.on("unhandledRejection", (reason) => {
        if (!runtime.reportFault(reason)) {
            throw reason;
        }
    });

    // The worker waits for `SYNC_REPLIES` to move, then reads the port. A late reply to an earlier
    // call that timed out is skipped; an abort of the task wakes the wait and fails the call.
    const callSync = (taskId: number, name: string, args: unknown[], access: HostAccess): unknown => {
        const seq = ++syncSeq;
        const deadline = Date.now() + SYNC_HOST_TIMEOUT_MS;
        let seen = Atomics.load(syncFlag, SYNC_REPLIES);
        syncPort.postMessage({ seq, taskId, name, args, access } satisfies SyncHostRequest);
        let reply: SyncHostReply | undefined;
        for (;;) {
            let message: SyncHostReply | undefined;
            while ((message = receiveMessageOnPort(syncPort)?.message as SyncHostReply | undefined)) {
                if (message.seq === seq) {
                    reply = message;
                }
            }
            if (abortedByMain(taskId)) {
                throw new Error("request aborted");
            }
            const remaining = deadline - Date.now();
            if (reply || remaining <= 0) {
                break;
            }
            Atomics.wait(syncFlag, SYNC_REPLIES, seen, remaining);
            seen = Atomics.load(syncFlag, SYNC_REPLIES);
        }
        if (!reply) {
            throw new Error(`Host function ${name} did not answer`);
        }
        if (!reply.ok) {
            throw new Error(reply.error);
        }
        return reply.value;
    };

    /** The regex script engine as a task: its host calls block the worker, as Lua's synchronous ones do. */
    const runScripts = (taskId: number, input: LuaRunInput): LuaRunOutput => {
        const start = performance.now();
        const { data, scripts, mode, chatID } = input.data as RegexScriptsInput;
        const access: HostAccess = "safe";
        // The Lua task's bounds, as JSON (the unit the runtime counts): a host argument and the result.
        // An oversized one fails the task, and no host call follows it (the engine would otherwise
        // skip just that script and go on to the next one's effects).
        let oversize: string | null = null;
        const live = () => {
            if (oversize !== null) {
                throw new Error(oversize);
            }
        };
        const bounded = (text: string, what: string) => {
            live();
            if (JSON.stringify(text).length > MAX_HOST_ARG_CHARS) {
                oversize = `Regex scripts: ${what} too large`;
                throw new Error(oversize);
            }
            return text;
        };
        const result = runRegexScripts(data, scripts, {
            mode,
            chatID,
            parse: (text) => String(callSync(taskId, "parse", [bounded(text, "a CBS input")], access) ?? ""),
            repeatBackSource: () => {
                live();
                return String(callSync(taskId, "repeatBack", [], access) ?? "");
            },
            applyEffect: (effect) => {
                callSync(taskId, "effect", [bounded(JSON.stringify(effect), "an effect")], access);
            },
        });
        const aborted = abortedByMain(taskId);
        if (!aborted && oversize === null && JSON.stringify(result.data).length > MAX_RESULT_JSON_CHARS) {
            oversize = "Regex scripts: the result is too large";
        }
        const error = aborted ? "request aborted" : oversize;
        return {
            res: error === null ? result.data : undefined,
            stopSending: false,
            ...(error !== null ? { error } : {}),
            ...(aborted ? { aborted: true } : {}),
            cpuMs: Math.round(performance.now() - start),
            memory: { used: 0, max: 0 },
        };
    };

    const runLua = async (taskId: number, input: LuaRunInput) => {
        const run = { controller: new AbortController(), callIds: new Set<number>() };
        runs.set(taskId, run);
        let result: LuaRunOutput;
        try {
            result =
                input.mode === REGEX_SCRIPTS_MODE
                    ? runScripts(taskId, input)
                    : await runtime.run(input, {
                          aborted: () => run.controller.signal.aborted || abortedByMain(taskId),
                          log: (value) => post({ type: "log", taskId, value }),
                          callSync: (name, args, access) => callSync(taskId, name, args, access),
                          callAsync: (name, args, access) =>
                              new Promise((resolve, reject) => {
                                  const callId = nextCallId++;
                                  run.callIds.add(callId);
                                  hostCalls.set(callId, { resolve, reject });
                                  post({ type: "host", taskId, callId, name, args, access });
                              }),
                      });
        } catch (error) {
            result = {
                res: undefined,
                stopSending: false,
                error: errorMessage(error),
                cpuMs: 0,
                memory: { used: 0, max: 0 },
            };
        } finally {
            // An unawaited host call does not outlive its run: its late answer is dropped.
            for (const callId of run.callIds) {
                hostCalls.delete(callId);
            }
            runs.delete(taskId);
        }
        try {
            post({ type: "luaDone", taskId, result });
        } catch (error) {
            post({ type: "luaDone", taskId, result: { ...result, res: undefined, error: errorMessage(error) } });
        }
    };

    port.on("message", (message: ToWorker) => {
        switch (message.type) {
            case "lua":
                void runLua(message.taskId, message.input);
                break;
            case "regex": {
                const start = performance.now();
                const result = runRegexOp(message.op);
                const ms = performance.now() - start;
                // A regex a run's host call spawned is the host's time, not the run's.
                runtime.exclude(ms);
                post({ type: "regexDone", taskId: message.taskId, result, ms });
                break;
            }
            case "abort": {
                const run = runs.get(message.taskId);
                if (run) {
                    run.controller.abort();
                    // The awaiting Lua thread resumes with the abort instead of waiting for the host.
                    for (const callId of run.callIds) {
                        hostCalls.get(callId)?.reject(new Error("request aborted"));
                        hostCalls.delete(callId);
                    }
                }
                break;
            }
            case "hostResult": {
                const call = hostCalls.get(message.callId);
                hostCalls.delete(message.callId);
                for (const run of runs.values()) {
                    run.callIds.delete(message.callId);
                }
                if (message.ok) {
                    call?.resolve(message.value);
                } else {
                    call?.reject(new Error(message.error));
                }
                break;
            }
        }
    });
    void runtime.warm().finally(() => post({ type: "ready" }));
}
