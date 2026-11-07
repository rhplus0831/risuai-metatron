import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch } = vi.hoisted(() => ({
    authFetch: vi.fn<(typeof import("../serverAuth"))["authFetch"]>(),
}));
vi.mock("../serverAuth", async () => (await import("./serverAuthMock")).createServerAuthMock({ authFetch }));

import {
    loadAssetPreview,
    readStorageReport,
    readStorageStatus,
    startStorageScan,
    sweepAssets,
} from "../assetLifecycleClient";
import { ResourceRequestError } from "../resourceClient";

beforeEach(() => {
    authFetch.mockReset();
});

const operations = [
    readStorageReport,
    readStorageStatus,
    startStorageScan,
    () => sweepAssets({ keys: [], inlays: [] }),
];

describe("asset lifecycle client", () => {
    it("uses authenticated no-store routes and sends explicit asset and inlay selections with dryRun false", async () => {
        authFetch.mockImplementation(async () => Response.json({ running: false }));
        await readStorageReport();
        await readStorageStatus();
        await startStorageScan();
        await sweepAssets({ keys: ["assets/chosen.png"], inlays: [] });
        await sweepAssets({ keys: [], inlays: ["chosen-inlay"] });
        expect(
            authFetch.mock.calls.map(([path, init]) => ({
                path,
                method: init?.method,
                cache: init?.cache,
                body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
            })),
        ).toEqual([
            { path: "/api/assets/report", method: "GET", cache: "no-store", body: undefined },
            { path: "/api/assets/status", method: "GET", cache: "no-store", body: undefined },
            { path: "/api/assets/scan", method: "POST", cache: "no-store", body: undefined },
            {
                path: "/api/assets/sweep",
                method: "POST",
                cache: "no-store",
                body: { dryRun: false, keys: ["assets/chosen.png"], inlays: [] },
            },
            {
                path: "/api/assets/sweep",
                method: "POST",
                cache: "no-store",
                body: { dryRun: false, keys: [], inlays: ["chosen-inlay"] },
            },
        ]);
        for (const [, init] of authFetch.mock.calls.slice(3)) {
            expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
        }
    });

    it("preserves a non-2xx server error's status and message as ResourceRequestError", async () => {
        authFetch.mockImplementation(async () =>
            Response.json({ error: "Scan is incomplete; deletion refused" }, { status: 409 }),
        );
        for (const run of operations) {
            const error = await run().catch((cause: unknown) => cause);
            expect(error).toBeInstanceOf(ResourceRequestError);
            expect(error).toMatchObject({ status: 409, message: "Scan is incomplete; deletion refused" });
        }
        expect(authFetch).toHaveBeenCalledTimes(4);
    });

    it("maps requests that do not reach the server to ResourceRequestError status zero", async () => {
        authFetch.mockRejectedValue(new TypeError("Failed to fetch"));
        for (const run of operations) {
            const error = await run().catch((cause: unknown) => cause);
            expect(error).toBeInstanceOf(ResourceRequestError);
            expect(error).toMatchObject({ status: 0, message: "Failed to fetch" });
        }
        expect(authFetch).toHaveBeenCalledTimes(4);
    });
});

