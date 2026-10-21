// Time limits for tests whose subject is not a limit (not a test file itself). No server import:
// a test that builds its own pool takes them without the server's module graph.
import type { HypaV3SeparatorLimits } from "../prompt/memory/host.ts";
import type { ScriptWorkerTimingOptions } from "../scripts/workerPool.ts";

/**
 * Script worker limits for tests whose subject is not a limit: ten minutes for a worker's boot, a
 * synchronous host answer, a Lua run, an engine's preparation, a regex script run, and a regex, and
 * a job budget ten runs deep (a nested run reserves what the outer runs left). The production
 * limits are real time, which a descheduled test runner could spend.
 */
export const UNHURRIED_SCRIPT_WORKERS = {
    bootMs: 600_000,
    syncHostTimeoutMs: 600_000,
    luaCpuMs: 600_000,
    prepareCpuMs: 600_000,
    regexScriptsCpuMs: 600_000,
    regexDeadlineMs: 600_000,
    luaBudgetMs: 6_000_000,
} satisfies ScriptWorkerTimingOptions;

/** HypaV3 separator limits for tests whose subject is not the chunking budget. */
export const UNHURRIED_HYPAV3_SEPARATOR = {
    budgetMs: 600_000,
    regexDeadlineMs: 600_000,
} satisfies HypaV3SeparatorLimits;
