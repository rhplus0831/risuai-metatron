// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, character } from "../../../shared/database.ts";
import { createHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { normalizeHypaV3Presets } from "../data/normalize/collections.ts";
import type { EmbeddingEnv } from "../prompt/embeddings.ts";
import type { MemoryHost } from "../prompt/memory/host.ts";
import { hypaMemoryV3 } from "../prompt/memory/hypav3.ts";
import type { RegexOp, RegexOpResult } from "../scripts/worker.ts";
import { createScriptWorkerPool } from "../scripts/workerPool.ts";

// Slice 1b of `docs/plan/audit-findings-perf.md` (audit MEM-01 and MEM-02): a HypaV3 preset can no
// longer hang or stall the server. The shared constructor (and through it the server normalizer)
// defaults a batch size or query count that is not an integer of at least 1 and any non-finite
// number; both summarization loops end with an error instead of spinning when the batch does not
// advance (run in a child process, so a broken guard cannot hang the run); and the summary chunk
// separator runs on a script worker through `MemoryHost.regex`, with the worker's timeout or the
// chunking budget returned as the memory step's error, the summaries kept, and an invalid pattern
// keeping the former double-newline fallback without a worker call.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const MODES = [
    ["standard", false],
    ["experimental", true],
] as const;

describe("createHypaV3Preset limits", () => {
    it.each([
        ["maxChatsPerSummary", 0, 6],
        ["maxChatsPerSummary", -3, 6],
        ["maxChatsPerSummary", 1.5, 6],
        ["maxChatsPerSummary", Number.NaN, 6],
        ["maxChatsPerSummary", Number.POSITIVE_INFINITY, 6],
        ["queryChatCount", 0, 3],
        ["queryChatCount", 2.5, 3],
        ["queryChatCount", Number.NaN, 3],
        ["memoryTokensRatio", Number.NaN, 0.2],
        ["summarizationRequestsPerMinute", Number.NEGATIVE_INFINITY, 20],
    ] as const)("defaults %s = %s to %s", (key, value, expected) => {
        const settings = createHypaV3Preset("P", { [key]: value }).settings as unknown as Record<string, number>;
        expect(settings[key]).toBe(expected);
    });

    it("keeps valid counts, including the UI's extremes", () => {
        const { settings } = createHypaV3Preset("P", { maxChatsPerSummary: 1, queryChatCount: 20 });
        expect(settings.maxChatsPerSummary).toBe(1);
        expect(settings.queryChatCount).toBe(20);
    });

    it("defaults a stored zero through the server normalizer", () => {
        const out = normalizeHypaV3Presets({
            items: [{ id: "a", name: "A", settings: { maxChatsPerSummary: 0, queryChatCount: -1 } }],
            selectedId: "a",
        });
        expect(out.items[0].settings).toMatchObject({ maxChatsPerSummary: 6, queryChatCount: 3 });
    });
});

