import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretPath } from "../../../../shared/llmSecrets.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize, serverNormalizer } from "./serverKinds";

// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`): the credential write queue of the save
// adapter (`resourceSync.svelte.ts` with `llmSecrets.svelte.ts`) against the in-memory stand-in of
// the resource routes, which serves the write-only contract (`fakeResourceServer.ts`). A queued
// set, clear, or cleanup is sent after the cycle's resource batch, one at a time on the
// record's revision; a stale revision rereads and retries a bounded number of times; a refused
// write (400) is a reported discard; a retryable failure keeps the write; a 412 halts; an
// acknowledgement or a reread is adopted by the sibling text (unchanged, local-only, both changed);
// a cleanup follows its owner's deletion (sent once saved, dropped once restored, waiting while
// quarantined without keeping the loop running); and `awaitSecretWrites` is the barrier the
// auxiliary calls take.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
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
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", resourceRecordRefused: "refused" },
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

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Bootstrap = typeof import("../../bootstrap");
type SettingsViews = typeof import("../settingsViews.svelte");
type Secrets = typeof import("../llmSecrets.svelte");

const STORED_KEY = "sk-stored-SENTINEL-AAAA";
const flat = (
    field: "openAIKey" | "mistralKey" | "cohereAPIKey" | "nanogptKey" | "openrouterKey" | "claudeAPIKey",
): SecretPath => ({
    kind: "flat",
    field,
});
const cred = (id: string): SecretPath => ({ kind: "entry", field: "credentials", id });
const secretRequests = (fake: FakeResourceServer) =>
    fake.requests.filter((r) => r.path.startsWith("/api/llm-secrets/"));
const requestLog = (fake: FakeResourceServer) => fake.requests.map((r) => `${r.method} ${r.path}`);
const onSecretRoutes = (path: string) => path.startsWith("/api/llm-secrets/");
const onBatch = (path: string) => path === "/api/resources/batch";

/**
 * Boots the adapter the way `loadData` does over a store holding two named credentials with keys
 * (the only entry map since `docs/plan/model-profiles.md` O2), a stored OpenAI key, and a readable
 * sibling; the boot compare pass has run.
 */
