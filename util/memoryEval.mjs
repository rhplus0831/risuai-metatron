#!/usr/bin/env node
// Measures Structured Memory over the deterministic fixture chats and prints the figures as Markdown
// tables, with the raw values as JSON on request. Plain Node over the TypeScript fixtures under
// `server/src/tests/fixtures/memory/structured/` (type stripping), no Vitest, no package script.
//
//   node util/memoryEval.mjs [--lang ko,en] [--turns 100,1000] [--seed N] [--dir path]
//                            [--section eval,ledger,send,checkpoint,estimate,health,rate]
//                            [--json file] [--export dir] [--repeat N] [--max-context N]
//
// Every section states its conditions. `rate` takes 65 s of real time per case and runs only when
// asked for. The run fails with a non-zero exit on a window that did not record, a probe label that
// resolves to no record, or a scripted request the story did not expect; nothing is caught and shown
// as a number. The writer here is scripted and the embedding is lexical: the figures test the read
// path over known-good records and say nothing of a model's recall.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MEMORY_CALL_OVERHEAD_TOKENS, MEMORY_HEALTH_ROUND_BYTES } from "../shared/structuredMemory.ts";
import { createTokenizers, TOKENIZER_FAMILIES } from "../server/src/prompt/tokenizers/index.ts";
import { memoryWorkCost } from "../server/src/prompt/memory/structured/rebuild.ts";
import { generateStory, MIN_STORY_TURNS, storySizes } from "../server/src/tests/fixtures/memory/structured/story.ts";
import { SUMMARY_SHARE } from "../server/src/tests/fixtures/memory/structured/scriptedWriter.ts";
import {
    CHARACTER_ID,
    CHAT_ID,
    createFixture,
    longestStall,
    storyChatFile,
    storyProbesFile,
    timeAddText,
} from "../server/src/tests/fixtures/memory/structured/harness.ts";
import {
    analysisOverhead,
    median,
    scoreProbe,
    sendLedger,
    summarizeScores,
    writerLedger,
} from "../server/src/tests/fixtures/memory/structured/evaluate.ts";
import {
    createHealthStore,
    fileSystemOf,
    replayCheckpointPages,
    runPromptBytes,
    runRateCase,
    sqliteModes,
    timeCacheReads,
    timeHealth,
    writeSyntheticRuns,
} from "../server/src/tests/fixtures/memory/structured/measure.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = path.join(ROOT, "server/src/tests/fixtures/memory/structured");
const SECTIONS = ["eval", "ledger", "send", "checkpoint", "estimate", "health", "rate"];
const FAMILIES = ["o200k_base", "cl100k_base", "claude"];
const CACHE_SIZES = [1000, 2000, 4000, 8000];
const SYNTHETIC_RUNS = { runs: 2000, inputBytes: 32 * 1024 };
const HEALTH_SHAPES = [
    { chats: 1, events: 1000, runs: 0, bodyBytes: 200 },
    { chats: 1, events: 5000, runs: 0, bodyBytes: 200 },
    { chats: 1, events: 20000, runs: 0, bodyBytes: 200 },
    { chats: 1, events: 5000, runs: 0, bodyBytes: 4000 },
    { chats: 1, events: 0, runs: 1000, bodyBytes: 200 },
    { chats: 1, events: 0, runs: 5000, bodyBytes: 200 },
    { chats: 1, events: 0, runs: 20000, bodyBytes: 200 },
    { chats: 64, events: 1000, runs: 0, bodyBytes: 200 },
    { chats: 64, events: 5000, runs: 5000, bodyBytes: 200 },
];
/** A health store whose setup takes longer than this is said so in the output. */
const HEALTH_SETUP_NOTICE_MS = 60_000;
const RATE_SECONDS = 65;
const RATE_CASES = [
    { name: "60 chats, loopback", chats: 60, callDelayMs: 0, loadBefore: false, neighbour: false },
    { name: "70 chats, loopback", chats: 70, callDelayMs: 0, loadBefore: false, neighbour: false },
    { name: "200 chats, loopback", chats: 200, callDelayMs: 0, loadBefore: false, neighbour: false },
    { name: "200 chats, 40 ms per call", chats: 200, callDelayMs: 40, loadBefore: false, neighbour: false },
    { name: "200 chats, a read before each revision", chats: 200, callDelayMs: 0, loadBefore: true, neighbour: false },
    { name: "60 chats with a neighbour route", chats: 60, callDelayMs: 0, loadBefore: false, neighbour: true },
];