describe("summarization without progress", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hypav3-limits-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    /**
     * The algorithm with a batch size of 0 written past the constructor (a database that skipped
     * normalization), in a child process the test kills after the timeout: before the guard, the
     * loop spun forever without an await.
     */
    function runWithZeroBatch(experimental: boolean): { error?: string; summaries: number } {
        const script = path.join(dir, `zero-batch-${experimental ? "exp" : "std"}.mjs`);
        const hypav3 = pathToFileURL(path.join(REPO_ROOT, "server/src/prompt/memory/hypav3.ts")).href;
        const presets = pathToFileURL(path.join(REPO_ROOT, "shared/hypaV3Presets.ts")).href;
        writeFileSync(
            script,
            [
                `import { hypaMemoryV3 } from ${JSON.stringify(hypav3)};`,
                `import { createHypaV3Preset } from ${JSON.stringify(presets)};`,
                `const preset = createHypaV3Preset("zero", { useExperimentalImpl: ${experimental}, similarMemoryRatio: 0, recentMemoryRatio: 0 });`,
                `preset.settings.maxChatsPerSummary = 0;`,
                `const signal = new AbortController().signal;`,
                `const host = {`,
                `    db: { maxResponse: 1, hypaV3Presets: [preset], hypaV3PresetId: preset.id },`,
                `    tokenize: async () => 1,`,
                `    request: async () => ({ type: "success", result: "summary" }),`,
                `    completions: async () => { throw new Error("unexpected"); },`,
                `    summarizer: async () => { throw new Error("unexpected"); },`,
                `    get embeddings() { throw new Error("unexpected"); },`,
                `    regex: async () => { throw new Error("unexpected"); },`,
                `    parseChatML: () => null,`,
                `    userName: () => "User",`,
                `    progress() {},`,
                `    random: () => 0.5,`,
                `    redact: (text) => text,`,
                `    fence: () => signal.throwIfAborted(),`,
                `    signal,`,
                `};`,
                `const chats = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: "Message " + i, memo: "m" + i }));`,
                `const result = await hypaMemoryV3(host, chats, 1500, 1000, {}, { name: "test" }, { tokenizeChat: async () => 200 });`,
                `process.stdout.write(JSON.stringify({ error: result.error, summaries: result.memory?.summaries.length }));`,
            ].join("\n"),
        );
        const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
        if (run.error) {
            throw run.error;
        }
        expect(run.status, run.stderr).toBe(0);
        return JSON.parse(run.stdout);
    }

    it.each(MODES)("the %s loop ends with an error instead of spinning", (_, experimental) => {
        expect(runWithZeroBatch(experimental)).toEqual({
            error: "[HypaV3] Summarization made no progress at start index 0 with maxChatsPerSummary 0.",
            summaries: 0,
        });
    });
});

