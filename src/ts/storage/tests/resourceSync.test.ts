import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";

// The save adapter (`resourceSync.svelte.ts`) against an in-memory stand-in for the resource routes.
// Each test boots a fresh module graph (the adapter keeps its transport state at module level) and
// exercises the real Svelte 5 runes: the watchers, `$state.snapshot`, and the record wrappers
// (`settings.*`, `characterList()`) as proxies.

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
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));

// `characterStore.svelte.ts` reaches the module updates, and `database.svelte.ts` (reached through
// `process/scripts`) re-exports asset helpers; nothing under test needs them.
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
type CharacterStore = typeof import("../characterStore.svelte");
type Selection = typeof import("../selection.svelte");
/** The record views a test edits after the boot installed the records. */
type Views = { settings: SettingsViews["settings"]; characterList: CharacterStore["characterList"] };

/** A character record as the server stores it: its own fields, no chats (they are resources of their own). */
function character(chaId: string, name: string, extra: Record<string, unknown> = {}) {
    return { chaId, name, type: "character", ...extra };
}

/**
 * Boots the adapter the way `loadData` does: read, seed, install the records (`installBootRecords`,
 * the selection at home), start, and let the boot compare pass run. `bootBatches` is what that pass
 * sent. `snapshot` changes the read snapshot after it was seeded and before it is installed (a
 * fixture the server could not hold); `installed` edits the views right after the installation
 * (what a load-time change of the installed records looks like to the first compare pass).
 */
async function boot(
    options: {
        prepare?: (server: FakeResourceServer) => void;
        snapshot?: (snapshot: Awaited<ReturnType<Client["readKinds"]>>) => void;
        installed?: (views: Views) => void;
    } = {},
) {
    vi.resetModules();
    const fake = new FakeResourceServer();
    // No `root` record since slice 6: the sections and collections are the records the server
    // materializes (`materialize` below); the sample singleton edit of these tests is `ui.theme`.
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", character("a", "Alice"));
    fake.set("characters", "b", character("b", "Bob"));
    await materialize(fake);
    options.prepare?.(fake);
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");
    const characterStore: CharacterStore = await import("../characterStore.svelte");
    const selection: Selection = await import("../selection.svelte");
    const { characterList } = characterStore;

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    options.snapshot?.(snapshot);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    options.installed?.({ settings, characterList });
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    const bootBatches = fake.batchBodies();
    fake.requests.length = 0;
    return { fake, client, sync, bootBatches, settings, characterList, characterStore, selection };
}

