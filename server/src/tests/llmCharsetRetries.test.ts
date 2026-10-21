// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { requestDataResponse } from "../llm/request.ts";
import { requestChatDataOuter } from "../llm/outer.ts";

// A `banCharacterset` rejection in the outer request loop counts against `requestRetrys` and ends
// with a failure, and the loop yields a turn of the event loop before every attempt, so a model that
// answers at once (Echo with no delay) cannot hold the server's main thread. The first part drives
// `requestChatDataOuter` with finite attempt scripts (an unexpected extra attempt throws, so a lost
// budget fails instead of spinning). The second part reproduces the hang: a real group send over the
// default runner with the Echo model and the `Latn` ban, in a child process the test kills after a
// timeout, since before the fix the job never yielded and no timer, stop, or test timeout could end
// it.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BANNED = "The model answered in a banned script (Latn)";

describe("requestChatDataOuter and banCharacterset", () => {
    const latin: requestDataResponse = { type: "success", result: "blocked Latin text" };
    const clean: requestDataResponse = { type: "success", result: "한국어 답변" };

    /** Runs the loop over a fixed list of answers; a call past the list is a failure of the loop. */
    async function run(
        answers: requestDataResponse[],
        options: { requestRetrys?: number; signal?: AbortSignal; onAttempt?: (index: number) => void } = {},
    ) {
        let attempts = 0;
        const result = await requestChatDataOuter({ formated: [], bias: {} }, "model", {
            db: { requestRetrys: options.requestRetrys ?? 2, antiServerOverloads: false, banCharacterset: ["Latn"] },
            signal: options.signal ?? new AbortController().signal,
            attempt: async () => {
                const index = attempts++;
                if (index >= answers.length) {
                    throw new Error(`attempt ${index + 1} past the ${answers.length} scripted answers`);
                }
                options.onAttempt?.(index);
                return answers[index];
            },
        });
        return { result, attempts };
    }

    it("a rejected answer with no retries left fails at once (requestRetrys 0)", async () => {
        expect(await run([latin], { requestRetrys: 0 })).toEqual({
            result: { type: "fail", result: BANNED },
            attempts: 1,
        });
    });

    it("rejections spend the budget: requestRetrys 2 allows three attempts", async () => {
        expect(await run([latin, latin, latin])).toEqual({ result: { type: "fail", result: BANNED }, attempts: 3 });
    });

    it("a clean answer after a rejection is returned", async () => {
        expect(await run([latin, clean], { requestRetrys: 1 })).toEqual({ result: clean, attempts: 2 });
    });

    it("rejections and failed attempts share one budget", async () => {
        const failed: requestDataResponse = { type: "fail", result: "upstream 400" };
        expect(await run([latin, failed, latin])).toEqual({ result: { type: "fail", result: BANNED }, attempts: 3 });
    });

    it("yields a turn of the event loop between attempts", async () => {
        let immediateRanAfter = -1;
        let attemptsSeen = 0;
        const { attempts } = await run([latin, clean], {
            onAttempt: (index) => {
                attemptsSeen = index + 1;
                if (index === 0) {
                    setImmediate(() => {
                        immediateRanAfter = attemptsSeen;
                    });
                }
            },
        });
        expect(attempts).toBe(2);
        // The immediate scheduled during the first attempt ran before the second one started.
        expect(immediateRanAfter).toBe(1);
    });

    it("an abort raised by a timer between attempts ends the loop before the next attempt", async () => {
        const controller = new AbortController();
        expect(
            await run([latin, clean], {
                signal: controller.signal,
                onAttempt: (index) => {
                    if (index === 0) {
                        setImmediate(() => controller.abort());
                    }
                },
            }),
        ).toEqual({ result: { type: "fail", result: "Aborted" }, attempts: 1 });
    });
});

