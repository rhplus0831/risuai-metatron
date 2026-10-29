// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransformRequest, TransformResponse } from "../../../shared/transform.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { ChatBindingError, jobScopeKinds } from "../jobs/jobScope.ts";
import type { GenerationRunnerDeps } from "../jobs/runSetup.ts";
import { createTransformService, TransformSnapshotError, TransformUnavailableError } from "../prompt/transform.ts";
import { createDisplayScopeLoader } from "../prompt/displayScope.ts";
import { DISPLAY_KIND_CLASSIFICATION, isDisplayKeyKind } from "../prompt/displayKinds.ts";
import { createTransformCache } from "../prompt/transformCache.ts";
import { createLuaBudget, createScriptWorkerPool } from "../scripts/workerPool.ts";

// The script transform's service (`server/src/prompt/transform.ts`) and its cache
// (`server/src/prompt/transformCache.ts`) on a real resource store, with script workers the test
// holds and releases, so the lifetime rules are observable: the 4 running and 32 queued slots, a
// maintenance (`pause`) and a shutdown (`close`) ending queued and running requests alike and every
// snapshot, an abort before or right after a slot is granted (a cached or plugin-failure-only answer
// included), the one absolute deadline from the first call's admission (the snapshot's expiry, a
// second call waiting for a slot, the clock read even when the timer was held back), the snapshot
// caps, the cache's generation fence against an older fill (a "Re-render" while an earlier two-call
// render waits; the forgotten generations of the floor), and the cache probe (an all-cached request
// answered without loading the scope, only while the load's checks would still pass); the snapshot's
// memory budget (the request's own projection once, each target's setup, unchanged variable copies,
// distinct source and default-variable maps; an oversized projection runs no Lua and still answers
// cached targets); and the shared display scopes (configuration and transcript read once per burst,
// both caches' bounds, each pinned entry charged once against the global budget, pins released on
// every end path, display writes kept out of the shared entries, with real workers).
// The route and the remaining real-worker paths are `transform.test.ts`.

type Held = { task: { data: string }; release: (suffix?: string) => void };

/** A store with one character `a` (an `editprocess` regex and a Lua trigger; the held workers append "!" instead of running them) and its chat `k`. */
function harness() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-transform-service-"));
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
            customscript: [{ comment: "", in: "X", out: "Y", type: "editprocess", flag: "g" }],
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
    /** The regex runs the test holds (released by the test), and how many began. */
    const held: Held[] = [];
    const counts = { regex: 0, lua: 0 };
    let hold = true;
    const scriptWorkers = {
        runScripts: (task: { data: string }) => {
            counts.regex++;
            return new Promise<{ data: string }>((resolve) => {
                const release = (suffix = "!") => resolve({ data: task.data + suffix });
                if (hold) {
                    held.push({ task, release });
                } else {
                    release();
                }
            });
        },
        runLua: async (task: { data: unknown }) => {
            counts.lua++;
            return { res: task.data };
        },
        regex: async () => ({ value: null }),
        createBudget: () => createLuaBudget(),
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
    const request = (id: string, extra: Partial<TransformRequest> = {}, source = `X${id}`): TransformRequest => ({
        clientId: "tab",
        mode: "editprocess",
        context,
        targets: [{ id, kind: "text", sourceId: "a", chatIndex: -1, source }],
        ...extra,
    });
    return {
        dir,
        store,
        kinds,
        deps,
        held,
        counts,
        request,
        setHold(value: boolean) {
            hold = value;
        },
        /** Waits until `count` regex runs are held. */
        async heldCount(count: number) {
            for (let i = 0; i < 500 && held.length < count; i++) {
                await new Promise((resolve) => setTimeout(resolve, 2));
            }
            expect(held.length).toBe(count);
        },
        dispose() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

type Harness = ReturnType<typeof harness>;
let current: Harness | null = null;
const open = () => (current = harness());
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    current?.dispose();
    current = null;
});

const settle = <T>(promise: Promise<T>) =>
    promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
    );
const okText = (response: TransformResponse) =>
    response.results.map((result) => (result.ok ? `${result.id}=${result.text}` : `${result.id}!${result.error}`));

// Review-only probes: observe the service through the existing I/O harness.
it("probe: a permanently oversized shared transcript is read again on every retry", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const h = open();
    h.setHold(false);
    h.store.applyChanges({
        chats: [
            {
                characterId: "a",
                chatId: "huge",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "huge",
                            name: "Huge imported chat",
                            message: Array.from({ length: 65 }, (_, i) => ({
                                chatId: `m${i}`,
                                role: "char",
                                data: "x".repeat(1024 * 1024),
                            })),
                        },
                    },
                ],
            },
        ],
    });
    const reads = vi.spyOn(h.store, "readChatSource");
    const configs = vi.spyOn(h.store, "readKinds");
    const service = createTransformService(h.deps);
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            const start = process.hrtime.bigint();
            const response = await service.transform(
                h.request("row", {
                    mode: "editdisplay",
                    handlers: "display-hooks",
                    context: { ...h.request("row").context, chatId: "huge" },
                }),
                new AbortController().signal,
            );
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            console.log(
                JSON.stringify({
                    probe: "oversized-transcript",
                    attempt: attempt + 1,
                    ms: +ms.toFixed(2),
                    transcriptReads: reads.mock.calls.length,
                    configurationReads: configs.mock.calls.length,
                    luaCalls: h.counts.lua,
                    results: response.results,
                    stats: service.stats(),
                }),
            );
            expect(response.results).toMatchObject([{ ok: false }]);
            expect(service.stats().snapshots).toBe(0);
        }
        expect(reads).toHaveBeenCalledTimes(1); // Expected: permanent refusal need not hydrate the same chat every retry.
    } finally {
        await service.close();
    }
});