beforeEach(() => {
    // The adapter's debounce and backoff timers; cleared after each test so an earlier test's
    // adapter instance never wakes up against a later test's fake server.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("seeding and no echo", () => {
    it("writes nothing after boot when the mirror equals the server", async () => {
        const { fake, sync, bootBatches } = await boot();
        expect(bootBatches).toEqual([]);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("saves the load-time normalization once (the first compare pass) and then stays quiet", async () => {
        const { fake, sync, bootBatches } = await boot({
            installed: ({ settings, characterList }) => {
                // What a load-time normalization changes after seeding: a section field and a
                // character field (the server normalizes the sections, so this stands in for it).
                settings.ui.theme = "normalized";
                (characterList()[1] as any).bias = [];
            },
        });
        expect(fake.data("ui", "main").theme).toBe("normalized");
        expect(fake.data("characters", "b").bias).toEqual([]);
        expect(fake.data("characters", "a").bias).toBeUndefined();
        expect(bootBatches).toHaveLength(1);
        expect(bootBatches[0].ops.map((op) => `${op.kind}/${op.id}`).sort()).toEqual(["characters/b", "ui/main"]);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("neither tracks nor saves the mirror's chats, selection, and render key with the character record", async () => {
        const { fake, sync, characterList, selection } = await boot();
        selection.selectCharacterAt(0);
        await tick();
        // Phase 6 slice 9a: a wrapper refuses a `chats`/`chatPage` write; the chat module holds them.
        const chat = await import("../chatStore.svelte");
        const alice = () => characterList()[0] as any;
        chat.installCharacterChats(
            "a",
            [{ id: "a-chat", message: [{ role: "user", data: "hi", chatId: "m1" }] } as any],
            alice(),
        );
        chat.selectChat("a", 0);
        alice().reloadKeys = { 0: 1 };
        await sync.flushResources();
        // Chats are saved by the chat module; the selection and the render key are client-only.
        expect(fake.batchCount()).toBe(0);
        alice().chats[0].message[0].data = "edited outside the chat module";
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        alice().name = "Alice 2";
        await sync.flushResources();
        const saved = fake.data("characters", "a");
        expect(saved.name).toBe("Alice 2");
        expect(saved).not.toHaveProperty("chats");
        expect(saved).not.toHaveProperty("chatPage");
        expect(saved).not.toHaveProperty("reloadKeys");
    });
});

describe("dirty generations", () => {
    it("saves a section edit with the seeded revision and records the new one", async () => {
        const { fake, sync, settings } = await boot();
        const before = fake.get("ui", "main")!.revision;
        settings.ui.theme = "edited";
        await sync.flushResources();
        const [batch] = fake.batchBodies();
        expect(batch.ops).toHaveLength(1);
        expect(batch.ops[0]).toMatchObject({ kind: "ui", id: "main", baseRevision: before });
        expect(batch.ops[0].data).not.toHaveProperty("characters");
        expect(batch.ops[0].data).not.toHaveProperty("botPresets");
        expect(fake.data("ui", "main").theme).toBe("edited");
        const afterFirst = fake.get("ui", "main")!.revision;
        expect(afterFirst).not.toBe(before);
        settings.ui.theme = "edited again";
        await sync.flushResources();
        expect(fake.batchBodies()[1].ops[0].baseRevision).toBe(afterFirst);
        expect(fake.data("ui", "main").theme).toBe("edited again");
    });

    it("saves presets deeply, and every character's writes, selected or not", async () => {
        const { fake, sync, settings, characterList, selection } = await boot();
        settings.presets[0].name = "renamed preset";
        selection.selectCharacterAt(1);
        await tick();
        characterList()[1].name = "Bob 2";
        // Since Phase 6 slice 5 a write to a character that is not selected is saved too (no watcher, no mark).
        characterList()[0].name = "Alice saved";
        await sync.flushResources();
        expect(fake.data("presets", "main")[0].name).toBe("renamed preset");
        expect(fake.data("characters", "b").name).toBe("Bob 2");
        expect(fake.data("characters", "a").name).toBe("Alice saved");
    });

    it("keeps an edit made while its batch is in flight dirty and saves it in the next cycle", async () => {
        const { fake, sync, settings } = await boot();
        fake.holdNextBatch = true;
        settings.ui.theme = "first";
        const flushed = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        settings.ui.theme = "second";
        await tick();
        fake.releaseBatch!();
        await flushed;
        // The flush covered "first"; "second" was made during the request and goes out on its own.
        expect(fake.data("ui", "main").theme).toBe("first");
        await vi.waitFor(() => expect(fake.data("ui", "main").theme).toBe("second"), { timeout: 3000 });
        expect(fake.batchCount()).toBe(2);
    });

    it("flush waits for an edit made before the call even when a later edit replaces its generation", async () => {
        const { fake, sync, settings } = await boot();
        fake.holdNextBatch = true;
        settings.ui.theme = "barrier-A";
        void sync.flushResources().catch(() => {});
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        settings.ui.theme = "barrier-B";
        await tick();
        const flushed = sync.flushResources();
        settings.ui.theme = "barrier-C";
        await tick();
        fake.releaseBatch!();
        const result = await flushed;
        expect(result.discarded).toEqual([]);
        expect(fake.data("ui", "main").theme).toBe("barrier-C");
    });
});

describe("membership", () => {
    it("creates a new character and deletes a removed one", async () => {
        const { fake, sync, characterStore } = await boot();
        // The list changes through the character module (Phase 6 slice 5: a push or splice through
        // the list wrapper is refused).
        characterStore.addCharacter(character("c", "Carol"));
        characterStore.removeCharacter("a");
        await sync.flushResources();
        expect(fake.get("characters", "c")).not.toBeNull();
        expect(fake.get("characters", "a")).toBeNull();
        const [batch] = fake.batchBodies();
        expect(batch.ops.find((op) => op.id === "c")).toMatchObject({ baseRevision: null });
        expect(batch.ops.find((op) => op.id === "a")).toMatchObject({ delete: true });
    });

    it("saves a character added while a batch is in flight without another edit", async () => {
        const { fake, sync, settings, characterStore } = await boot();
        fake.holdNextBatch = true;
        settings.ui.theme = "in flight";
        void sync.flushResources().catch(() => {});
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        characterStore.addCharacter(character("late", "Late"));
        await tick();
        fake.releaseBatch!();
        await vi.waitFor(() => expect(fake.get("characters", "late")).not.toBeNull(), { timeout: 3000 });
    });

    it("repairs a duplicate chaId at installation and refuses one at insertion, so no record overwrites another", async () => {
        // Since Phase 6 slice 5 the ids are unique by construction: an installed list with a repeated
        // id gets a new id for the later entry (the save loop no longer renames), and an insertion
        // of a taken id is refused.
        const { fake, sync, characterList, characterStore } = await boot({
            // A second record of `a` in the boot read (the seed does not know it: a fixture the server could not hold).
            snapshot: (snapshot) => {
                const records = snapshot.kinds[RESOURCE_KIND.characters];
                records.push(JSON.parse(JSON.stringify(records[0])));
            },
        });
        await sync.flushResources();
        const ids = characterList().map((entry: any) => entry.chaId);
        expect(new Set(ids).size).toBe(3);
        expect(ids[0]).toBe("a");
        for (const id of ids) {
            expect(fake.get("characters", id)).not.toBeNull();
        }
        expect(fake.data("characters", "a").name).toBe("Alice");
        const validation = await import("../mutationValidation");
        const batches = fake.batchCount();
        expect(() => characterStore.addCharacter(JSON.parse(JSON.stringify(characterList()[1])))).toThrow(
            validation.MutationValidationError,
        );
        await sync.flushResources();
        expect(characterList().map((entry: any) => entry.chaId)).toEqual(ids);
        expect(fake.batchCount()).toBe(batches);
    });
});

describe("conflicts", () => {
    it("reloads a record another tab changed, reports the discard, and shows the notice once", async () => {
        const { fake, sync, settings, characterList, selection } = await boot();
        fake.set("characters", "a", character("a", "Alice from tab B"));
        fake.set("ui", "main", { ...fake.data<Record<string, unknown>>("ui", "main")!, theme: "remote user" });
        selection.selectCharacterAt(0);
        await tick();
        characterList()[0].name = "local edit";
        settings.ui.theme = "local user";
        const result = await sync.flushResources();
        expect(result.discarded.sort()).toEqual(["characters/a", "ui/main"]);
        expect(characterList()[0].name).toBe("Alice from tab B");
        expect(settings.ui.theme).toBe("remote user");
        expect(fake.data("characters", "a").name).toBe("Alice from tab B");
        expect(alerts.normal).toHaveBeenCalledTimes(1);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        // The hydrated data is the saved state: nothing is echoed back.
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
    });

    it("does not echo a reloaded section record whose keys the other tab wrote in another order", async () => {
        const { fake, sync, settings } = await boot();
        const reversed = Object.fromEntries(Object.entries(fake.data("ui", "main")).reverse());
        reversed.theme = "reordered";
        fake.set("ui", "main", reversed);
        settings.ui.theme = "stale";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["ui/main"]);
        expect(settings.ui.theme).toBe("reordered");
        const uiBatches = fake.batchBodies().filter((batch) => batch.ops.some((op) => op.kind === "ui"));
        expect(uiBatches).toHaveLength(1);
        await sync.flushResources();
        expect(fake.batchBodies().filter((batch) => batch.ops.some((op) => op.kind === "ui"))).toHaveLength(1);
    });

    it("sends the non-conflicting operations of a rejected batch in the next cycle", async () => {
        const { fake, sync, settings } = await boot();
        fake.set("ui", "main", { ...fake.data<Record<string, unknown>>("ui", "main")!, theme: "remote" });
        settings.ui.theme = "local";
        settings.modules.push({ name: "new module" } as any);
        await sync.flushResources();
        expect(fake.data("modules", "main")).toEqual([{ name: "new module" }]);
        expect(settings.ui.theme).toBe("remote");
    });

    it("treats a 409 after a lost response as committed when the server holds what was sent", async () => {
        const { fake, sync, settings } = await boot();
        fake.dropNextBatchResponse = true;
        settings.ui.theme = "committed but unacknowledged";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.data("ui", "main").theme).toBe("committed but unacknowledged");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(settings.ui.theme).toBe("committed but unacknowledged");
        expect(alerts.normal).not.toHaveBeenCalled();
        settings.ui.theme = "next";
        await sync.flushResources();
        expect(fake.data("ui", "main").theme).toBe("next");
    });

    it("removes a character deleted elsewhere and moves the selection home", async () => {
        const { fake, sync, characterList, selection } = await boot();
        fake.delete("characters", "a");
        selection.selectCharacterAt(0);
        await tick();
        characterList()[0].name = "edit on a deleted character";
        await sync.flushResources();
        expect(characterList().map((entry: any) => entry.chaId)).toEqual(["b"]);
        expect(selection.selectedIndex()).toBe(-1);
    });

    it("notifies remote-change listeners for every reloaded record", async () => {
        const { fake, sync, characterList } = await boot();
        const seen: string[] = [];
        const off = sync.onRemoteRecordApplied((kind, id) => seen.push(`${kind}/${id}`));
        fake.set("characters", "b", character("b", "Bob remote"));
        // The write itself queues the save of `b`, which is not selected (Phase 6 slice 5: no mark).
        characterList()[1].name = "Bob local";
        await sync.flushResources();
        expect(seen).toEqual(["characters/b"]);
        off();
    });
});

describe("a generating character (the generation deferral is gone)", () => {
    /**
     * Makes `chaId` generating as the app does: a server job of this tab streams into a chat of it
     * (the mirror's chats are local, so the chat is placed there directly; since Phase 6 slice 9a
     * through the chat module, `installCharacterChats`). Returns the job's end.
     */
    async function generate(characterList: () => any[], chaId: string) {
        const chat = await import("../chatStore.svelte");
        const character = characterList().find((entry: any) => entry.chaId === chaId);
        chat.installCharacterChats(
            chaId,
            [
                {
                    id: `k${chaId}`,
                    name: "K",
                    note: "",
                    localLore: [],
                    message: [{ role: "char", data: "", chatId: "r" }],
                },
            ],
            character,
        );
        chat.applyServerGeneration(
            { chaId, chatId: `k${chaId}` },
            { jobId: `J${chaId}`, messageId: "r", generationId: `g${chaId}`, text: "so far", seq: 0 },
        );
        expect(chat.isCharacterGenerating(chaId)).toBe(true);
        return () => chat.endServerJob(`J${chaId}`);
    }

    it("reloads the generating character inside the cycle on a conflict, and saves the batch's other edit after it", async () => {
        const { fake, sync, settings, characterList, selection } = await boot();
        const seen: string[] = [];
        sync.onRemoteRecordApplied((kind, id) => seen.push(`${kind}/${id}`));
        selection.selectCharacterAt(0);
        await tick();
        const end = await generate(characterList, "a");
        fake.set("characters", "a", character("a", "remote name"));
        characterList()[0].name = "local name";
        settings.ui.theme = "saved anyway";
        // Since Phase 6 slice 5 nothing holds a generating character back: the conflict reloads it
        // at once, with the discard reported and the notice shown.
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/a"]);
        expect(characterList()[0].name).toBe("remote name");
        expect(seen).toEqual(["characters/a"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        // The batch was atomic, so the section edit was rejected with it; the loop saves it on its own.
        await vi.waitFor(() => expect(fake.data("ui", "main").theme).toBe("saved anyway"), { timeout: 3000 });
        expect(fake.data("characters", "a").name).toBe("remote name");
        end();
    });

    it("retries a failed conflict reload with the cycle's backoff and keeps the local state meanwhile", async () => {
        const { fake, sync, characterList, selection } = await boot();
        selection.selectCharacterAt(0);
        await tick();
        const end = await generate(characterList, "a");
        fake.set("characters", "a", character("a", "remote name"));
        characterList()[0].name = "local name";
        fake.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/read" };
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 500 });
        expect(characterList()[0].name).toBe("local name");
        expect(fake.data("characters", "a").name).toBe("remote name");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/a"]);
        expect(characterList()[0].name).toBe("remote name");
        end();
    });

    it("reloads a generating character that is not selected the same way", async () => {
        const { fake, sync, characterList, selection } = await boot();
        selection.selectCharacterAt(0);
        await tick();
        const end = await generate(characterList, "b");
        fake.set("characters", "b", character("b", "remote Bob"));
        characterList()[1].name = "local Bob";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/b"]);
        expect(characterList()[1].name).toBe("remote Bob");
        end();
    });
});

describe("restore (412) and errors", () => {
    it("halts, alerts, and reloads on a 412 from a batch", async () => {
        const { fake, sync, settings } = await boot();
        const themeBefore = fake.data("ui", "main").theme;
        fake.restore("epoch-2");
        settings.ui.theme = "after restore";
        await expect(sync.flushResources()).rejects.toThrow();
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        await vi.waitFor(() => expect((location as any).reload).toHaveBeenCalled());
        expect(fake.data("ui", "main").theme).toBe(themeBefore);
        await expect(sync.flushResources()).rejects.toThrow(/restored/);
    });

    it("halts when a conflict read answers with another epoch", async () => {
        const { fake, sync, settings } = await boot();
        fake.set("ui", "main", { ...fake.data<Record<string, unknown>>("ui", "main")!, theme: "remote" });
        fake.readEpoch = "epoch-from-a-restore";
        settings.ui.theme = "local";
        await expect(sync.flushResources()).rejects.toThrow();
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        expect(settings.ui.theme).toBe("local");
    });

    it("halts when any other resource request hits a 412 (the transport listener)", async () => {
        const { fake, sync, client, settings } = await boot();
        fake.restore("epoch-3");
        await expect(
            client.putResource("inlays", "x", { name: "x", ext: "json", type: "signature" }, null),
        ).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        settings.ui.theme = "never saved";
        await expect(sync.flushResources()).rejects.toThrow(/restored/);
        expect(fake.batchCount()).toBe(0);
    });

    it("shows one notice for several epoch refusals and reloads only after it is acknowledged, once", async () => {
        // The restore-notice fix after Phase 6 slice 2: the reload waits for the notice's own
        // acknowledgement (here a deferred `alertTerminal`), however long it takes.
        let acknowledge: () => void = () => {};
        alerts.terminal.mockImplementationOnce(
            () => new Promise<undefined>((resolve) => (acknowledge = () => resolve(undefined))),
        );
        const { fake, sync, client, settings } = await boot();
        const themeBefore = fake.data("ui", "main").theme;
        const reload = (location as any).reload;
        fake.restore("epoch-2");
        settings.ui.theme = "after restore";
        await expect(sync.flushResources()).rejects.toThrow();
        await expect(
            client.putResource("inlays", "x", { name: "x", ext: "json", type: "signature" }, null),
        ).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        client.epochMismatch("epoch-2");
        await expect(sync.watchForRestore()).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(alerts.terminal).toHaveBeenCalledTimes(1);
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        expect(reload).not.toHaveBeenCalled();
        acknowledge();
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        // A refusal after the acknowledgement neither shows the notice again nor reloads again.
        client.epochMismatch("epoch-2");
        await vi.advanceTimersByTimeAsync(1000);
        expect(alerts.terminal).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(fake.data("ui", "main").theme).toBe(themeBefore);
    });

    it("quarantines a record the server refuses as too large, keeps saving the rest, and retries it once it changes", async () => {
        const { fake, sync, settings } = await boot();
        fake.maxBodyBytes = 200;
        settings.ui.theme = "x".repeat(300);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 413 });
        expect(alerts.error).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1200);
        expect(fake.batchCount()).toBe(1);
        // An explicit flush rejects at once with the same reason; unchanged content is not resent.
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 413 });
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(fake.batchCount()).toBe(1);
        // Other records keep saving around the refused one, on the loop's own schedule.
        settings.presets.push({ name: "p2" } as any);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 413 });
        await vi.advanceTimersByTimeAsync(1200);
        expect(fake.data("presets", "main")).toEqual([{ name: "p1" }, { name: "p2" }]);
        expect(
            fake
                .batchBodies()
                .at(-1)!
                .ops.map((op) => op.kind),
        ).toEqual(["presets"]);
        expect(fake.batchCount()).toBe(2);
        fake.maxBodyBytes = Infinity;
        settings.ui.theme = "small again";
        await sync.flushResources();
        expect(fake.data("ui", "main").theme).toBe("small again");
        expect(alerts.error).toHaveBeenCalledTimes(1);
    });

    it("quarantines a record the server refuses as invalid by its content, alerts once, and keeps saving the others", async () => {
        const { fake, sync, settings } = await boot();
        const themeBefore = fake.data("ui", "main").theme;
        fake.failNext = {
            status: 400,
            body: { error: "ops[0]: ui main: theme must be a string" },
            times: 1,
            match: (path) => path === "/api/resources/batch",
        };
        settings.ui.theme = "refused";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 400 });
        expect(alerts.error).toHaveBeenCalledTimes(1);
        // Not resent while unchanged, even though the server would now accept it.
        await vi.advanceTimersByTimeAsync(3000);
        expect(fake.batchCount()).toBe(1);
        expect(fake.data("ui", "main").theme).toBe(themeBefore);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 400 });
        expect(alerts.error).toHaveBeenCalledTimes(1);
        // Another record saves on its own, without the refused one.
        settings.presets.push({ name: "p2" } as any);
        await vi.advanceTimersByTimeAsync(1200);
        expect(fake.data("presets", "main")).toEqual([{ name: "p1" }, { name: "p2" }]);
        expect(
            fake
                .batchBodies()
                .at(-1)!
                .ops.map((op) => op.kind),
        ).toEqual(["presets"]);
        // A change to the refused record retries it.
        settings.ui.theme = "repaired";
        await sync.flushResources();
        expect(fake.data("ui", "main").theme).toBe("repaired");
        expect(alerts.error).toHaveBeenCalledTimes(1);
    });

    it("keeps everything dirty through a retryable failure and saves once the server answers", async () => {
        const { fake, sync, settings } = await boot();
        fake.failNext = { status: 503, times: 1 };
        settings.ui.theme = "retry me";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 503 });
        expect(alerts.error).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(fake.data("ui", "main").theme).toBe("retry me");
    });
});

