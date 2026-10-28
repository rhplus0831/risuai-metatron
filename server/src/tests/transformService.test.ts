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

describe("the transform service's lifetime", () => {
    it("a maintenance ends the running and the queued requests; a queued one never runs after it", async () => {
        const h = open();
        const service = createTransformService(h.deps);
        const work = Array.from({ length: 5 }, (_, i) =>
            settle(service.transform(h.request(String(i)), new AbortController().signal)),
        );
        await h.heldCount(4);
        expect(service.stats()).toMatchObject({ active: 4, queued: 1 });
        const reopen = service.pause("maintenance now");
        // Admission is refused while it lasts.
        await expect(service.transform(h.request("late"), new AbortController().signal)).rejects.toBeInstanceOf(
            TransformUnavailableError,
        );
        reopen();
        for (const run of h.held.splice(0)) {
            run.release();
        }
        const outcomes = await Promise.all(work);
        expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, false, false, false, false]);
        for (const outcome of outcomes) {
            expect(outcome.ok ? "" : (outcome.error as Error).message).toBe("maintenance now");
        }
        // The queued request did not start its run after the maintenance ended.
        expect(h.counts.regex).toBe(4);
        expect(service.stats()).toMatchObject({
            active: 0,
            queued: 0,
            snapshots: 0,
            cached: 0,
            retainedBytes: 0,
            pinnedEntries: 0,
        });
        // New work runs after the maintenance.
        h.setHold(false);
        expect(okText(await service.transform(h.request("after"), new AbortController().signal))).toEqual([
            "after=Xafter!",
        ]);
        await service.close();
    });

    it("shutdown ends the running and the queued requests, waits for them, and refuses new work", async () => {
        const h = open();
        const service = createTransformService(h.deps);
        const work = Array.from({ length: 5 }, (_, i) =>
            settle(service.transform(h.request(String(i)), new AbortController().signal)),
        );
        await h.heldCount(4);
        const closing = service.close();
        let closed = false;
        void closing.then(() => (closed = true));
        await new Promise((resolve) => setTimeout(resolve, 5));
        // The held runs are still running: close waits for them.
        expect(closed).toBe(false);
        for (const run of h.held.splice(0)) {
            run.release();
        }
        await closing;
        const outcomes = await Promise.all(work);
        expect(outcomes.map((outcome) => (outcome.ok ? "ok" : (outcome.error as Error).message))).toEqual(
            Array(5).fill("The server is shutting down"),
        );
        expect(h.counts.regex).toBe(4);
        expect(service.stats()).toMatchObject({
            active: 0,
            queued: 0,
            snapshots: 0,
            cached: 0,
            retainedBytes: 0,
            pinnedEntries: 0,
        });
        await expect(service.transform(h.request("x"), new AbortController().signal)).rejects.toBeInstanceOf(
            TransformUnavailableError,
        );
    });

    it("refuses more than 32 queued requests; an aborted queued request leaves the queue", async () => {
        const h = open();
        const service = createTransformService(h.deps);
        const controllers = Array.from({ length: 36 }, () => new AbortController());
        const work = controllers.map((controller, i) =>
            settle(service.transform(h.request(String(i)), controller.signal)),
        );
        await h.heldCount(4);
        expect(service.stats()).toMatchObject({ active: 4, queued: 32 });
        await expect(service.transform(h.request("over"), new AbortController().signal)).rejects.toThrow(
            "Too many renders are waiting",
        );
        controllers[10].abort(new Error("tab closed"));
        const aborted = await work[10];
        expect(aborted.ok ? "" : (aborted.error as Error).message).toBe("tab closed");
        expect(service.stats()).toMatchObject({ active: 4, queued: 31 });
        // The rest run as slots free up, the aborted one never.
        h.setHold(false);
        for (const run of h.held.splice(0)) {
            run.release();
        }
        const outcomes = await Promise.all(work);
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(35);
        expect(h.counts.regex).toBe(35);
        expect(service.stats()).toMatchObject({ active: 0, queued: 0, snapshots: 0 });
        await service.close();
    });

    it("an already-aborted request runs nothing", async () => {
        const h = open();
        h.setHold(false);
        const service = createTransformService(h.deps);
        const controller = new AbortController();
        controller.abort(new Error("gone before"));
        await expect(service.transform(h.request("a"), controller.signal)).rejects.toThrow("gone before");
        expect(h.counts.regex).toBe(0);
        expect(service.stats()).toMatchObject({
            active: 0,
            queued: 0,
            snapshots: 0,
            cached: 0,
            retainedBytes: 0,
            pinnedEntries: 0,
        });
        await service.close();
    });

    it("an abort right after the slot is granted ends an all-cached answer and a plugin-failure-only second call", async () => {
        const h = open();
        h.setHold(false);
        const service = createTransformService(h.deps);
        const primed = await service.transform(h.request("c"), new AbortController().signal);
        expect(primed.results[0]).toMatchObject({ ok: true, cached: false });
        const controller = new AbortController();
        const cached = service.transform(h.request("c"), controller.signal);
        controller.abort(new Error("aborted after acquisition"));
        await expect(cached).rejects.toThrow("aborted after acquisition");

        const first = await service.transform(h.request("p", { handlers: "h" }), new AbortController().signal);
        expect(first.snapshotId).toBeTruthy();
        const resumeController = new AbortController();
        const second = service.resume(
            { clientId: "tab", snapshotId: first.snapshotId!, texts: [{ id: "p", error: "hook failed" }] },
            resumeController.signal,
        );
        resumeController.abort(new Error("aborted at the second call"));
        await expect(second).rejects.toThrow("aborted at the second call");
        expect(service.stats()).toMatchObject({ active: 0, queued: 0, snapshots: 0 });
        await service.close();
    });
});

