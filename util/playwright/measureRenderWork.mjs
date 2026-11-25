// Measures chat rendering in the dev stack, with cold transform/translation inputs, in system Chrome.
// Numbers are observations, never budgets: only driver failures, page errors, or unexpected egress
// fail the run. Open/settle/export timeouts and missing metrics are reported in JSON and Markdown.
// Linux /proc is used for renderer and GPU memory; canvas memory is not represented by JS heap.
//
// Each scenario gets a new context and a newly bound chat: N alternating user/assistant messages,
// plus one plain greeting (reported separately). Assistant messages repeat exactly one sheet
// (a leading webfont @import, one font-family rule, 500 selector rules) and 12 short JS fences.
// Their prose uses RenderWorkFixture (KaTeX_Main-Regular.woff2 resolved from the installed katex).
// The mock provider serves the imported CSS and font locally with CORS; fixtureRequests records
// both request counts. Every message and the greeting has a fresh scenario nonce, outside
// the sheet. One chat is seeded per batch, below the API's 100 MiB body cap even at 600 messages.
// The translation target language is en (an empty language disables a chat's auto-translate).
// Translation uses the rendered target, not stored message translations. Both formatting flags
// keep their defaults (false): markParsing takes ParseMarkdown(pretranslate), translateHTML,
// postTranslationParse. The default one-step translator sends a system instruction and user text;
// the mock echoes that text with 'Translated: ', preserving style-data placeholders, after 75 ms.
//
// Coverage uses each named function's FIRST range count with callCount:true and detailed:true:
// its invocation count, excluding async resumptions, verified with a standalone inspector probe
// (an async function with three awaits called twice counts two; a sync call counts one).
// CSS preparations per distinct sheet use the cssTools.parse coverage count, including 'absent'.
// Coverage starts before app navigation so functions compile with block coverage; boot and Away
// warmup counts are discarded before the Render open. Profile and screenshot never enable it.
// Source declarations distinguish an uncalled/lazily compiled function (0) from an absent function.
// Matches use URL pathnames without Vite queries and the single table below; absent functions are
// 'absent', not zero. Optimized css-tools' parse is matched only in its own dependency module,
// resolving a minified local function name from that module's explicit named export when needed;
// unidentifiable dependency functions stay absent, with candidate names recorded. Coverage adds
// overhead. Only open, switch, and switch-mounted enable the Profiler domain. Open reports work
// counts without mount timings or a trace. Profile uses its own fresh chat/context without coverage
// or the Profiler domain: its timings and trace cover the open-button click through settling.
// Long tasks are outer renderer-main RunTask events >=50 ms; frame gaps use DrawFrame
// (or BeginFrame) on one renderer thread. No synthetic animation loop is added to the workload.
// DrawFrame gaps include idle intervals without a redraw; they are not dropped-frame counts.
//
// Open uses openCharacterChat for Away first, then a prepared DOM button click for Render so no
// text locator scans the transcript during measurement. First-visible polls only the first body.
// Settled means N translated message bodies and the greeting, no spinners/held rows, and 1500 ms
// without transform, browser translation, or provider activity. Both switch scenarios select home
// with selectCharacter(null), verify that no .risu-chat rows remain anywhere, then wait for quiet
// alone. Switch starts its timer at the open click. Switch-mounted uses a MutationObserver to
// record when all N message rows mount and start the same timer, allowing their render/translation
// pipelines to begin without waiting for their bodies to finish rendering.
// A debugger statement in the switching callback pauses the renderer for the coverage snapshot
// and home store call, so no render work runs
// between that counter boundary and the switch; source/name resolution is deferred until after
// measurement. Mount time from open, actual switch delay after mount, total switch delay, trigger
// delay, coverage-to-switch skew, and mounted and
// translated row counts at the switch are reported (a busy main thread can delay the command).
//
// Renderer PID: a short, premeasurement blink.user_timing trace locates a unique page performance
// mark's PID, validated against browser CDP SystemInfo's renderer list. New renderer candidates
// are also recorded (Chrome can create a WebUI renderer as well as this page). GPU is the sole GPU
// process. Before export, GC then /proc status, then clear_refs=5 on each PID; if refused, VmHWM
// delta remains a historical-high-water delta, not an isolated export peak.
// Each download event samples both PIDs before waiting for the PNG file: RSS at that notification,
// and cumulative HWM since the pre-export reset (not a separate peak for each page). The renderer
// can already be capturing the next page. Samples do not pause export or force GC. If HWM drops
// during export, observedVmHwmBytes preserves the largest read; an unsampled peak can still be missed.
// End-of-export RSS is also sampled after the existing GC. Optional heap snapshots follow these metrics;
// they cover V8/Oilpan, not all native image/canvas memory, and can themselves trigger collection.
// All downloads through the success/error alert (or timeout) are read, including multipart Blob exports;
// PNG signature, IHDR, dimensions and IEND are checked. Files are inspected in Playwright's temporary download
// storage, not retained. Trace gzip files and the default trace directory ARE retained.
//
// Env: ROWS=30,150,600; SCENARIOS=open,profile,switch,switch-mounted,screenshot;
// SWITCH_DELAY_MS=100 (after the open click for switch; after all N message rows mount for switch-mounted);
// SCREENSHOT_TIMEOUT_MS=900000; RENDER_OUT=<JSON file> (JSON always also printed to stdout);
// RENDER_HEAP_SNAPSHOT=<file> (optional post-export CDP snapshot; {rows} expands to the row count,
// or .<rows> is appended for multiple ROWS to avoid overwriting); path/bytes/timing are in JSON.
// RENDER_TRACE_DIR=<directory> (default: kept temp directory, printed); DEBUG=1 (stack to stderr).
// RISU_CHROME is honored by stack.mjs. Viewport 1280x800, headless; one dev stack at a time.
// Usage: ROWS=30 util/playwright/offline.sh node util/playwright/measureRenderWork.mjs
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
import {
    chromePath,
    clearSafeBootAttempts,
    isolateContext,
    openApp,
    openCharacterChat,
    repoRoot,
    startStack,
    unexpectedEgress,
} from "./stack.mjs";