const { values: args } = parseArgs({
    options: {
        lang: { type: "string", default: "ko,en" },
        turns: { type: "string", default: "100,1000" },
        seed: { type: "string", default: "1" },
        dir: { type: "string" },
        section: { type: "string", default: SECTIONS.filter((name) => name !== "rate").join(",") },
        json: { type: "string" },
        export: { type: "string" },
        repeat: { type: "string", default: "7" },
        "max-context": { type: "string", default: "16384" },
    },
});
const languages = args.lang.split(",").filter(Boolean);
const turnCounts = args.turns.split(",").filter(Boolean).map(Number);
const seed = Number(args.seed);
const repeats = Number(args.repeat);
const maxContext = Number(args["max-context"]);
const dir = args.dir ?? os.tmpdir();
const sections = new Set(args.section.split(",").filter(Boolean));
for (const section of sections) {
    if (!SECTIONS.includes(section)) {
        throw new Error(`Unknown section ${section}; the sections are ${SECTIONS.join(", ")}`);
    }
}
for (const family of FAMILIES) {
    if (!TOKENIZER_FAMILIES.includes(family)) {
        throw new Error(`Unknown tokenizer family ${family}`);
    }
}

const out = [];
const print = (line = "") => {
    out.push(line);
    console.log(line);
};
const fmt = (value) =>
    typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(2)) : String(value ?? "");
