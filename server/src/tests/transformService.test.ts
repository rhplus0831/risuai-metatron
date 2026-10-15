// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransformRequest, TransformResponse } from "../../../shared/transform.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { ChatBindingError } from "../jobs/jobScope.ts";
import type { GenerationRunnerDeps } from "../jobs/runSetup.ts";
import { createTransformService, TransformSnapshotError, TransformUnavailableError } from "../prompt/transform.ts";
import { createTransformCache } from "../prompt/transformCache.ts";

// Phase 5 slice 13a: the script transform's service (`server/src/prompt/transform.ts`) and its cache
// (`server/src/prompt/transformCache.ts`) on a real resource store, with script workers the test
// holds and releases, so the lifetime rules are observable: the 4 running and 32 queued slots, a
// maintenance (`pause`) and a shutdown (`close`) ending queued and running requests alike and every
// snapshot, an abort before or right after a slot is granted (a cached or plugin-failure-only answer
// included), the one absolute deadline from the first call's admission (the snapshot's expiry, a
// second call waiting for a slot, the clock read even when the timer was held back), the snapshot
// caps, the cache's generation fence against an older fill (a "Re-render" while an earlier
// two-call render waits; the forgotten generations of the floor), and the cache probe (an all-cached
// request answered without loading the scope, only while the load's checks would still pass). The
// route and the real workers are `transform.test.ts`.

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
        expect(service.stats()).toEqual({ active: 0, queued: 0, snapshots: 0, cached: 0 });
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
        expect(service.stats()).toEqual({ active: 0, queued: 0, snapshots: 0, cached: 0 });
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
        expect(service.stats()).toEqual({ active: 0, queued: 0, snapshots: 0, cached: 0 });
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
        expect(service.stats()).toEqual({ active: 0, queued: 0, snapshots: 0, cached: 0 });
        await service.close();
    });

    it("the deadline is read from the clock: a held-back timer does not let an overdue snapshot be kept", async () => {
        const h = open();
        h.setHold(false);
        let clock = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        // The scope read takes 31 s by the clock while no timer can run.
        const slowStore = {
            ...h.store,
            readKinds(...args: Parameters<typeof h.store.readKinds>) {
                const result = h.store.readKinds(...args);
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
        expect(service.stats()).toEqual({ active: 0, queued: 0, snapshots: 0, cached: 0 });
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
        const loads = vi.spyOn(h.store, "readKinds");

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
        expect(loads).toHaveBeenCalledTimes(1);

        // `noCache` always loads and renders again.
        const fresh = await service.transform(
            h.request("c", { targets: [{ ...h.request("c").targets[0], noCache: true }] }),
            signal(),
        );
        expect(fresh.results[0]).toMatchObject({ ok: true, cached: false });
        expect(loads).toHaveBeenCalledTimes(2);
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
        const loads = vi.spyOn(h.store, "readKinds");

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
        expect(loads).toHaveBeenCalledTimes(1);
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