const FUNCTIONS = [
    ...["ParseMarkdown", "decodeStyleContent", "trimMarkdownSharingStyles", "restoreStyles", "scopeCss"].map(
        (name) => ({ name, pathname: "/src/ts/parser/parser.svelte.ts" }),
    ),
    ...["translateHTML", "translateLLM", "getLLMCache"].map((name) => ({
        name,
        pathname: "/src/ts/translator/translator.ts",
    })),
    { name: "serverProcessScript", pathname: "/src/ts/parser/transformClient.ts" },
    { name: "markParsing", pathname: "/src/lib/ChatScreens/ChatBody.svelte" },
    {
        name: "cssTools.parse",
        functionName: "parse",
        exportName: "parse",
        dependency: /\/node_modules\/\.vite\/deps\/@adobe_css-tools\.js$/,
    },
];
const ROWS = (process.env.ROWS ?? "30,150,600").split(",").map(Number);
const SCENARIO_NAMES = ["open", "profile", "switch", "switch-mounted", "screenshot"];
const SCENARIOS = (process.env.SCENARIOS ?? SCENARIO_NAMES.join(",")).split(",").map((s) => s.trim());
const SWITCH_DELAY_MS = Number(process.env.SWITCH_DELAY_MS ?? 100);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 900_000);
const QUIET_MS = 1500;
const SETTLE_TIMEOUT_MS = 600_000;
const PREFIX = "Translated: ";
const FONT_FAMILY = "RenderWorkFixture";
const FONT_CSS_PATH = "/render-fixture/font.css";
const FONT_PATH = "/render-fixture/font.woff2";
const FONT_SOURCE = "katex/dist/fonts/KaTeX_Main-Regular.woff2";
const SHEET = Array.from({ length: 500 }, (_, n) => `.panel${n} .item${n}:hover{color:red;padding:1px 2px}`).join("");
const FENCES = Array.from({ length: 12 }, (_, n) => `\`\`\`js\nconst item${n} = ${n};\n\`\`\``).join("\n\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 100) / 100;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const log = (message) => process.stderr.write(`${message}\n`);
const report = {
    startedAt: new Date().toISOString(),
    environment: {
        node: process.version,
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        platform: process.platform,
        commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    },
    configuration: {
        rows: ROWS,
        scenarios: SCENARIOS,
        switchDelayMs: SWITCH_DELAY_MS,
        screenshotTimeoutMs: SCREENSHOT_TIMEOUT_MS,
        quietMs: QUIET_MS,
        settleTimeoutMs: SETTLE_TIMEOUT_MS,
        viewport: { width: 1280, height: 800 },
        distinctSheets: 1,
        sheetRules: 502,
        sheetBytes: null,
        webfont: {
            family: FONT_FAMILY,
            stylesheetUrl: null,
            fontPath: FONT_PATH,
            source: FONT_SOURCE,
            accessControlAllowOrigin: "*",
            importedRules: 1,
        },
        fencesPerAssistant: 12,
        providerDelayMs: 75,
        extraGreetingRows: 1,
        coverageCount:
            "first function range with detailed:true is its invocation count; async resumptions excluded (verified with an inspector probe)",
    },
    results: [],
    fixtureRequests: { fontCss: 0, font: 0 },
    errors: [],
};

function requestSummary(records) {
    const transforms = records.filter((r) => r.kind === "transform");
    const translations = records.filter((r) => r.kind === "translation");
    return {
        transformRequests: transforms.length,
        transformTargets: transforms.reduce((sum, r) => sum + r.targets, 0),
        translationRequests: translations.length,
        translationStarts: translations.filter((r) => r.pathname === "/api/llm/request").length,
        failedRequests: records.filter((r) => r.failure).length,
        records,
    };
}

function providerSummary(records) {
    const counts = new Map();
    for (const r of records) counts.set(r.textKey, (counts.get(r.textKey) ?? 0) + 1);
    return {
        requests: records.length,
        distinctTexts: counts.size,
        maxRequestsPerText: Math.max(0, ...counts.values()),
        records,
    };
}

function watch(page) {
    const state = { auth: null, epoch: null, requests: [], pageErrors: [], lastActivity: Date.now() };
    const byRequest = new Map();
    page.on("pageerror", (error) => state.pageErrors.push(String(error)));
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) state.auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) state.epoch = headers["x-resource-epoch"];
        const pathname = new URL(request.url()).pathname;
        if (request.method() !== "POST") return;
        let body;
        try {
            body = request.postDataJSON();
        } catch {
            return;
        }
        const transform = /^\/api\/transform(?:\/continue)?$/.test(pathname);
        const translation =
            (pathname === "/api/llm/request" && body?.mode === "translate") ||
            /^\/api\/llm\/request\/[^/]+\/answer$/.test(pathname);
        if (!transform && !translation) return;
        const record = {
            kind: transform ? "transform" : "translation",
            pathname,
            startedAt: Date.now(),
            finishedAt: null,
            targets: Array.isArray(body?.targets) ? body.targets.length : 0,
            targetIdentities: body?.targets?.map((t) => ({
                id: t.id,
                messageId: t.messageId,
                sourceId: t.sourceId,
                chatIndex: t.chatIndex,
                textKey: typeof t.source === "string" ? hash(t.source) : null,
            })),
            context: body?.context,
            translationTextKey: body?.arg?.formated ? hash(JSON.stringify(body.arg.formated)) : undefined,
        };
        byRequest.set(request, record);
        state.requests.push(record);
        state.lastActivity = record.startedAt;
    });
    const finish = (request, failure = null) => {
        const record = byRequest.get(request);
        if (!record) return;
        record.finishedAt = Date.now();
        record.failure = failure;
        state.lastActivity = record.finishedAt;
        byRequest.delete(request);
    };
    page.on("requestfinished", (r) => finish(r));
    // Row cancellation is an observation, not a page error or driver failure.
    page.on("requestfailed", (r) => finish(r, r.failure()?.errorText ?? "failed"));
    page.on("response", (response) => {
        const epoch = response.headers()["x-resource-epoch"];
        if (epoch) state.epoch = epoch;
        const record = byRequest.get(response.request());
        if (record) record.status = response.status();
    });
    return state;
}

function coverageReader(cdp) {
    const locations = new Map();
    const dependencyCandidates = new Set();
    const samples = [];
    const exportNames = new Map();
    const sources = new Map();
    const declarations = new Map();
    return {
        async take() {
            const { result, timestamp } = await cdp.send("Profiler.takePreciseCoverage");
            const sample = { timestamp, receivedAt: Date.now(), functions: {} };
            samples.push({ sample, result });
            return sample;
        },
        async finish() {
            for (const { sample, result } of samples) {
                const values = Object.fromEntries(FUNCTIONS.map((f) => [f.name, 0]));
                for (const script of result) {
                    let pathname;
                    try {
                        pathname = new URL(script.url).pathname;
                    } catch {
                        continue;
                    }
                    if (/adobe.*css.*tools/i.test(pathname)) {
                        for (const fn of script.functions) dependencyCandidates.add(`${pathname}:${fn.functionName}`);
                    }
                    for (const entry of FUNCTIONS) {
                        if (entry.dependency ? !entry.dependency.test(pathname) : pathname !== entry.pathname) continue;
                        let functionName = entry.functionName ?? entry.name;
                        if (!sources.has(pathname)) {
                            const response = await fetch(script.url);
                            if (!response.ok) throw new Error(`Cannot inspect coverage script: ${script.url}`);
                            sources.set(pathname, await response.text());
                        }
                        const source = sources.get(pathname);
                        if (entry.exportName) {
                            if (!exportNames.has(pathname)) {
                                const exports = [...source.matchAll(/export\s*\{([^}]+)\}/g)];
                                const alias = exports
                                    .flatMap((match) => match[1].split(","))
                                    .map((part) =>
                                        part.trim().match(new RegExp(`^(\\w+)\\s+as\\s+${entry.exportName}$`)),
                                    )
                                    .find(Boolean)?.[1];
                                exportNames.set(pathname, alias ?? functionName);
                            }
                            functionName = exportNames.get(pathname);
                        }
                        const declaration = new RegExp(
                            `^\\s*(?:export\\s+)?(?:(?:async\\s+)?function\\s+${functionName}\\s*\\(|(?:const|let|var)\\s+${functionName}\\s*=)`,
                            "m",
                        );
                        if (declaration.test(source))
                            declarations.set(entry.name, { name: entry.name, pathname, functionName });
                        for (const fn of script.functions) {
                            if (fn.functionName !== functionName) continue;
                            values[entry.name] += fn.ranges[0]?.count ?? 0;
                            locations.set(`${entry.name}:${script.scriptId}:${fn.ranges[0]?.startOffset}`, {
                                name: entry.name,
                                pathname,
                                functionName: fn.functionName,
                                startOffset: fn.ranges[0]?.startOffset,
                                endOffset: fn.ranges[0]?.endOffset,
                            });
                        }
                    }
                }
                sample.functions = values;
            }
            const found = new Set([...declarations.keys(), ...[...locations.values()].map((l) => l.name)]);
            for (const { sample } of samples) {
                for (const entry of FUNCTIONS) if (!found.has(entry.name)) sample.functions[entry.name] = "absent";
            }
            return {
                locations: [...locations.values()],
                sourceDeclarations: [...declarations.values()],
                absent: FUNCTIONS.filter((f) => !found.has(f.name)).map((f) => f.name),
                dependencyCandidates: [...dependencyCandidates],
            };
        },
    };
}