const table = (headers, rows) => {
    print(`| ${headers.join(" | ")} |`);
    print(`| ${headers.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
        print(`| ${row.map(fmt).join(" | ")} |`);
    }
    print();
};
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const conditions = {
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    tokenizers: FAMILIES,
    fileSystem: fileSystemOf(dir),
    dir,
    repeats,
    seed,
    maxContext,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
};
const printConditions = (extra = {}) => {
    const all = { ...conditions, ...extra };
    print(
        `Conditions: Node ${all.node}, SQLite ${all.sqlite}, tokenizers ${all.tokenizers.join("/")}, ` +
            `temp dir on ${all.fileSystem}, ${all.repeats} repeats, seed ${all.seed}` +
            Object.entries(extra)
                .map(([key, value]) => `, ${key} ${value}`)
                .join(""),
    );
    print();
};

const tokenizers = createTokenizers({ rootDir: ROOT });
const counter = (family) => (text) => tokenizers.count(family, text);
const result = { conditions, sources: {}, fixtures: {} };
const started = performance.now();

try {
    // --- sizes of the source ---
    for (const name of ["story.ts", "scriptedWriter.ts", "harness.ts", "evaluate.ts", "measure.ts", "README.md"]) {
        result.sources[name] = statSync(path.join(FIXTURES, name)).size;
    }
    result.sources["util/memoryEval.mjs"] = statSync(fileURLToPath(import.meta.url)).size;
    print(`# Structured Memory evaluation`);
    print();
    print(
        `Source bytes: ${Object.entries(result.sources)
            .map(([name, bytes]) => `${name} ${bytes}`)
            .join(", ")}.`,
    );
    print();

    // --- the export ---
    if (args.export) {
        mkdirSync(args.export, { recursive: true });
        for (const language of languages) {
            for (const turns of turnCounts) {
                const story = generateStory({ language, turns, seed });
                const stem = path.join(args.export, `${language}-${turns}`);
                writeFileSync(`${stem}-chat.json`, JSON.stringify(storyChatFile(story)));
                writeFileSync(`${stem}-probes.json`, JSON.stringify(storyProbesFile(story), null, 2));
                print(`Exported ${stem}-chat.json and ${stem}-probes.json.`);
            }
        }
        print();
    }

    const fixtureSections = ["eval", "ledger", "send", "checkpoint", "estimate"];
    if (fixtureSections.some((section) => sections.has(section))) {
        for (const language of languages) {
            for (const turns of turnCounts) {
                await runFixture(language, turns);
            }
        }
    }
    if (sections.has("send")) {
        await runCacheReads();
    }
    if (sections.has("checkpoint")) {
        await runSyntheticCheckpoint();
    }
    if (sections.has("health")) {
        await runHealth();
    }
    if (sections.has("rate")) {
        await runRate();
    }
    print(`Done in ${seconds(performance.now() - started)}.`);
    if (args.json) {
        writeFileSync(args.json, JSON.stringify(result, null, 2));
        print(`Raw values written to ${args.json}.`);
    }
} finally {
    await tokenizers.dispose();
}

// ---------------------------------------------------------------------------------------------

async function runFixture(language, turns) {
    const key = `${language}-${turns}`;
    const story = generateStory({ language, turns, seed });
    const sizes = storySizes(story);
    const entry = (result.fixtures[key] = { language, turns, seed, sizes });
    print(`## Fixture ${key}`);
    print();
    print(
        `Generated: ${sizes.messages} messages, ${sizes.messageBytes} bytes of message text, ` +
            `${sizes.jsonBytes} bytes as JSON. Cast ${story.cast.join(", ")}; final stage ${story.finalStage.join(", ")}.`,
    );
    print();
    const fixture = createFixture({ story, algorithm: "structuredMemory", dir, tokenizers, maxContext });
    try {
        const estimate = sections.has("estimate")
            ? await memoryWorkCost(
                  fixture.store,
                  { chaId: CHARACTER_ID, chatId: CHAT_ID },
                  { mode: "rebuild", turns: 1 },
              )
            : null;
        const rebuildStart = performance.now();
        const rebuilt = await fixture.rebuild();
        const rebuildMs = performance.now() - rebuildStart;
        const byKind = {};
        for (const call of fixture.calls) {
            byKind[call.kind] = (byKind[call.kind] ?? 0) + 1;
        }
        const records = fixture.records();
        const receipts = { warnings: {}, unverified: {}, refused: {}, notRecorded: 0 };
        for (const row of records.runs) {
            const run = fixture.store.memory.readRecord(CHARACTER_ID, CHAT_ID, "runs", row.id).data;
            if (run.result !== "recorded") {
                receipts.notRecorded++;
            }
            for (const warning of run.receipt?.warnings ?? []) {
                receipts.warnings[warning.kind] = (receipts.warnings[warning.kind] ?? 0) + 1;
            }
            for (const item of run.receipt?.unverified ?? []) {
                receipts.unverified[item.reason] = (receipts.unverified[item.reason] ?? 0) + 1;
            }
            for (const item of run.receipt?.refused ?? []) {
                receipts.refused[item.refusal] = (receipts.refused[item.refusal] ?? 0) + 1;
            }
        }
        if (receipts.notRecorded > 0) {
            throw new Error(`${receipts.notRecorded} runs of ${key} did not record`);
        }
        entry.rebuild = {
            windows: rebuilt.windows,
            tasks: rebuilt.tasks,
            ms: rebuildMs,
            calls: byKind,
            unresolvedThreadCloses: fixture.scripted.unresolvedCloses,
            embeddingRequests: fixture.embeddings.requests,
            embeddedTexts: fixture.embeddings.texts,
            records: {
                events: records.events.length,
                pages: records.pages.length,
                threads: records.threads.length,
                runs: records.runs.length,
            },
            receipts,
        };
        print(
            `Rebuild: ${rebuilt.windows} windows in ${rebuilt.tasks} tasks, ${seconds(rebuildMs)}; calls ` +
                `${Object.entries(byKind)
                    .map(([kind, count]) => `${kind} ${count}`)
                    .join(", ")}; records ${records.events.length} events, ${records.pages.length} pages, ` +
                `${records.threads.length} threads; receipt warnings ${JSON.stringify(receipts.warnings)}, ` +
                `unverified ${JSON.stringify(receipts.unverified)}, refused ${JSON.stringify(receipts.refused)}.`,
        );
        print();

        if (sections.has("estimate")) {
            await runEstimate(fixture, story, estimate, entry);
        }

        // The probes: setups first, then every send, each over the same records.
        const sends = [];
        if (sections.has("eval") || sections.has("ledger")) {
            for (const probe of story.probes) {
                if (probe.setup) {
                    fixture.applySetup(probe.setup);
                }
            }
            for (const probe of story.probes) {
                sends.push({ probe, send: await fixture.send(probe.query, { diagnostics: sections.has("eval") }) });
            }
        }
        if (sections.has("eval")) {
            runEval(fixture, story, sends, entry);
        }
        if (sections.has("ledger")) {
            await runLedger(fixture, story, sends, entry);
        }
        if (sections.has("send")) {
            await runSendTiming(fixture, story, entry);
        }
        if (sections.has("checkpoint")) {
            runFixtureCheckpoint(fixture, entry);
        }
    } finally {
        await fixture.dispose();
    }
}

function runEval(fixture, story, sends, entry) {
    const records = fixture.records();
    const scores = sends.map(({ probe, send }) => scoreProbe(probe, send, records));
    const summary = summarizeScores(scores);
    entry.eval = { scores, summary };
    print(`### eval: capture and exclusion over the manifest`);
    print();
    printConditions();
    table(
        [
            "probe",
            "kind",
            "pass",
            "needed found",
            "forbidden leaked",
            "distractors selected",
            "events lane",
            "best lexical cosine",
            "lanes selected",
        ],
        scores.map((score) => [
            score.id,
            score.kind,
            score.pass === undefined ? "n/a" : score.pass ? "yes" : "no",
            `${score.needed.filter(({ found }) => found).length}/${score.needed.length}`,
            `${score.forbidden.filter(({ leaked }) => leaked).length}/${score.forbidden.length}`,
            `${score.distractors.filter(({ selected }) => selected).length}/${score.distractors.length}`,
            score.eventsOpen === undefined
                ? ""
                : `${score.eventsOpen ? "open" : "closed"} ${(score.eventReasons ?? []).join("/")}`,
            score.bestSimilarity === undefined ? "" : score.bestSimilarity.toFixed(2),
            Object.entries(score.selectedByLane)
                .map(([lane, count]) => `${lane} ${count}`)
                .join(", "),
        ]),
    );
    const boundary = scores.find((score) => score.boundary);
    if (boundary) {
        const { lineFound, inUnaware, elsewhere } = boundary.boundary;
        print(
            `Knowledge boundary: page line ${lineFound ? "found" : "missing"}, fact ${inUnaware ? "inside" : "not inside"} ` +
                `"does not know", ${elsewhere ? "also stated elsewhere on the line" : "stated nowhere else on the line"}.`,
        );
        print();
    }
    table(
        ["kind", "probes", "capture", "exclusion", "all parts present", "boundary held", "distractors selected"],
        summary.map((row) => [
            row.kind,
            row.probes,
            `${row.capture.found}/${row.capture.total}`,
            `${row.exclusion.absent}/${row.exclusion.total}`,
            `${row.allParts.present}/${row.allParts.total}`,
            `${row.boundary.held}/${row.boundary.total}`,
            `${row.distractors.selected}/${row.distractors.total}`,
        ]),
    );
}

async function runLedger(fixture, story, sends, entry) {
    print(`### ledger: tokens per chat, structured memory beside HypaV3`);
    print();
    printConditions({ maxContext: fixture.maxContext, maxResponse: fixture.maxResponse });
    const structured = { writer: {}, sends: {} };
    for (const family of FAMILIES) {
        structured.writer[family] = await writerLedger(fixture.calls, counter(family));
        structured.sends[family] = [];
        for (const { probe, send } of sends) {
            structured.sends[family].push({ probe: probe.id, ...(await sendLedger(send, counter(family))) });
        }
    }
    const hypa = createFixture({
        story,
        algorithm: "hypaV3",
        dir,
        tokenizers,
        maxContext: fixture.maxContext,
        maxResponse: fixture.maxResponse,
    });
    let hypaSide;
    try {
        const summarizeStart = performance.now();
        const summarized = await hypa.summarize();
        hypaSide = {
            handOffs: summarized.handOffs,
            stopReason: summarized.stopReason,
            ms: performance.now() - summarizeStart,
            summaries: hypa.calls.length,
            writer: {},
            sends: {},
        };
        for (const family of FAMILIES) {
            hypaSide.writer[family] = await writerLedger(hypa.calls, counter(family));
            hypaSide.sends[family] = [];
            for (const { probe } of sends) {
                const send = await hypa.send(probe.query);
                hypaSide.sends[family].push({ probe: probe.id, ...(await sendLedger(send, counter(family))) });
            }
        }
    } finally {
        await hypa.dispose();
    }
    entry.ledger = { structured, hypaV3: hypaSide };
    const row = (label, totals) => [
        label,
        totals.calls,
        totals.inputTokens,
        totals.outputTokens,
        totals.inputChars,
        totals.outputChars,
    ];
    for (const family of FAMILIES) {
        print(`Writer calls, ${family}:`);
        print();
        const w = structured.writer[family];
        const h = hypaSide.writer[family];
        table(
            ["call", "calls", "input tokens", "output tokens", "input chars", "output chars"],
            [
                row("structured analysis", w.analysis),
                row("structured patch", w.patch),
                row("structured compaction", w.compaction),
                row("structured total", {
                    calls: w.analysis.calls + w.patch.calls + w.compaction.calls,
                    inputTokens: w.analysis.inputTokens + w.patch.inputTokens + w.compaction.inputTokens,
                    outputTokens: w.analysis.outputTokens + w.patch.outputTokens + w.compaction.outputTokens,
                    inputChars: w.analysis.inputChars + w.patch.inputChars + w.compaction.inputChars,
                    outputChars: w.analysis.outputChars + w.patch.outputChars + w.compaction.outputChars,
                }),
                row("HypaV3 summary", h.summary),
            ],
        );
        const med = (list, field) => median(list.map((item) => item[field]));
        print(`Per send (median over ${sends.length} probe sends), ${family}:`);
        print();
        table(
            ["algorithm", "card tokens", "raw history tokens", "raw entries"],
            [
                [
                    "structured memory",
                    med(structured.sends[family], "cardTokens"),
                    med(structured.sends[family], "rawTokens"),
                    med(structured.sends[family], "rawEntries"),
                ],
                [
                    "HypaV3",
                    med(hypaSide.sends[family], "cardTokens"),
                    med(hypaSide.sends[family], "rawTokens"),
                    med(hypaSide.sends[family], "rawEntries"),
                ],
            ],
        );
    }
    print(
        `HypaV3 side: ${hypaSide.handOffs} hand-offs, stopped ${hypaSide.stopReason}, ${hypaSide.summaries} summaries ` +
            `in ${seconds(hypaSide.ms)}; summaries are a fixed ${SUMMARY_SHARE} share of their window's text. A token-shape ledger, not a capture comparison.`,
    );
    print();
}

async function runEstimate(fixture, story, estimate, entry) {
    print(`### estimate: the cost preview against the analysis calls`);
    print();
    printConditions();
    const turnText = new Map(story.turns.map((turn) => [turn.turn, `${turn.user}\n${turn.char}`]));
    const windowText = (call) => turnText.get(call.turn) ?? "";
    const windowBytes = [...turnText.values()].reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    const families = {};
    for (const family of FAMILIES) {
        const ledger = await writerLedger(fixture.calls, counter(family));
        const overhead = await analysisOverhead(fixture.calls, windowText, counter(family));
        const windowTokens = overhead.find(({ part }) => part === "all").windowTokens;
        families[family] = { ledger, overhead, windowBytes, windowTokens, bytesPerToken: windowBytes / windowTokens };
    }
    entry.estimate = { preview: estimate, overheadConstant: MEMORY_CALL_OVERHEAD_TOKENS, families };
    table(
        [
            "family",
            "preview calls",
            "preview tokens",
            "analysis calls",
            "analysis input",
            "ratio actual/preview",
            "patch input (beside)",
            "compaction input (beside)",
            "window bytes/token",
        ],
        FAMILIES.map((family) => {
            const { ledger, bytesPerToken } = families[family];
            return [
                family,
                estimate.calls,
                estimate.estimatedTokens,
                ledger.analysis.calls,
                ledger.analysis.inputTokens,
                ledger.analysis.inputTokens / estimate.estimatedTokens,
                ledger.patch.inputTokens,
                ledger.compaction.inputTokens,
                bytesPerToken,
            ];
        }),
    );
    for (const family of FAMILIES) {
        print(
            `Analysis overhead over the window's raw text, ${family} (constant ${MEMORY_CALL_OVERHEAD_TOKENS} per call):`,
        );
        print();
        table(
            [
                "calls",
                "count",
                "input tokens",
                "window tokens",
                "overhead per call",
                "cast chars",
                "scene chars",
                "threads chars",
                "previous chars",
            ],
            families[family].overhead.map((row) => [
                row.part,
                row.calls,
                row.inputTokens,
                row.windowTokens,
                row.overheadPerCall,
                row.slots.cast,
                row.slots.scene,
                row.slots.threads,
                row.slots.previous,
            ]),
        );
    }
}

async function runSendTiming(fixture, story, entry) {
    print(`### send: the read path's components, warm cache`);
    print();
    printConditions();
    const queries = [
        story.probes.find(({ id }) => id === "needed-event"),
        story.probes.find(({ id }) => id === "control"),
    ];
    const rows = [];
    entry.send = { queries: [] };
    for (const probe of queries) {
        await fixture.send(probe.query);
        const reads = [];
        const selects = [];
        const addTexts = [];
        const gets = [];
        const tokenizeCalls = [];
        const tokenizeMs = [];
        const stalls = [];
        for (let repeat = 0; repeat < repeats; repeat++) {
            const {
                result: { result: send, addTextMs },
                stallMs,
            } = await longestStall(() => timeAddText(() => fixture.send(probe.query)));
            reads.push(send.timings.readMs);
            selects.push(send.timings.selectMs);
            addTexts.push(addTextMs);
            gets.push(send.cacheGets);
            tokenizeCalls.push(send.timings.tokenizeCalls);
            tokenizeMs.push(send.timings.tokenizeMs);
            stalls.push(stallMs);
        }
        const planning = Array.from({ length: repeats }, () => fixture.timePlanningReads());
        const measured = {
            probe: probe.id,
            readMemoryRecordsMs: median(reads),
            selectMemoryMs: median(selects),
            ofWhichAddTextMs: median(addTexts),
            cacheGets: median(gets),
            tokenizeCalls: median(tokenizeCalls),
            tokenizeMs: median(tokenizeMs),
            longestStallMs: median(stalls),
            planningRerecordMs: median(planning.map(({ rerecordMs }) => rerecordMs)),
            planningRecordedMs: median(planning.map(({ recordedMs }) => recordedMs)),
        };
        entry.send.queries.push(measured);
        rows.push([
            probe.id,
            measured.readMemoryRecordsMs,
            measured.selectMemoryMs,
            measured.ofWhichAddTextMs,
            measured.cacheGets,
            measured.tokenizeCalls,
            measured.tokenizeMs,
            measured.longestStallMs,
            measured.planningRerecordMs,
            measured.planningRecordedMs,
        ]);
    }
    table(
        [
            "query",
            "readMemoryRecords ms",
            "selectMemory ms",
            "of which addText ms",
            "cache.get calls",
            "tokenizeChat calls",
            "tokenizeChat busy ms",
            "longest stall ms",
            "readRerecordEvents ms (task)",
            "readRecordedMessages ms (task)",
        ],
        rows,
    );
    print(
        `The last two columns are the writer task's planning reads, not part of a send. ` +
            `The send is \`readMemoryRecords\` and \`selectMemory\` alone: admission, assembly, and the hand-off are outside it. ` +
            `"tokenizeChat" is the selection's own counting (the dropped entries, the card's lines and parts, the trim), ` +
            `its busy time being the time any call was in flight, overlapping calls counted once; ` +
            `"longest stall" is the longest gap between two setImmediate ticks during the send: how long the thread was held. ` +
            `The scripted embedding answers without real I/O, so a production send yields once more, ` +
            `at the query's embedding call, than this one does.`,
    );
    print();
}

async function runCacheReads() {
    print(`## send: cache reads beside addText, fresh processor per pass`);
    print();
    printConditions();
    const rows = await timeCacheReads(dir, CACHE_SIZES, repeats);
    result.cacheReads = rows;
    table(
        ["texts", "distinct keys", "cache.get calls", "cache reads alone ms", "addText ms"],
        rows.map((row) => [row.texts, row.distinctKeys, row.cacheGets, row.cacheReadsMs, row.addTextMs]),
    );
}

function runFixtureCheckpoint(fixture, entry) {
    print(`### checkpoint: real saves over the fixture's records`);
    print();
    const file = path.join(fixture.dir, "resources.sqlite");
    const modes = sqliteModes(file);
    printConditions({ journal: modes.journal, synchronous: modes.synchronous });
    const first = fixture.checkpointSave("first");
    const second = fixture.checkpointSave("second");
    const replay = replayCheckpointPages(file, CHAT_ID, dir);
    entry.checkpoint = { firstMs: first, secondMs: second, replay };
    table(
        ["save", "ms"],
        [
            ["first", first],
            ["second, no change", second],
        ],
    );
    printReplay(replay);
}

function printReplay(replay) {
    print(`Replayed attribution (the same steps on a scratch page table; not the real save's split):`);
    print();
    table(
        [
            "round",
            "total ms",
            "read",
            "JSON.stringify",
            "byteLength",
            "row-id SHA",
            "join",
            "page SHA",
            "inserts",
            "residual",
            "raw bytes",
            "encoded bytes",
            "pages",
            "inserted",
        ],
        replay.map((round) => [
            round.round === 0 ? "first" : "second",
            round.totalMs,
            round.parts.read,
            round.parts.stringify,
            round.parts.byteLength,
            round.parts.idHash,
            round.parts.join,
            round.parts.pageHash,
            round.parts.insert,
            round.residualMs,
            round.rawBytes,
            round.encodedBytes,
            round.pages,
            round.inserted,
        ]),
    );
}

// The seeded runs are rows an older build left: recorded runs still holding their prompts. One live
// recording through the real writer and task service settles a run, which prunes the chat's run history
// in that commit; the saves are timed over what it leaves.
async function runSyntheticCheckpoint() {
    print(
        `## checkpoint: real saves over ${SYNTHETIC_RUNS.runs} seeded runs of ${SYNTHETIC_RUNS.inputBytes} bytes ` +
            `after one live recording`,
    );
    print();
    const story = generateStory({ language: "en", turns: MIN_STORY_TURNS, seed });
    const fixture = createFixture({ story, algorithm: "structuredMemory", dir });
    try {
        const file = path.join(fixture.dir, "resources.sqlite");
        const ref = { characterId: CHARACTER_ID, chatId: CHAT_ID };
        writeSyntheticRuns(fixture.store, ref, SYNTHETIC_RUNS.runs, SYNTHETIC_RUNS.inputBytes);
        const seeded = runPromptBytes(file, CHAT_ID);
        const modes = sqliteModes(file);
        printConditions({ journal: modes.journal, synchronous: modes.synchronous, storyTurns: story.turns.length });
        const recordStart = performance.now();
        // The first user message of turn 2 confirms turn 1: one window, one recorded commit.
        await fixture.record(story.turns[1].userId);
        const recordMs = performance.now() - recordStart;
        const left = runPromptBytes(file, CHAT_ID);
        const first = fixture.checkpointSave("first");
        const second = fixture.checkpointSave("second");
        const replay = replayCheckpointPages(file, CHAT_ID, dir);
        result.checkpointSynthetic = {
            ...SYNTHETIC_RUNS,
            seeded,
            recordMs,
            left,
            firstMs: first,
            secondMs: second,
            replay,
        };
        table(
            ["memory_runs", "rows", "holding prompts", "prompt bytes", "run data bytes"],
            [
                ["seeded", seeded.runs, seeded.holding, seeded.promptBytes, seeded.dataBytes],
                ["after the recording", left.runs, left.holding, left.promptBytes, left.dataBytes],
            ],
        );
        table(
            ["step", "ms"],
            [
                ["the recording (one window, its calls scripted)", recordMs],
                ["first save", first],
                ["second save, no change", second],
            ],
        );
        printReplay(replay);
    } finally {
        await fixture.dispose();
    }
}

async function runHealth() {
    print(`## health: readHealth over many events and runs`);
    print();
    printConditions({ budgetBytes: MEMORY_HEALTH_ROUND_BYTES });
    const rows = [];
    for (const shape of HEALTH_SHAPES) {
        const setupStart = performance.now();
        const scratch = createHealthStore(dir, shape);
        const setupMs = performance.now() - setupStart;
        try {
            const { medianMs, answered } = timeHealth(scratch, MEMORY_HEALTH_ROUND_BYTES, repeats);
            rows.push({ ...shape, medianMs, answered, setupMs });
        } finally {
            scratch.dispose();
        }
    }
    result.health = rows;
    table(
        ["chats", "events per chat", "runs per chat", "event body bytes", "median ms", "refs answered", "setup s"],
        rows.map((row) => [
            row.chats,
            row.events,
            row.runs,
            row.bodyBytes,
            row.medianMs,
            row.answered,
            row.setupMs / 1000,
        ]),
    );
    for (const row of rows.filter((row) => row.setupMs > HEALTH_SETUP_NOTICE_MS)) {
        print(
            `Writing the ${row.chats} chats of ${row.events} events and ${row.runs} runs took ${seconds(row.setupMs)}, ` +
                `longer than a minute; that is the store's bulk write, not the health read.`,
        );
        print();
    }
}

async function runRate() {
    print(`## rate: the revisions route under the default limiter, real server, real time`);
    print();
    printConditions({ secondsPerCase: RATE_SECONDS });
    const rows = [];
    for (const testCase of RATE_CASES) {
        const caseStart = performance.now();
        const measured = await runRateCase({ ...testCase, seconds: RATE_SECONDS });
        rows.push({ ...measured, wallMs: performance.now() - caseStart });
        print(`Ran "${testCase.name}" in ${seconds(performance.now() - caseStart)}.`);
    }
    print();
    result.rate = rows;
    table(
        [
            "case",
            "chats",
            "delay ms",
            "read before",
            "revision calls",
            "load calls",
            "first-minute requests",
            "denied",
            "first 429 at s",
            "latency median ms",
            "latency p95 ms",
            "limit",
        ],
        rows.map((row) => [
            row.name,
            row.chats,
            row.callDelayMs,
            row.loadBefore ? "yes" : "no",
            row.revisionRequests,
            row.loadRequests,
            row.firstMinuteRequests,
            row.denied,
            row.firstDeniedAtS === null ? "none" : row.firstDeniedAtS,
            row.revisionLatencyMs.median,
            row.revisionLatencyMs.p95,
            row.limit,
        ]),
    );
    const neighbour = rows.find((row) => row.neighbour);
    if (neighbour) {
        print(`The neighbour route (GET /api/resources/ui/main every 10 ms) beside 60 chats, per ten seconds:`);
        print();
        table(
            ["from s", "requests", "denied"],
            neighbour.neighbour.map((bucket) => [bucket.bucketS, bucket.requests, bucket.denied]),
        );
    }
    print(
        `The walker is a serial loop reproducing the client's two-second recheck window for one chat per call; ` +
            `the client code itself did not run, and the seeding requests count against the same per-IP window.`,
    );
    print();
}
