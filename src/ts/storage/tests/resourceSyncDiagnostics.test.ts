import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";

// Request history slice 8 (`docs/plan/request-history-diagnostics.md`): the save adapter's
// diagnostics over a stubbed collector. A 409 records one `sync conflict` with counts by category
// (records, chats, orders; `generating` the subset a job blocked) before the recovery's first
// read, with no id; a restore's reload records `sync reload restore` and flushes the mirror right
// before `location.reload()`.

const { server, alerts, diagnostics } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
    /** What the adapter asked of the collector and the page, in order; `onRecord` runs before each event is kept. */
    diagnostics: { calls: [] as unknown[], onRecord: null as (() => void) | null },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertTerminal: alerts.terminal,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../diagnostics/collector", () => ({
    recordClientEvent: (input: unknown) => {
        diagnostics.onRecord?.();
        diagnostics.calls.push(input);
    },
    flushClientDiagnostics: () => diagnostics.calls.push("flush"),
}));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Bootstrap = typeof import("../../bootstrap");
type SettingsViews = typeof import("../settingsViews.svelte");

async function boot() {
    vi.resetModules();
    const fake = new FakeResourceServer();
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", { chaId: "a", name: "Alice", type: "character" });
    await materialize(fake);
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    diagnostics.calls.length = 0;
    diagnostics.onRecord = null;
    return { fake, sync, settings };
}

const events = () => diagnostics.calls.filter((call) => typeof call === "object");

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn(() => diagnostics.calls.push("reload")) });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("the save adapter's diagnostics", () => {
    it("records one `sync conflict` with the counts by category for a 409 another tab caused, without the record's id", async () => {
        const { fake, sync, settings } = await boot();
        fake.set("ui", "main", { ...fake.data<Record<string, unknown>>("ui", "main")!, theme: "remote user" });
        settings.ui.theme = "local user";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["ui/main"]);
        expect(events()).toEqual([{ kind: "sync", phase: "conflict", records: 1, chats: 0, orders: 0, generating: 0 }]);
        await sync.flushResources();
        expect(events()).toHaveLength(1);
    });

    it("counts every conflict of the 409 by category, the generating ones as a subset, before the recovery's first read", async () => {
        const { fake, sync, settings } = await boot();
        fake.failNext = {
            status: 409,
            times: 1,
            match: (path) => path === "/api/resources/batch",
            body: {
                error: "Revision conflict",
                conflicts: [
                    { kind: "ui", id: "main", revision: null },
                    { kind: "characters", id: "alice-private", revision: "e:1:1", reason: "generating" },
                    { kind: "chat", characterId: "alice-private", id: "k", revision: null, reason: "generating" },
                    { kind: "chat", characterId: "b", id: "q", revision: null },
                    { kind: "chatOrder", characterId: "a", revision: null },
                ],
            },
        };
        settings.ui.theme = "local";
        const reads = () => fake.requests.filter((request) => request.path === "/api/resources/read").length;
        let readsAtRecord = -1;
        diagnostics.onRecord = () => {
            readsAtRecord = reads();
        };
        await sync.flushResources().catch(() => {});
        const conflicts = events().filter((event) => (event as { phase?: string }).phase === "conflict");
        expect(conflicts).toEqual([
            { kind: "sync", phase: "conflict", records: 2, chats: 2, orders: 1, generating: 2 },
        ]);
        expect(readsAtRecord).toBe(0);
        expect(JSON.stringify(diagnostics.calls)).not.toMatch(/alice|main|"k"|"q"/);
    });

    it("records `sync reload restore` and flushes the mirror right before the reload a restore's notice starts", async () => {
        const { fake, sync, settings } = await boot();
        fake.restore("epoch-2");
        settings.ui.theme = "after restore";
        await expect(sync.flushResources()).rejects.toThrow();
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        await vi.waitFor(() => expect((location as any).reload).toHaveBeenCalledTimes(1));
        expect(diagnostics.calls).toEqual([{ kind: "sync", phase: "reload", reason: "restore" }, "flush", "reload"]);
    });
});
