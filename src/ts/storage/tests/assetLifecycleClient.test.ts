import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch } = vi.hoisted(() => ({
    authFetch: vi.fn<(typeof import("../serverAuth"))["authFetch"]>(),
}));
vi.mock("../serverAuth", async () => (await import("./serverAuthMock")).createServerAuthMock({ authFetch }));

import { readStorageReport, readStorageStatus, startStorageScan, sweepAssets } from "../assetLifecycleClient";
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
