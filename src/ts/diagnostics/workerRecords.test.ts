import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkerRecords } from "./workerRecords";

// The page's read of the service worker's push records (`workerRecords.ts`) over `fake-indexeddb`:
// the stored rows each through the browser's projection (a hostile or malformed row dropped, the
// server's fields removed, only `push`), the database never created by the read, no IndexedDB as no
// records, and every failure (a throwing or failing open, a blocked one, one past the wait, with a
// late connection closed) as `failed` without a throw.

const DB = "risu-sw-diagnostics";
const AT = 1_700_000_000_000;
const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";

/** A database as the worker leaves it, holding `rows`. */
async function seeded(rows: unknown[]): Promise<IDBFactory> {
    const factory = new IDBFactory();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("records", { autoIncrement: true });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite");
        for (const row of rows) tx.objectStore("records").add(row);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
    });
    db.close();
    return factory;
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("readWorkerRecords", () => {
    it("answers the stored rows in order, each through the browser's projection: a server phase, the server's fields, a payload, a notice, and a malformed row are left out", async () => {
        const factory = await seeded([
            { at: AT, kind: "push", phase: "received", inFront: false, focusedHidden: true },
            {
                at: AT + 1,
                kind: "push",
                phase: "shown",
                inFront: false,
                focusedHidden: true,
                title: "Alice",
                url: "/chat/a/k",
            },
            { at: AT + 2, kind: "push", phase: "clicked", jobId: JOB, service: "fcm", status: 201 },
            { at: AT + 3, kind: "push", phase: "accepted", service: "fcm", jobId: JOB },
            { at: AT + 4, kind: "notice", notice: "resourceReloaded" },
            { at: AT + 5, kind: "page", phase: "boot" },
            { at: AT + 6, kind: "push", phase: "sent" },
            { at: "yesterday", kind: "push", phase: "shown" },
            { kind: "push", phase: "shown" },
            null,
            "a string",
            42,
            { at: AT + 7, kind: "push", phase: "showFailed", inFront: "yes" },
        ]);
        expect(await readWorkerRecords(1000, factory)).toEqual({
            events: [
                { at: AT, kind: "push", phase: "received", inFront: false, focusedHidden: true },
                { at: AT + 1, kind: "push", phase: "shown", inFront: false, focusedHidden: true },
                { at: AT + 2, kind: "push", phase: "clicked" },
                { at: AT + 7, kind: "push", phase: "showFailed" },
            ],
            failed: false,
        });
    });

    it("answers no records, not a failure, without IndexedDB or without the database, and never creates the database", async () => {
        vi.stubGlobal("indexedDB", undefined);
        expect(await readWorkerRecords()).toEqual({ events: [], failed: false });
        const factory = new IDBFactory();
        expect(await readWorkerRecords(1000, factory)).toEqual({ events: [], failed: false });
        // The next open still finds no database (its upgrade runs), after the read's own open settled.
        const created = await new Promise<boolean>((resolve) => {
            const probe = factory.open(DB, 1);
            let upgraded = false;
            probe.onupgradeneeded = () => {
                upgraded = true;
                probe.transaction?.abort();
            };
            probe.onerror = () => resolve(!upgraded);
            probe.onsuccess = () => {
                probe.result.close();
                resolve(!upgraded);
            };
        });
        expect(created).toBe(false);
        expect(await factory.databases()).toEqual([]);
        // The page's own factory is read when none is given.
        vi.stubGlobal("indexedDB", await seeded([{ at: AT, kind: "push", phase: "clicked" }]));
        expect(await readWorkerRecords()).toEqual({
            events: [{ at: AT, kind: "push", phase: "clicked" }],
            failed: false,
        });
    });

    it("answers `failed` without throwing when the open throws, errors, or is blocked, or when the read passes the wait; a connection that opens after that is closed unused", async () => {
        const throwing = {
            open() {
                throw new DOMException("denied", "SecurityError");
            },
        } as unknown as IDBFactory;
        expect(await readWorkerRecords(1000, throwing)).toEqual({ events: [], failed: true });
        Object.defineProperty(globalThis, "indexedDB", {
            configurable: true,
            get() {
                throw new DOMException("denied", "SecurityError");
            },
        });
        expect(await readWorkerRecords()).toEqual({ events: [], failed: true });
        vi.unstubAllGlobals();

        type Request = { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; result?: unknown };
        const requests: Request[] = [];
        const stuck = {
            open() {
                const request: Request = {};
                requests.push(request);
                return request;
            },
        } as unknown as IDBFactory;
        vi.useFakeTimers();
        const erroring = readWorkerRecords(1000, stuck);
        requests[0].onerror!();
        expect(await erroring).toEqual({ events: [], failed: true });
        const blocked = readWorkerRecords(1000, stuck);
        requests[1].onblocked!();
        expect(await blocked).toEqual({ events: [], failed: true });

        let settled: unknown = null;
        const late = readWorkerRecords(1000, stuck).then((result) => (settled = result));
        await vi.advanceTimersByTimeAsync(999);
        expect(settled).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        await late;
        expect(settled).toEqual({ events: [], failed: true });
        const connection = { close: vi.fn(), objectStoreNames: { contains: vi.fn(() => true) }, transaction: vi.fn() };
        requests[2].result = connection;
        requests[2].onsuccess!();
        expect(connection.close).toHaveBeenCalledTimes(1);
        expect(connection.transaction).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
