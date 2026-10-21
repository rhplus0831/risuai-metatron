import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `createSimpleCharacter`: a character's asset lists are frozen values replaced whole, so the
// simple-character argument a mounted chat row keeps must read the character's current lists, not
// the list captured when the row was mounted. The getters read the live character on every access
// and are tracked like any wrapper read; the argument still serializes with both lists. The module
// graph beyond the records is mocked as in `stores.importOrder.test.ts`.

vi.mock("./storage/characterStore.svelte", () => ({ selectedCharacter: () => null }));
vi.mock("./storage/chatStore.svelte", () => ({
    selectedChat: () => null,
    currentChatRef: () => null,
    findChat: () => undefined,
    heldChatRevision: () => null,
    isMessageLocked: () => false,
}));
vi.mock("./storage/settingsViews.svelte", () => ({
    settings: { modules: [], enabledModules: [] },
    activePreset: { id: "preset", moduleIntergration: "" },
    activePersona: { id: "persona" },
}));
vi.mock("./process/modules", () => ({ moduleUpdate: vi.fn() }));
vi.mock("./parser/parser.svelte", () => ({}));
vi.mock("./alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lang", () => ({ language: {} }));
vi.mock("./network/generationJobs", () => ({ generationClientId: () => "client" }));
vi.mock("./plugins/apiV3/pluginContext", () => ({ capturePluginContext: () => undefined, invokeHook: vi.fn() }));
vi.mock("./plugins/pluginHooks", () => ({ pluginHooks: {} }));
vi.mock("./storage/serverAuth", () => ({ authFetch: vi.fn() }));
vi.mock("./storage/resourceClient", () => ({ epochMismatch: () => false, getResourceEpoch: () => "" }));
vi.mock("./util", () => ({ checkPersonaBinded: () => undefined }));

import { createSimpleCharacter } from "./stores.svelte";
import {
    initializeRecords,
    isFrozenAssetList,
    resetRecords,
    setCharacterWriteListener,
    setRecordWriteListener,
    trackedCharacters,
} from "./storage/records.svelte";
import { createProbe } from "./storage/tests/reactiveProbe.svelte";

type Asset = [string, string, string];
const asset = (name: string): Asset => [name, `assets/${name}.png`, "png"];
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

beforeEach(() => {
    resetRecords();
    setRecordWriteListener(() => {});
    setCharacterWriteListener({ character: () => {}, membership: () => {} });
});
afterEach(() => resetRecords());

describe("createSimpleCharacter", () => {
    it("reads the character's current asset lists on every access, tracked, and serializes them", () => {
        initializeRecords({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    customscript: [],
                    additionalAssets: [asset("cat")],
                    emotionImages: [["joy", "emotions/joy.png"]],
                },
            ],
        });
        const character = trackedCharacters<any[]>()![0];
        const simple = createSimpleCharacter(character)!;
        expect(simple.type).toBe("simple");
        expect(simple.chaId).toBe("c");
        expect(isFrozenAssetList(simple.additionalAssets)).toBe(true);
        expect(simple.additionalAssets).toBe(character.additionalAssets);
        expect(plain(simple.emotionImages)).toEqual([["joy", "emotions/joy.png"]]);
        const probe = createProbe(() => simple.additionalAssets);
        try {
            expect(probe.seen).toHaveLength(1);
            character.additionalAssets = [asset("cat"), asset("dog")];
            expect(simple.additionalAssets).toBe(character.additionalAssets);
            expect(plain(simple.additionalAssets)).toEqual([asset("cat"), asset("dog")]);
            expect(plain(probe.derived())).toEqual([asset("cat"), asset("dog")]);
            character.emotionImages = [...character.emotionImages, ["calm", "emotions/calm.png"]];
            expect(plain(simple.emotionImages)).toEqual([
                ["joy", "emotions/joy.png"],
                ["calm", "emotions/calm.png"],
            ]);
            expect(plain(simple)).toMatchObject({
                type: "simple",
                chaId: "c",
                additionalAssets: [asset("cat"), asset("dog")],
                emotionImages: [
                    ["joy", "emotions/joy.png"],
                    ["calm", "emotions/calm.png"],
                ],
            });
            expect({ ...simple }.additionalAssets).toBe(character.additionalAssets);
        } finally {
            probe.dispose();
        }
        expect(createSimpleCharacter(null)).toBeNull();
        expect(createSimpleCharacter({ type: "group" } as any)).toBeNull();
    });
});