describe("the transform service's deadline and snapshots", () => {
    it("a snapshot expires at the first call's deadline and cannot be claimed after it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const h = open();
        h.setHold(false);
        const service = createTransformService(h.deps);
        const first = await service.transform(h.request("t", { handlers: "h" }), new AbortController().signal);
        expect(first.pending).toEqual([{ id: "t", text: "Xt" }]);
        expect(service.stats().snapshots).toBe(1);
        vi.advanceTimersByTime(29_999);
        expect(service.stats().snapshots).toBe(1);
        vi.advanceTimersByTime(1);
        expect(service.stats().snapshots).toBe(0);
        await expect(
            service.resume(
                { clientId: "tab", snapshotId: first.snapshotId!, texts: [{ id: "t", text: "Xt" }] },
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(TransformSnapshotError);
        await service.close();
    });

    it("a second call waiting for a slot past the deadline is an expired snapshot", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const h = open();
        h.setHold(false);
        const service = createTransformService(h.deps);
        const first = await service.transform(h.request("t", { handlers: "h" }), new AbortController().signal);
        // Four requests take every slot.
        h.setHold(true);
        const busy = Array.from({ length: 4 }, (_, i) =>
            settle(service.transform(h.request(`busy${i}`), new AbortController().signal)),
        );
        for (let i = 0; i < 50 && h.held.length < 4; i++) {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(h.held).toHaveLength(4);
        const second = settle(
            service.resume(
                { clientId: "tab", snapshotId: first.snapshotId!, texts: [{ id: "t", text: "Xt" }] },
                new AbortController().signal,
            ),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(service.stats()).toMatchObject({ active: 4, queued: 1, snapshots: 0 });
        await vi.advanceTimersByTimeAsync(30_000);
        const outcome = await second;
        expect(outcome.ok).toBe(false);
        expect(outcome.ok ? null : outcome.error).toBeInstanceOf(TransformSnapshotError);
        expect(service.stats()).toMatchObject({ queued: 0 });
        // The busy requests passed their own deadline too.
        for (const run of h.held.splice(0)) {
            run.release();
        }
        expect((await Promise.all(busy)).every((entry) => !entry.ok)).toBe(true);
        expect(service.stats()).toMatchObject({
            active: 0,
            queued: 0,
            snapshots: 0,
            cached: 0,
            retainedBytes: 0,
            pinnedEntries: 0,
        });
        await service.close();
    });

    it("the deadline is read from the clock: a held-back timer does not let an overdue snapshot be kept", async () => {
        const h = open();
        h.setHold(false);
        let clock = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        // The character read every load makes takes 31 s by the clock while no timer can run.
        const slowStore = {
            ...h.store,
            readRefs(...args: Parameters<typeof h.store.readRefs>) {
                const result = h.store.readRefs(...args);
                clock += 31_001;
                return result;
            },
        };
        const service = createTransformService({ ...h.deps, store: slowStore } as GenerationRunnerDeps);
        await expect(
            service.transform(h.request("d", { handlers: "h" }), new AbortController().signal),
        ).rejects.toThrow("The render took too long");
        await expect(service.transform(h.request("e"), new AbortController().signal)).rejects.toThrow(
            "The render took too long",
        );
        expect(service.stats()).toMatchObject({
            active: 0,
            queued: 0,
            snapshots: 0,
            cached: 0,
            retainedBytes: 0,
            pinnedEntries: 0,
        });
        await service.close();
    });

    it("keeps at most 4 snapshots per client and 16 in all, the oldest dropped", async () => {
        const h = open();
        h.setHold(false);
        const service = createTransformService(h.deps);
        const own: string[] = [];
        for (let i = 0; i < 5; i++) {
            own.push(
                (await service.transform(h.request(`o${i}`, { handlers: "h" }), new AbortController().signal))
                    .snapshotId!,
            );
        }
        expect(service.stats().snapshots).toBe(4);
        await expect(
            service.resume(
                { clientId: "tab", snapshotId: own[0], texts: [{ id: "o0", text: "x" }] },
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(TransformSnapshotError);
        for (let client = 0; client < 4; client++) {
            for (let i = 0; i < 4; i++) {
                await service.transform(
                    { ...h.request(`c${client}-${i}`, { handlers: "h" }), clientId: `tab${client}` },
                    new AbortController().signal,
                );
            }
        }
        expect(service.stats().snapshots).toBe(16);
        // The 16 later snapshots pushed out every one of the first client's.
        await expect(
            service.resume(
                { clientId: "tab", snapshotId: own[4], texts: [{ id: "o4", text: "x" }] },
                new AbortController().signal,
            ),
        ).rejects.toBeInstanceOf(TransformSnapshotError);
        await service.close();
        expect(service.stats().snapshots).toBe(0);
    });

    it("an older two-call render finishing after a Re-render of the same target does not replace its result", async () => {
        const h = open();
        h.setHold(false);
        const service = createTransformService(h.deps);
        const signal = new AbortController().signal;
        const older = await service.transform(h.request("t", { handlers: "h" }), signal);
        const rerender = await service.transform(
            {
                ...h.request("t", { handlers: "h" }),
                targets: [{ id: "t", kind: "text", sourceId: "a", chatIndex: -1, source: "Xt", noCache: true }],
            },
            signal,
        );
        const fresh = await service.resume(
            { clientId: "tab", snapshotId: rerender.snapshotId!, texts: [{ id: "t", text: "X new" }] },
            signal,
        );
        expect(okText(fresh)).toEqual(["t=X new!"]);
        // The older render still answers its own call, but its result is not stored.
        const late = await service.resume(
            { clientId: "tab", snapshotId: older.snapshotId!, texts: [{ id: "t", text: "X old" }] },
            signal,
        );
        expect(okText(late)).toEqual(["t=X old!"]);
        const next = await service.transform(h.request("t", { handlers: "h" }), signal);
        expect(next.snapshotId).toBeUndefined();
        expect(next.results).toEqual([expect.objectContaining({ id: "t", text: "X new!", cached: true })]);
        await service.close();
    });
});

describe("the transform snapshot's memory budget", () => {
    beforeEach(() => {
        // Neither fixture size nor a continuation gap races the render deadline or the CBS clock.
        vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    });
    const signal = () => new AbortController().signal;
    const patchCharacter = (h: Harness, fields: Record<string, unknown>) => {
        const kind = h.kinds.get("characters")!;
        const stored = h.store.get(kind, "a")!;
        h.store.put(kind, "a", { ...(stored.data as object), ...fields }, stored.revision);
    };
    const patchChat = (h: Harness, set: Record<string, unknown>) => {
        h.store.applyChanges({
            chats: [
                {
                    characterId: "a",
                    chatId: "k",
                    baseRevision: h.store.chatRevision("a", "k"),
                    ops: [{ op: "meta", set }],
                },
            ],
        });
    };
    /** Every requested target is either pending or failed, and the accepted set can still finish. */
    const finishPending = async (
        service: ReturnType<typeof createTransformService>,
        request: TransformRequest,
        first: TransformResponse,
    ) => {
        expect(first.snapshotId).toEqual(expect.any(String));
        const pending = first.pending ?? [];
        const pendingIds = new Set(pending.map(({ id }) => id));
        expect(first.results).toEqual(
            request.targets
                .filter(({ id }) => !pendingIds.has(id))
                .map(({ id }) => ({ id, ok: false, error: expect.any(String) })),
        );
        expect(service.stats().snapshots).toBe(1);
        const second = await service.resume(
            { clientId: request.clientId, snapshotId: first.snapshotId!, texts: pending },
            signal(),
        );
        expect(second.results).toEqual(
            pending.map(({ id }) => expect.objectContaining({ id, ok: true, cached: false })),
        );
        expect(service.stats().snapshots).toBe(0);
    };

    it("a request's own projection over the snapshot budget fails every uncached target without running Lua or retaining a snapshot", async () => {
        const h = open();
        h.setHold(false);
        // The targets are tiny; it is the owner character, read for each request, that exceeds 8 MiB.
        patchCharacter(h, { desc: "x".repeat(9 * 1024 * 1024) });
        const service = createTransformService(h.deps);
        try {
            for (let i = 0; i < 4; i++) {
                const request = h.request(`tiny${i}`, {
                    mode: "editdisplay",
                    handlers: "display",
                    targets: [...h.request(`tiny${i}`).targets, ...h.request(`other${i}`).targets],
                });
                const first = await service.transform(request, signal());
                expect(first.snapshotId).toBeUndefined();
                expect(first.pending ?? []).toEqual([]);
                expect(first.results).toEqual(
                    request.targets.map(({ id }) => ({ id, ok: false, error: expect.any(String) })),
                );
                expect(service.stats().snapshots).toBe(0);
            }
            expect(h.counts.lua).toBe(0);
            expect(h.counts.regex).toBe(0);
        } finally {
            await service.close();
        }
    });

    it("each pending target pays for its unchanged chat-variable entries", async () => {
        const h = open();
        h.setHold(false);
        patchChat(h, {
            scriptstate: Object.fromEntries(Array.from({ length: 8192 }, (_, i) => [`$v${i}`, "0"])),
        });
        // All 32 tiny texts fit if unchanged entries are charged only with the shared scope.
        const request = h.request("v", {
            mode: "editdisplay",
            handlers: "display",
            targets: Array.from({ length: 32 }, (_, i) => h.request(`v${i}`).targets[0]),
        });
        const service = createTransformService(h.deps);
        try {
            const first = await service.transform(request, signal());
            expect(first.pending?.length).toBeGreaterThan(0);
            expect(first.pending?.length).toBeLessThan(request.targets.length);
            await finishPending(service, request, first);
        } finally {
            await service.close();
        }
    });

    it("a tiny Lua head result still pays for its large source, with the loaded character charged once", async () => {
        const h = open();
        h.setHold(false);
        patchCharacter(h, { desc: "d".repeat(5 * 1024 * 1024) });
        // The input texts total just under 4 MiB, while every head result is only four bytes.
        const lua = vi.spyOn(h.deps.scriptWorkers, "runLua").mockResolvedValue({
            res: "tiny",
            stopSending: false,
            cpuMs: 0,
            memory: { used: 0, max: 0 },
        });
        const request = h.request("source", {
            mode: "editdisplay",
            handlers: "display",
            targets: [
                ...Array.from(
                    { length: 8 },
                    (_, i) => h.request(`source${i}`, {}, "s".repeat(512 * 1024 - 2) + i).targets[0],
                ),
                ...h.request("small", {}, "fits").targets,
            ],
        });
        const service = createTransformService(h.deps);
        try {
            const first = await service.transform(request, signal());
            // More than one fits because the loaded character is shared; all eight large sources do not.
            expect(first.pending?.length).toBeGreaterThan(1);
            expect(first.pending?.length).toBeLessThan(request.targets.length);
            expect(first.pending).toContainEqual({ id: "small", text: "tiny" });
            expect(first.pending?.every(({ text }) => text === "tiny")).toBe(true);
            expect(lua).toHaveBeenCalled();
            await finishPending(service, request, first);
        } finally {
            await service.close();
        }
    });

    it("target setup costs limit tiny targets, and cached targets survive an oversized loaded scope", async () => {
        const h = open();
        h.setHold(false);
        patchCharacter(h, { desc: "d".repeat(6 * 1024 * 1024) });
        // This character is loaded only when a target names it, so the primed cache key stays valid.
        const kind = h.kinds.get("characters")!;
        const owner = h.store.get(kind, "a")!.data as object;
        h.store.put(kind, "extra", { ...owner, chaId: "extra", desc: "e".repeat(3 * 1024 * 1024) }, null);
        const request = h.request("setup", {
            mode: "editdisplay",
            handlers: "display",
            targets: Array.from({ length: 64 }, (_, i) => h.request(`setup${i}`).targets[0]),
        });
        const service = createTransformService(h.deps);
        try {
            const first = await service.transform(request, signal());
            // The scope fits once and these texts are tiny, but 64 individual setups do not fit.
            expect(first.pending?.length).toBeGreaterThan(1);
            expect(first.pending?.length).toBeLessThan(request.targets.length);
            await finishPending(service, request, first);
            const cached = request.targets.find(({ id }) => id === first.pending![0].id)!;
            const luaBefore = h.counts.lua;
            const mixed = await service.transform(
                {
                    ...request,
                    targets: [
                        h.request("fresh").targets[0],
                        { ...h.request("extra").targets[0], sourceId: "extra" },
                        cached,
                    ],
                },
                signal(),
            );
            expect(mixed.results).toEqual([
                { id: "fresh", ok: false, error: expect.any(String) },
                { id: "extra", ok: false, error: expect.any(String) },
                expect.objectContaining({ id: cached.id, ok: true, cached: true }),
            ]);
            expect(mixed.snapshotId).toBeUndefined();
            expect(mixed.pending ?? []).toEqual([]);
            expect(service.stats().snapshots).toBe(0);
            expect(h.counts.lua).toBe(luaBefore);
        } finally {
            await service.close();
        }
    });

    it("each pending target reserves space for character and template default-variable maps", async () => {
        const h = open();
        h.setHold(false);
        const defaults = Array.from({ length: 4096 }, (_, i) => `v${i}=0`).join("\n");
        const kind = h.kinds.get("presets")!;
        // Default maps are lazy: their allowance must apply even before a missing variable is read.
        const request = h.request("defaults", {
            mode: "editdisplay",
            handlers: "display",
            targets: Array.from({ length: 32 }, (_, i) => h.request(`defaults${i}`, {}, "{{getvar::v0}}").targets[0]),
        });
        const service = createTransformService(h.deps);
        try {
            for (const source of ["character", "template"]) {
                patchCharacter(h, { defaultVariables: source === "character" ? defaults : "" });
                const stored = h.store.get(kind, "main")!;
                const presets = stored.data as { id: string }[];
                h.store.put(
                    kind,
                    "main",
                    presets.map((preset) => ({
                        ...preset,
                        templateDefaultVariables: source === "template" ? defaults : "",
                    })),
                    stored.revision,
                );
                const first = await service.transform(request, signal());
                expect(first.pending?.length, source).toBeGreaterThan(0);
                expect(first.pending?.length, source).toBeLessThan(request.targets.length);
                await finishPending(service, request, first);
            }
        } finally {
            await service.close();
        }
    });
});

describe("the transform cache", () => {
    const entry = (text: string) => ({ text, emotions: [] });

    it("evicts the least recently used by count and by bytes, and keeps no result over the entry limit", () => {
        const cache = createTransformCache({ entries: 2, bytes: 10, entryBytes: 6 });
        expect(cache.set("a", entry("aaa"), cache.generation("a"))).toBe(true);
        expect(cache.set("b", entry("bbb"), cache.generation("b"))).toBe(true);
        expect(cache.get("a")?.text).toBe("aaa");
        expect(cache.set("c", entry("ccc"), cache.generation("c"))).toBe(true);
        // `b` was the least recently used.
        expect(cache.get("b")).toBeUndefined();
        expect(cache.size).toBe(2);
        expect(cache.set("d", entry("dddddd"), cache.generation("d"))).toBe(true);
        // 3 + 6 bytes fit, a third does not: the oldest goes.
        expect(cache.set("e", entry("ee"), cache.generation("e"))).toBe(true);
        expect([cache.get("a"), cache.get("c")].filter(Boolean)).toHaveLength(0);
        expect(cache.set("big", entry("1234567"), cache.generation("big"))).toBe(false);
        expect(cache.get("big")).toBeUndefined();
        // An empty result is kept (and answered) as any other.
        expect(cache.set("empty", entry(""), cache.generation("empty"))).toBe(true);
        expect(cache.get("empty")).toEqual(entry(""));
    });

    it("refuses a fill begun before the key's invalidation, also once its generation was forgotten or the cache cleared", () => {
        const cache = createTransformCache();
        const before = cache.generation("t");
        cache.invalidate("t");
        expect(cache.set("t", entry("stale"), before)).toBe(false);
        expect(cache.set("t", entry("new"), cache.generation("t"))).toBe(true);
        // 4,096 other invalidations forget `t`'s generation: the floor rises above it.
        const afterNew = cache.generation("t");
        const otherBefore = cache.generation("other");
        for (let i = 0; i < 4096; i++) {
            cache.invalidate(`k${i}`);
        }
        expect(cache.set("t", entry("stale"), before)).toBe(false);
        expect(cache.set("t", entry("stale"), afterNew)).toBe(false);
        expect(cache.set("other", entry("stale"), otherBefore)).toBe(false);
        expect(cache.get("t")?.text).toBe("new");
        const beforeClear = cache.generation("x");
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.set("x", entry("stale"), beforeClear)).toBe(false);
        expect(cache.set("x", entry("ok"), cache.generation("x"))).toBe(true);
    });
});

describe("the transform cache probe", () => {
    const signal = () => new AbortController().signal;
    /** The first result's cache key (it rendered). */
    const keyOf = (response: TransformResponse) => {
        const result = response.results[0];
        if (!result.ok) {
            throw new Error(result.error);
        }
        return result.key;
    };
    const character = (chaId: string, fields: Record<string, unknown> = {}) => ({
        chaId,
        type: "character",
        name: chaId.toUpperCase(),
        firstMessage: "hi",
        desc: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
        ...fields,
    });
    /** Loads so far: every load reads its chat owner's record. */
    const ownerReads = (spy: { mock: { calls: Parameters<Harness["store"]["readRefs"]>[] } }, owner: string) =>
        spy.mock.calls.filter(([refs]) => refs.some((ref) => ref.kind.name === "characters" && ref.id === owner))
            .length;
    const touch = (h: Harness, chaId: string) => {
        const kind = h.kinds.get("characters")!;
        const stored = h.store.get(kind, chaId)!;
        h.store.put(
            kind,
            chaId,
            { ...(stored.data as object), desc: `${Date.now()}-${Math.random()}` },
            stored.revision,
        );
    };

    it("answers an all-cached request without loading the scope, and loads it when any target must run", async () => {
        const h = open();
        h.setHold(false);
        const service = createTransformService(h.deps);
        const first = await service.transform(h.request("c"), signal());
        expect(first.results[0]).toMatchObject({ ok: true, text: "Xc!", cached: false });
        const loads = vi.spyOn(h.store, "readRefs");

        const again = await service.transform(h.request("c"), signal());
        expect(again.results[0]).toMatchObject({ ok: true, text: "Xc!", cached: true, key: keyOf(first) });
        expect(loads).not.toHaveBeenCalled();
        expect(h.counts.regex).toBe(1);

        // One target to run: the request loads, and its cached target is still answered from the cache.
        const mixed = await service.transform(
            h.request("c", { targets: [...h.request("c").targets, ...h.request("d").targets] }),
            signal(),
        );
        expect(mixed.results).toMatchObject([
            { id: "c", ok: true, cached: true },
            { id: "d", ok: true, text: "Xd!", cached: false },
        ]);
        expect(ownerReads(loads, "a")).toBe(1);

        // `noCache` always loads and renders again.
        const fresh = await service.transform(
            h.request("c", { targets: [{ ...h.request("c").targets[0], noCache: true }] }),
            signal(),
        );
        expect(fresh.results[0]).toMatchObject({ ok: true, cached: false });
        expect(ownerReads(loads, "a")).toBe(2);
        expect(h.counts.regex).toBe(3);
        await service.close();
    });

    it("does not answer from the cache once the chat is bound to another existing prompt preset: the load refuses it", async () => {
        const h = open();
        h.setHold(false);
        const presets = h.kinds.get("presets")!;
        const stored = h.store.get(presets, "main")!;
        const list = stored.data as { id: string }[];
        h.store.put(presets, "main", [...list, { ...list[0], id: "other-preset" }], stored.revision);
        const service = createTransformService(h.deps);
        const first = await service.transform(h.request("c"), signal());
        expect(first.results[0]).toMatchObject({ ok: true, cached: false });

        // Only the chat's binding changes: every record the key names keeps its revision.
        h.store.applyChanges({
            chats: [
                {
                    characterId: "a",
                    chatId: "k",
                    baseRevision: h.store.chatRevision("a", "k"),
                    ops: [{ op: "meta", set: { promptPresetId: "other-preset" } }],
                },
            ],
        });
        await expect(service.transform(h.request("c"), signal())).rejects.toBeInstanceOf(ChatBindingError);
        expect(h.counts.regex).toBe(1);
        await service.close();
    });

    it("keys a group's chat by its members: a member's change renders again, another character's does not load", async () => {
        const h = open();
        h.setHold(false);
        const characters = h.kinds.get("characters")!;
        h.store.put(characters, "b", character("b"), null);
        h.store.put(characters, "outsider", character("outsider"), null);
        h.store.put(
            characters,
            "g",
            { chaId: "g", type: "group", name: "G", firstMessage: "", desc: "", characters: ["a", "b"] },
            null,
        );
        h.store.applyChanges({
            chats: [
                {
                    characterId: "g",
                    chatId: "gk",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { id: "gk", name: "GK", message: [] } }],
                },
            ],
        });
        const base = h.request("c");
        const request = { ...base, context: { ...base.context, characterId: "g", chatId: "gk" } };
        const service = createTransformService(h.deps);
        const first = await service.transform(request, signal());
        expect(first.results[0]).toMatchObject({ ok: true, text: "Xc!", cached: false });
        const loads = vi.spyOn(h.store, "readRefs");

        expect((await service.transform(request, signal())).results[0]).toMatchObject({ cached: true });
        touch(h, "outsider");
        expect((await service.transform(request, signal())).results[0]).toMatchObject({
            cached: true,
            key: keyOf(first),
        });
        expect(loads).not.toHaveBeenCalled();

        // `b` is a member but not the target's source: only the group's key names it.
        touch(h, "b");
        const after = await service.transform(request, signal());
        expect(after.results[0]).toMatchObject({ ok: true, cached: false });
        expect(keyOf(after)).not.toBe(keyOf(first));
        expect(ownerReads(loads, "g")).toBe(1);
        await service.close();
    });
});

describe("the transform load", () => {
    const signal = () => new AbortController().signal;
    const character = (chaId: string) => ({
        chaId,
        type: "character",
        name: chaId.toUpperCase(),
        firstMessage: "hi",
        desc: "",
        globalLore: [],
        customscript: [],
        triggerscript: [],
    });

    it("reads the owner, its members, the targets' sources, and the chat's speakers, not every character", async () => {
        const h = open();
        h.setHold(false);
        const characters = h.kinds.get("characters")!;
        for (const id of ["b", "source", "former", "outsider"]) {
            h.store.put(characters, id, character(id), null);
        }
        h.store.put(
            characters,
            "g",
            { chaId: "g", type: "group", name: "G", firstMessage: "", desc: "", characters: ["a", "b"] },
            null,
        );
        // `former` spoke in the chat but is no longer a member.
        h.store.applyChanges({
            chats: [
                {
                    characterId: "g",
                    chatId: "gk",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: "gk",
                                name: "GK",
                                message: [{ role: "char", data: "earlier", saying: "former", chatId: "m1" }],
                            },
                        },
                    ],
                },
            ],
        });
        const base = h.request("c");
        const request: TransformRequest = {
            ...base,
            context: { ...base.context, characterId: "g", chatId: "gk" },
            targets: [...base.targets, { ...h.request("d").targets[0], sourceId: "source" }],
        };
        const readKinds = vi.spyOn(h.store, "readKinds");
        const readRefs = vi.spyOn(h.store, "readRefs");
        const service = createTransformService(h.deps);

        // Each target renders with its own source: `a`'s regex scripts run, `source` has none.
        const response = await service.transform(request, signal());
        expect(response.results).toMatchObject([
            { id: "c", ok: true, text: "Xc!", cached: false },
            { id: "d", ok: true, text: "Xd", cached: false },
        ]);
        expect(readKinds).toHaveBeenCalled();
        for (const [kindList] of readKinds.mock.calls) {
            expect(kindList.map((kind) => kind.name)).not.toContain("characters");
        }
        const read = new Set(
            readRefs.mock.calls.flatMap(([refs]) =>
                refs.filter((ref) => ref.kind.name === "characters").map((ref) => ref.id),
            ),
        );
        expect(read).toEqual(new Set(["g", "a", "b", "source", "former"]));
        await service.close();
    });
});

