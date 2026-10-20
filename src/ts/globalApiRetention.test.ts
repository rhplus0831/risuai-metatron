// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real API and its caches; replace unrelated application boot and storage/network I/O.
vi.mock("./storage/characterStore.svelte", () => ({ selectedCharacter: () => null }));
vi.mock("./storage/settingsViews.svelte", () => ({ settings: { providers: {} } }));
vi.mock("./util", () => ({ checkNullish: (x: unknown) => x == null, sleep: async () => {} }));
vi.mock("streamsaver", () => ({ default: {} }));
vi.mock("./storage/database.svelte", () => ({}));
vi.mock("./stores.svelte", () => ({ bodyIntercepterStore: [] }));
vi.mock("./plugins/plugins.svelte", () => ({}));
vi.mock("./alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("./parser/parser.svelte", () => ({}));
vi.mock("./characterCards", () => ({}));
vi.mock("./storage/chatStore.svelte", () => ({}));
vi.mock("./storage/selection.svelte", () => ({}));
vi.mock("./storage/resourceClient", () => ({}));
vi.mock("./storage/resourceSync.svelte", () => ({ saving: false }));
vi.mock("./storage/characterOrder", () => ({}));
vi.mock("./storage/assetClient", () => ({ readAsset: vi.fn(), writeAsset: vi.fn() }));
vi.mock("./gui/animation", () => ({}));
vi.mock("./gui/colorscheme", () => ({}));
vi.mock("src/lang", () => ({}));
vi.mock("./gui/guisize", () => ({}));
vi.mock("./process/modules", () => ({}));
vi.mock("./storage/serverAuth", () => ({}));

import { readAsset } from "./storage/assetClient";
import {
    addFetchLog,
    appendFetchLog,
    getFetchData,
    getFetchLogs,
    globalFetch,
    getFileSrc,
    holdFileSrc,
    setUsingSw,
} from "./globalApi.svelte";

const BUDGET = 16 * 1024 * 1024; // Goal A, UTF-16 code units (not UTF-8 bytes).
const GRACE = 100; // Goal B; deliberately independent of the production constant.
const logs = getFetchLogs();
const ids = () => logs.map((entry) => entry.chatId);
const chars = () => logs.reduce((n, entry) => n + entry.body.length + entry.header.length + entry.response.length, 0);
const entry = (id: string, body = "", header = "", response = "") => ({
    chatId: id,
    body,
    header,
    response,
    success: true,
    date: "test",
    url: `https://log.test/${id}`,
});
const fetchMock = vi.fn();
const writers = ["addFetchLog", "appendFetchLog", "globalFetch"] as const;
type Writer = (typeof writers)[number];
const payload = (text = "x") => ({ body: { text }, headers: { text }, response: { text } });
const serialized = (data: ReturnType<typeof payload>) => ({
    body: JSON.stringify(data.body, null, 2),
    header: JSON.stringify(data.headers, null, 2),
    response: JSON.stringify(data.response, null, 2),
});
async function write(writer: Writer, id: string, data = payload()) {
    if (writer === "appendFetchLog") {
        appendFetchLog({ ...entry(id), ...serialized(data) });
    } else if (writer === "addFetchLog") {
        expect(addFetchLog({ ...data, chatId: id, success: true, url: `https://log.test/${id}` })).toBe(0);
    } else {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => data.response,
        });
        expect((await globalFetch(`https://log.test/${id}`, { ...data, chatId: id, plainFetchForce: true })).ok).toBe(
            true,
        );
    }
}