function traceMetrics(events, rendererPid) {
    const main = events.find(
        (e) => e.ph === "M" && e.name === "thread_name" && e.pid === rendererPid && e.args?.name === "CrRendererMain",
    );
    if (!main) return { unavailable: "Renderer main thread not identified in trace", rendererPid };
    const tasks = events
        .filter(
            (e) =>
                e.pid === main.pid &&
                e.tid === main.tid &&
                e.ph === "X" &&
                /^(?:ThreadControllerImpl::)?RunTask$/.test(e.name),
        )
        .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    let end = -Infinity;
    const durations = [];
    for (const task of tasks) {
        if (task.ts < end) continue;
        end = task.ts + task.dur;
        if (task.dur >= 50_000) durations.push(task.dur / 1000);
    }
    const series = new Map();
    for (const e of events) {
        if (e.pid !== main.pid || !["DrawFrame", "BeginFrame"].includes(e.name) || e.ph === "E") continue;
        const key = `${e.name}:${e.tid}`;
        if (!series.has(key)) series.set(key, []);
        series.get(key).push(e.ts);
    }
    const preferred = [...series].filter(([key]) => key.startsWith("DrawFrame:"));
    const choices = preferred.length ? preferred : [...series];
    choices.sort((a, b) => b[1].length - a[1].length);
    const [frameSource, times] = choices[0] ?? [null, []];
    const sortedTimes = [...new Set(times)].sort((a, b) => a - b);
    const gaps = sortedTimes
        .slice(1)
        .map((ts, i) => (ts - sortedTimes[i]) / 1000)
        .sort((a, b) => a - b);
    const percentile = (p) => (gaps.length ? round(gaps[Math.ceil(p * gaps.length) - 1]) : null);
    return {
        rendererPid,
        mainThreadId: main.tid,
        taskEvents: tasks.length,
        longTasks: {
            count: durations.length,
            totalMs: round(durations.reduce((a, b) => a + b, 0)),
            maxMs: round(Math.max(0, ...durations)),
        },
        frames: {
            source: frameSource,
            intervals: gaps.length,
            medianMs: percentile(0.5),
            p95Ms: percentile(0.95),
            maxMs: gaps.length ? round(gaps.at(-1)) : null,
            over50Ms: gaps.filter((g) => g > 50).length,
            unavailable: gaps.length ? undefined : "No frame interval events on the renderer",
        },
    };
}

