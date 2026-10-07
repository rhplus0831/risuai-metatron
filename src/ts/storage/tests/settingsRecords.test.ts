import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { bootMutations, plain } from "./mutationStoresHarness";
import { StoreBackedServer } from "./storeBackedServer";

// Phase 6 slice 4 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/settings-ownership.md`,
// "Validation"): the settings records under the real boot (`installBootRecords`, since slice 10), the real save loop, and
// the real server store (`storeBackedServer.ts`), with no settings watcher left. Covered here: a
// nested view write and a direct record write saved on the held revision; reactive reads across a
// server copy; the root snapshot and the views' JSON; an absent plugin storage record staying absent under
// reads; `reconcileSelection` after a `presets` or `personas` replacement
// on the conflict-reload and hydration paths, with a retained wrapper then writing into the new
// record; the record notification counts of the bulk writers (one per record they change); and the
// module mutations keeping lorebook content verbatim (the old-format conversion is an import step).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
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

const opsOf = (fake: StoreBackedServer) => fake.batchBodies().flatMap((batch: any) => batch.ops);

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const records = await import("../records.svelte");
    const presets = await import("../presets.svelte");
    const probes = await import("./reactiveProbe.svelte");
    /** Replaces the save loop's record hook with a counter (no save follows): the notifications a writer makes. */
    const countNotifications = () => {
        const notified: string[] = [];
        records.setRecordWriteListener((kind) => notified.push(kind));
        return notified;
    };
    return { ...booted, records, presets, probes, countNotifications };
}

