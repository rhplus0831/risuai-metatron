// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({
        holdFileSrc: () => ({ src: Promise.resolve(""), release: () => {} }),
        getFileSrc: vi.fn(async () => ""),
    }),
);
vi.mock("src/ts/characters", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/characters")>()),
    getCharImage: vi.fn(async () => ""),
}));
vi.mock("src/ts/tokenizer", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/tokenizer")>()),
    countTokens: vi.fn(async () => 0),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lib/SideBars/LoreBook/LoreBookSetting.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/RegexList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/TriggerList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Toggles.svelte", () => ({ default: () => {} }));

import { CharConfigSubMenu } from "src/ts/stores.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import CharConfig from "./CharConfig.svelte";

let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify([]))),
    );
    installFlatDatabaseWithChats({
        voicevoxUrl: "http://voicevox.test",
        characters: [
            {
                chaId: "voicevox-character",
                type: "character",
                name: "Voice",
                desc: "",
                firstMessage: "",
                ttsMode: "VOICEVOX",
                voicevoxConfig: { SPEED_SCALE: 1, PITCH_SCALE: 0, VOLUME_SCALE: 1, INTONATION_SCALE: 1 },
                chatPage: 0,
                chats: [{ id: "voice-chat", name: "Chat", note: "", localLore: [], message: [] }],
            },
        ],
    });
    selectCharacter("voicevox-character");
    CharConfigSubMenu.set(5);
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(CharConfig, { target });
    flushSync();
});

afterEach(async () => {
    await unmount(instance);
    target.remove();
    CharConfigSubMenu.set(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it.each([
    ["Speed scale", "SPEED_SCALE", 1, 1.4],
    ["Pitch scale", "PITCH_SCALE", 0, -0.25],
    ["Volume scale", "VOLUME_SCALE", 1, 0.6],
    ["Intonation scale", "INTONATION_SCALE", 1, 1.2],
] as const)("stores finite %s input and restores its default on an empty change", (label, key, fallback, finite) => {
    const caption = [...target.querySelectorAll("span")].find((node) => node.textContent === label)!;
    const input = caption.nextElementSibling as HTMLInputElement;
    expect(input.type).toBe("number");

    for (const [typed, expected] of [
        [String(finite), finite],
        ["", fallback],
    ] as const) {
        input.value = typed;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        const config = selectedCharacter()!.voicevoxConfig;
        expect(config[key]).toBe(expected);
        expect(JSON.parse(JSON.stringify(config))[key]).toBe(expected);
        expect(input.value).toBe(String(expected));
    }
});