describe("asset previews", () => {
    let previews: ReturnType<typeof loadAssetPreview>[];
    let finishBodies: (() => void)[];

    function preview(key: string) {
        const handle = loadAssetPreview(key);
        previews.push(handle);
        // A release may reject before the test reaches its rejection assertion.
        void handle.src.catch(() => {});
        return handle;
    }

    function pendingBody() {
        let resolve!: (blob: Blob) => void;
        const blob = new Blob(["preview"], { type: "image/webp" });
        const body = new Promise<Blob>((done) => {
            resolve = done;
        });
        const response = new Response();
        const read = vi.spyOn(response, "blob").mockReturnValue(body);
        const finish = () => resolve(blob);
        finishBodies.push(finish);
        return { response, read, finish, blob };
    }

    beforeEach(() => {
        previews = [];
        finishBodies = [];
        vi.useFakeTimers();
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    });

    afterEach(async () => {
        for (const handle of previews) handle.release();
        for (const finish of finishBodies) finish();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("holds four preview slots through body reads and starts queued UTF-8 keys FIFO with no-store", async () => {
        const bodies = Array.from({ length: 6 }, pendingBody);
        for (const body of bodies) authFetch.mockResolvedValueOnce(body.response);
        const handles = ["한.png", "b.png", "c.png", "d.png", "e.png", "f.png"].map((name) =>
            preview(`assets/${name}`),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(authFetch).toHaveBeenCalledTimes(4);
        expect(authFetch).toHaveBeenNthCalledWith(1, "/api/assets/preview/6173736574732fed959c2e706e67", {
            method: "GET",
            cache: "no-store",
            signal: expect.any(AbortSignal),
        });
        expect(bodies[0].read).toHaveBeenCalledOnce();
        // Receiving headers does not free a slot: the response body is still pending.
        expect(bodies[4].read).not.toHaveBeenCalled();
        bodies[0].finish();
        await handles[0].src;
        await vi.advanceTimersByTimeAsync(0);
        expect(authFetch).toHaveBeenCalledTimes(5);
        expect(authFetch.mock.calls[4][0]).toBe("/api/assets/preview/6173736574732f652e706e67");
        bodies[1].finish();
        await handles[1].src;
        await vi.advanceTimersByTimeAsync(0);
        expect(authFetch).toHaveBeenCalledTimes(6);
        expect(authFetch.mock.calls[5][0]).toBe("/api/assets/preview/6173736574732f662e706e67");
    });

    it("releases queued, in-flight, and loaded previews idempotently without leaking a late body URL", async () => {
        const bodies = Array.from({ length: 4 }, pendingBody);
        for (const body of bodies) authFetch.mockResolvedValueOnce(body.response);
        const handles = ["a", "b", "c", "d", "queued"].map((name) => preview(`assets/${name}.png`));
        await vi.advanceTimersByTimeAsync(0);
        expect(authFetch).toHaveBeenCalledTimes(4);

        handles[4].release();
        handles[4].release();
        await expect(handles[4].src).rejects.toBeDefined();

        const signal = authFetch.mock.calls[0][1]!.signal!;
        handles[0].release();
        handles[0].release();
        expect(signal.aborted).toBe(true);
        await expect(handles[0].src).rejects.toBeDefined();
        bodies[0].finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(authFetch).toHaveBeenCalledTimes(4);

        bodies[1].finish();
        await expect(handles[1].src).resolves.toBe("blob:preview");
        expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(bodies[1].blob);
        handles[1].release();
        handles[1].release();
        expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview");
    });

    it.each(["HTTP", "network"])("rejects a %s preview failure and admits the next queued request", async (failure) => {
        let fail!: () => void;
        const response = new Promise<Response>((resolve, reject) => {
            fail =
                failure === "HTTP"
                    ? () => resolve(new Response(null, { status: 404 }))
                    : () => reject(new TypeError("Failed to fetch"));
        });
        authFetch.mockReturnValueOnce(response);
        for (let i = 0; i < 4; i++) authFetch.mockResolvedValueOnce(pendingBody().response);
        const failed = preview("assets/failed.png");
        for (const name of ["b", "c", "d", "queued"]) preview(`assets/${name}.png`);
        expect(authFetch).toHaveBeenCalledTimes(4);
        fail();
        await vi.advanceTimersByTimeAsync(0);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        await expect(failed.src).rejects.toBeDefined();
        expect(authFetch).toHaveBeenCalledTimes(5);
        expect(authFetch.mock.calls[4][0]).toBe("/api/assets/preview/6173736574732f7175657565642e706e67");
    });
});