async function boot() {
    vi.resetModules();
    const fake = new FakeResourceServer();
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    await materialize(fake);
    fake.set(
        "credentials",
        "main",
        (await serverNormalizer("credentials"))([
            { id: "c1", name: "C1", type: "openai" },
            { id: "c2", name: "C2", type: "anthropic" },
        ]),
    );
    fake.set(
        "llmSecrets",
        "main",
        (await serverNormalizer("llmSecrets"))({
            openAIKey: STORED_KEY,
            google: { projectId: "proj", accessToken: "" },
            credentials: { c1: { key: "ck-1" }, c2: { key: "ck-2" } },
        }),
    );
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");
    const secrets: Secrets = await import("../llmSecrets.svelte");

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    // The records and the selection (at home), as `loadData` installs them.
    bootstrap.installBootRecords(snapshot);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    const bootBatches = fake.batchBodies();
    fake.requests.length = 0;
    return { fake, client, sync, secrets, bootBatches, settings };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("a queued credential write", () => {
    it("is sent after the cycle's batch on the record's revision, never in the record, and its acknowledgement bumps the path's version", async () => {
        const { fake, sync, secrets, settings, bootBatches } = await boot();
        const path = flat("openAIKey");
        // An idle boot with set and unset keys writes nothing for the record, and shows the statuses.
        expect(bootBatches.flatMap((batch) => batch.ops.map((op) => op.kind))).not.toContain("llmSecrets");
        expect(secrets.secretStatus(path)).toEqual({ set: true, hint: "AAAA", pending: false });
        expect(secrets.secretStatus(flat("claudeAPIKey"))).toEqual({ set: false, hint: "", pending: false });
        expect(secrets.secretStatus(cred("c1"))).toEqual({ set: true, hint: "", pending: false });
        expect(secrets.secretStatus(cred("c2"))).toEqual({ set: true, hint: "", pending: false });
        expect(settings.llmSecrets.openAIKey).toBe("");
        const unload = () => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };
        expect(unload()).toBe(false);

        const revision = fake.get("llmSecrets", "main")!.revision;
        settings.ui.zoomsize = 123;
        secrets.setSecret(path, "sk-new-SENTINEL-BBBB");
        expect(secrets.secretStatus(path)).toEqual({ set: true, hint: "", pending: true });
        expect(settings.llmSecrets.openAIKey).toBe("");
        // A queued write is unsaved work: the unload warning shows.
        expect(unload()).toBe(true);
        await sync.flushResources();
        expect(requestLog(fake)).toEqual(["POST /api/resources/batch", "PUT /api/llm-secrets/openAIKey"]);
        expect(fake.batchBodies()[0].ops.map((op) => op.kind)).toEqual(["ui"]);
        expect(secretRequests(fake)[0].body).toEqual({ value: "sk-new-SENTINEL-BBBB", baseRevision: revision });
        expect(fake.data("llmSecrets", "main").openAIKey).toBe("sk-new-SENTINEL-BBBB");
        expect(secrets.secretStatus(path)).toEqual({ set: true, hint: "BBBB", pending: false });
        expect(secrets.llmSecretState.queue).toEqual([]);
        expect(secrets.secretVersion(path)).toBe(1);
        expect(settings.llmSecrets.openAIKey).toBe("");
        // Nothing is echoed afterwards (adopting the server's record marks the mirror once more, as
        // any reload does; the next cycle finds the text equal), and nothing is unsaved.
        await sync.flushResources();
        expect(fake.requests).toHaveLength(2);
        expect(unload()).toBe(false);

        // Two short keys share a masked status; each acknowledged replacement still bumps the version,
        // and `awaitSecretWrites` is the barrier that sends it.
        secrets.setSecret(path, "short-1");
        await sync.awaitSecretWrites();
        expect(secrets.secretStatus(path)).toEqual({ set: true, hint: "", pending: false });
        expect(secrets.secretVersion(path)).toBe(2);
        secrets.setSecret(path, "short-2");
        await sync.awaitSecretWrites();
        expect(secrets.secretVersion(path)).toBe(3);
        expect(fake.data("llmSecrets", "main").openAIKey).toBe("short-2");
        // An unrelated path keeps its version; an empty barrier resolves at once.
        expect(secrets.secretVersion(flat("claudeAPIKey"))).toBe(0);
        await sync.awaitSecretWrites();
        expect(fake.requests).toHaveLength(4);
        // A clear removes the key; the plain record never carried any credential.
        secrets.clearSecret(path);
        await sync.flushResources();
        expect(fake.data("llmSecrets", "main").openAIKey).toBe("");
        expect(secrets.secretStatus(path)).toEqual({ set: false, hint: "", pending: false });
        for (const batch of fake.batchBodies()) {
            expect(batch.ops.map((op) => op.kind)).not.toContain("llmSecrets");
        }
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("goes after the batch that creates its credential: a key queued with it, and a key queued while a batch is in flight", async () => {
        const { fake, sync, secrets, settings } = await boot();
        settings.credentials.push({ id: "c3", name: "C3", type: "openai" });
        secrets.setSecret(cred("c3"), "ck-3");
        expect(secrets.secretStatus(cred("c3"))).toEqual({ set: true, hint: "", pending: true });
        await sync.flushResources();
        expect(requestLog(fake)).toEqual(["POST /api/resources/batch", "PUT /api/llm-secrets/credentials/~c3/key"]);
        expect(fake.batchBodies()[0].ops.map((op) => op.kind)).toEqual(["credentials"]);
        expect(secretRequests(fake)[0].body).toMatchObject({ value: "ck-3" });
        expect(fake.data("credentials", "main").map((c: { id: string }) => c.id)).toEqual(["c1", "c2", "c3"]);
        expect(fake.data("llmSecrets", "main").credentials.c3).toEqual({ key: "ck-3" });
        expect(secrets.secretStatus(cred("c3"))).toEqual({ set: true, hint: "", pending: false });

        // A credential created, and its key queued, while a batch is in flight: the key waits for the
        // next cycle, after the batch that carries the credential.
        fake.requests.length = 0;
        fake.holdNextBatch = true;
        settings.credentials.push({ id: "c4", name: "C4", type: "openai" });
        const flushed = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        settings.credentials.push({ id: "c5", name: "C5", type: "openai" });
        secrets.setSecret(cred("c5"), "ck-5");
        await tick();
        fake.releaseBatch!();
        await flushed;
        await sync.flushResources();
        const log = requestLog(fake);
        const batches = fake.batchBodies();
        expect(batches).toHaveLength(2);
        // Each batch carries its new credential as an item patch (slice 3g): the added item whole, in order.
        expect(batches[0].ops[0].patch).toMatchObject({
            items: [expect.objectContaining({ id: "c4" })],
            order: ["c1", "c2", "c3", "c4"],
        });
        expect(batches[1].ops[0].patch).toMatchObject({
            items: [expect.objectContaining({ id: "c5" })],
            order: ["c1", "c2", "c3", "c4", "c5"],
        });
        expect(log).toEqual([
            "POST /api/resources/batch",
            "POST /api/resources/batch",
            "PUT /api/llm-secrets/credentials/~c5/key",
        ]);
        expect(fake.data("llmSecrets", "main").credentials.c5).toEqual({ key: "ck-5" });
    });

    it("retries a stale revision after a reread, a bounded number of times per cycle, and keeps the write for the next cycle", async () => {
        const { fake, sync, secrets, client } = await boot();
        const conflict = (times: number) => {
            fake.failNext = {
                status: 409,
                body: { error: "Revision conflict", revision: fake.get("llmSecrets", "main")!.revision },
                times,
                match: onSecretRoutes,
            };
        };
        conflict(1);
        secrets.setSecret(flat("mistralKey"), "m1");
        await sync.flushResources();
        expect(requestLog(fake)).toEqual([
            "PUT /api/llm-secrets/mistralKey",
            "GET /api/resources/llmSecrets/main",
            "PUT /api/llm-secrets/mistralKey",
        ]);
        expect(fake.data("llmSecrets", "main").mistralKey).toBe("m1");
        expect(secrets.secretStatus(flat("mistralKey"))).toEqual({ set: true, hint: "", pending: false });

        fake.requests.length = 0;
        conflict(3);
        secrets.setSecret(flat("mistralKey"), "m2");
        await expect(sync.flushResources()).rejects.toBeInstanceOf(client.ResourceConflictError);
        expect(requestLog(fake).filter((entry) => entry.startsWith("PUT"))).toHaveLength(3);
        expect(requestLog(fake).filter((entry) => entry.startsWith("GET"))).toHaveLength(2);
        expect(secrets.secretStatus(flat("mistralKey"))).toEqual({ set: true, hint: "", pending: true });
        expect(fake.data("llmSecrets", "main").mistralKey).toBe("m1");
        await sync.flushResources();
        expect(fake.data("llmSecrets", "main").mistralKey).toBe("m2");
        expect(secrets.llmSecretState.queue).toEqual([]);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("drops a refused write (400) as a reported discard with an alert that never carries the value; the barrier reports the refusal", async () => {
        const { fake, sync, secrets } = await boot();
        fake.failNext = { status: 400, body: { error: "Unknown credential path" }, times: 1, match: onSecretRoutes };
        secrets.setSecret(flat("cohereAPIKey"), "co-VALUE-1");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["llmSecrets/cohereAPIKey"]);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.error.mock.calls[0][0]).toContain("llmSecrets/cohereAPIKey");
        expect(alerts.error.mock.calls[0][0]).not.toContain("co-VALUE-1");
        expect(secrets.secretStatus(flat("cohereAPIKey"))).toEqual({ set: false, hint: "", pending: false });
        expect(secrets.llmSecretState.queue).toEqual([]);
        expect(fake.data("llmSecrets", "main").cohereAPIKey ?? "").toBe("");
        // Not retried.
        await sync.flushResources();
        expect(secretRequests(fake)).toHaveLength(1);

        fake.failNext = { status: 404, body: { error: "Unknown resource kind" }, times: 1, match: onSecretRoutes };
        secrets.setSecret(flat("cohereAPIKey"), "co-VALUE-2");
        await expect(sync.awaitSecretWrites()).rejects.toThrow("The server refused a key");
        expect(secrets.llmSecretState.queue).toEqual([]);
        // A later write of the same path goes through.
        secrets.setSecret(flat("cohereAPIKey"), "co-3");
        await sync.awaitSecretWrites();
        expect(fake.data("llmSecrets", "main").cohereAPIKey).toBe("co-3");
    });

    it("keeps a write through a retryable failure (5xx, network) and sends it once the server answers; the barrier fails meanwhile", async () => {
        const { fake, sync, secrets } = await boot();
        fake.failNext = { status: 503, times: 1, match: onSecretRoutes };
        secrets.setSecret(flat("nanogptKey"), "n1");
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 503 });
        expect(secrets.secretStatus(flat("nanogptKey"))).toEqual({ set: true, hint: "", pending: true });
        expect(fake.data("llmSecrets", "main").nanogptKey ?? "").toBe("");
        await sync.flushResources();
        expect(fake.data("llmSecrets", "main").nanogptKey).toBe("n1");
        expect(secrets.secretStatus(flat("nanogptKey"))).toEqual({ set: true, hint: "", pending: false });

        fake.failNext = { status: 0, times: 1, match: onSecretRoutes };
        secrets.setSecret(flat("nanogptKey"), "n2");
        await expect(sync.awaitSecretWrites()).rejects.toMatchObject({ status: 0 });
        expect(secrets.llmSecretState.queue).toHaveLength(1);
        await sync.awaitSecretWrites();
        expect(fake.data("llmSecrets", "main").nanogptKey).toBe("n2");
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("halts for a restore on a 412 and keeps the write; the barrier refuses while halted, with or without a queue", async () => {
        const { fake, sync, secrets } = await boot();
        fake.failNext = {
            status: 412,
            body: { error: "EpochMismatch", epoch: "epoch-2" },
            times: 1,
            match: onSecretRoutes,
        };
        secrets.setSecret(flat("openrouterKey"), "or-1");
        await expect(sync.flushResources()).rejects.toThrow();
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        expect(secrets.llmSecretState.queue).toHaveLength(1);
        expect(secrets.secretStatus(flat("openrouterKey")).pending).toBe(true);
        expect(fake.data("llmSecrets", "main").openrouterKey ?? "").toBe("");
        await expect(sync.awaitSecretWrites()).rejects.toThrow("Saving stopped");
        expect(() => sync.assertSaveAdmission()).toThrow("Saving stopped");
        secrets.llmSecretState.queue.splice(0);
        await expect(sync.awaitSecretWrites()).rejects.toThrow("Saving stopped");
        // Nothing more was sent.
        expect(secretRequests(fake)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(secretRequests(fake)).toHaveLength(1);
    });
});

describe("adopting the server's record after a write or a reread", () => {
    it("takes the server's siblings when the local ones are unchanged, even under a no-op dirty mark", async () => {
        const { fake, sync, secrets, settings } = await boot();
        // A dirty mark without a change: an edit and its undo in one tick.
        settings.llmSecrets.vertexClientEmail = "tmp";
        settings.llmSecrets.vertexClientEmail = "";
        await tick();
        // Another tab changed a sibling.
        const remote = fake.data("llmSecrets", "main");
        fake.set("llmSecrets", "main", { ...remote, google: { ...remote.google, projectId: "remote" } });
        secrets.setSecret(flat("openAIKey"), "sk-x");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(requestLog(fake)).toEqual([
            "PUT /api/llm-secrets/openAIKey",
            "GET /api/resources/llmSecrets/main",
            "PUT /api/llm-secrets/openAIKey",
        ]);
        expect(settings.llmSecrets.google.projectId).toBe("remote");
        expect(settings.llmSecrets.google.accessToken).toBe("");
        expect(fake.data("llmSecrets", "main")).toMatchObject({ openAIKey: "sk-x", google: { projectId: "remote" } });
        // The reread's changed revision invalidated every path; the write bumped its own again.
        expect(secrets.secretVersion(flat("claudeAPIKey"))).toBe(1);
        expect(secrets.secretVersion(cred("c1"))).toBe(1);
        expect(secrets.secretVersion(flat("openAIKey"))).toBe(2);
        // Nothing is written back: the mirror equals the server.
        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.requests).toEqual([]);
    });

    it("keeps a local sibling edit made during the write and sends it next on the acknowledged revision", async () => {
        const { fake, sync, secrets, settings } = await boot();
        settings.ui.zoomsize = 5;
        secrets.setSecret(flat("openAIKey"), "sk-y");
        fake.beforeNextBatch = () => {
            settings.llmSecrets.vertexClientEmail = "edited-during";
        };
        const first = await sync.flushResources();
        expect(first.discarded).toEqual([]);
        expect(requestLog(fake)).toEqual(["POST /api/resources/batch", "PUT /api/llm-secrets/openAIKey"]);
        expect(fake.data("llmSecrets", "main").openAIKey).toBe("sk-y");
        expect(settings.llmSecrets.vertexClientEmail).toBe("edited-during");
        const second = await sync.flushResources();
        expect(second.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        const sibling = fake
            .batchBodies()
            .at(-1)!
            .ops.find((op) => op.kind === "llmSecrets");
        expect(sibling.data).toMatchObject({ vertexClientEmail: "edited-during" });
        expect(sibling.data).not.toHaveProperty("openAIKey");
        expect(sibling.data).not.toHaveProperty("credentials");
        expect(fake.data("llmSecrets", "main")).toMatchObject({
            openAIKey: "sk-y",
            vertexClientEmail: "edited-during",
        });
        expect(secrets.secretStatus(flat("openAIKey"))).toEqual({ set: true, hint: "", pending: false });
    });

    it("treats a local edit over a remotely changed sibling as the normal conflict: the server's copy wins, the discard is reported, the write still lands", async () => {
        const { fake, sync, secrets, settings } = await boot();
        settings.ui.zoomsize = 6;
        secrets.setSecret(flat("openAIKey"), "sk-z");
        fake.beforeNextBatch = () => {
            const remote = fake.data("llmSecrets", "main");
            fake.set("llmSecrets", "main", { ...remote, vertexClientEmail: "remote" });
            settings.llmSecrets.vertexClientEmail = "local";
        };
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["llmSecrets/main"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(settings.llmSecrets.vertexClientEmail).toBe("remote");
        expect(settings.llmSecrets.openAIKey).toBe("");
        expect(fake.data("llmSecrets", "main")).toMatchObject({ openAIKey: "sk-z", vertexClientEmail: "remote" });
        expect(secrets.secretStatus(flat("openAIKey"))).toEqual({ set: true, hint: "", pending: false });
        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.requests).toEqual([]);
    });

    it("recognizes a sibling write whose acknowledgement was lost on the conflict reread, keeps the stored keys, and echoes nothing", async () => {
        const { fake, sync, secrets, settings } = await boot();
        fake.dropNextBatchResponse = true;
        settings.llmSecrets.vertexClientEmail = "lost-ack";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.data("llmSecrets", "main")).toMatchObject({ vertexClientEmail: "lost-ack", openAIKey: STORED_KEY });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(settings.llmSecrets.vertexClientEmail).toBe("lost-ack");
        expect(secrets.secretStatus(flat("openAIKey"))).toEqual({ set: true, hint: "AAAA", pending: false });
        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.requests).toEqual([]);
    });
});

describe("the cleanup of a deleted owner's entry", () => {
    const removeCredential = (credentials: { id: string }[], id: string) => {
        credentials.splice(
            credentials.findIndex((entry) => entry.id === id),
            1,
        );
    };

    it("is sent once the deletion is saved, for a named credential", async () => {
        const { fake, sync, secrets, settings } = await boot();
        removeCredential(settings.credentials, "c2");
        secrets.deleteEntrySecret("credentials", "c2");
        expect(secrets.secretStatus(cred("c2"))).toEqual({ set: false, hint: "", pending: true });
        await sync.flushResources();
        expect(requestLog(fake)).toEqual(["POST /api/resources/batch", "PUT /api/llm-secrets/credentials/~c2/key"]);
        expect(fake.batchBodies()[0].ops.map((op) => op.kind)).toEqual(["credentials"]);
        expect(secretRequests(fake)[0].body).toMatchObject({ value: "" });
        expect(fake.data("llmSecrets", "main").credentials).toEqual({ c1: { key: "ck-1" } });
        expect(secrets.secretStatus(cred("c2"))).toEqual({ set: false, hint: "", pending: false });
        expect(secrets.llmSecretState.queue).toEqual([]);
    });

    it("is dropped without a request when a conflict restored the owner, while an explicit clear of a live owner still goes", async () => {
        const { fake, sync, secrets, settings } = await boot();
        // Another tab renamed c1: this client's deletion of c2 conflicts and is discarded.
        const credentials = fake.data("credentials", "main");
        fake.set(
            "credentials",
            "main",
            credentials.map((c: { id: string }) => (c.id === "c1" ? { ...c, name: "renamed" } : c)),
        );
        removeCredential(settings.credentials, "c2");
        secrets.deleteEntrySecret("credentials", "c2");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["credentials/main"]);
        expect(settings.credentials.map((c) => [c.id, c.name])).toEqual([
            ["c1", "renamed"],
            ["c2", "C2"],
        ]);
        expect(secretRequests(fake)).toEqual([]);
        expect(fake.data("llmSecrets", "main").credentials.c2).toEqual({ key: "ck-2" });
        expect(secrets.secretStatus(cred("c2"))).toEqual({ set: true, hint: "", pending: false });
        expect(secrets.llmSecretState.queue).toEqual([]);

        secrets.clearSecret(cred("c2"));
        await sync.flushResources();
        expect(secretRequests(fake).map((r) => `${r.method} ${r.path}`)).toEqual([
            "PUT /api/llm-secrets/credentials/~c2/key",
        ]);
        expect(fake.data("llmSecrets", "main").credentials).toEqual({ c1: { key: "ck-1" } });
    });

    it("waits behind a quarantined deletion without keeping the loop running, the barrier names the refusal, and goes once the deletion is saved", async () => {
        const { fake, sync, secrets, settings } = await boot();
        // The adapter's own periodic timers, set at start; a scheduled cycle would add one.
        const timersAtRest = vi.getTimerCount();
        fake.failNext = { status: 400, body: { error: "ops[0]: credentials refused" }, times: 1, match: onBatch };
        removeCredential(settings.credentials, "c2");
        secrets.deleteEntrySecret("credentials", "c2");
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 400 });
        expect(fake.batchCount()).toBe(1);
        expect(secretRequests(fake)).toEqual([]);
        expect(fake.data("llmSecrets", "main").credentials.c2).toEqual({ key: "ck-2" });
        // Unsaved, but not runnable work: no cycle is scheduled for it.
        expect(secrets.secretStatus(cred("c2"))).toEqual({ set: false, hint: "", pending: true });
        expect(vi.getTimerCount()).toBe(timersAtRest);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fake.batchCount()).toBe(1);
        expect(secretRequests(fake)).toEqual([]);
        await expect(sync.awaitSecretWrites()).rejects.toMatchObject({ status: 400 });
        expect(secretRequests(fake)).toEqual([]);
        expect(secrets.llmSecretState.queue).toHaveLength(1);

        // An edit of the refused collection retries it; the cleanup follows the saved deletion.
        settings.credentials[0].name = "fixed";
        await sync.flushResources();
        expect(requestLog(fake).slice(1)).toEqual([
            "POST /api/resources/batch",
            "PUT /api/llm-secrets/credentials/~c2/key",
        ]);
        expect(fake.data("credentials", "main").map((c: { id: string }) => c.id)).toEqual(["c1"]);
        expect(fake.data("llmSecrets", "main").credentials).toEqual({ c1: { key: "ck-1" } });
        expect(secrets.llmSecretState.queue).toEqual([]);
        expect(secrets.secretStatus(cred("c2"))).toEqual({ set: false, hint: "", pending: false });
    });
});