/** The `loadData` sequence on a store without a `pluginStorage` record (a fresh store has none). */
async function bootWithoutPluginStorage() {
    vi.resetModules();
    const fake = await StoreBackedServer.create();
    server.current = fake;
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const bootstrap = await import("../../bootstrap");
    const records = await import("../records.svelte");
    const settingsViews = await import("../settingsViews.svelte");
    const snapshots = await import("../snapshots.svelte");
    const pluginStorageStore = await import("../pluginStorageStore.svelte");
    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    return { fake, sync, records, snapshots, pluginStorageStore, settings: settingsViews.settings };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("writes through the views and the records", () => {
    it("save exactly the record written, on the held revision, for a nested view write and a direct record write", async () => {
        const { fake, sync, records, settings } = await boot();
        const first = fake.record("ui", "main")!.revision;
        settings.ui.colorScheme.bgcolor = "#123456";
        await sync.flushResources();
        expect(opsOf(fake)).toEqual([expect.objectContaining({ kind: "ui", id: "main", baseRevision: first })]);
        expect(fake.record("ui", "main")!.data.colorScheme.bgcolor).toBe("#123456");
        const second = fake.record("ui", "main")!.revision;
        expect(second).not.toBe(first);

        fake.requests.length = 0;
        records.trackedRecord<any>("ui")!.zoomsize = 123;
        records.trackedRecord<any>("hotkeys")![0].key = "q";
        await sync.flushResources();
        const ops = opsOf(fake);
        expect(ops.map((op: any) => op.kind).sort()).toEqual(["hotkeys", "ui"]);
        expect(ops.find((op: any) => op.kind === "ui").baseRevision).toBe(second);
        expect(fake.record("ui", "main")!.data.zoomsize).toBe(123);
        expect(fake.record("hotkeys", "main")!.data[0].key).toBe("q");
        expect(settings.ui.zoomsize).toBe(123);

        // Nothing else is dirty: the next cycle sends nothing.
        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("leaves reads, the root snapshot, and JSON writing nothing, and gives detached plain copies", async () => {
        const { fake, sync, snapshots, records, settings } = await boot();
        const snapshot = snapshots.rootSnapshot() as any;
        // The views' wrappers serialize like the records they read (Phase 6 slice 10: no aggregate object).
        const json = JSON.parse(
            JSON.stringify({
                zoomsize: settings.ui.zoomsize,
                colorScheme: settings.ui.colorScheme,
                botPresets: settings.presets,
                plugins: settings.plugins,
            }),
        );
        for (const copy of [snapshot, json]) {
            expect(copy.zoomsize).toBe(settings.ui.zoomsize);
            expect(copy.colorScheme).toEqual(plain(settings.ui.colorScheme));
            expect(copy.botPresets.map((preset: any) => preset.id)).toEqual(
                settings.presets.map((preset: any) => preset.id),
            );
            expect(copy.plugins).toEqual([{ name: "plug", realArg: { a: "1" } }]);
            expect(records.isRecordWrapper(copy.colorScheme)).toBe(false);
            expect(records.isRecordWrapper(copy.botPresets)).toBe(false);
        }
        snapshot.colorScheme.bgcolor = "#changed";
        snapshot.botPresets[0].name = "changed";
        expect(settings.ui.colorScheme.bgcolor).not.toBe("#changed");
        expect(settings.presets[0].name).not.toBe("changed");
        // The snapshot carries every root name the views serve; the views read through the records.
        expect(Object.keys(snapshot)).toEqual(
            expect.arrayContaining(["zoomsize", "botPresets", "modules", "personas"]),
        );
        expect(records.isRecordWrapper(settings.ui.colorScheme)).toBe(true);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("re-runs a reader after a server copy replaces its record, at the top level and nested", async () => {
        const { records, probes, settings } = await boot();
        const zoom = probes.createProbe(() => settings.ui.zoomsize);
        const color = probes.createProbe(() => settings.ui.colorScheme.bgcolor);
        const presetName = probes.createProbe(() => settings.presets[0].name);
        const ui = plain(records.recordData("ui"));
        records.applyRaw("ui", { ...ui, zoomsize: 77, colorScheme: { ...ui.colorScheme, bgcolor: "#777777" } });
        records.applyRaw(
            "presets",
            plain(records.recordData("presets")).map((preset: any, index: number) =>
                index === 0 ? { ...preset, name: "renamed by the server" } : preset,
            ),
        );
        const { flushSync } = await import("svelte");
        flushSync();
        expect(zoom.seen.at(-1)).toBe(77);
        expect(zoom.derived()).toBe(77);
        expect(color.seen.at(-1)).toBe("#777777");
        expect(presetName.seen.at(-1)).toBe("renamed by the server");
        // A local write re-runs them too.
        settings.ui.zoomsize = 78;
        flushSync();
        expect(zoom.seen.at(-1)).toBe(78);
        for (const probe of [zoom, color, presetName]) {
            probe.dispose();
        }
    });

    it("keeps an absent pluginStorage record absent under every read, and creates and saves it on the first write", async () => {
        const { fake, sync, snapshots, records, pluginStorageStore, settings } = await bootWithoutPluginStorage();
        expect(fake.record("pluginStorage", "main")).toBeNull();
        expect(settings.pluginStorage).toBeUndefined();
        expect(pluginStorageStore.getPluginStorageValue("k")).toBeNull();
        expect(pluginStorageStore.pluginStorageKeys()).toEqual([]);
        expect(pluginStorageStore.getSafeLocalPluginValue("k")).toBeNull();
        expect(snapshots.rootSnapshot().pluginCustomStorage).toBeUndefined();
        expect(JSON.parse(JSON.stringify(snapshots.rootSnapshot()))).not.toHaveProperty("pluginCustomStorage");
        expect(records.hasRecord("pluginStorage")).toBe(false);
        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);

        pluginStorageStore.setPluginStorageItem("k", "v");
        await sync.flushResources();
        expect(opsOf(fake).map((op: any) => op.kind)).toEqual(["pluginStorage"]);
        expect(fake.record("pluginStorage", "main")!.data).toEqual({ _pluginStorage: { k: "v" } });
    });
});

describe("entry credentials over the save loop", () => {
    it("never put a custom model's key or a model preset's proxyKey in a batch: they go to the credential routes after it", async () => {
        const { fake, sync, settings, record, mirrorText } = await boot();
        const SECRET = "sk-entry-SENTINEL";
        settings.customModels.push({ id: "m1", internalId: "i1", name: "M1", key: `${SECRET}-push` } as any);
        settings.customModels[0] = { ...plain(settings.customModels[0]), name: "M1b", key: `${SECRET}-element` };
        settings.customModels = [
            ...settings.customModels,
            { id: "m2", internalId: "i2", name: "M2", key: `${SECRET}-list` } as any,
        ];
        (settings.modelPresets[0] as Record<string, unknown>).proxyKey = `${SECRET}-proxy`;
        await sync.flushResources();
        const sent = JSON.stringify(fake.batchBodies());
        expect(sent).not.toContain(SECRET);
        expect(record("customModels")).toEqual([
            { id: "m1", internalId: "i1", name: "M1b" },
            { id: "m2", internalId: "i2", name: "M2" },
        ]);
        expect(fake.secretRequests().map((request: any) => request.path)).toEqual([
            "/api/llm-secrets/customModels/~m1/key",
            "/api/llm-secrets/customModels/~m1/key",
            "/api/llm-secrets/customModels/~m2/key",
            `/api/llm-secrets/modelPresets/~${settings.modelPresets[0].id}/proxyKey`,
        ]);
        const stored = fake.record("llmSecrets", "main")!.data as any;
        expect(stored.customModels).toEqual({ m1: { key: `${SECRET}-element` }, m2: { key: `${SECRET}-list` } });
        expect(stored.modelPresets[settings.modelPresets[0].id]).toEqual({ proxyKey: `${SECRET}-proxy` });
        // The tab holds none of them (the root snapshot and the character list).
        expect(mirrorText()).not.toContain(SECRET);
    });
});

describe("server copies of presets and personas", () => {
    it("reconcile the selections after a conflict reload removed the selected entries, and a retained wrapper then writes into the new record", async () => {
        const { fake, sync, collectionStore, selectionModule, selection, settings, record } = await boot();
        collectionStore.setPersonas([
            { id: "pa", name: "A", icon: "", personaPrompt: "", note: "" },
            { id: "pb", name: "B", icon: "", personaPrompt: "", note: "" },
        ]);
        await sync.flushResources();
        const [p1, p2] = settings.presets.map((preset: any) => preset.id);
        selectionModule.selectPreset(p2);
        selectionModule.selectPersona("pb");
        const retainedPreset = settings.presets[0];
        const retainedPersona = settings.personas[0];
        const retainedScheme = settings.ui.colorScheme;
        // Another tab removed the selected preset and changed the ui record; this tab edited both.
        fake.set("presets", "main", [record("presets")[0]]);
        fake.set("ui", "main", { ...record("ui"), zoomsize: 61 });
        settings.presets[0].name = "local";
        settings.ui.zoomsize = 60;
        fake.requests.length = 0;
        let result = await sync.flushResources();
        expect(result.discarded.sort()).toEqual(["presets/main", "ui/main"]);
        expect(settings.presets.map((preset: any) => preset.id)).toEqual([p1]);
        expect(selection.presetId).toBe(p1);
        expect(selection.personaId).toBe("pb");
        expect(settings.ui.zoomsize).toBe(61);
        // Then the selected persona, alone.
        fake.set("personas", "main", [record("personas")[0]]);
        settings.personas[0].name = "local";
        result = await sync.flushResources();
        expect(result.discarded).toEqual(["personas/main"]);
        expect(settings.personas.map((persona: any) => persona.id)).toEqual(["pa"]);
        expect(selection.personaId).toBe("pa");
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);

        // The wrappers held before the reload write into the reloaded records, on their new revisions.
        retainedPreset.name = "after";
        retainedPersona.name = "after";
        retainedScheme.bgcolor = "#abcdef";
        alerts.normal.mockClear();
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        expect(record("presets").map((preset: any) => [preset.id, preset.name])).toEqual([[p1, "after"]]);
        expect(record("personas").map((persona: any) => [persona.id, persona.name])).toEqual([["pa", "after"]]);
        expect(record("ui")).toMatchObject({
            zoomsize: 61,
            colorScheme: expect.objectContaining({ bgcolor: "#abcdef" }),
        });
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("reconcile the selections after a hydration removed the selected entries, and a later write saves on the hydrated revision", async () => {
        const { fake, sync, collectionStore, selectionModule, selection, settings, record } = await boot();
        collectionStore.setPersonas([
            { id: "pa", name: "A", icon: "", personaPrompt: "", note: "" },
            { id: "pb", name: "B", icon: "", personaPrompt: "", note: "" },
        ]);
        await sync.flushResources();
        const [p1, p2] = settings.presets.map((preset: any) => preset.id);
        selectionModule.selectPreset(p2);
        selectionModule.selectPersona("pb");
        const hydrate = (kind: string) => {
            fake.set(kind, "main", [record(kind)[0]]);
            const stored = fake.record(kind, "main")!;
            expect(sync.applyHydration({ kind, id: "main", revision: stored.revision, data: stored.data })).toBe(true);
        };
        hydrate("presets");
        expect(selection.presetId).toBe(p1);
        expect(selection.personaId).toBe("pb");
        hydrate("personas");
        expect(selection.personaId).toBe("pa");
        fake.requests.length = 0;
        await tick();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        settings.presets[0].name = "after hydration";
        settings.personas[0].name = "after hydration";
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        expect(
            opsOf(fake)
                .map((op: any) => op.kind)
                .sort(),
        ).toEqual(["personas", "presets"]);
        expect(record("presets")[0].name).toBe("after hydration");
        expect(record("personas")[0].name).toBe("after hydration");
        expect(alerts.normal).not.toHaveBeenCalled();
    });
});

describe("bulk writers notify once per record they change", () => {
    it("updateSettings; a preset switch of either kind writes no record", async () => {
        const { collectionStore, presets, settings, countNotifications } = await boot();
        const [, p2] = settings.presets.map((preset: any) => preset.id);
        const [, m2] = settings.modelPresets.map((preset: any) => preset.id);
        const notified = countNotifications();
        // `maxContext` and `fallbackWhenBlankResponse` are the model preset's (`docs/plan/split-preset.md`).
        collectionStore.updateSettings({
            temperature: 5,
            maxContext: 1234,
            theme: "waifu",
            lineHeight: 2,
            fallbackWhenBlankResponse: true,
            hypaModel: "m",
        });
        expect(notified.sort()).toEqual(["memoryTranslateMedia", "modelPresets", "presets", "ui"]);
        notified.length = 0;
        presets.changeToPreset(p2);
        presets.changeToModelPreset(m2);
        expect(notified).toEqual([]);
    });

    it("updatePersona and updateModule commit a multi-field patch once; updateModule patches the live module in place", async () => {
        const { collectionStore, settings, countNotifications } = await boot();
        const moduleId = collectionStore.addModule({ name: "M", description: "d", lorebook: [] });
        const personaId = settings.personas[0].id;
        const retainedModule = settings.modules[0];
        const notified = countNotifications();
        collectionStore.updatePersona(personaId, { name: "N", personaPrompt: "pp", note: "nn" });
        expect(notified).toEqual(["personas"]);
        notified.length = 0;
        collectionStore.updateModule(moduleId, { name: "M2", description: "d2", custom: { a: 1 } });
        expect(notified).toEqual(["modules"]);
        expect(retainedModule.name).toBe("M2");
        expect(plain(settings.modules[0])).toMatchObject({
            id: moduleId,
            name: "M2",
            description: "d2",
            custom: { a: 1 },
        });
        // A patch the module rule refuses changes nothing and notifies nothing.
        notified.length = 0;
        expect(() => collectionStore.updateModule(moduleId, { name: 5, lorebook: "corrupt" })).toThrow();
        expect(notified).toEqual([]);
        expect(plain(settings.modules[0]).name).toBe("M2");
    });

    it("setPluginArgument, addAuthRefresh, checkCharOrder, and the plugin storage writers", async () => {
        const { collectionStore, pluginStorageStore, characterOrder, settings, countNotifications } = await boot();
        const notified = countNotifications();
        expect(collectionStore.setPluginArgument("plug", "a", "2")).toBe(true);
        expect(collectionStore.setPluginArgument("plug", "__proto__", "p")).toBe(true);
        expect(notified).toEqual(["plugins", "plugins"]);
        notified.length = 0;
        collectionStore.addAuthRefresh({ url: "u", tokenUrl: "t", refreshToken: "r", clientId: "c" });
        collectionStore.addAuthRefresh({ url: "u", tokenUrl: "t2", refreshToken: "r2", clientId: "c2" });
        expect(notified).toEqual(["authRefreshes", "authRefreshes"]);
        notified.length = 0;
        // An order that is already repaired is not written again.
        characterOrder.checkCharOrder();
        expect(notified).toEqual(["characterOrder"]);
        notified.length = 0;
        characterOrder.checkCharOrder();
        expect(notified).toEqual([]);
        settings.characterOrder.push("gone-1", "gone-2", "gone-3");
        notified.length = 0;
        characterOrder.checkCharOrder();
        expect(notified).toEqual(["characterOrder"]);
        expect(plain(settings.characterOrder)).not.toContain("gone-1");
        notified.length = 0;
        pluginStorageStore.setPluginStorageItem("k", { nested: true });
        pluginStorageStore.setPluginStorageItem("__proto__", "p");
        pluginStorageStore.removePluginStorageItem("k");
        pluginStorageStore.clearPluginStorage();
        pluginStorageStore.setSafeLocalPluginValue("s", "v");
        pluginStorageStore.clearSafeLocalPluginStorage();
        pluginStorageStore.setPluginCustomValue("custom", [1, 2]);
        pluginStorageStore.replacePluginCustomStorage({ only: 1 });
        expect(notified).toEqual(Array(8).fill("pluginStorage"));
        // A removal of a key that is not there writes nothing.
        notified.length = 0;
        pluginStorageStore.removePluginStorageItem("missing");
        expect(notified).toEqual([]);
    });
});

describe("module mutations outside an import", () => {
    it("keep old-format lorebook content verbatim on add, replace, and patch (the conversion is an import step)", async () => {
        const { sync, collectionStore, record } = await boot();
        const old = {
            key: "k",
            comment: "c",
            content: "<char> meets <user>\n@@end",
            mode: "normal",
            activationPercent: 50,
        };
        const id = collectionStore.addModule({ name: "Old", lorebook: [old] });
        await sync.flushResources();
        expect(record("modules").find((module: any) => module.id === id).lorebook).toEqual([old]);
        collectionStore.updateModule(id, { lorebook: [{ ...old, comment: "patched" }] });
        await sync.flushResources();
        expect(record("modules").find((module: any) => module.id === id).lorebook).toEqual([
            { ...old, comment: "patched" },
        ]);
        collectionStore.setModules([{ id, name: "Old", lorebook: [old] }]);
        await sync.flushResources();
        expect(record("modules")).toEqual([{ id, name: "Old", lorebook: [old] }]);
    });

    it("refuse a malformed module before anything changes, on the client and on the server", async () => {
        const { fake, collectionStore, validation, refused } = await boot();
        await refused(
            () => collectionStore.addModule({ name: "Bad", lorebook: "corrupt" }),
            validation.MutationValidationError,
        );
        await refused(() => collectionStore.addModule({ name: 5 }), validation.MutationValidationError);
        await refused(
            () => collectionStore.setModules([{ id: "a", name: "A", regex: {} }]),
            validation.MutationValidationError,
        );
        // The server's normalizer applies the same rule (another client, an older build).
        expect(() => fake.set("modules", "main", [{ id: "x", name: "X", trigger: "t" }])).toThrow(/trigger/);
        expect(() => fake.set("modules", "main", [{ id: "x", description: 1 }])).toThrow(/description/);
    });
});