async function readTrace(cdp) {
    const completed = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    const { stream } = await completed;
    const chunks = [];
    try {
        for (;;) {
            const part = await cdp.send("IO.read", { handle: stream });
            chunks.push(Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8"));
            if (part.eof) break;
        }
    } finally {
        await cdp.send("IO.close", { handle: stream });
    }
    return Buffer.concat(chunks);
}

async function identifyRenderer(cdp, page, browserCdp, oldProcesses) {
    const marker = `renderer-${randomUUID()}`;
    await cdp.send("Tracing.start", { categories: "blink.user_timing", transferMode: "ReturnAsStream" });
    await page.evaluate((marker) => {
        performance.mark(marker);
        performance.clearMarks(marker);
    }, marker);
    const events = JSON.parse(await readTrace(cdp)).traceEvents;
    const markedPids = [...new Set(events.filter((e) => e.name === marker).map((e) => e.pid))];
    const processes = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo;
    const renderers = processes.filter((p) => p.type === "renderer");
    const oldIds = new Set(oldProcesses.map((p) => p.id));
    const candidates = renderers.filter((p) => !oldIds.has(p.id)).map((p) => p.id);
    const matches = renderers.filter((p) => markedPids.includes(p.id)).map((p) => p.id);
    return {
        pid: matches.length === 1 ? matches[0] : null,
        candidates,
        markedPids,
        method: "page performance.mark trace PID matched to SystemInfo renderer list",
        unavailable: matches.length === 1 ? undefined : "No unique renderer matched the page timing marker",
    };
}

async function stopTrace(cdp, file, rendererPid) {
    const raw = await readTrace(cdp);
    const compressed = gzipSync(raw);
    await writeFile(file, compressed);
    return {
        path: file,
        bytes: compressed.length,
        uncompressedBytes: raw.length,
        ...traceMetrics(JSON.parse(raw).traceEvents, rendererPid),
    };
}

async function processMemory(pid) {
    if (!pid) return { unavailable: "No unambiguous process PID" };
    try {
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        const bytes = (name) => {
            const match = status.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
            return match ? Number(match[1]) * 1024 : null;
        };
        return { pid, sampledAt: Date.now(), vmHwmBytes: bytes("VmHWM"), vmRssBytes: bytes("VmRSS") };
    } catch (error) {
        return { pid, unavailable: error.message };
    }
}

async function resetPeak(pid) {
    if (!pid) return { succeeded: false, reason: "No unambiguous process PID" };
    try {
        await writeFile(`/proc/${pid}/clear_refs`, "5");
        return { succeeded: true, resetAt: Date.now() };
    } catch (error) {
        return { succeeded: false, reason: error.message };
    }
}

async function inspectDownload(download) {
    const result = { name: download.suggestedFilename(), receivedAt: Date.now() };
    try {
        const failure = await download.failure();
        if (failure) return { ...result, validPng: false, failure };
        const file = await download.path();
        result.bytes = (await stat(file)).size;
        const handle = await open(file, "r");
        try {
            const header = Buffer.alloc(24);
            const tail = Buffer.alloc(12);
            await handle.read(header, 0, 24, 0);
            if (result.bytes >= 12) await handle.read(tail, 0, 12, result.bytes - 12);
            const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            const ihdr = header.readUInt32BE(8) === 13 && header.toString("ascii", 12, 16) === "IHDR";
            result.width = png && ihdr ? header.readUInt32BE(16) : null;
            result.height = png && ihdr ? header.readUInt32BE(20) : null;
            result.validPng = !!(
                png &&
                ihdr &&
                result.width > 0 &&
                result.height > 0 &&
                tail.toString("ascii", 4, 8) === "IEND"
            );
            if (!result.validPng)
                result.failure = result.bytes === 0 ? "Empty download" : "Invalid PNG header/dimensions/IEND";
        } finally {
            await handle.close();
        }
    } catch (error) {
        result.validPng = false;
        result.failure = error.message;
    }
    return result;
}

// DOM polling deliberately reads bodies directly, without Playwright's transcript-wide text engine.
async function rowState(page, nonce, translated = true) {
    return page.evaluate(
        ({ nonce, translated, prefix }) => {
            const rows = [...document.querySelectorAll(".default-chat-screen .risu-chat")];
            let rendered = 0;
            let messageRows = 0;
            let greetingRows = 0;
            let translatedBodies = 0;
            for (const row of rows) {
                if (Number(row.getAttribute("data-chat-index")) >= 0) messageRows++;
                else greetingRows++;
                const body = row.querySelector(".chattext");
                const text = body?.textContent ?? "";
                if (text.includes(prefix)) translatedBodies++;
                if (
                    text.includes(nonce) &&
                    (!translated || text.includes(prefix)) &&
                    !body.querySelector('[style*="spin"], .loadmove') &&
                    !row.closest(".chat-row-held, .chat-row-pending")
                )
                    rendered++;
            }
            return {
                mountedRows: rows.length,
                messageRows,
                greetingRows,
                renderedRows: rendered,
                translatedBodies,
                heldRows: rows.filter((row) => row.closest(".chat-row-held, .chat-row-pending")).length,
                firstBodyText: rows[0]?.querySelector(".chattext")?.textContent.slice(0, 160),
                registrySheets: document.querySelectorAll("[data-chat-styles] > style").length,
            };
        },
        { nonce, translated, prefix: PREFIX },
    );
}

async function waitSettled(
    page,
    state,
    providerRecords,
    nonce,
    n,
    { quietOnly = false, translated = true, since = Date.now() } = {},
) {
    const started = Date.now();
    let nextLog = started + 10_000;
    let rows;
    while (Date.now() - started < SETTLE_TIMEOUT_MS) {
        rows = await rowState(page, nonce, translated);
        const providerLast = providerRecords.at(-1);
        const last = Math.max(state.lastActivity, providerLast?.finishedAt ?? providerLast?.receivedAt ?? 0, since);
        const busy =
            state.requests.some((r) => r.finishedAt === null) || providerRecords.some((r) => r.finishedAt === null);
        const ready = quietOnly || (rows.messageRows === n && rows.renderedRows === n + 1);
        if (Date.now() >= nextLog) {
            log(`Waiting for ${nonce}: ${JSON.stringify({ ...rows, busy, quietForMs: Date.now() - last })}`);
            nextLog = Date.now() + 10_000;
        }
        if (ready && !busy && Date.now() - last >= QUIET_MS) return { status: "settled", at: Date.now(), ...rows };
        if (state.pageErrors.length) throw new Error(`Page error: ${state.pageErrors.join("; ")}`);
        await sleep(250);
    }
    return { status: "timeout", at: Date.now(), ...rows };
}

async function screenshot(page, cdp, browserCdp, rendererPid, timeoutMs, rows) {
    // Import and resolve labels before resetting memory and starting the export clock.
    await page.evaluate(async () => {
        const stores = await import("/src/ts/stores.svelte.ts");
        const { language } = await import("/src/lang/index.ts");
        window.__renderExport = { outcome: null, alert: null, screenshot: language.screenshot };
        window.__renderExportUnsubscribe = stores.alertStore.subscribe((alert) => {
            if (alert.type === "error" || (alert.type === "normal" && alert.msg === language.screenshotSaved)) {
                window.__renderExport.outcome = alert.type === "error" ? "error" : "success";
                window.__renderExport.alert = alert.msg;
                window.__renderExport.finishedAt = Date.now();
            }
        });
    });
    await page.locator("button.rounded-r-md:has(svg.lucide-menu)").click();
    const item = await page.evaluateHandle(() => {
        const label = [...document.querySelectorAll("span.ml-2")].find(
            (el) => el.textContent === window.__renderExport.screenshot,
        );
        if (!label) throw new Error("Screenshot menu item not found");
        return label.parentElement;
    });
    const processInfo = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo;
    const gpuCandidates = processInfo.filter((p) => p.type === "GPU").map((p) => p.id);
    const gpuPid = gpuCandidates.length === 1 ? gpuCandidates[0] : null;
    await cdp.send("HeapProfiler.collectGarbage");
    const heapBefore = await cdp.send("Runtime.getHeapUsage");
    const before = { renderer: await processMemory(rendererPid), gpu: await processMemory(gpuPid) };
    const reset = { renderer: await resetPeak(rendererPid), gpu: await resetPeak(gpuPid) };
    const baseline = { renderer: await processMemory(rendererPid), gpu: await processMemory(gpuPid) };
    const downloads = [];
    const pageSamples = [];
    const onDownload = (download) => {
        const receivedAt = Date.now();
        const pageNumber = downloads.length + 1;
        pageSamples.push(
            Promise.all([processMemory(rendererPid), processMemory(gpuPid)]).then(([renderer, gpu]) => ({
                page: pageNumber,
                name: download.suggestedFilename(),
                receivedAt,
                elapsedMs: receivedAt - startedAt,
                renderer,
                gpu,
            })),
        );
        downloads.push(inspectDownload(download));
    };
    page.on("download", onDownload);
    const startedAt = Date.now();
    let outcome;
    try {
        await item.evaluate((element) => element.click());
        try {
            await page.waitForFunction(() => window.__renderExport.outcome !== null, null, {
                polling: 250,
                timeout: timeoutMs,
            });
            outcome = await page.evaluate(() => window.__renderExport);
        } catch (error) {
            if (error.name !== "TimeoutError") throw error;
            outcome = { outcome: "timeout", timeoutMs };
        }
        // The alert follows anchor.click; allow the browser to deliver its download notifications.
        await sleep(500);
        const files = await Promise.all(downloads);
        const after = { renderer: await processMemory(rendererPid), gpu: await processMemory(gpuPid) };
        await cdp.send("HeapProfiler.collectGarbage");
        const heap = await cdp.send("Runtime.getHeapUsage");
        const afterGc = { renderer: await processMemory(rendererPid), gpu: await processMemory(gpuPid) };
        const samples = await Promise.all(pageSamples);
        const memory = Object.fromEntries(
            ["renderer", "gpu"].map((kind) => {
                const hwms = [baseline[kind], ...samples.map((sample) => sample[kind]), after[kind]]
                    .map((sample) => sample.vmHwmBytes)
                    .filter((bytes) => bytes != null);
                const observedPeak = hwms.length ? Math.max(...hwms) : null;
                return [
                    kind,
                    {
                        before: before[kind],
                        reset: reset[kind],
                        baseline: baseline[kind],
                        after: after[kind],
                        afterGc: afterGc[kind],
                        vmHwmDeltaBytes:
                            after[kind].vmHwmBytes == null || baseline[kind].vmHwmBytes == null
                                ? null
                                : after[kind].vmHwmBytes - baseline[kind].vmHwmBytes,
                        observedVmHwmBytes: observedPeak,
                        observedVmHwmDeltaBytes:
                            observedPeak == null || baseline[kind].vmHwmBytes == null
                                ? null
                                : observedPeak - baseline[kind].vmHwmBytes,
                        vmHwmDecreased: hwms.some((bytes, index) => index > 0 && bytes < hwms[index - 1]),
                        isolatedPeak: reset[kind].succeeded,
                    },
                ];
            }),
        );
        const durationMs = (outcome.finishedAt ?? Date.now()) - startedAt;
        let heapSnapshot;
        if (process.env.RENDER_HEAP_SNAPSHOT) {
            const requested = process.env.RENDER_HEAP_SNAPSHOT;
            const file = path.resolve(
                requested.includes("{rows}")
                    ? requested.replaceAll("{rows}", String(rows))
                    : `${requested}${ROWS.length > 1 ? `.${rows}` : ""}`,
            );
            await mkdir(path.dirname(file), { recursive: true });
            const stream = createWriteStream(file);
            const written = finished(stream);
            // Handle stream errors immediately, including errors before CDP finishes emitting chunks.
            written.catch(() => {});
            const onChunk = ({ chunk }) => stream.write(chunk);
            const snapshotStartedAt = Date.now();
            cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
            try {
                await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
            } finally {
                cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
                stream.end();
                await written;
            }
            heapSnapshot = {
                path: file,
                bytes: (await stat(file)).size,
                durationMs: Date.now() - snapshotStartedAt,
                rendererAfter: await processMemory(rendererPid),
                gpuAfter: await processMemory(gpuPid),
            };
        }
        return {
            ...outcome,
            startedAt,
            durationMs,
            files,
            pageSamples: samples,
            pages: files.length,
            invalidPngs: files.filter((f) => !f.validPng).length,
            memory,
            gpuCandidates,
            heapBeforeExport: heapBefore,
            heapAfterGc: heap,
            heapSnapshot,
        };
    } finally {
        page.off("download", onDownload);
        await item.dispose();
        await page.evaluate(() => window.__renderExportUnsubscribe());
    }
}

function printTables() {
    const get = (result, dotted) => dotted.split(".").reduce((value, key) => value?.[key], result);
    for (const scenario of SCENARIOS) {
        console.log(`\n${scenario}\n`);
        const results = ROWS.map((n) => report.results.find((r) => r.scenario === scenario && r.rows === n));
        const metrics =
            scenario === "open"
                ? [
                      ["Mounted rows (including greeting)", "settled.mountedRows"],
                      ["Rendered message rows", "settled.messageRows"],
                      ["Settle status", "settled.status"],
                      ...FUNCTIONS.map((f) => [f.name, `coverage.functions.${f.name}`]),
                      ["CSS preparations / distinct sheet", "cssPreparationsPerSheet"],
                      ["Registry sheets", "settled.registrySheets"],
                      ["Transform requests", "requests.transformRequests"],
                      ["Transform targets", "requests.transformTargets"],
                      ["Browser translation starts", "requests.translationStarts"],
                      ["Provider requests", "provider.requests"],
                      ["Distinct translated texts", "provider.distinctTexts"],
                      ["Max provider requests / text", "provider.maxRequestsPerText"],
                  ]
                : scenario === "profile"
                  ? [
                        ["Profiler enabled", "coverageEnabled"],
                        ["Mounted rows (including greeting)", "settled.mountedRows"],
                        ["Rendered message rows", "settled.messageRows"],
                        ["Settle status", "settled.status"],
                        ["First visible (ms)", "firstVisibleMs"],
                        ["Settled (ms)", "settledMs"],
                        ["Long tasks >=50 ms", "trace.longTasks.count"],
                        ["Long task total (ms)", "trace.longTasks.totalMs"],
                        ["Long task max (ms)", "trace.longTasks.maxMs"],
                        ["Frame gap median (ms)", "trace.frames.medianMs"],
                        ["Frame gap p95 (ms)", "trace.frames.p95Ms"],
                        ["Frame gap max (ms)", "trace.frames.maxMs"],
                        ["Frame gaps >50 ms", "trace.frames.over50Ms"],
                        ["Trace gzip bytes", "trace.bytes"],
                    ]
                  : scenario === "switch" || scenario === "switch-mounted"
                    ? [
                          ["Switch status", "switchStatus"],
                          ["Actual switch delay (ms)", "switchDelayMs"],
                          ...(scenario === "switch-mounted"
                              ? [
                                    ["All message rows mounted (ms from open)", "mountDelayMs"],
                                    ["Actual switch delay after mount (ms)", "switchAfterMountMs"],
                                ]
                              : []),
                          ["Switch trigger delay (ms)", "switchTriggerDelayMs"],
                          ["Coverage-to-switch skew (ms)", "coverageToSwitchMs"],
                          ["Mounted Render rows at switch", "rowsAtSwitch.mountedRows"],
                          ["Mounted Render message rows at switch", "rowsAtSwitch.messageRows"],
                          ["Translated rows at switch (including greeting)", "rowsAtSwitch.renderedRows"],
                          ["Translated message rows at switch", "rowsAtSwitch.renderedMessageRows"],
                          ["Chat rows on home", "homeRows"],
                          ["Quiet status", "settled.status"],
                          ...FUNCTIONS.flatMap((f) => [
                              [`${f.name} before`, `before.functions.${f.name}`],
                              [`${f.name} after`, `after.functions.${f.name}`],
                          ]),
                          ["Transform requests after", "requestsAfter.transformRequests"],
                          ["Transform targets after", "requestsAfter.transformTargets"],
                          ["Transform requests crossing switch", "inFlight.transformRequests"],
                          ["Transform targets crossing switch", "inFlight.transformTargets"],
                          ["Browser translation starts after", "requestsAfter.translationStarts"],
                          ["Browser translation requests crossing switch", "inFlight.translationRequests"],
                          ["Provider requests after", "providerAfter.requests"],
                          ["Distinct texts after", "providerAfter.distinctTexts"],
                          ["Max provider requests / text after", "providerAfter.maxRequestsPerText"],
                      ]
                    : [
                          ["Mounted rows (including greeting)", "settled.mountedRows"],
                          ["Settle status", "settled.status"],
                          ["Export status", "export.outcome"],
                          ["Export duration (ms)", "export.durationMs"],
                          ["Downloaded PNG files", "export.pages"],
                          ["Invalid/empty PNGs", "export.invalidPngs"],
                          ["PNG bytes (each)", (r) => r?.export?.files?.map((f) => f.bytes).join(", ")],
                          [
                              "PNG dimensions (each)",
                              (r) => r?.export?.files?.map((f) => `${f.width}x${f.height}`).join(", "),
                          ],
                          ...["renderer", "gpu"].flatMap((p) => [
                              [`${p} PID`, `export.memory.${p}.before.pid`],
                              [`${p} clear_refs worked`, `export.memory.${p}.reset.succeeded`],
                              [`${p} VmHWM before (bytes)`, `export.memory.${p}.before.vmHwmBytes`],
                              [`${p} VmHWM after (bytes)`, `export.memory.${p}.after.vmHwmBytes`],
                              [`${p} VmHWM delta (bytes)`, `export.memory.${p}.vmHwmDeltaBytes`],
                              [`${p} VmRSS after (bytes)`, `export.memory.${p}.after.vmRssBytes`],
                              [`${p} largest sampled VmHWM (bytes)`, `export.memory.${p}.observedVmHwmBytes`],
                              [
                                  `${p} largest sampled VmHWM delta (bytes)`,
                                  `export.memory.${p}.observedVmHwmDeltaBytes`,
                              ],
                              [`${p} VmHWM decreased during export`, `export.memory.${p}.vmHwmDecreased`],
                          ]),
                          ["JS heap after GC (bytes)", "export.heapAfterGc.usedSize"],
                      ];
        console.log(`| Metric | ${ROWS.join(" | ")} |`);
        console.log(`| --- | ${ROWS.map(() => "---:").join(" | ")} |`);
        for (const [name, selector] of metrics) {
            const values = results.map((r) => {
                // Function names can contain dots, so treat the functions table as one key space.
                const match = typeof selector === "string" && selector.match(/^(.*?)\.functions\.(.*)$/);
                const value =
                    typeof selector === "function"
                        ? selector(r)
                        : match
                          ? get(r, match[1])?.functions[match[2]]
                          : get(r, selector);
                return value ?? "unavailable";
            });
            console.log(`| ${name} | ${values.join(" | ")} |`);
        }
        if (scenario === "screenshot") {
            console.log("\nPer-page download notifications; cumulative HWM / current RSS in MiB.\n");
            console.log("| Rows | Page | Elapsed ms | Renderer HWM / RSS | GPU HWM / RSS |");
            console.log("| ---: | ---: | ---: | ---: | ---: |");
            const mib = (bytes) => (bytes == null ? "unavailable" : round(bytes / 1024 ** 2));
            for (const result of results) {
                for (const sample of result?.export?.pageSamples ?? []) {
                    const values = ["renderer", "gpu"].map(
                        (kind) => `${mib(sample[kind].vmHwmBytes)} / ${mib(sample[kind].vmRssBytes)}`,
                    );
                    console.log(`| ${result.rows} | ${sample.page} | ${sample.elapsedMs} | ${values.join(" | ")} |`);
                }
            }
        }
    }
}

let stack;
let browser;
let provider;
const providerRecords = [];
const allBlocked = [];
const allPageErrors = [];
try {
    if (
        ROWS.length === 0 ||
        ROWS.some((n) => !Number.isSafeInteger(n) || n < 1) ||
        SCENARIOS.length === 0 ||
        SCENARIOS.some((s) => !SCENARIO_NAMES.includes(s)) ||
        !Number.isFinite(SWITCH_DELAY_MS) ||
        SWITCH_DELAY_MS < 0 ||
        !Number.isFinite(SCREENSHOT_TIMEOUT_MS) ||
        SCREENSHOT_TIMEOUT_MS <= 0
    ) {
        throw new Error("Invalid ROWS, SCENARIOS, SWITCH_DELAY_MS, or SCREENSHOT_TIMEOUT_MS");
    }
    report.traceDirectory = process.env.RENDER_TRACE_DIR
        ? path.resolve(process.env.RENDER_TRACE_DIR)
        : await mkdtemp(path.join(os.tmpdir(), "risu-render-traces-"));
    await mkdir(report.traceDirectory, { recursive: true });
    log(`Trace directory (kept): ${report.traceDirectory}`);
    const font = await readFile(createRequire(path.join(repoRoot, "package.json")).resolve(FONT_SOURCE));
    provider = http.createServer(async (req, res) => {
        try {
            const pathname = new URL(req.url, "http://127.0.0.1").pathname;
            if (pathname === FONT_CSS_PATH || pathname === FONT_PATH) {
                const css = pathname === FONT_CSS_PATH;
                report.fixtureRequests[css ? "fontCss" : "font"]++;
                res.writeHead(200, {
                    "content-type": css ? "text/css" : "font/woff2",
                    "access-control-allow-origin": "*",
                });
                res.end(
                    css
                        ? `@font-face{font-family:"${FONT_FAMILY}";src:url("${FONT_PATH}") format("woff2");font-weight:400;font-style:normal}`
                        : font,
                );
                return;
            }
            const parts = [];
            for await (const part of req) parts.push(part);
            const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
            const text = body.messages?.filter((m) => m.role === "user").at(-1)?.content;
            if (typeof text !== "string") throw new Error("Mock expected the default translator's user text");
            const record = { receivedAt: Date.now(), finishedAt: null, path: req.url, text, textKey: hash(text) };
            providerRecords.push(record);
            await sleep(75);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: PREFIX + text } }] }));
            record.finishedAt = Date.now();
        } catch (error) {
            report.errors.push(`Mock provider: ${error.message}`);
            res.writeHead(500);
            res.end(error.message);
        }
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
    const providerUrl = `${providerOrigin}/v1/chat/completions`;
    const fontCssUrl = `${providerOrigin}${FONT_CSS_PATH}`;
    // Rendered translation runs Markdown's quote styling over inline CSS; keep these values unquoted.
    const fixtureSheet = `@import url(${fontCssUrl});.fixture-font{font-family:${FONT_FAMILY},serif}${SHEET}`;
    report.configuration.sheetBytes = Buffer.byteLength(fixtureSheet);
    report.configuration.webfont.stylesheetUrl = fontCssUrl;
    let stackOutput = "";
    const start = () =>
        startStack({
            serverPort: 6266,
            vitePort: 5366,
            log: (output) => {
                stackOutput = (stackOutput + output).slice(-40_000);
                if (process.env.DEBUG) process.stderr.write(output);
            },
        });
    try {
        stack = await start();
    } catch (error) {
        if (!/EMFILE.*watch/s.test(stackOutput) || process.env.CHOKIDAR_USEPOLLING === "1") throw error;
        process.env.CHOKIDAR_USEPOLLING = "1";
        report.environment.pollingRetry = true;
        log("Vite hit EMFILE watch; retrying with CHOKIDAR_USEPOLLING=1");
        stack = await start();
    }
    browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        args: ["--disable-features=SpareRendererForSitePerProcess"],
    });
    report.environment.chrome = browser.version();
    const browserCdp = await browser.newBrowserCDPSession();
    const newPage = async ({ coverageEnabled = false } = {}) => {
        const context = await browser.newContext({ viewport: report.configuration.viewport, acceptDownloads: true });
        const blocked = await isolateContext(context);
        allBlocked.push(blocked);
        await clearSafeBootAttempts(context);
        const page = await context.newPage();
        const cdp = coverageEnabled ? await context.newCDPSession(page) : null;
        if (cdp) {
            await cdp.send("Profiler.enable");
            await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
        }
        const state = watch(page);
        allPageErrors.push(state.pageErrors);
        await openApp(page, stack.baseURL);
        return { context, page, state, cdp };
    };
    const bootstrap = await newPage();
    const api = async (pathname, body) => {
        const response = await fetch(stack.baseURL + pathname, {
            method: body ? "POST" : "GET",
            headers: {
                "risu-auth": bootstrap.state.auth,
                "x-resource-epoch": bootstrap.state.epoch,
                "content-type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const value = await response.json();
        bootstrap.state.epoch = response.headers.get("x-resource-epoch") ?? value?.epoch ?? bootstrap.state.epoch;
        if (!response.ok)
            throw new Error(`API ${pathname} refused (${response.status}): ${JSON.stringify(value).slice(0, 2000)}`);
        return value;
    };
    const kinds = [
        "ui",
        "presets",
        "modelPresets",
        "modelProfiles",
        "personas",
        "providers",
        "memoryTranslateMedia",
        "characterOrder",
    ];
    const records = Object.fromEntries(
        await Promise.all(kinds.map(async (k) => [k, await api(`/api/resources/${k}/main`)])),
    );
    const renderId = randomUUID();
    const awayId = randomUUID();
    const binding = chatBindingFixture(records.modelPresets, records.presets, records.personas);
    const character = (id, name) => ({
        name,
        chaId: id,
        type: "character",
        firstMessage: `${name} greeting`,
        desc: "",
        notes: "",
        chatFolders: [],
        emotionImages: [],
        bias: [],
        viewScreen: "none",
        globalLore: [],
        utilityBot: false,
        customscript: [],
        exampleMessage: "",
        creatorNotes: "",
        systemPrompt: "",
        postHistoryInstructions: "",
        alternateGreetings: [],
        tags: [],
        creator: "",
        characterVersion: "",
        personality: "",
        scenario: "",
        firstMsgIndex: -1,
        replaceGlobalNote: "",
        triggerscript: [],
    });
    const render = {
        ...character(renderId, "Render"),
        customscript: [
            { comment: "display", in: "Render prose", out: "Rendered prose", type: "editdisplay", flag: "g" },
        ],
    };
    const awayNonce = `away-${randomUUID()}`;
    const awayChatId = randomUUID();
    const away = { ...character(awayId, "Away"), firstMessage: `${awayNonce} greeting` };
    const preset = {
        ...records.presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        seperateModelsForAxModels: true,
        seperateModels: { translate: "reverse_proxy" },
        forceReplaceUrl: providerUrl,
        customProxyRequestModel: "render-mock",
        maxContext: 16000,
        maxResponse: 4000,
        customTokenizer: "tik",
    };
    await api("/api/resources/batch", {
        ops: [
            ...modelFixtureOps(preset, records.modelPresets, records.modelProfiles),
            {
                kind: "presets",
                id: "main",
                baseRevision: records.presets.revision,
                data: [promptFixture(preset), ...records.presets.data.slice(1)],
            },
            {
                kind: "providers",
                id: "main",
                baseRevision: records.providers.revision,
                data: { ...records.providers.data, useStreaming: false },
            },
            {
                kind: "memoryTranslateMedia",
                id: "main",
                baseRevision: records.memoryTranslateMedia.revision,
                data: {
                    ...records.memoryTranslateMedia.data,
                    translatorType: "llm",
                    translator: "en",
                    llmTranslationTarget: "rendered",
                    autoTranslateCachedOnly: false,
                },
            },
            {
                kind: "ui",
                id: "main",
                baseRevision: records.ui.revision,
                data: { ...records.ui.data, didFirstSetup: true },
            },
            { kind: "characters", id: renderId, baseRevision: null, data: render },
            { kind: "characters", id: awayId, baseRevision: null, data: away },
            {
                kind: "characterOrder",
                id: "main",
                baseRevision: records.characterOrder.revision,
                data: [...records.characterOrder.data, renderId, awayId],
            },
        ],
        chats: [
            {
                characterId: awayId,
                chatId: awayChatId,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: awayChatId,
                            name: "Away",
                            ...binding,
                            autoTranslate: false,
                            message: [{ role: "user", data: `${awayNonce} plain message`, chatId: randomUUID() }],
                        },
                    },
                ],
            },
        ],
        chatOrders: [],
    });
    report.configuration.translationDefaults = {
        translateBeforeHTMLFormatting: records.memoryTranslateMedia.data.translateBeforeHTMLFormatting === true,
        legacyTranslation: records.memoryTranslateMedia.data.legacyTranslation === true,
        storedTranslateBeforeHTMLFormatting: records.memoryTranslateMedia.data.translateBeforeHTMLFormatting ?? "unset",
        branch: "ParseMarkdown(pretranslate) -> translateHTML -> postTranslationParse",
        llmTranslationTarget: "rendered",
    };
    await bootstrap.context.close();

    for (const n of ROWS)
        for (const scenario of SCENARIOS) {
            log(`Starting ${scenario}, ${n} messages`);
            const scenarioStart = Date.now();
            const nonce = `${scenario}-${n}-${randomUUID()}`;
            const chatId = randomUUID();
            const ui = await api("/api/resources/ui/main");
            const storedRender = await api(`/api/resources/characters/${renderId}`);
            const message = Array.from({ length: n }, (_, i) => ({
                role: i % 2 === 0 ? "user" : "char",
                chatId: randomUUID(),
                data:
                    i % 2 === 0
                        ? `${nonce} row ${i}: short user prose.`
                        : `<style>${fixtureSheet}</style>\n\n<p class="fixture-font">Render prose ${nonce} row ${i}.</p>\n\n${FENCES}\n\nEnd ${nonce} row ${i}.`,
            }));
            const batch = {
                ops: [
                    {
                        kind: "ui",
                        id: "main",
                        baseRevision: ui.revision,
                        data: { ...ui.data, chatLoadInitialPages: n },
                    },
                    {
                        kind: "characters",
                        id: renderId,
                        baseRevision: storedRender.revision,
                        data: { ...storedRender.data, firstMessage: `${nonce} Render greeting` },
                    },
                ],
                chats: [
                    {
                        characterId: renderId,
                        chatId,
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    id: chatId,
                                    name: nonce,
                                    ...binding,
                                    autoTranslate: true,
                                    translateBotOnly: false,
                                    message,
                                },
                            },
                        ],
                    },
                ],
                chatOrders: [],
            };
            const seedBytes = Buffer.byteLength(JSON.stringify(batch));
            await api("/api/resources/batch", batch);
            const oldProcesses = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo;
            const switches = scenario === "switch" || scenario === "switch-mounted";
            const usesCoverage = scenario === "open" || switches;
            const { context, page, state, cdp: coverageCdp } = await newPage({ coverageEnabled: usesCoverage });
            const result = { rows: n, scenario, nonce, chatId, seedBytes, coverageEnabled: usesCoverage };
            report.results.push(result);
            try {
                // Import once before measured work; Vite can reload on its first dependency optimization.
                const prepare = async () =>
                    page.evaluate(
                        async ({ renderId, chatId, nonce, prefix }) => {
                            const selection = await import("/src/ts/storage/selection.svelte.ts");
                            const chats = await import("/src/ts/storage/chatStore.svelte.ts");
                            window.__renderSelection = selection;
                            window.__renderRowSnapshot = () => {
                                const rows = [...document.querySelectorAll(".default-chat-screen .risu-chat")];
                                const messages = rows.filter((row) => Number(row.getAttribute("data-chat-index")) >= 0);
                                const rendered = rows.filter((row) => {
                                    const body = row.querySelector(".chattext");
                                    return (
                                        body?.textContent.includes(nonce) &&
                                        body.textContent.includes(prefix) &&
                                        !body.querySelector('[style*="spin"], .loadmove')
                                    );
                                });
                                return {
                                    mountedRows: rows.length,
                                    messageRows: messages.length,
                                    greetingRows: rows.length - messages.length,
                                    renderedRows: rendered.length,
                                    renderedMessageRows: rendered.filter(
                                        (row) => Number(row.getAttribute("data-chat-index")) >= 0,
                                    ).length,
                                };
                            };
                            chats.selectChat(renderId, chatId);
                        },
                        { renderId, chatId, nonce, prefix: PREFIX },
                    );
                try {
                    await prepare();
                } catch (error) {
                    if (!/Execution context was destroyed/.test(error.message)) throw error;
                    await openApp(page, stack.baseURL);
                    await prepare();
                }
                await openCharacterChat(page, awayId);
                log(`Away opened before ${scenario} ${n}`);
                await waitSettled(page, state, providerRecords, awayNonce, 1, {
                    translated: false,
                });
                await page.locator(`[data-char-id="${renderId}"]`).first().click();
                const button = await page.getByRole("button", { name: /Open most recent chat/ }).elementHandle();
                if (!button) throw new Error("Open chat button not found");
                const cdp = coverageCdp ?? (await context.newCDPSession(page));
                if (scenario === "profile" || scenario === "screenshot")
                    result.renderer = await identifyRenderer(cdp, page, browserCdp, oldProcesses);
                const rendererPid = result.renderer?.pid ?? null;
                const coverage = usesCoverage ? coverageReader(cdp) : null;
                let before;
                if (switches) {
                    await cdp.send("Debugger.enable");
                    const paused = new Promise((resolve) => cdp.once("Debugger.paused", resolve));
                    await page.exposeBinding("__renderSwitch", async () => {
                        await paused;
                        try {
                            before = await coverage.take();
                            const switched = await cdp.send("Runtime.evaluate", {
                                expression: `
                        window.__renderMeasure.rowsAtSwitch = window.__renderRowSnapshot();
                        window.__renderMeasure.switchAt = Date.now();
                        window.__renderSelection.selectCharacter(null);
                    `,
                            });
                            if (switched.exceptionDetails) throw new Error(switched.exceptionDetails.text);
                        } finally {
                            await cdp.send("Debugger.resume");
                        }
                    });
                }
                await button.evaluate(
                    (element, { scenario, delay, n }) =>
                        element.addEventListener(
                            "click",
                            () => {
                                window.__renderMeasure = {
                                    startedAt: Date.now(),
                                    start: performance.now(),
                                    firstVisibleMs: null,
                                };
                                const requestSwitch = () => {
                                    if (window.__renderMeasure.switchRequested) return;
                                    window.__renderMeasure.switchRequested = true;
                                    window.__renderMeasure.switchTriggeredAt = Date.now();
                                    window.__renderMeasure.rowsAtTrigger = window.__renderRowSnapshot();
                                    window.__renderSwitch().catch((error) => {
                                        window.__renderMeasure.switchError = String(error);
                                    });
                                    // The coverage snapshot and home selection run while this callback is paused.
                                    debugger;
                                };
                                if (scenario === "switch") setTimeout(requestSwitch, delay);
                                if (scenario === "switch-mounted") {
                                    const observer = new MutationObserver(() => {
                                        const rows = document.querySelectorAll(
                                            '.default-chat-screen .risu-chat[data-chat-index]:not([data-chat-index="-1"])',
                                        );
                                        if (rows.length < n) return;
                                        window.__renderMeasure.mountedAt = Date.now();
                                        observer.disconnect();
                                        setTimeout(requestSwitch, delay);
                                    });
                                    observer.observe(document.body, { childList: true, subtree: true });
                                    window.__renderMountObserver = observer;
                                }
                            },
                            { once: true },
                        ),
                    { scenario, delay: SWITCH_DELAY_MS, n },
                );
                if (coverage) await coverage.take();
                const requestStart = state.requests.length;
                const providerStart = providerRecords.length;
                if (scenario === "profile")
                    await cdp.send("Tracing.start", {
                        categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame,toplevel",
                        transferMode: "ReturnAsStream",
                    });
                await button.evaluate((element) => element.click());
                await button.dispose();
                if (switches) {
                    try {
                        await page.waitForFunction(
                            () => !!(window.__renderMeasure?.switchAt || window.__renderMeasure?.switchError),
                            null,
                            {
                                timeout: SETTLE_TIMEOUT_MS,
                            },
                        );
                    } catch (error) {
                        if (error.name !== "TimeoutError") throw error;
                    }
                    const timing = await page.evaluate(() => window.__renderMeasure);
                    if (timing.switchError) throw new Error(`Switch failed: ${timing.switchError}`);
                    result.startedAt = timing.startedAt;
                    if (!timing.switchAt) {
                        result.switchStatus = "timeout";
                        result.rowsAtTimeout = await page.evaluate(() => window.__renderRowSnapshot());
                        result.before = await coverage.take();
                    } else {
                        result.switchStatus = "switched";
                        result.switchAt = timing.switchAt;
                        result.switchDelayMs = timing.switchAt - timing.startedAt;
                        if (scenario === "switch-mounted") {
                            result.mountedAt = timing.mountedAt;
                            result.mountDelayMs = timing.mountedAt - timing.startedAt;
                            result.switchAfterMountMs = timing.switchAt - timing.mountedAt;
                        }
                        result.switchTriggerDelayMs = timing.switchTriggeredAt - timing.startedAt;
                        result.rowsAtTrigger = timing.rowsAtTrigger;
                        result.coverageToSwitchMs = timing.switchAt - before.receivedAt;
                        result.rowsAtSwitch = timing.rowsAtSwitch;
                        result.before = before;
                        await page.waitForFunction(
                            () =>
                                window.__renderSelection.selection.characterId === null &&
                                document.querySelectorAll(".risu-chat").length === 0,
                        );
                        result.settled = await waitSettled(page, state, providerRecords, nonce, n, {
                            quietOnly: true,
                            since: timing.switchAt,
                        });
                        result.homeRows = await page.evaluate(() => document.querySelectorAll(".risu-chat").length);
                        if (result.homeRows !== 0)
                            throw new Error("Home unexpectedly mounted chat rows after the switch");
                        result.after = await coverage.take();
                        const requests = state.requests.slice(requestStart);
                        result.requestsBefore = requestSummary(requests.filter((r) => r.startedAt < timing.switchAt));
                        result.requestsAfter = requestSummary(requests.filter((r) => r.startedAt >= timing.switchAt));
                        result.inFlight = requestSummary(
                            requests.filter(
                                (r) =>
                                    r.startedAt < timing.switchAt &&
                                    (r.finishedAt === null || r.finishedAt >= timing.switchAt),
                            ),
                        );
                        result.providerBefore = providerSummary(
                            providerRecords.slice(providerStart).filter((r) => r.receivedAt < timing.switchAt),
                        );
                        result.providerAfter = providerSummary(
                            providerRecords.slice(providerStart).filter((r) => r.receivedAt >= timing.switchAt),
                        );
                    }
                } else {
                    if (scenario === "profile") {
                        try {
                            await page.waitForFunction(
                                (nonce) => {
                                    const body = document.querySelector(".default-chat-screen .risu-chat .chattext");
                                    if (!body || !body.textContent.includes(nonce)) return false;
                                    const rect = body.getBoundingClientRect();
                                    if (
                                        rect.width === 0 ||
                                        rect.height === 0 ||
                                        rect.bottom <= 0 ||
                                        rect.top >= innerHeight
                                    )
                                        return false;
                                    window.__renderMeasure.firstVisibleMs =
                                        performance.now() - window.__renderMeasure.start;
                                    return true;
                                },
                                nonce,
                                { polling: 50, timeout: SETTLE_TIMEOUT_MS },
                            );
                        } catch (error) {
                            if (error.name !== "TimeoutError") throw error;
                        }
                    }
                    result.settled = await waitSettled(page, state, providerRecords, nonce, n);
                    const timing = await page.evaluate(() => window.__renderMeasure);
                    result.startedAt = timing.startedAt;
                    if (scenario === "profile") {
                        result.firstVisibleMs = timing.firstVisibleMs === null ? null : round(timing.firstVisibleMs);
                        result.settledMs = result.settled.at - timing.startedAt;
                    }
                    if (coverage) result.coverage = await coverage.take();
                    result.requests = requestSummary(state.requests.slice(requestStart));
                    result.provider = providerSummary(providerRecords.slice(providerStart));
                    if (scenario === "profile")
                        result.trace = await stopTrace(
                            cdp,
                            path.join(report.traceDirectory, `profile-${n}.json.gz`),
                            rendererPid,
                        );
                    if (scenario === "screenshot")
                        result.export = await screenshot(page, cdp, browserCdp, rendererPid, SCREENSHOT_TIMEOUT_MS, n);
                }
                if (coverage) {
                    await cdp.send("Profiler.stopPreciseCoverage");
                    await cdp.send("Profiler.disable");
                    if (switches) await cdp.send("Debugger.disable");
                    result.coverageInventory = await coverage.finish();
                    if (result.coverage) result.cssPreparationsPerSheet = result.coverage.functions["cssTools.parse"];
                }
                await cdp.detach();
                result.wallTimeMs = Date.now() - scenarioStart;
                log(`Finished ${scenario} ${n}: ${result.wallTimeMs} ms`);
            } finally {
                await context.close();
            }
        }
} catch (error) {
    report.errors.push(error.stack ?? String(error));
    log(String(error.stack ?? error));
} finally {
    if (browser) await browser.close().catch((error) => report.errors.push(String(error)));
    if (stack) {
        report.unexpectedEgress = unexpectedEgress(allBlocked.flat(), await stack.deniedEgress());
        if (report.unexpectedEgress.length)
            report.errors.push(`Unexpected egress: ${report.unexpectedEgress.join(", ")}`);
        await stack.stop().catch((error) => report.errors.push(String(error)));
    }
    if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
    }
    report.pageErrors = allPageErrors.flat();
    if (report.pageErrors.length) report.errors.push(...report.pageErrors.map((e) => `Page error: ${e}`));
    report.finishedAt = new Date().toISOString();
    report.wallTimeMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    printTables();
    if (process.env.RENDER_OUT) {
        try {
            await writeFile(path.resolve(process.env.RENDER_OUT), `${JSON.stringify(report, null, 2)}\n`);
        } catch (error) {
            report.errors.push(`Cannot write RENDER_OUT: ${error.message}`);
            log(report.errors.at(-1));
        }
    }
    console.log(`\n${JSON.stringify(report, null, 2)}`);
    process.exitCode = report.errors.length ? 1 : 0;
}