let pathIndex = 0;
const path = () => `assets/retention-${++pathIndex}.png`;
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    logs.length = 0;
    setUsingSw(false);
    vi.mocked(readAsset)
        .mockReset()
        .mockResolvedValue(Buffer.from([1, 2, 3]));
    fetchMock.mockReset().mockRejectedValue(new Error("unexpected network"));
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("tab request log retention", () => {
    it("keeps the newest 20 through every writer and mixed writes, preserving the array and chat lookup", async () => {
        for (const sequence of [
            ...writers.map((writer) => Array<Writer>(25).fill(writer)),
            Array.from({ length: 25 }, (_, i) => writers[i % 3]),
        ]) {
            logs.length = 0;
            for (const [i, writer] of sequence.entries()) await write(writer, String(i));
            expect(getFetchLogs()).toBe(logs);
            expect(ids()).toEqual(Array.from({ length: 20 }, (_, i) => String(24 - i)));
            expect(getFetchData("12")).toBe(logs[12]);
            expect(getFetchData("0")).toBeNull();
        }
    });

    it("repairs an already overlong live array on the next insertion through each writer", async () => {
        for (const writer of writers) {
            logs.length = 0;
            logs.push(...Array.from({ length: 40 }, (_, i) => entry(String(39 - i))));
            await write(writer, "new");
            expect(getFetchLogs()).toBe(logs);
            expect(ids()).toEqual(["new", ...Array.from({ length: 19 }, (_, i) => String(39 - i))]);
        }
    });

    it("counts body, header and response in UTF-16, retaining the exact budget then evicting the oldest", async () => {
        // Every field is substantial and contains surrogate pairs: omitting any field, counting
        // code points, or counting UTF-8 bytes gives a different answer at this boundary.
        const data = payload("😀".repeat(1_000_000));
        const expected = serialized(data);
        const cost = expected.body.length + expected.header.length + expected.response.length;
        for (const writer of writers) {
            logs.length = 0;
            appendFetchLog(entry("old", "o".repeat(BUDGET - cost)));
            await write(writer, "at-budget", data);
            expect(ids()).toEqual(["at-budget", "old"]);
            expect(chars()).toBe(BUDGET);
            await write(writer, "over-budget");
            expect(ids()).toEqual(["over-budget", "at-budget"]);
            expect(chars()).toBeLessThanOrEqual(BUDGET);
        }
    });

    it("keeps an oversized newest entry whole, then drops it for the next newest entry", async () => {
        const data = payload("z".repeat(Math.ceil(BUDGET / 3)));
        const expected = serialized(data);
        for (const writer of writers) {
            logs.length = 0;
            appendFetchLog(entry("old"));
            await write(writer, "huge", data);
            expect(ids()).toEqual(["huge"]);
            expect(chars()).toBeGreaterThan(BUDGET);
            for (const field of ["body", "header", "response"] as const)
                expect(logs[0][field] === expected[field]).toBe(true);
            await write(writer, "small");
            expect(ids()).toEqual(["small"]);
        }
    });
});

