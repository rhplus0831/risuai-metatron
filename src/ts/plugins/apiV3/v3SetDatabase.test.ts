// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

// The plugin `setDatabase` host setter over the settings records. A forwarded key of
// `allowedDbKeys` (`temperature`, `maxContext`, ...) lands in the preset this client has selected.
// When the object also carries `plugins`, the install prompt is awaited before anything is
// assigned, and every field lands in the presets selected when the call started, whatever the
// user selects while the prompt is open.

const captured = vi.hoisted(() => ({
    api: null as null | Record<string, any>,
    confirm: [] as ((v: boolean) => void)[],
}));

vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(api: Record<string, any>) {
            captured.api = api;
        }
        run() {}
    },
}));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: vi.fn(() => new Promise<boolean>((resolve) => captured.confirm.push(resolve))),
    }),
);
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string) => text),
    hasher: vi.fn(async () => "host-setter-script"),
}));
vi.mock("src/ts/process/index.svelte", () => ({
    sendChat: vi.fn(),
}));

import { llmSecretState, setMaskedSecrets } from "src/ts/storage/llmSecrets.svelte";
import { maskLlmSecrets } from "../../../../shared/llmSecrets.ts";
import { changeToModelPreset, changeToPreset, removeModelPreset } from "src/ts/storage/presets.svelte";
import { selection, selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import { activeMainProfile, activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets.ts";
import { assembleChats, seedChats } from "src/ts/storage/chatStore.svelte";
import { MutationTargetGoneError } from "src/ts/storage/mutationValidation";
import * as resourceClient from "src/ts/storage/resourceClient";
import { executePluginV3 } from "./v3.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { seedPluginPermissions } from "./permissionStore";

const preset = (id: string) => settings.presets.find((entry: { id: string }) => entry.id === id) as any;
/** The main profile of the model preset `id`: `m-a` or `m-b`. */
const mainProfile = (id: string) =>
    settings.modelProfiles.find((entry: { id: string }) => entry.id === `m-${id}`) as any;

beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectModelPreset("");
    // The write-only `llmSecrets` state: an empty masked record and no queued credential write.
    llmSecretState.queue.splice(0);
    setMaskedSecrets(maskLlmSecrets({}));
    captured.confirm.length = 0;
    // The records installed as the app installs them (there is no whole-database aggregate).
    installFlatDatabase({
        characters: [],
        plugins: [],
        botPresets: [
            { id: "a", name: "A", temperature: 80 },
            { id: "b", name: "B", temperature: 50 },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "A", mainSlot: { profileId: "m-a" } }, { id: "a" }),
            normalizeModelPreset({ name: "B", mainSlot: { profileId: "m-b" } }, { id: "b" }),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "m-a", name: "A", maxContext: 4000 }),
            normalizeModelProfile({ id: "m-b", name: "B", maxContext: 5000 }),
        ],
    });
    if (!captured.api) {
        await executePluginV3({ name: "host-setter-test", script: "", version: "3.0" } as any);
    }
    expect(captured.api?.setDatabase).toBeTypeOf("function");
});