// Phase 5 cutover: a job a restore or import ended (its `maintenance` terminal comes before the
// replacement) makes the tab read until the server answers with another epoch (`watchForRestore`).
describe("the restore watch of a job ended by maintenance", () => {
    const watchReads = (fake: FakeResourceServer) =>
        fake.requests.filter((request) => request.method === "GET" && request.path === "/api/resources/ui/main").length;

    it("keeps waiting through old-epoch answers, a 503, and a network failure, then halts with the notice and the reload once the epoch changes", async () => {
        const { fake, sync, settings } = await boot();
        let settled: boolean | undefined;
        const watch = sync.watchForRestore().then((replaced) => (settled = replaced));
        const onWatchRead = (path: string) => path === "/api/resources/ui/main";
        await vi.advanceTimersByTimeAsync(1000);
        expect(watchReads(fake)).toBe(1);
        fake.failNext = { status: 503, times: 1, match: onWatchRead };
        await vi.advanceTimersByTimeAsync(1000);
        fake.failNext = { status: 0, times: 1, match: onWatchRead };
        await vi.advanceTimersByTimeAsync(1000);
        expect(watchReads(fake)).toBe(3);
        expect(settled).toBeUndefined();
        expect(alerts.terminal).not.toHaveBeenCalled();
        fake.restore("epoch-2");
        await vi.advanceTimersByTimeAsync(1000);
        await watch;
        expect(settled).toBe(true);
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
        await vi.waitFor(() => expect((location as any).reload).toHaveBeenCalled());
        settings.ui.theme = "never saved";
        await expect(sync.flushResources()).rejects.toThrow(/restored/);
        expect(fake.batchCount()).toBe(0);
    });

    it("reads again after a read that hangs for 5 s, ends after two minutes when nothing was replaced, and frees its slot for the next watch", async () => {
        // `Date` too: the watch's two-minute deadline compares `Date.now()`.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
        const { fake, sync } = await boot();
        let hang = true;
        let hung = 0;
        server.current = {
            fetch: (path: string, init?: RequestInit) => {
                if (hang && path === "/api/resources/ui/main") {
                    hung += 1;
                    return new Promise<Response>(() => {});
                }
                return fake.fetch(path, init);
            },
        };
        let settled: boolean | undefined;
        void sync.watchForRestore().then((replaced) => (settled = replaced));
        await vi.advanceTimersByTimeAsync(1000);
        expect(hung).toBe(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(hung).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(hung).toBe(2);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(settled).toBe(false);
        expect(alerts.terminal).not.toHaveBeenCalled();
        // A new watch starts its own reads (the slot was freed) and sees a later replacement.
        hang = false;
        fake.restore("epoch-2");
        const again = sync.watchForRestore();
        await vi.advanceTimersByTimeAsync(1000);
        await expect(again).resolves.toBe(true);
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
    });

    it("runs one watch at a time for every caller, and answers true at once when saving already halted for a restore", async () => {
        const { fake, sync } = await boot();
        const first = sync.watchForRestore();
        const second = sync.watchForRestore();
        expect(second).toBe(first);
        await vi.advanceTimersByTimeAsync(1000);
        expect(watchReads(fake)).toBe(1);
        fake.restore("epoch-2");
        await vi.advanceTimersByTimeAsync(1000);
        await expect(first).resolves.toBe(true);
        const reads = watchReads(fake);
        await expect(sync.watchForRestore()).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(3000);
        expect(watchReads(fake)).toBe(reads);
        expect(alerts.terminal).toHaveBeenCalledTimes(1);
    });
});

describe("batch sizing", () => {
    it("measures UTF-8 bytes", async () => {
        const { sync } = await boot();
        expect(sync.utf8ByteLength("abc")).toBe(3);
        expect(sync.utf8ByteLength("é")).toBe(2);
        expect(sync.utf8ByteLength("가")).toBe(3);
        expect(sync.utf8ByteLength("😀")).toBe(4);
        const mixed = JSON.stringify({ text: "가나다 abc 😀 é" });
        expect(sync.utf8ByteLength(mixed)).toBe(new TextEncoder().encode(mixed).byteLength);
    });

    it("packs by byte size, so two records of 60 MiB each never share a batch", async () => {
        const { sync } = await boot();
        const big = { bytes: 62_914_657 };
        expect(sync.splitBatches([big, big]).map((batch) => batch.length)).toEqual([1, 1]);
        const small = { bytes: 10 };
        expect(sync.splitBatches([small, big, big, small])).toEqual([
            [small, big],
            [big, small],
        ]);
    });

    it("packs at most 5,000 operations per batch", async () => {
        const { sync } = await boot();
        const ops = Array.from({ length: 5001 }, () => ({ bytes: 1 }));
        expect(sync.splitBatches(ops).map((batch) => batch.length)).toEqual([5000, 1]);
    });

    it("sends the character records as UTF-8 within the cap", async () => {
        const { fake, sync, characterList } = await boot();
        // Each character is about 3 bytes per Hangul character; both fit only when measured correctly.
        (characterList()[0] as any).desc = "가".repeat(1000);
        (characterList()[1] as any).desc = "가".repeat(1000);
        // Both writes queue their character's save (Phase 6 slice 5: no mark).
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
        expect(fake.data("characters", "a").desc).toHaveLength(1000);
    });
});

describe("plugin storage keys", () => {
    it("saves an own `__proto__` key of the plugin storage", async () => {
        const { fake, sync } = await boot();
        // `pluginStorage` has no watcher (Phase 4): the write goes through the store module, which
        // marks the record. Imported after `boot` so it shares that module graph.
        const store: typeof import("../pluginStorageStore.svelte") = await import("../pluginStorageStore.svelte");
        store.setSafeLocalPluginValue("ordinary", 1);
        store.setSafeLocalPluginValue("__proto__", { probe: "value" });
        await sync.flushResources();
        const saved = fake.data("pluginStorage", "main")._safeLocalPluginStorage;
        expect(Object.hasOwn(saved, "__proto__")).toBe(true);
        expect(saved.__proto__).toEqual({ probe: "value" });
        expect(saved.ordinary).toBe(1);
    });
});