describe("summary chunk separator", () => {
    const SUMMARY = "first part\n\nsecond part";
    const unexpected = () => {
        throw new Error("unexpected call");
    };

    type Probe = {
        host: MemoryHost;
        ops: Array<{ op: RegexOp; opts?: { deadlineMs?: number } }>;
        progressOpened: () => boolean;
        embeddingsTouched: () => boolean;
    };

    /** A host whose only working services are the ones before the embedding step. */
    function probe(regex: (op: RegexOp, opts?: { deadlineMs?: number }) => Promise<RegexOpResult>): Probe {
        const ops: Probe["ops"] = [];
        let progressOpened = false;
        let embeddingsTouched = false;
        const signal = new AbortController().signal;
        const host: MemoryHost = {
            db: {} as MemoryHost["db"],
            tokenize: async () => 1,
            request: unexpected,
            completions: unexpected,
            summarizer: unexpected,
            get embeddings(): EmbeddingEnv {
                embeddingsTouched = true;
                throw new Error("no embeddings in this test");
            },
            regex: (op, opts) => {
                ops.push({ op, opts });
                return regex(op, opts);
            },
            parseChatML: () => null,
            userName: () => "User",
            progress: (payload) => {
                progressOpened ||= payload.open;
            },
            random: () => 0.5,
            redact: (text) => text,
            fence: () => signal.throwIfAborted(),
            signal,
        };
        return { host, ops, progressOpened: () => progressOpened, embeddingsTouched: () => embeddingsTouched };
    }

    async function run(
        probe: Probe,
        experimental: boolean,
        separator: string,
        summaries: string[] = [SUMMARY],
    ): Promise<Awaited<ReturnType<typeof hypaMemoryV3>>> {
        const preset = createHypaV3Preset("separator", {
            preserveOrphanedMemory: true,
            recentMemoryRatio: 0,
            similarMemoryRatio: 1,
            summaryChunkSeparator: separator,
            useExperimentalImpl: experimental,
        });
        Object.assign(probe.host.db, { maxResponse: 1, hypaV3Presets: [preset], hypaV3PresetId: preset.id });
        const chats: OpenAIChat[] = [{ role: "user", content: "Recent message", memo: "recent" }];
        const room = {
            hypaV3Data: { summaries: summaries.map((text) => ({ text, chatMemos: ["orphan"], isImportant: false })) },
        } as unknown as Chat;
        return hypaMemoryV3(probe.host, chats, 100, 1000, room, { name: "Probe" } as character, {
            tokenizeChat: async () => 1,
        });
    }

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe.each(MODES)("%s", (_, experimental) => {
        it.each([
            ["\\n\\n", "\\n\\n", ""],
            ["/\\n+/gi", "\\n+", "gi"],
        ])("sends the separator %s to the worker as a split", async (separator, pattern, flags) => {
            const p = probe(async (op) => ({ value: op.input.split(new RegExp(op.pattern, op.flags)) }));
            // The chunks reached the embedding step: the run failed there, not at the separator.
            await expect(run(p, experimental, separator)).rejects.toThrow("no embeddings in this test");
            expect(p.ops).toEqual([
                { op: { op: "split", pattern, flags, input: SUMMARY }, opts: { deadlineMs: expect.any(Number) } },
            ]);
            expect(p.ops[0].opts?.deadlineMs).toBeLessThanOrEqual(1000);
            expect(p.embeddingsTouched()).toBe(true);
        });

        it("keeps the double-newline fallback for an invalid pattern without a worker call", async () => {
            const p = probe(unexpected);
            await expect(run(p, experimental, "/(/")).rejects.toThrow("no embeddings in this test");
            expect(p.ops).toEqual([]);
            expect(p.embeddingsTouched()).toBe(true);
        });

        it("returns the worker's timeout as the memory error, keeps the summaries, and opens no overlay", async () => {
            const p = probe(async () => ({ error: "Regex timed out", timedOut: true }));
            const result = await run(p, experimental, "/(a+)+$/", ["aaaaaaaaaaaaaaaaaaaaaaaaaa!"]);
            expect(result.error).toBe("[HypaV3] Summary chunk separator failed: Error: Regex timed out");
            expect(result.memory?.summaries.map((summary) => summary.text)).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaa!"]);
            expect(result.chats).toHaveLength(1);
            expect(p.embeddingsTouched()).toBe(false);
            expect(p.progressOpened()).toBe(false);
        });

        it("stops at the chunking budget instead of splitting every summary", async () => {
            // The step's start, the first split's budget check, then a clock past the budget.
            vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(100).mockReturnValue(6000);
            const p = probe(async () => ({ value: ["part"] }));
            const result = await run(p, experimental, "\\n\\n", ["one", "two", "three"]);
            expect(p.ops).toHaveLength(1);
            expect(p.ops[0].opts).toEqual({ deadlineMs: 1000 });
            expect(result.error).toBe(
                "[HypaV3] Summary chunk separator failed: Error: Summary chunk separator timed out: 5000 ms chunking budget exhausted",
            );
            expect(result.memory?.summaries).toHaveLength(3);
            expect(p.embeddingsTouched()).toBe(false);
        });

        it("ends a catastrophic pattern on a real worker while the event loop stays free", async () => {
            const pool = createScriptWorkerPool({ rootDir: REPO_ROOT, size: 1, maxSize: 1 });
            try {
                // The host's adapter owns the deadline: 100 ms here instead of the production 1,000 ms.
                const p = probe((op) => pool.regex(op, { deadlineMs: 100 }));
                const started = performance.now();
                let timerFiredAfterMs: number | null = null;
                const timer = setTimeout(() => {
                    timerFiredAfterMs = performance.now() - started;
                }, 10);
                try {
                    const result = await run(p, experimental, "/(a+)+$/", ["a".repeat(26) + "!"]);
                    expect(result.error).toBe("[HypaV3] Summary chunk separator failed: Error: Regex timed out");
                } finally {
                    clearTimeout(timer);
                }
                expect(performance.now() - started).toBeLessThan(5000);
                expect(timerFiredAfterMs).not.toBeNull();
                expect(timerFiredAfterMs!).toBeLessThan(1000);
            } finally {
                await pool.dispose();
            }
        });
    });
});