describe("held file sources", () => {
    let create: ReturnType<typeof vi.spyOn>;
    let revoke: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        // Fake only the release grace, never stream/network/request deadlines.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let serial = 0;
        create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:held-${++serial}`);
        revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    });

    it("shares one load across holds and reloads only 100 ms after the last idempotent release", async () => {
        const loc = path();
        const one = holdFileSrc(loc),
            two = holdFileSrc(loc);
        expect(await one.src).toBe("blob:held-1");
        expect(await two.src).toBe("blob:held-1");
        expect(readAsset).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledTimes(1);
        one.release();
        one.release();
        await vi.advanceTimersByTimeAsync(GRACE);
        expect(revoke).not.toHaveBeenCalled();
        two.release();
        await vi.advanceTimersByTimeAsync(GRACE - 1);
        expect(revoke).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(revoke.mock.calls).toEqual([["blob:held-1"]]);
        expect(await getFileSrc(loc)).toBe("blob:held-2");
        expect(readAsset).toHaveBeenCalledTimes(2);
    });

    it("a new hold within the grace reuses the URL and starts a fresh grace on release", async () => {
        const loc = path();
        const old = holdFileSrc(loc);
        await old.src;
        old.release();
        await vi.advanceTimersByTimeAsync(99);
        const next = holdFileSrc(loc);
        expect(await next.src).toBe("blob:held-1");
        await vi.advanceTimersByTimeAsync(100);
        expect(revoke).not.toHaveBeenCalled();
        expect(readAsset).toHaveBeenCalledTimes(1);
        next.release();
        await vi.advanceTimersByTimeAsync(99);
        expect(revoke).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(revoke.mock.calls).toEqual([["blob:held-1"]]);
    });

    it("plain reads share a held load and pin it, including a read during the release grace", async () => {
        for (const when of ["before", "during-hold", "during-grace"] as const) {
            const loc = path();
            if (when === "before") await getFileSrc(loc);
            const held = holdFileSrc(loc);
            const src = await held.src;
            if (when === "during-hold") expect(await getFileSrc(loc)).toBe(src);
            held.release();
            if (when === "during-grace") {
                await vi.advanceTimersByTimeAsync(99);
                expect(await getFileSrc(loc)).toBe(src);
            }
            await vi.advanceTimersByTimeAsync(200);
            expect(await getFileSrc(loc)).toBe(src);
        }
        expect(revoke).not.toHaveBeenCalled();
        expect(readAsset).toHaveBeenCalledTimes(3);
    });

    it("a release before loading resolves revokes after resolution and its grace", async () => {
        const loading = deferred<Buffer>();
        vi.mocked(readAsset).mockReturnValueOnce(loading.promise);
        const loc = path();
        const held = holdFileSrc(loc);
        held.release();
        await vi.advanceTimersByTimeAsync(200);
        expect(create).not.toHaveBeenCalled();
        loading.resolve(Buffer.from([7]));
        expect(await held.src).toBe("blob:held-1");
        await vi.advanceTimersByTimeAsync(99);
        expect(revoke).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(revoke.mock.calls).toEqual([["blob:held-1"]]);
        expect(await getFileSrc(loc)).toBe("blob:held-2");
    });

    it("a hold or plain read during a released pending load prevents its later revocation", async () => {
        for (const mode of ["hold", "plain"] as const) {
            const loading = deferred<Buffer>();
            vi.mocked(readAsset).mockReturnValueOnce(loading.promise);
            const loc = path();
            const old = holdFileSrc(loc);
            old.release();
            const current = mode === "hold" ? holdFileSrc(loc) : { src: getFileSrc(loc), release() {} };
            loading.resolve(Buffer.from([7]));
            expect(await current.src).toBe(await old.src);
            await vi.advanceTimersByTimeAsync(200);
            expect(revoke).not.toHaveBeenCalled();
            // Pin the held variant before releasing it so both cases finish without timers.
            expect(await getFileSrc(loc)).toBe(await old.src);
            current.release();
        }
        expect(readAsset).toHaveBeenCalledTimes(2);
    });

    it("service-worker URLs share registration and survive every release without revocation", async () => {
        setUsingSw(true);
        fetchMock.mockResolvedValueOnce({ json: async () => ({ able: false }) }).mockResolvedValueOnce({ ok: true });
        const loc = path();
        const hex = Buffer.from(loc, "utf8").toString("hex");
        const a = holdFileSrc(loc),
            b = holdFileSrc(loc);
        expect(await a.src).toBe(`/sw/img/${hex}`);
        expect(await b.src).toBe(`/sw/img/${hex}`);
        a.release();
        b.release();
        await vi.advanceTimersByTimeAsync(200);
        expect(revoke).not.toHaveBeenCalled();
        expect(await getFileSrc(loc)).toBe(`/sw/img/${hex}`);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`/sw/check/${hex}`, `/sw/register/${hex}`]);
        expect(readAsset).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
    });
});

describe("worker cache lookup", () => {
    let api: typeof import("./globalApi.svelte");
    let create: ReturnType<typeof vi.spyOn>;
    let revoke: ReturnType<typeof vi.spyOn>;
    let match: ReturnType<typeof vi.fn>;
    let open: ReturnType<typeof vi.fn>;
    const workerUrl = (loc: string, operation = "img") =>
        `/sw/${operation}/${Buffer.from(loc, "utf8").toString("hex")}`;

    beforeEach(async () => {
        // A new module models a new page; no cache handle or known path leaks across cases.
        vi.resetModules();
        api = await import("./globalApi.svelte");
        api.setUsingSw(true);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:worker-fallback");
        revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        match = vi.fn().mockResolvedValue(undefined);
        open = vi.fn().mockResolvedValue({ match });
        vi.stubGlobal("caches", { open });
    });

    it("reads risuCache directly and shares an in-flight hit without worker or asset I/O", async () => {
        const loc = "assets/한글 image.png";
        const lookup = deferred<Response>();
        match.mockReturnValue(lookup.promise);
        const a = api.holdFileSrc(loc);
        const b = api.getFileSrc(loc);
        await vi.advanceTimersByTimeAsync(0);
        expect(open).toHaveBeenCalledExactlyOnceWith("risuCache");
        expect(match).toHaveBeenCalledExactlyOnceWith(workerUrl(loc));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(readAsset).not.toHaveBeenCalled();
        lookup.resolve(new Response("cached bytes"));
        expect(await a.src).toBe(workerUrl(loc));
        expect(await b).toBe(workerUrl(loc));
        a.release();
        await vi.advanceTimersByTimeAsync(200);
        expect(create).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("registers bytes only on a direct miss and waits for the shared POST to finish", async () => {
        const loc = path();
        const bytes = Buffer.from([137, 80, 78, 71]);
        vi.mocked(readAsset).mockResolvedValue(bytes);
        const registration = deferred<{ ok: boolean }>();
        fetchMock.mockReturnValue(registration.promise);
        const a = api.holdFileSrc(loc);
        const b = api.holdFileSrc(loc);
        let resolved = false;
        void a.src.then(() => {
            resolved = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(match).toHaveBeenCalledExactlyOnceWith(workerUrl(loc));
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
            workerUrl(loc, "register"),
            expect.objectContaining({
                method: "POST",
                body: bytes,
            }),
        );
        expect(readAsset).toHaveBeenCalledExactlyOnceWith(loc);
        expect(resolved).toBe(false);
        registration.resolve({ ok: true });
        expect(await a.src).toBe(workerUrl(loc));
        expect(await b.src).toBe(workerUrl(loc));
        a.release();
        a.release();
        b.release();
        await vi.advanceTimersByTimeAsync(200);
        expect(await api.getFileSrc(loc)).toBe(workerUrl(loc));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
    });

    it("remembers a known path for the page after a cache hit and releases", async () => {
        const loc = path();
        match.mockResolvedValue(new Response("cached"));
        const held = api.holdFileSrc(loc);
        expect(await held.src).toBe(workerUrl(loc));
        held.release();
        await vi.advanceTimersByTimeAsync(200);
        open.mockClear().mockRejectedValue(new Error("later cache denied"));
        match.mockClear().mockRejectedValue(new Error("later lookup denied"));
        fetchMock.mockClear().mockRejectedValue(new Error("worker unavailable"));
        vi.mocked(readAsset).mockClear();
        api.setUsingSw(false);
        api.setUsingSw(true);
        const again = api.holdFileSrc(loc);
        expect(await again.src).toBe(workerUrl(loc));
        again.release();
        expect(await api.getFileSrc(loc)).toBe(workerUrl(loc));
        expect(open).not.toHaveBeenCalled();
        expect(match).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(readAsset).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
    });

    it.each(["missing caches", "match throws"])("falls back to check for hits and misses when %s", async (failure) => {
        if (failure === "missing caches") vi.stubGlobal("caches", undefined);
        if (failure === "match throws") match.mockRejectedValue(new Error("match denied"));
        const hit = path();
        const miss = path();
        fetchMock
            .mockResolvedValueOnce({ json: async () => ({ able: true }) })
            .mockResolvedValueOnce({ json: async () => ({ able: false }) })
            .mockResolvedValueOnce({ ok: true });
        expect(await api.getFileSrc(hit)).toBe(workerUrl(hit));
        expect(readAsset).not.toHaveBeenCalled();
        expect(await api.getFileSrc(miss)).toBe(workerUrl(miss));
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            workerUrl(hit, "check"),
            workerUrl(miss, "check"),
            workerUrl(miss, "register"),
        ]);
        expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST", body: Buffer.from([1, 2, 3]) });
        expect(readAsset).toHaveBeenCalledExactlyOnceWith(miss);
        expect(create).not.toHaveBeenCalled();
        // Failure is per read: later paths can use page-side Cache Storage again.
        vi.stubGlobal("caches", { open });
        open.mockResolvedValue({ match });
        match.mockResolvedValue(new Response("now available"));
        const later = path();
        expect(await api.getFileSrc(later)).toBe(workerUrl(later));
        expect(match).toHaveBeenLastCalledWith(workerUrl(later));
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each(["missing", "empty"])("does not register a %s asset or remember it as available", async (kind) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const loc = path();
        vi.mocked(readAsset).mockResolvedValueOnce(kind === "empty" ? Buffer.alloc(0) : (null as never));
        expect(await api.getFileSrc(loc)).toBe("");
        expect(match).toHaveBeenCalledExactlyOnceWith(workerUrl(loc));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        fetchMock.mockResolvedValue({ ok: true });
        expect(await api.getFileSrc(loc)).toBe(workerUrl(loc));
        expect(match).toHaveBeenCalledTimes(2);
        expect(readAsset).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
            workerUrl(loc, "register"),
            expect.objectContaining({ method: "POST" }),
        );
    });

    it.each(["rejects", "returns not ok"])(
        "keeps blob hold, revoke and pin lifetimes when registration %s",
        async (failure) => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            if (failure === "rejects") fetchMock.mockRejectedValue(new Error("worker failed"));
            else fetchMock.mockResolvedValue({ ok: false });
            const loc = path();
            const a = api.holdFileSrc(loc);
            const b = api.holdFileSrc(loc);
            expect(await a.src).toBe("blob:worker-fallback");
            expect(await b.src).toBe("blob:worker-fallback");
            expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
                workerUrl(loc, "register"),
                expect.objectContaining({ method: "POST" }),
            );
            expect(readAsset).toHaveBeenCalledTimes(1);
            a.release();
            a.release();
            await vi.advanceTimersByTimeAsync(200);
            expect(revoke).not.toHaveBeenCalled();
            b.release();
            await vi.advanceTimersByTimeAsync(99);
            expect(revoke).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:worker-fallback");
            const pinned = api.holdFileSrc(loc);
            expect(await api.getFileSrc(loc)).toBe(await pinned.src);
            pinned.release();
            await vi.advanceTimersByTimeAsync(200);
            expect(match).toHaveBeenCalledTimes(2);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(readAsset).toHaveBeenCalledTimes(2);
            expect(create).toHaveBeenCalledTimes(2);
            expect(revoke).toHaveBeenCalledTimes(1);
        },
    );

    it("uses the object-URL path without cache or worker I/O while worker use is disabled", async () => {
        api.setUsingSw(false);
        const loc = path();
        expect(await api.getFileSrc(loc)).toBe("blob:worker-fallback");
        expect(readAsset).toHaveBeenCalledExactlyOnceWith(loc);
        expect(open).not.toHaveBeenCalled();
        expect(match).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledTimes(1);
    });
});
