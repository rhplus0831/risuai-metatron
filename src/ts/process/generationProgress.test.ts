import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GenerationProgressEntry } from "../../../shared/events.ts";
import {
    generationElapsedMs,
    generationSamples,
    generationServerNow,
    generationTokensPerSecond,
    noteGenerationFrame,
    replaceGenerations,
    resetGenerationProgress,
    runningGenerations,
} from "./generationProgress.svelte";

const entry: GenerationProgressEntry = {
    jobId: "job",
    characterId: "character",
    chatId: "chat",
    clientId: "device",
    kind: "send",
    startedAt: 8000,
    at: 10000,
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    resetGenerationProgress();
});

afterEach(() => {
    resetGenerationProgress();
    vi.useRealTimers();
});

it("replaces hello snapshots, upserts running jobs, removes ended jobs, and resets the set", () => {
    replaceGenerations([entry, { ...entry, jobId: "stale" }]);
    replaceGenerations([{ ...entry, stage: "memory" }]);
    expect(runningGenerations()).toEqual([{ ...entry, stage: "memory" }]);
    noteGenerationFrame({ ...entry, state: "running", stage: "generating" });
    const other = { ...entry, jobId: "other" };
    noteGenerationFrame({ ...other, state: "running" });
    expect(runningGenerations()).toEqual([{ ...entry, stage: "generating" }, other]);
    noteGenerationFrame({ state: "ended", jobId: entry.jobId, characterId: entry.characterId, chatId: entry.chatId });
    expect(runningGenerations()).toEqual([other]);
    replaceGenerations(undefined);
    expect(runningGenerations()).toEqual([]);
    replaceGenerations([entry]);
    resetGenerationProgress();
    expect(runningGenerations()).toEqual([]);
});

it("drops malformed running frames and hello entries field by field without admitting partial data, and ignores a legacy sequence field", () => {
    replaceGenerations([entry]);
    const invalidFields = [
        { jobId: null },
        { characterId: 1 },
        { chatId: [] },
        { clientId: false },
        { kind: "unknown" },
        { startedAt: NaN },
        { at: Infinity },
        { stage: "unknown" },
        { retry: -1 },
        { retry: 0.5 },
        { output: { tokens: -1, since: 8000, at: 10000 } },
        { output: { tokens: 1, since: "8000", at: 10000 } },
        { output: { tokens: 1, since: 8000, at: NaN } },
    ];
    for (const fields of invalidFields) {
        noteGenerationFrame({ ...entry, state: "running", ...fields });
        expect(runningGenerations(), JSON.stringify(fields)).toEqual([entry]);
    }
    noteGenerationFrame({ state: "ended", jobId: entry.jobId });
    expect(runningGenerations()).toEqual([entry]);
    replaceGenerations([
        ...invalidFields.map((fields) => ({ ...entry, jobId: "invalid", ...fields })),
        { ...entry, jobId: "valid" },
    ]);
    expect(runningGenerations()).toEqual([{ ...entry, jobId: "valid" }]);
    // An older server's `sequence`, well formed or not, neither drops its entry nor is kept.
    replaceGenerations([{ ...entry, sequence: { sent: "1", total: 2 } }]);
    expect(runningGenerations()).toEqual([entry]);
    noteGenerationFrame({ ...entry, state: "running", stage: "generating", sequence: { sent: 1, total: -2 } });
    expect(runningGenerations()).toEqual([{ ...entry, stage: "generating" }]);
    noteGenerationFrame({ ...entry, state: "running", stage: "memory", sequence: { sent: 1, total: 3 } });
    expect(runningGenerations()).toEqual([{ ...entry, stage: "memory" }]);
});

it("uses the latest server clock offset for elapsed time and clears it on reset", () => {
    noteGenerationFrame({ ...entry, state: "running" });
    vi.setSystemTime(4000);
    expect(generationServerNow()).toBe(13000);
    expect(generationElapsedMs(entry, generationServerNow())).toBe(5000);
    noteGenerationFrame({ ...entry, state: "running", at: 20000 });
    vi.setSystemTime(5000);
    expect(generationElapsedMs(entry, generationServerNow())).toBe(13000);
    resetGenerationProgress();
    expect(generationServerNow()).toBe(5000);
});

it("computes speed from the last five seconds of output samples and restarts history for a new reply", () => {
    const speed = () => generationTokensPerSecond(generationSamples(entry.jobId));
    const output = (tokens: number, at: number, since = 9000) =>
        noteGenerationFrame({ ...entry, state: "running", at: 30000, output: { tokens, at, since } });
    noteGenerationFrame({ ...entry, state: "running" });
    expect(speed()).toBeNull();
    output(10, 10000);
    expect(speed()).toBe(10);
    output(30, 16000);
    output(50, 18000);
    output(90, 21000);
    expect(generationSamples(entry.jobId).map((sample) => sample.at)).toEqual([16000, 18000, 21000]);
    expect(speed()).toBe(12);
    output(120, 22000, 20000);
    expect(speed()).toBe(60);
    output(6, 23000, 20000);
    expect(speed()).toBe(2);
    resetGenerationProgress();
    expect(speed()).toBeNull();
});