describe("shared display scopes", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    });
    const signal = () => new AbortController().signal;
    const MiB = 1024 * 1024;
    const createChat = (h: Harness, chatId: string, data = "stored") => {
        h.store.applyChanges({
            chats: [
                {
                    characterId: "a",
                    chatId,
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: { id: chatId, name: chatId, message: [{ role: "char", chatId: "m", data }] },
                        },
                    ],
                },
            ],
        });
    };
    const requestFor = (h: Harness, id: string, chatId = "k", handlers?: string): TransformRequest => {
        const request = h.request(id, { handlers });
        return {
            ...request,
            context: { ...request.context, chatId },
            targets: request.targets.map((target) => ({ ...target, noCache: true })),
        };
    };
    const continueWith = (first: TransformResponse, clientId = "tab") => ({
        clientId,
        snapshotId: first.snapshotId!,
        texts: first.pending!,
    });
    const expectReleased = (service: ReturnType<typeof createTransformService>) => {
        expect(service.stats()).toMatchObject({ snapshots: 0, retainedBytes: 0, pinnedEntries: 0 });
    };
    const editPreset = (h: Harness, name: string) => {
        const kind = h.kinds.get("presets")!;
        const record = h.store.get(kind, "main")!;
        h.store.put(
            kind,
            "main",
            (record.data as object[]).map((preset) => ({ ...preset, name })),
            record.revision,
        );
    };
    const loaderContext = (h: Harness, chatId = "k") => ({
        ...h.request("context").context,
        chatId,
        mode: "transform" as const,
        input: "",
        chatRevision: "",
    });

    it("eight uncached batches reuse all configuration and the transcript while reading characters each time", async () => {
        const h = open();
        h.setHold(false);
        const configuration = vi.spyOn(h.store, "readKinds");
        const transcript = vi.spyOn(h.store, "readChatSource");
        const characters = vi.spyOn(h.store, "readRefs");
        const service = createTransformService(h.deps);
        try {
            for (let i = 0; i < 8; i++) {
                const response = await service.transform(requestFor(h, `batch${i}`), signal());
                expect(response.results).toMatchObject([{ ok: true, cached: false }]);
            }
            expect(h.counts.regex).toBe(8);
            expect(configuration).toHaveBeenCalledTimes(1);
            expect(configuration.mock.calls[0][0].map((kind) => kind.name).sort()).toEqual(
                jobScopeKinds(h.kinds)
                    .map((kind) => kind.name)
                    .filter((name) => name !== "characters")
                    .sort(),
            );
            expect(transcript).toHaveBeenCalledTimes(1);
            expect(characters.mock.calls.flatMap(([refs]) => refs).every((ref) => ref.kind.name === "characters")).toBe(
                true,
            );
            expect(
                characters.mock.calls
                    .flatMap(([refs]) => refs)
                    .filter((ref) => ref.kind.name === "characters" && ref.id === "a"),
            ).toHaveLength(8);
            expectReleased(service);
        } finally {
            await service.close();
        }
    });

    it("a chat write reloads only the transcript and a preset edit reloads only configuration", async () => {
        const h = open();
        h.setHold(false);
        const configuration = vi.spyOn(h.store, "readKinds");
        const transcript = vi.spyOn(h.store, "readChatSource");
        const service = createTransformService(h.deps);
        try {
            await service.transform(requestFor(h, "before"), signal());
            h.store.applyChanges({
                chats: [
                    {
                        characterId: "a",
                        chatId: "k",
                        baseRevision: h.store.chatRevision("a", "k"),
                        ops: [{ op: "meta", set: { scriptstate: { $v: "written" } } }],
                    },
                ],
            });
            const changed = requestFor(h, "chat");
            changed.targets[0].source = "{{getvar::v}}";
            expect(okText(await service.transform(changed, signal()))).toEqual(["chat=written!"]);
            expect(configuration).toHaveBeenCalledTimes(1);
            expect(transcript).toHaveBeenCalledTimes(2);
            editPreset(h, "edited");
            await service.transform(requestFor(h, "preset"), signal());
            expect(configuration).toHaveBeenCalledTimes(2);
            expect(transcript).toHaveBeenCalledTimes(2);
        } finally {
            await service.close();
        }
    });

    it.each(["entry count", "bytes"] as const)("configuration eviction respects its %s bound", (bound) => {
        const h = open();
        editPreset(h, "version0");
        const context = loaderContext(h);
        const measured = createDisplayScopeLoader(h.store, h.kinds);
        measured.load(context);
        const oneEntry = measured.stats().configuration.bytes;
        const maxBytes = bound === "bytes" ? 2 * oneEntry : 32 * MiB;
        const loader = createDisplayScopeLoader(h.store, h.kinds, {
            configuration: { maxEntries: bound === "entry count" ? 2 : 8, maxBytes },
        });
        const reads = vi.spyOn(h.store, "readKinds");
        for (let i = 0; i < 3; i++) {
            if (i > 0) editPreset(h, `version${i}`);
            loader.load(context);
            expect(loader.stats().configuration.entries).toBe(Math.min(i + 1, 2));
            expect(loader.stats().configuration.bytes).toBeLessThanOrEqual(maxBytes);
        }
        loader.load(context);
        expect(reads).toHaveBeenCalledTimes(3);
        loader.clear();
        expect(loader.stats()).toEqual({
            configuration: { entries: 0, bytes: 0 },
            transcripts: { entries: 0, bytes: 0 },
        });
        loader.load(context);
        expect(reads).toHaveBeenCalledTimes(4);
    });

    it.each(["entry count", "bytes"] as const)(
        "transcript eviction respects its %s bound and retains the most recently used chat",
        (bound) => {
            const h = open();
            for (const id of ["one", "two", "new"]) createChat(h, id, "x".repeat(1024));
            const measured = createDisplayScopeLoader(h.store, h.kinds);
            measured.load(loaderContext(h, "one"));
            const oneEntry = measured.stats().transcripts.bytes;
            const maxBytes = bound === "bytes" ? 2 * oneEntry : 64 * MiB;
            const loader = createDisplayScopeLoader(h.store, h.kinds, {
                transcripts: { maxEntries: bound === "entry count" ? 2 : 8, maxBytes },
            });
            const reads = vi.spyOn(h.store, "readChatSource");
            for (const id of ["one", "two", "one", "new", "one"]) loader.load(loaderContext(h, id));
            expect(reads.mock.calls.map(([, id]) => id)).toEqual(["one", "two", "new"]);
            expect(loader.stats().transcripts.entries).toBe(2);
            expect(loader.stats().transcripts.bytes).toBeLessThanOrEqual(maxBytes);
            loader.load(loaderContext(h, "two"));
            expect(reads.mock.calls.map(([, id]) => id)).toEqual(["one", "two", "new", "two"]);
            expect(loader.stats().transcripts.entries).toBe(2);
            expect(loader.stats().transcripts.bytes).toBeLessThanOrEqual(maxBytes);
        },
    );

    it("large transcripts are charged once across snapshots and remain pinned after cache eviction", async () => {
        const h = open();
        h.setHold(false);
        createChat(h, "large", "x".repeat(10 * MiB));
        const service = createTransformService(h.deps);
        try {
            const kept: TransformResponse[] = [];
            for (let i = 0; i < 4; i++) {
                const first = await service.transform(requestFor(h, `large${i}`, "large", "hooks"), signal());
                expect(first.results).toEqual([]);
                expect(first.pending).toHaveLength(1);
                expect(first.snapshotId).toEqual(expect.any(String));
                kept.push(first);
            }
            const charged = service.stats().retainedBytes;
            expect(service.stats()).toMatchObject({ snapshots: 4, pinnedEntries: 2 });
            expect(charged).toBeGreaterThan(10 * MiB);
            expect(charged).toBeLessThan(12 * MiB);
            for (let i = 0; i < 8; i++) {
                createChat(h, `other${i}`);
                await service.transform(requestFor(h, `other${i}`, `other${i}`), signal());
            }
            expect(service.stats().displayScope.transcripts.entries).toBe(8);
            expect(service.stats().displayScope.transcripts.bytes).toBeLessThan(MiB);
            expect(service.stats()).toMatchObject({ retainedBytes: charged, pinnedEntries: 2 });
            for (let i = 0; i < kept.length; i++) {
                expect((await service.resume(continueWith(kept[i]), signal())).results[0]).toMatchObject({ ok: true });
                if (i < kept.length - 1) {
                    expect(service.stats().pinnedEntries).toBe(2);
                    expect(service.stats().retainedBytes).toBeGreaterThan(10 * MiB);
                }
            }
            expectReleased(service);
        } finally {
            await service.close();
        }
    });

    it.each(["success", "target error", "abort"] as const)(
        "a claimed continuation holds its pins through %s and releases them when finished",
        async (ending) => {
            const h = open();
            const service = createTransformService(h.deps);
            try {
                const first = await service.transform(requestFor(h, "held", "k", "hooks"), signal());
                const charged = service.stats().retainedBytes;
                expect(charged).toBeGreaterThan(0);
                expect(service.stats().pinnedEntries).toBe(2);
                const controller = new AbortController();
                const second = settle(
                    service.resume(
                        {
                            ...continueWith(first),
                            texts:
                                ending === "target error" ? [{ id: "held", error: "plugin exploded" }] : first.pending!,
                        },
                        controller.signal,
                    ),
                );
                // Claiming removes the waiting snapshot synchronously, before the slot is granted.
                expect(service.stats()).toMatchObject({ snapshots: 0, retainedBytes: charged, pinnedEntries: 2 });
                if (ending !== "target error") {
                    await vi.advanceTimersByTimeAsync(0);
                    expect(h.held).toHaveLength(1);
                    expect(service.stats()).toMatchObject({
                        active: 1,
                        snapshots: 0,
                        retainedBytes: charged,
                        pinnedEntries: 2,
                    });
                    if (ending === "abort") controller.abort(new Error("tab left"));
                    h.held.shift()!.release();
                }
                const outcome = await second;
                if (ending === "abort") {
                    expect(outcome).toMatchObject({ ok: false, error: { message: "tab left" } });
                } else {
                    expect(outcome.ok).toBe(true);
                    if (outcome.ok)
                        expect(outcome.value.results[0]).toMatchObject(
                            ending === "target error"
                                ? { ok: false, error: "A plugin handler failed: plugin exploded" }
                                : { ok: true },
                        );
                }
                expectReleased(service);
            } finally {
                h.setHold(false);
                for (const held of h.held.splice(0)) held.release();
                await service.close();
            }
        },
    );

    it.each(["expiry", "replacement", "maintenance", "shutdown"] as const)(
        "waiting snapshot pins are released on %s",
        async (ending) => {
            const h = open();
            h.setHold(false);
            const reads = vi.spyOn(h.store, "readKinds");
            const service = createTransformService(h.deps);
            try {
                const first = await service.transform(requestFor(h, "old", "k", "hooks"), signal());
                expect(service.stats()).toMatchObject({ snapshots: 1, pinnedEntries: 2 });
                expect(service.stats().retainedBytes).toBeGreaterThan(0);
                if (ending === "expiry") {
                    await vi.advanceTimersByTimeAsync(30_000);
                } else if (ending === "replacement") {
                    const replacements: TransformResponse[] = [];
                    for (let i = 0; i < 4; i++) {
                        createChat(h, `replacement${i}`);
                        replacements.push(
                            await service.transform(
                                requestFor(h, `replacement${i}`, `replacement${i}`, "hooks"),
                                signal(),
                            ),
                        );
                    }
                    expect(service.stats()).toMatchObject({ snapshots: 4, pinnedEntries: 5 });
                    for (const replacement of replacements) await service.resume(continueWith(replacement), signal());
                } else if (ending === "maintenance") {
                    const reopen = service.pause("maintenance");
                    expect(service.stats().displayScope).toEqual({
                        configuration: { entries: 0, bytes: 0 },
                        transcripts: { entries: 0, bytes: 0 },
                    });
                    reopen();
                } else {
                    await service.close();
                    expect(service.stats().displayScope).toEqual({
                        configuration: { entries: 0, bytes: 0 },
                        transcripts: { entries: 0, bytes: 0 },
                    });
                }
                expectReleased(service);
                if (ending !== "shutdown")
                    await expect(service.resume(continueWith(first), signal())).rejects.toBeInstanceOf(
                        TransformSnapshotError,
                    );
                if (ending === "maintenance") {
                    await service.transform(requestFor(h, "after"), signal());
                    expect(reads).toHaveBeenCalledTimes(2);
                    expect(service.stats().displayScope.configuration.entries).toBe(1);
                }
            } finally {
                await service.close();
            }
        },
    );

    it.each(["queue full", "aborted while queued"] as const)(
        "a continuation releases its pins when %s",
        async (ending) => {
            const h = open();
            const service = createTransformService(h.deps);
            const work: ReturnType<typeof settle<TransformResponse>>[] = [];
            try {
                const first = await service.transform(requestFor(h, "pending", "k", "hooks"), signal());
                const charged = service.stats().retainedBytes;
                for (let i = 0; i < (ending === "queue full" ? 36 : 4); i++) {
                    work.push(settle(service.transform(requestFor(h, `busy${i}`), signal())));
                }
                await vi.advanceTimersByTimeAsync(0);
                expect(h.held).toHaveLength(4);
                const controller = new AbortController();
                const second = service.resume(continueWith(first), controller.signal);
                if (ending === "aborted while queued") {
                    expect(service.stats()).toMatchObject({
                        snapshots: 0,
                        queued: 1,
                        retainedBytes: charged,
                        pinnedEntries: 2,
                    });
                    controller.abort(new Error("queued tab left"));
                }
                await expect(second).rejects.toThrow(
                    ending === "queue full" ? "Too many renders are waiting" : "queued tab left",
                );
                expectReleased(service);
            } finally {
                h.setHold(false);
                for (const held of h.held.splice(0)) held.release();
                await Promise.all(work);
                await service.close();
            }
        },
    );

    it("the global budget replaces this client's oldest waiter before other clients and refuses a target when a continuation holds the space", async () => {
        const h = open();
        // One 21-Mi-character string is 63 MiB in UTF-8: shared data leaves less than 1 MiB
        // for projections. A 512 KiB character lets one larger projection fit, but not two.
        createChat(h, "large", "界".repeat(21 * MiB));
        const service = createTransformService(h.deps);
        let running: ReturnType<typeof settle<TransformResponse>> | undefined;
        try {
            const olderOther = await service.transform(
                { ...requestFor(h, "other", "large", "hooks"), clientId: "other" },
                signal(),
            );
            const characters = h.kinds.get("characters")!;
            const character = h.store.get(characters, "a")!;
            h.store.put(
                characters,
                "a",
                { ...(character.data as object), desc: "d".repeat(512 * 1024) },
                character.revision,
            );
            const olderOwn = await service.transform(requestFor(h, "own", "large", "hooks"), signal());
            expect(olderOther.pending).toHaveLength(1);
            expect(olderOwn.pending).toHaveLength(1);
            expect(service.stats()).toMatchObject({ snapshots: 2, pinnedEntries: 2 });
            const newer = await service.transform(requestFor(h, "new", "large", "hooks"), signal());
            expect(newer.results).toEqual([]);
            expect(newer.pending).toHaveLength(1);
            expect(service.stats()).toMatchObject({ snapshots: 2, pinnedEntries: 2 });
            expect(service.stats().retainedBytes).toBeGreaterThan(63 * MiB);
            expect(service.stats().retainedBytes).toBeLessThan(64 * MiB);
            await expect(service.resume(continueWith(olderOwn), signal())).rejects.toBeInstanceOf(
                TransformSnapshotError,
            );
            // The older other-client snapshot survived; a plugin failure consumes it without a held worker.
            expect(
                (
                    await service.resume(
                        { ...continueWith(olderOther, "other"), texts: [{ id: "other", error: "finished" }] },
                        signal(),
                    )
                ).results,
            ).toEqual([{ id: "other", ok: false, error: "A plugin handler failed: finished" }]);
            const outsider = await service.transform(
                { ...requestFor(h, "outsider", "large", "hooks"), clientId: "outsider" },
                signal(),
            );
            expect(outsider.results).toEqual([]);
            expect(outsider.pending).toHaveLength(1);
            expect(service.stats().snapshots).toBe(1);
            await expect(service.resume(continueWith(newer), signal())).rejects.toBeInstanceOf(TransformSnapshotError);
            running = settle(service.resume(continueWith(outsider, "outsider"), signal()));
            await vi.advanceTimersByTimeAsync(0);
            expect(h.held).toHaveLength(1);
            expect(service.stats()).toMatchObject({ snapshots: 0, pinnedEntries: 2 });
            const charged = service.stats().retainedBytes;
            const refused = await service.transform(requestFor(h, "refused", "large", "hooks"), signal());
            expect(refused.snapshotId).toBeUndefined();
            expect(refused.pending).toBeUndefined();
            expect(refused.results).toEqual([
                { id: "refused", ok: false, error: "The render's texts are over the limit of one request" },
            ]);
            expect(service.stats()).toMatchObject({ snapshots: 0, retainedBytes: charged, pinnedEntries: 2 });
            h.held.shift()!.release();
            expect(await running).toMatchObject({ ok: true, value: { results: [{ ok: true }] } });
            expectReleased(service);
        } finally {
            for (const held of h.held.splice(0)) held.release();
            await running;
            await service.close();
        }
    });

    it("Lua, trigger locals and nested CBS writes stay in each target overlay across requests and a continuation", async () => {
        const h = open();
        const chars = h.kinds.get("characters")!;
        const original = h.store.get(chars, "a")!;
        const effect = (type: string, fields: Record<string, unknown>) => ({ type, indent: 0, ...fields });
        h.store.put(
            chars,
            "a",
            {
                ...(original.data as object),
                customscript: [],
                triggerscript: [
                    {
                        comment: "lua",
                        type: "start",
                        conditions: [],
                        effect: [
                            {
                                type: "triggerlua",
                                code: `
                    listenEdit("editDisplay", function(id, data, meta)
                        local before = getChatVar(id, "v") .. "/" .. getChatVar(id, "nested")
                        setChatVar(id, "v", tostring(meta.index))
                        return before .. ">" .. data
                    end)`,
                            },
                        ],
                    },
                    {
                        comment: "display",
                        type: "display",
                        conditions: [],
                        effect: [
                            effect("v2GetDisplayState", { outputVar: "d" }),
                            effect("v2SetVar", { var: "localOnly", operator: "=", value: "9", valueType: "value" }),
                            effect("v2ConcatString", {
                                source1: "d",
                                source1Type: "var",
                                source2: "localOnly",
                                source2Type: "var",
                                outputVar: "out",
                            }),
                            effect("v2SetDisplayState", { value: "out", valueType: "var" }),
                        ],
                    },
                ],
            },
            original.revision,
        );
        const personas = h.kinds.get("personas")!;
        const persona = h.store.get(personas, "main")!;
        h.store.put(
            personas,
            "main",
            (persona.data as object[]).map((value) => ({
                ...value,
                personaPrompt: "{{settempvar::nested::local}}{{tempvar::nested}}",
            })),
            persona.revision,
        );
        h.store.applyChanges({
            chats: [
                {
                    characterId: "a",
                    chatId: "k",
                    baseRevision: h.store.chatRevision("a", "k"),
                    ops: [
                        {
                            op: "meta",
                            set: { scriptstate: { $v: "stored", $nested: "stored-nested", $tv: "stored-tv" } },
                        },
                    ],
                },
            ],
        });

        // Capture the actual objects returned to the loader, before any projection or target can write.
        const raw: { value: unknown; before: unknown }[] = [];
        const readKinds = h.store.readKinds.bind(h.store);
        const readChatSource = h.store.readChatSource.bind(h.store);
        const configuration = vi.spyOn(h.store, "readKinds").mockImplementation((...args) => {
            const result = readKinds(...args);
            raw.push({ value: result, before: structuredClone(result) });
            return result;
        });
        const transcript = vi.spyOn(h.store, "readChatSource").mockImplementation((...args) => {
            const result = readChatSource(...args);
            raw.push({ value: result, before: structuredClone(result) });
            return result;
        });
        // Freeze the main-thread deadlines; the worker's injectable CPU and synchronous host
        // allowances exceed the test's hang guard, so this checks writes, never execution speed.
        const allowance = 2 ** 40;
        const pool = createScriptWorkerPool({
            rootDir: path.resolve(import.meta.dirname, "../../.."),
            size: 1,
            maxSize: 1,
            luaCpuMs: allowance,
            prepareCpuMs: allowance,
            regexScriptsCpuMs: allowance,
            luaBudgetMs: allowance,
            syncHostTimeoutMs: allowance,
        });
        const service = createTransformService({ ...h.deps, scriptWorkers: pool });
        const source = "{{getvar::v}}|{{getvar::nested}}|{{persona}}|{{tempvar::nested}}|{{getvar::tv}}";
        const request = (ids: number[], handlers?: string) =>
            h.request("unused", {
                mode: "editdisplay",
                handlers,
                targets: ids.map((index) => ({
                    id: String(index),
                    sourceId: "a",
                    kind: "text",
                    chatIndex: index,
                    source,
                    noCache: true,
                })),
            });
        const expected = (ids: number[]) =>
            ids.map((index) =>
                expect.objectContaining({
                    id: String(index),
                    ok: true,
                    cached: false,
                    text: `stored/stored-nested>${index}|stored-nested|local||stored-tv9`,
                }),
            );
        try {
            await pool.warm();
            for (const ids of [
                [1, 2, 3],
                [3, 2, 1],
            ]) {
                expect((await service.transform(request(ids), signal())).results).toEqual(expected(ids));
                for (const entry of raw) expect(entry.value).toEqual(entry.before);
            }
            const first = await service.transform(request([1, 2], "hooks"), signal());
            expect(first.pending).toEqual(
                [1, 2].map((index) => ({ id: String(index), text: `stored/stored-nested>${source}9` })),
            );
            for (const entry of raw) expect(entry.value).toEqual(entry.before);
            expect((await service.resume(continueWith(first), signal())).results).toEqual(expected([1, 2]));
            for (const entry of raw) expect(entry.value).toEqual(entry.before);
            const later = h.request("later", {
                targets: [
                    {
                        id: "later",
                        sourceId: "a",
                        kind: "text",
                        chatIndex: -1,
                        source: "{{getvar::v}}/{{getvar::nested}}/{{getvar::tv}}",
                        noCache: true,
                    },
                ],
            });
            expect((await service.transform(later, signal())).results).toMatchObject([
                { ok: true, cached: false, text: "stored/stored-nested/stored-tv" },
            ]);
            expect(configuration).toHaveBeenCalledTimes(1);
            expect(transcript).toHaveBeenCalledTimes(1);
            for (const entry of raw) expect(entry.value).toEqual(entry.before);
            expectReleased(service);
        } finally {
            await service.close();
            await pool.dispose();
        }
    });
});