describe("the plugin setDatabase host setter", () => {
    it("round-trips 1,000 existing characters with a linear number of list lookup visits", async () => {
        const characters = Array.from({ length: 1_000 }, (_, i) => ({
            chaId: `character-${i}`,
            name: `Character ${i}`,
            type: "character",
        }));
        installFlatDatabase({ characters });
        seedPluginPermissions({
            id: "main",
            revision: "00000000-0000-4000-8000-000000000000:1:1",
            data: {
                grants: { "host-setter-script_db": true },
                lastGrantTime: { "host-setter-test_db_lastGrantTime": Number.MAX_SAFE_INTEGER },
            },
        });
        const snapshot = await captured.api!.getDatabase(["characters"], { chats: "summaries" });
        const incoming = snapshot.characters
            .reverse()
            .map((entry: any) => ({ ...entry, name: `Updated ${entry.chaId}` }));
        const list = characterList();
        const findIndex = Array.prototype.findIndex;
        let lookupVisits = 0;
        const spy = vi.spyOn(Array.prototype, "findIndex").mockImplementation(function (predicate, thisArg) {
            const counted = this === list;
            return findIndex.call(this, (value, index, array) => {
                if (counted) lookupVisits += 1;
                return predicate.call(thisArg, value, index, array);
            });
        });
        try {
            await captured.api!.setDatabase({ characters: incoming });
        } finally {
            spy.mockRestore();
        }

        expect(characterList().map((entry) => [entry.chaId, entry.name])).toEqual(
            characters.map((entry) => [entry.chaId, `Updated ${entry.chaId}`]),
        );
        // Allow several linear passes, while rejecting a list search for every incoming character.
        expect(lookupVisits).toBeLessThanOrEqual(characters.length * 10);
    });

    it("lands a forwarded key in the selected preset of its owner and leaves the others alone", async () => {
        // `temperature` is the prompt preset's, `maxContext` the model preset's main profile's.
        await captured.api!.setDatabase({ temperature: 91, maxContext: 9100 });
        expect(preset("a")).toMatchObject({ temperature: 91 });
        expect(preset("b")).toMatchObject({ temperature: 50 });
        expect(mainProfile("a")).toMatchObject({ maxContext: 9100 });
        expect(mainProfile("b")).toMatchObject({ maxContext: 5000 });
        expect(activePreset.temperature).toBe(91);
        expect(activeMainProfile.maxContext).toBe(9100);

        changeToPreset("b");
        await captured.api!.setDatabase({ temperature: 92, maxContext: 9200 });
        expect(preset("b").temperature).toBe(92);
        expect(preset("a").temperature).toBe(91);
        // The model preset selection did not move with the prompt preset's.
        expect(mainProfile("a").maxContext).toBe(9200);
        expect(mainProfile("b").maxContext).toBe(5000);
        changeToModelPreset("b");
        await captured.api!.setDatabase({ maxContext: 9300 });
        expect(mainProfile("b").maxContext).toBe(9300);
        expect(mainProfile("a").maxContext).toBe(9200);
    });

    it("awaits the plugin install prompt before assigning anything, and every field lands in the presets selected at the call", async () => {
        const pending = captured.api!.setDatabase({
            temperature: 91,
            plugins: [{ name: "installed-via-plugin", script: "", version: "3.0" }],
            maxContext: 9100,
        });
        // The prompt is open: nothing has been assigned, whatever the key order.
        await Promise.resolve();
        expect(captured.confirm).toHaveLength(1);
        expect(preset("a")).toMatchObject({ temperature: 80 });
        expect(mainProfile("a")).toMatchObject({ maxContext: 4000 });

        // The user switches both presets while the prompt is open, then accepts.
        changeToPreset("b");
        changeToModelPreset("b");
        captured.confirm[0](true);
        await pending;

        expect(preset("a")).toMatchObject({ temperature: 91 });
        expect(preset("b")).toMatchObject({ temperature: 50 });
        expect(mainProfile("a")).toMatchObject({ maxContext: 9100 });
        expect(mainProfile("b")).toMatchObject({ maxContext: 5000 });
        expect(settings.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(["installed-via-plugin"]);
    });

    it("refuses the whole call when the selected model preset is deleted during plugin consent", async () => {
        const theme = settings.ui.theme;
        const presets = JSON.parse(JSON.stringify(settings.presets));
        const survivingModels = JSON.parse(JSON.stringify(settings.modelPresets.filter((entry) => entry.id === "b")));
        const profiles = JSON.parse(JSON.stringify(settings.modelProfiles));
        const pending = captured.api!.setDatabase({
            theme: "from-plugin",
            plugins: [{ name: "installed-via-plugin", script: "", version: "3.0" }],
            temperature: 91,
            maxContext: 9100,
        });
        const rejected = expect(pending).rejects.toBeInstanceOf(MutationTargetGoneError);
        await Promise.resolve();
        expect(captured.confirm).toHaveLength(1);

        expect(removeModelPreset("a")).toBe(true);
        expect(selection.modelPresetId).toBe("b");
        captured.confirm[0](true);
        await rejected;

        expect(settings.presets).toEqual(presets);
        expect(settings.modelPresets).toEqual(survivingModels);
        expect(settings.modelProfiles).toEqual(profiles);
        expect(settings.ui.theme).toBe(theme);
        expect(settings.plugins).toEqual([]);
    });

    it("accepts a call without preset fields when the selected model preset is deleted during plugin consent", async () => {
        const plugin = { name: "installed-via-plugin", script: "", version: "3.0" };
        const pending = captured.api!.setDatabase({ theme: "from-plugin", plugins: [plugin] });
        await Promise.resolve();
        expect(captured.confirm).toHaveLength(1);

        expect(removeModelPreset("a")).toBe(true);
        expect(selection.modelPresetId).toBe("b");
        captured.confirm[0](true);
        await expect(pending).resolves.toBeUndefined();

        expect(settings.ui.theme).toBe("from-plugin");
        expect(settings.plugins).toEqual([plugin]);
    });

    it("setDatabaseLite writes to the presets selected at call start after chat loading and a selection change", async () => {
        vi.useFakeTimers();
        const chat = { id: "chat", name: "Chat", message: [], note: "", localLore: [], fmIndex: -1 };
        const character = { chaId: "loading", name: "Loading", type: "character" };
        const revision = "00000000-0000-4000-8000-000000000000:1:1";
        const summaries = [{ characterId: "loading", id: chat.id, revision, name: chat.name, fmIndex: -1 }];
        const orders = [{ characterId: "loading", revision, ids: [chat.id] }];
        let signalRead!: () => void;
        let resumeRead!: () => void;
        const entered = new Promise<void>((resolve) => (signalRead = resolve));
        const release = new Promise<void>((resolve) => (resumeRead = resolve));
        const read = vi.spyOn(resourceClient, "readRefs").mockImplementation(async () => {
            signalRead();
            await release;
            return {
                epoch: "",
                items: [],
                chats: [{ characterId: "loading", id: chat.id, revision, data: chat }],
            };
        });
        let pending: Promise<void> | undefined;
        try {
            installFlatDatabase({
                characters: [character],
                botPresets: [
                    { id: "a", name: "A", temperature: 80 },
                    { id: "b", name: "B", temperature: 50 },
                ],
                modelPresets: [
                    normalizeModelPreset({ mainSlot: { profileId: "m-a" } }, { id: "a" }),
                    normalizeModelPreset({ mainSlot: { profileId: "m-b" } }, { id: "b" }),
                ],
                modelProfiles: [
                    normalizeModelProfile({ id: "m-a", maxContext: 4000 }),
                    normalizeModelProfile({ id: "m-b", maxContext: 5000 }),
                ],
            });
            assembleChats([character], summaries, orders);
            seedChats(summaries, orders);
            pending = captured.api!.setDatabaseLite({
                characters: [{ ...character, name: "Updated", chats: [chat] }],
                temperature: 91,
                maxContext: 9100,
            });
            await entered;
            expect(preset("a").temperature).toBe(80);
            expect(mainProfile("a").maxContext).toBe(4000);
            changeToPreset("b");
            changeToModelPreset("b");
            resumeRead();
            await pending;

            expect(preset("a").temperature).toBe(91);
            expect(preset("b").temperature).toBe(50);
            expect(mainProfile("a").maxContext).toBe(9100);
            expect(mainProfile("b").maxContext).toBe(5000);
            expect(characterList()[0].name).toBe("Updated");
        } finally {
            resumeRead();
            if (pending) await Promise.allSettled([pending]);
            read.mockRestore();
            assembleChats([], [], []);
            vi.useRealTimers();
        }
    });
});