describe("a group send with the Echo model and a banned script", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "charset-retries-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    type Report = {
        attempts: number;
        immediateRanAfter: number;
        attemptsAtStop: number | null;
        terminal: { type: string; reason?: string; status?: number; message?: string; stage?: string } | null;
    };

    /**
     * The hang reproduced over the real server, the default runner, the real group and
     * character records, and `POST /api/generations` with `kind: "group"`: the Echo model answers
     * "blocked Latin text" at once, and the providers ban `Latn`. The child counts the runner's
     * request attempts; in `stop` mode it issues the owner's DELETE from a timer 50 ms after the
     * first attempt. The test kills a child that never ends.
     */
    function runGroupSend(mode: "budget" | "stop"): Report {
        const script = path.join(dir, `group-${mode}.mjs`);
        const support = pathToFileURL(path.join(REPO_ROOT, "server/src/tests/testSupport.ts")).href;
        writeFileSync(
            script,
            [
                `import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";`,
                `import os from "node:os";`,
                `import path from "node:path";`,
                `import { createResourceTestClient } from ${JSON.stringify(support)};`,
                `const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};`,
                `const mode = ${JSON.stringify(mode)};`,
                `const rootDir = mkdtempSync(path.join(os.tmpdir(), "charset-retries-root-"));`,
                `mkdirSync(path.join(rootDir, "dist"), { recursive: true });`,
                `writeFileSync(path.join(rootDir, "dist/index.html"), "<html><head></head><body></body></html>");`,
                `mkdirSync(path.join(rootDir, "save/server"), { recursive: true });`,
                `writeFileSync(path.join(rootDir, "save/server/password"), "pw");`,
                `symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");`,
                `globalThis.fetch = async () => { throw new Error("Real outbound fetch forbidden"); };`,
                `console.log = () => {};`,
                `console.error = () => {};`,
                `console.warn = () => {};`,
                `const client = await createResourceTestClient({ rootDir });`,
                `const get = async (kind) => await (await client.get(kind, "main")).json();`,
                `const rows = {};`,
                `for (const kind of ["presets", "modelPresets", "modelProfiles", "personas", "providers"]) rows[kind] = await get(kind);`,
                `const presetId = rows.presets.data[0].id;`,
                `const modelPresetId = rows.modelPresets.data[0].id;`,
                `const profileId = rows.modelProfiles.data[0].id;`,
                `const personaId = rows.personas.data[0].id;`,
                `const required = async (response) => { if (response.status !== 200) throw new Error(response.status + ": " + (await response.text())); return response; };`,
                `await required(await client.json("/api/resources/batch", { ops: [`,
                `    { kind: "modelProfiles", id: "main", baseRevision: rows.modelProfiles.revision, data: rows.modelProfiles.data.map((p) => (p.id === profileId ? { ...p, modelId: "echo_model" } : p)) },`,
                `    { kind: "modelPresets", id: "main", baseRevision: rows.modelPresets.revision, data: rows.modelPresets.data.map((p) => (p.id === modelPresetId ? { ...p, mainSlot: { profileId }, subSlot: { profileId } } : p)) },`,
                `    { kind: "providers", id: "main", baseRevision: rows.providers.revision, data: { ...rows.providers.data, echoMessage: "blocked Latin text", echoDelay: 0, banCharacterset: ["Latn"], requestRetrys: mode === "budget" ? 2 : 10000, useStreaming: false } },`,
                `] }));`,
                `const blank = { exampleMessage: "", personality: "", scenario: "", bias: [], emotionImages: [], alternateGreetings: [], globalLore: [], systemPrompt: "", replaceGlobalNote: "", additionalAssets: [], viewScreen: "none", firstMessage: "", desc: "", lowLevelAccess: true, triggerscript: [], customscript: [] };`,
                `await required(await client.json("/api/resources/batch", {`,
                `    ops: [`,
                `        { kind: "characters", id: "speaker", baseRevision: null, data: { ...blank, chaId: "speaker", type: "character", name: "Speaker" } },`,
                `        { kind: "characters", id: "group", baseRevision: null, data: { ...blank, chaId: "group", type: "group", name: "Group", characters: ["speaker"], characterTalks: [1], characterActive: [true], orderByOrder: true } },`,
                `    ],`,
                `    chats: [{ characterId: "group", chatId: "k", baseRevision: null, ops: [{ op: "create", chat: { id: "k", name: "K", fmIndex: -1, promptPresetId: presetId, modelPresetId, bindedPersona: personaId, message: [{ chatId: "u0", role: "user", data: "Hello group" }], scriptstate: {} } }] }],`,
                `}));`,
                `const before = (await (await required(await client.json("/api/resources/read", { chats: [{ characterId: "group", id: "k" }] }))).json()).chats[0];`,
                `let attempts = 0;`,
                `let immediateRanAfter = -1;`,
                `let attemptsAtStop = null;`,
                `let jobId = "";`,
                `const realRun = client.context.llmRequests.runInJob;`,
                `client.context.llmRequests.runInJob = async (spec) => {`,
                `    attempts += 1;`,
                `    if (attempts === 1) {`,
                `        setImmediate(() => { immediateRanAfter = attempts; });`,
                `        if (mode === "stop") {`,
                `            setTimeout(async () => {`,
                `                attemptsAtStop = attempts;`,
                `                await client.request("/api/generations/" + jobId + "?clientId=charset-test", { method: "DELETE" });`,
                `            }, 50);`,
                `        }`,
                `    }`,
                `    return realRun(spec);`,
                `};`,
                `const created = await required(await client.json("/api/generations", { kind: "group", clientId: "charset-test", context: { characterId: "group", chatId: "k", presetId, modelPresetId, personaId, mode: "group", input: "", chatRevision: before.revision } }));`,
                `jobId = (await created.json()).jobId;`,
                `let terminal = null;`,
                `for (let i = 0; i < 2000 && !terminal; i++) {`,
                `    const state = await (await client.request("/api/generations/" + jobId + "?clientId=charset-test")).json();`,
                `    terminal = state.terminal ?? null;`,
                `    if (!terminal) await new Promise((resolve) => setTimeout(resolve, 10));`,
                `}`,
                `const { epoch, ...rest } = terminal ?? {};`,
                `process.stdout.write(JSON.stringify({ attempts, immediateRanAfter, attemptsAtStop, terminal: terminal ? rest : null }));`,
                `await client.close();`,
            ].join("\n"),
        );
        const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000 });
        if (run.error) {
            throw run.error;
        }
        expect(run.status, run.stderr).toBe(0);
        return JSON.parse(run.stdout) as Report;
    }

    it("ends with the request's failure once the retries are spent, yielding between attempts", () => {
        expect(runGroupSend("budget")).toEqual({
            attempts: 3,
            immediateRanAfter: 1,
            attemptsAtStop: null,
            terminal: { type: "error", reason: "failed", status: 500, message: BANNED, stage: "request" },
        });
    }, 90_000);

    it("observes a stop scheduled from a timer while the rejections continue", () => {
        const report = runGroupSend("stop");
        expect(report.terminal).toEqual({
            type: "error",
            reason: "aborted",
            status: 499,
            message: "The generation was aborted",
        });
        expect(report.immediateRanAfter).toBe(1);
        expect(report.attemptsAtStop).toBeGreaterThanOrEqual(1);
        // The stop ended the loop well inside its 10,000-attempt budget.
        expect(report.attempts).toBeLessThan(10_000);
        expect(report.attempts).toBeGreaterThanOrEqual(report.attemptsAtStop ?? 0);
    }, 90_000);
});
