import { SvelteMap } from "svelte/reactivity";
import type { GenerationProgressEntry } from "../../../shared/events.ts";
import { GENERATION_KINDS, GENERATION_STAGES } from "../../../shared/jobs.ts";

/**
 * The tab's content-free view of the server's running generation jobs from the live-update feed.
 * `eventFeed.ts` routes a same-epoch `hello` here to replace the set and `generation` frames to
 * upsert or remove one job. Every retired connection and epoch mismatch clears the jobs, samples,
 * and clock offset, so a missed `ended` frame cannot leave a job listed.
 *
 * One server clock offset is taken from the newest received entry's `at` minus the tab's
 * `Date.now()` at receipt. Per-job output samples cover `OUTPUT_SAMPLE_WINDOW_MS` by their own
 * server `at`, relative to the newest sample. A changed `since` or lower token count starts a new
 * reply's sample history.
 */
const OUTPUT_SAMPLE_WINDOW_MS = 5000;

const entries = new SvelteMap<string, GenerationProgressEntry>();
export type GenerationOutputSample = NonNullable<GenerationProgressEntry["output"]>;
const samples = new SvelteMap<string, readonly GenerationOutputSample[]>();
let serverOffset = $state(0);

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function count(value: unknown): value is number {
    return finite(value) && value >= 0;
}

/** Invalid optional fields reject the entry too, so consumers only see the shared contract. */
function parseEntry(value: unknown): GenerationProgressEntry | null {
    const fields = record(value);
    if (!fields) return null;
    const { jobId, characterId, chatId, clientId, startedAt, at } = fields;
    const kind = GENERATION_KINDS.find((kind) => kind === fields.kind);
    if (
        typeof jobId !== "string" ||
        typeof characterId !== "string" ||
        typeof chatId !== "string" ||
        typeof clientId !== "string" ||
        !kind ||
        !finite(startedAt) ||
        !finite(at)
    )
        return null;
    const entry: GenerationProgressEntry = { jobId, characterId, chatId, clientId, kind, startedAt, at };
    if (fields.stage !== undefined) {
        const stage = GENERATION_STAGES.find((stage) => stage === fields.stage);
        if (!stage) return null;
        entry.stage = stage;
    }
    if (fields.retry !== undefined) {
        if (!count(fields.retry) || !Number.isInteger(fields.retry)) return null;
        entry.retry = fields.retry;
    }
    if (fields.output !== undefined) {
        const output = record(fields.output);
        if (!output || !count(output.tokens) || !count(output.since) || !count(output.at)) return null;
        entry.output = { tokens: output.tokens, since: output.since, at: output.at };
    }
    return entry;
}

function upsert(entry: GenerationProgressEntry, receivedAt: number) {
    serverOffset = entry.at - receivedAt;
    entries.set(entry.jobId, entry);
    const output = entry.output;
    if (!output) return;
    let history = samples.get(entry.jobId) ?? [];
    const last = history.at(-1);
    // Each reply has its own count and start time, including replies within a multi-reply job.
    if (last && (output.since !== last.since || output.tokens < last.tokens)) history = [];
    if (history.at(-1)?.at === output.at) return;
    samples.set(
        entry.jobId,
        [...history, output].filter((sample) => sample.at >= output.at - OUTPUT_SAMPLE_WINDOW_MS),
    );
}

/** A same-epoch hello replaces the whole set; malformed entries are skipped independently. */
export function replaceGenerations(snapshot: unknown) {
    const receivedAt = Date.now();
    const next = new Map<string, GenerationProgressEntry>();
    for (const value of Array.isArray(snapshot) ? snapshot : []) {
        const entry = parseEntry(value);
        if (entry) {
            next.set(entry.jobId, entry);
            upsert(entry, receivedAt);
        }
    }
    for (const jobId of entries.keys()) {
        if (!next.has(jobId)) {
            entries.delete(jobId);
            samples.delete(jobId);
        }
    }
}

/** A running frame upserts one job; a well-formed end removes it and its speed history. */
export function noteGenerationFrame(value: unknown) {
    const frame = record(value);
    if (!frame) return;
    if (frame.state === "running") {
        const entry = parseEntry(frame);
        if (entry) upsert(entry, Date.now());
    } else if (
        frame.state === "ended" &&
        typeof frame.jobId === "string" &&
        typeof frame.characterId === "string" &&
        typeof frame.chatId === "string"
    ) {
        entries.delete(frame.jobId);
        samples.delete(frame.jobId);
    }
}

/** Clears running jobs, output samples, and the server clock offset. */
export function resetGenerationProgress() {
    entries.clear();
    samples.clear();
    serverOffset = 0;
}

/** A reactive list of every currently running job, including previews. */
export function runningGenerations(): readonly GenerationProgressEntry[] {
    return [...entries.values()];
}

/** A job's reactive output samples, or an empty list when none are held. */
export function generationSamples(jobId: string): readonly GenerationOutputSample[] {
    return samples.get(jobId) ?? [];
}

/** Converts the tab's ticking clock to the clock used by feed timestamps. */
export function generationServerNow(tabNow = Date.now()): number {
    return tabNow + serverOffset;
}

/** Elapsed server-clock milliseconds since admission, clamped to zero. */
export function generationElapsedMs(entry: GenerationProgressEntry, serverNow: number): number {
    return Math.max(0, serverNow - entry.startedAt);
}

/** Tokens/s from deltas, or tokens since `since` for one sample; null with none or a non-positive duration. */
export function generationTokensPerSecond(history: readonly GenerationOutputSample[]): number | null {
    const last = history.at(-1);
    if (!last) return null;
    const first = history[0];
    const duration = last.at - (history.length > 1 ? first.at : last.since);
    return duration > 0 ? (last.tokens - (history.length > 1 ? first.tokens : 0)) / (duration / 1000) : null;
}

/** The newest job for this chat created by another tab or device. */
export function foreignGeneration(
    characterId: string,
    chatId: string,
    clientId: string,
): GenerationProgressEntry | null {
    let newest: GenerationProgressEntry | null = null;
    for (const entry of entries.values()) {
        if (
            entry.characterId === characterId &&
            entry.chatId === chatId &&
            entry.clientId !== clientId &&
            (!newest || entry.startedAt > newest.startedAt)
        )
            newest = entry;
    }
    return newest;
}
