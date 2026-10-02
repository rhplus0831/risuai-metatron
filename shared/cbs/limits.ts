/**
 * Cooperative limits on CBS evaluation, for a host that evaluates card text where a runaway must
 * not hold the thread (the server's main thread). A host without `limits` gets none: the evaluator
 * then never counts and never reads the clock, and its results are unchanged.
 *
 * The limits are checked at points inside the evaluator and the registry, so they are not a hard
 * deadline (one operation between two checks runs to its end) and not a heap bound (the lengths of
 * the amplifying operations are charged before they allocate, other results after they return).
 */
export type CbsUsage = {
    /** Evaluation time spent so far by every evaluator that shares this object. */
    usedMs: number;
};

export type CbsLimits = {
    /**
     * Work one top-level parse may spend, nested parses included: one unit per character scanned and
     * per character a function or an expansion produces, plus the registry's charges for its loops.
     */
    maxWork: number;
    /** Wall time one top-level parse may take. */
    maxMs: number;
    /** An allowance of evaluation time shared by several evaluators (a job's). */
    total?: { usage: CbsUsage; maxMs: number };
    /** A monotonic clock in milliseconds (default `performance.now`). */
    now?: () => number;
};

export type CbsLimitReason = "work" | "time" | "total";

/** A limit was reached. The evaluator's own `catch` blocks let it through; it is never a function's failure. */
export class CbsLimitError extends Error {
    reason: CbsLimitReason;
    constructor(reason: CbsLimitReason, limits: CbsLimits) {
        super(
            reason === "work"
                ? `CBS limit reached: one template took more than ${limits.maxWork} steps`
                : reason === "time"
                  ? `CBS limit reached: one template took more than ${limits.maxMs} ms`
                  : `CBS limit reached: the templates took more than ${limits.total?.maxMs} ms in all`,
        );
        this.name = "CbsLimitError";
        this.reason = reason;
    }
}

/** Work units between two clock reads at most (the evaluator also reads it at every `{{` and `}}`). */
const CLOCK_INTERVAL = 4096;

export type CbsBudget = {
    limits: CbsLimits;
    now: () => number;
    /** Parses in progress: the budget starts over when the first one enters. */
    depth: number;
    work: number;
    nextClock: number;
    startedAt: number;
    deadline: number;
    /** What the deadline stands for: the parse's own time, or what is left of the shared allowance. */
    deadlineReason: "time" | "total";
};

const validLimit = (value: unknown): value is number => typeof value === "number" && value > 0 && !Number.isNaN(value);

export function createCbsBudget(limits: CbsLimits): CbsBudget {
    if (!validLimit(limits.maxWork) || !validLimit(limits.maxMs) || (limits.total && !validLimit(limits.total.maxMs))) {
        throw new Error("CBS limits must be positive numbers");
    }
    return {
        limits,
        now: limits.now ?? (() => performance.now()),
        depth: 0,
        work: 0,
        nextClock: CLOCK_INTERVAL,
        startedAt: 0,
        deadline: 0,
        deadlineReason: "time",
    };
}

/** A parse begins. The outermost one starts the budget over and takes its deadline. */
export function enterCbsParse(budget: CbsBudget): void {
    if (budget.depth === 0) {
        const { limits } = budget;
        const startedAt = budget.now();
        let allowed = limits.maxMs;
        budget.deadlineReason = "time";
        if (limits.total) {
            const left = limits.total.maxMs - limits.total.usage.usedMs;
            if (!(left > 0)) {
                throw new CbsLimitError("total", limits);
            }
            if (left < allowed) {
                allowed = left;
                budget.deadlineReason = "total";
            }
        }
        budget.work = 0;
        budget.nextClock = CLOCK_INTERVAL;
        budget.startedAt = startedAt;
        budget.deadline = startedAt + allowed;
    }
    budget.depth++;
}

/** A parse ended, by a result or an error. The outermost one adds its time to the shared allowance. */
export function leaveCbsParse(budget: CbsBudget): void {
    budget.depth--;
    if (budget.depth === 0 && budget.limits.total) {
        budget.limits.total.usage.usedMs += Math.max(0, budget.now() - budget.startedAt);
    }
}

export function checkCbsClock(budget: CbsBudget): void {
    if (budget.now() > budget.deadline) {
        throw new CbsLimitError(budget.deadlineReason, budget.limits);
    }
}

/**
 * Charges `units` of work. A charge that is not a positive number counts nothing (a NaN from a
 * card's argument must not poison the count); an infinite one reaches the limit.
 */
export function spendCbsWork(budget: CbsBudget, units: number): void {
    if (!(units > 0)) {
        return;
    }
    budget.work += units;
    if (budget.work > budget.limits.maxWork) {
        throw new CbsLimitError("work", budget.limits);
    }
    if (budget.work >= budget.nextClock) {
        budget.nextClock = budget.work + CLOCK_INTERVAL;
        checkCbsClock(budget);
    }
}

/**
 * An upper bound of `text.replaceAll(pattern, replacement).length` for string arguments, counted
 * without building the result, to charge before the allocation. In the replacement `$$` is one
 * dollar, `$&` the match, and `` $` `` and `$'` the text before and after it (counted as the whole
 * text); any other `$` is literal, as a string pattern has no groups.
 */
export function replaceAllBound(text: string, pattern: string, replacement: string): number {
    let count = 0;
    if (pattern === "") {
        count = text.length + 1;
    } else {
        for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + pattern.length)) {
            count++;
        }
    }
    if (count === 0) {
        return text.length;
    }
    let inserted = replacement.length;
    for (let at = replacement.indexOf("$"); at !== -1; at = replacement.indexOf("$", at + 1)) {
        const next = replacement[at + 1];
        if (next === "$") {
            at++;
        } else if (next === "&") {
            inserted += pattern.length;
        } else if (next === "`" || next === "'") {
            inserted += text.length;
        }
    }
    return text.length + count * inserted;
}