it("probe: changed retained inputs cannot confirm the pre-edit key", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const h = open();
    h.setHold(false);
    const service = createTransformService(h.deps);
    const request = h.request("row", { mode: "editdisplay" }, "{{description}} / {{user}} / {{getvar::v}}");
    const invoke = () => service.transform(request, new AbortController().signal);
    try {
        const first = (await invoke()).results[0];
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        request.targets[0].knownKey = first.key;
        expect((await invoke()).same).toHaveLength(1);
        for (const field of [
            "desc",
            "personality",
            "firstMessage",
            "globalLore",
            "additionalAssets",
            "defaultVariables",
            "customscript",
        ]) {
            const baseline = (await invoke()).results[0];
            if (baseline?.ok) request.targets[0].knownKey = baseline.key;
            else {
                const known = (await invoke()).same?.[0];
                if (known) request.targets[0].knownKey = known.key;
            }
            const record = h.store.get(h.kinds.get("characters")!, "a")!;
            const values: Record<string, unknown> = {
                desc: "new desc",
                personality: "new personality",
                firstMessage: "new greeting",
                globalLore: [{ content: "new lore" }],
                additionalAssets: [["asset", "assets/new.png", "png"]],
                defaultVariables: "v=changed",
                customscript: [{ comment: "", in: "new", out: "edited", type: "editdisplay" }],
            };
            h.store.put(
                h.kinds.get("characters")!,
                "a",
                { ...(record.data as object), [field]: values[field] },
                record.revision,
            );
            const result = await invoke();
            expect(result.same, field).toBeUndefined();
            expect(result.results[0], field).toMatchObject({ ok: true, cached: false });
            if (result.results[0]?.ok) request.targets[0].knownKey = result.results[0].key;
            console.log("input-change", field, "full answer; old key not confirmed");
        }
        for (const kind of ["personas", "modules", "presets", "ui", "memoryTranslateMedia", "globalChatVariables"]) {
            const record = h.store.get(h.kinds.get(kind)!, "main");
            // Change an existing field without altering the shape accepted by that resource kind.
            const copy: any = structuredClone(record?.data ?? (kind === "modules" ? [] : {}));
            if (Array.isArray(copy)) {
                if (copy.length) copy[0].name = `edited-${kind}`;
                else copy.push({ id: "probe-module", name: "probe", lorebook: [] });
            } else if (kind === "globalChatVariables") copy.probe = "new";
            else if (kind === "ui") copy.language = "ko";
            else copy.dynamicAssetsEditDisplay = true;
            h.store.put(h.kinds.get(kind)!, "main", copy, record?.revision ?? null);
            const result = await invoke();
            expect(result.same, kind).toBeUndefined();
            if (result.results[0]?.ok) request.targets[0].knownKey = result.results[0].key;
            console.log("input-change", kind, "full answer; old key not confirmed");
        }
    } finally {
        await service.close();
    }
});

import { runRegexScripts } from "../../../shared/scripts/regex.ts";
import { createNodeCbsEvaluator } from "./cbsHost.ts";
it("probe: plain-text parse skipping preserves CBS markers and unusual regex flags", () => {
    const db: any = {
        username: "Uma",
        characters: [
            {
                chaId: "c",
                name: "Risu",
                type: "character",
                chatPage: 0,
                chats: [{ id: "k", message: [], scriptstate: { $deferred: "{{user}}" } }],
            },
        ],
        personas: [],
    };
    const parse = createNodeCbsEvaluator(db, { selectedCharID: 0 }).risuChatParser;
    const samples = [
        "plain\nmultiple lines",
        "```\n{{user}}\n```",
        String.raw`\{{user}}`,
        "{#if 1\nkept#}",
        "<USER>",
        "<Char>",
        "<bot>",
        "{{getvar::deferred}}",
        "a {brace}",
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const flags = ["g", "gims", "ggimq", "<order 1>g", "<cbs>g", "uy", "uv"];
    for (const source of samples)
        for (const flag of flags) {
            const out = runRegexScripts(
                source,
                [{ comment: "", in: "absent", out: "same", type: "editdisplay", ableFlag: true, flag }],
                { mode: "editdisplay", chatID: -1, parse, repeatBackSource: () => "" },
            );
            // uv is deliberately invalid and remains the script engine's ordinary skipped-script behavior.
            expect(out.data, JSON.stringify({ source, flag })).toBe(
                flag === "uv" || flag === "<cbs>g" ? source : parse(source),
            );
        }
    const introduced = runRegexScripts(
        "seed",
        [
            { comment: "", in: "seed", out: "{{user}}", type: "editdisplay" },
            { comment: "", in: "absent", out: "x", type: "editdisplay" },
        ],
        { mode: "editdisplay", chatID: -1, parse, repeatBackSource: () => "" },
    );
    expect(introduced.data).toBe("Uma");
});
it("probe: plain text changed to CBS by a plugin is parsed after continuation", async () => {
    const h = open();
    h.setHold(false);
    const service = createTransformService(h.deps);
    try {
        const request = h.request("plain", { mode: "editdisplay", handlers: "plugin-set" }, "plain");
        const first = await service.transform(request, new AbortController().signal);
        const result = await service.resume(
            { clientId: "tab", snapshotId: first.snapshotId!, texts: [{ id: "plain", text: "{{user}}" }] },
            new AbortController().signal,
        );
        const persona = (h.store.get(h.kinds.get("personas")!, "main")!.data as any[])[0];
        expect(result.results[0]).toMatchObject({ ok: true, text: persona.name });
    } finally {
        await service.close();
    }
});
