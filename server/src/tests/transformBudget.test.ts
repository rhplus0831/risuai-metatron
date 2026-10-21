// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TransformRequest } from "../../../shared/transform.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import type { GenerationRunnerDeps } from "../jobs/runSetup.ts";
import { createTransformService } from "../prompt/transform.ts";
import { createLuaBudget, type LuaBudget, type LuaTask } from "../scripts/workerPool.ts";

// A render's aggregate Lua budget (`server/src/prompt/transform.ts`): one per request from the
// pool's `createBudget()` (the pool's configured total, as the job runners take theirs), handed to
// every Lua run of the request's targets, kept by the snapshot for the second call of a two-call
// render, and fresh for a separate render. Observed at the pool boundary with a double that
// records the budgets it hands out and the one each Lua run crosses with.

const BUDGET_MS = 7654;

/** A store with one character `a` (one Lua trigger, run as its `editDisplay` handler) and its chat `k`, over a recording pool. */
function harness() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-transform-budget-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds });
    store.put(
        kinds.get("characters")!,
        "a",
        {
            chaId: "a",
            type: "character",
            name: "A",
            firstMessage: "hi",
            desc: "",
            globalLore: [],
            customscript: [],
            triggerscript: [
                { comment: "lua", type: "start", conditions: [], effect: [{ type: "triggerlua", code: "hook" }] },
            ],
        },
        null,
    );
    store.applyChanges({
        chats: [
            {
                characterId: "a",
                chatId: "k",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "k", name: "K", message: [] } }],
            },
        ],
    });
    const presetId = (store.get(kinds.get("presets")!, "main")!.data as { id: string }[])[0].id;
    const modelPresetId = (store.get(kinds.get("modelPresets")!, "main")!.data as { id: string }[])[0].id;
    const personaId = (store.get(kinds.get("personas")!, "main")!.data as { id: string }[])[0].id;
    /** The budgets `createBudget` handed out, in order. */
    const budgets: LuaBudget[] = [];
    /** Every Lua run: the text it edits and the budget it crosses with. */
    const runs: { text: unknown; budget: LuaBudget | undefined }[] = [];
    const scriptWorkers = {
        runScripts: async (task: { data: string }) => ({ data: task.data }),
        runLua: async (task: LuaTask, run: { budget?: LuaBudget } = {}) => {
            runs.push({ text: task.data, budget: run.budget });
            return { res: task.data };
        },
        regex: async () => ({ value: null }),
        createBudget: () => {
            const budget = createLuaBudget(BUDGET_MS);
            budgets.push(budget);
            return budget;
        },
    };
    const deps = {
        store,
        kinds,
        rootDir: dir,
        savePath: dir,
        tokens: {},
        llm: {},
        scriptWorkers,
    } as unknown as GenerationRunnerDeps;
    const context = { characterId: "a", chatId: "k", presetId, modelPresetId, personaId, selectedPersonaId: personaId };
    const request = (ids: string[], extra: Partial<TransformRequest> = {}): TransformRequest => ({
        clientId: "tab",
        mode: "editdisplay",
        context,
        targets: ids.map((id) => ({ id, kind: "text", sourceId: "a", chatIndex: -1, source: `text ${id}` })),
        ...extra,
    });
    return {
        deps,
        budgets,
        runs,
        request,
        dispose() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

let current: ReturnType<typeof harness> | null = null;
const open = () => (current = harness());
afterEach(() => {
    current?.dispose();
    current = null;
});

describe("a render's Lua budget", () => {
    it("takes one budget per request from the pool, shared by the targets' runs, and a fresh one for the next request", async () => {
        const h = open();
        const service = createTransformService(h.deps);
        const signal = new AbortController().signal;
        const first = await service.transform(h.request(["p", "q"]), signal);
        expect(first.results.map((result) => result.ok)).toEqual([true, true]);
        expect(h.budgets).toHaveLength(1);
        expect(h.budgets[0]).toMatchObject({ totalMs: BUDGET_MS });
        // Both targets' handlers crossed with the request's one budget, the pool's own object.
        expect(h.runs.map((run) => run.text)).toEqual(["text p", "text q"]);
        expect(h.runs.map((run) => run.budget)).toEqual([h.budgets[0], h.budgets[0]]);
        expect(h.runs[0].budget).toBe(h.budgets[0]);
        expect(h.runs[1].budget).toBe(h.budgets[0]);

        // A separate render: its own budget, none of the first one's.
        const second = await service.transform(h.request(["r"]), signal);
        expect(second.results.map((result) => result.ok)).toEqual([true]);
        expect(h.budgets).toHaveLength(2);
        expect(h.budgets[1]).not.toBe(h.budgets[0]);
        expect(h.runs[2].budget).toBe(h.budgets[1]);
        await service.close();
    });

    it("keeps the request's budget for the second call of a two-call render, without a new one", async () => {
        const h = open();
        const service = createTransformService(h.deps);
        const signal = new AbortController().signal;
        const first = await service.transform(h.request(["p", "q"], { handlers: "h" }), signal);
        expect(first.snapshotId).toBeTruthy();
        expect(first.pending?.map((entry) => entry.id)).toEqual(["p", "q"]);
        expect(h.budgets).toHaveLength(1);
        expect(h.runs.map((run) => run.budget)).toEqual([h.budgets[0], h.budgets[0]]);
        const second = await service.resume(
            {
                clientId: "tab",
                snapshotId: first.snapshotId!,
                texts: [
                    { id: "p", text: "text p (plugin)" },
                    { id: "q", text: "text q (plugin)" },
                ],
            },
            signal,
        );
        expect(second.results.map((result) => (result.ok ? result.text : result.error))).toEqual([
            "text p (plugin)",
            "text q (plugin)",
        ]);
        // The continuation ran on the kept setups: no budget was made for it.
        expect(h.budgets).toHaveLength(1);
        await service.close();
    });
});
