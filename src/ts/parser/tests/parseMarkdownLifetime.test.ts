import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/parser/transformClient", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/parser/transformClient")>()),
    captureTransform: vi.fn(() => null),
    serverProcessScript: vi.fn(async (_char: unknown, data: string) => ({ data, emoChanged: false })),
}));

import { getFileSrc } from "src/ts/globalApi.svelte";
import * as inlays from "src/ts/process/files/inlays";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { ParseMarkdown } from "../parser.svelte";
import { isTransient } from "../renderErrors";
import { captureTransform, serverProcessScript, type CapturedTransform } from "../transformClient";

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFileSrc)
        .mockReset()
        .mockImplementation(async (path) => path);
    vi.spyOn(inlays, "getInlayMedia").mockResolvedValue(null);
    installFlatDatabase({
        legacyMediaFindings: false,
        hideAllImages: false,
        enabledModules: [],
        modules: [],
        characters: [
            { chaId: "c", type: "character", name: "C", additionalAssets: [], emotionImages: [], customscript: [] },
        ],
    });
    selectCharacter("c");
    flushSync();
});

afterEach(() => vi.restoreAllMocks());

describe("ParseMarkdown render lifetime", () => {
    it("marks a rejected inlay record read as transient", async () => {
        const failure = new Error("Inlay record unavailable");
        vi.mocked(inlays.getInlayMedia).mockRejectedValueOnce(failure);
        const parsing = ParseMarkdown("{{inlay::missing-record}}", "c", "normal", -1, {}, null);
        await expect(parsing).rejects.toSatisfy(isTransient);
        expect(inlays.getInlayMedia).toHaveBeenCalledExactlyOnceWith("missing-record");
        expect(getFileSrc).toHaveBeenCalledTimes(0);
        expect(serverProcessScript).toHaveBeenCalledTimes(0);
    });

    it.each(["additional asset", "inlay image"])(
        "marks a rejected %s file source read as transient",
        async (source) => {
            const asset =
                source === "additional asset" ? "assets/rejected-additional.png" : "assets/rejected-inlay.png";
            const char = selectedCharacter();
            if (char?.type !== "character") throw new Error("Missing character fixture");
            char.additionalAssets = [["picture", asset, "png"]];
            vi.mocked(inlays.getInlayMedia).mockResolvedValueOnce({ type: "image", asset });
            vi.mocked(getFileSrc).mockRejectedValueOnce(new TypeError("Asset unavailable"));
            const macro = source === "additional asset" ? "{{img::picture}}" : "{{inlay::picture}}";
            await expect(ParseMarkdown(macro, char, "normal", -1, {}, null)).rejects.toSatisfy(isTransient);
            expect(getFileSrc).toHaveBeenCalledExactlyOnceWith(asset);
            expect(inlays.getInlayMedia).toHaveBeenCalledTimes(source === "inlay image" ? 1 : 0);
            expect(serverProcessScript).toHaveBeenCalledTimes(0);
        },
    );

    it("stops before the script stage when aborted in the first asset read", async () => {
        const char = selectedCharacter();
        if (char?.type !== "character") throw new Error("Missing character fixture");
        char.additionalAssets = [["picture", "assets/abort-first-pass.png", "png"]];
        const controller = new AbortController();
        vi.mocked(getFileSrc).mockImplementationOnce(async () => {
            controller.abort();
            return "assets/abort-first-pass.png";
        });
        const transform: CapturedTransform = {
            chatRef: { chaId: "c", chatId: "chat-c" },
            context: {
                characterId: "c",
                chatId: "chat-c",
                presetId: "preset",
                modelPresetId: "model-preset",
                personaId: "persona",
                selectedPersonaId: "persona",
            },
            pluginContext: undefined,
            generation: 0,
            cacheGeneration: 0,
            noCache: false,
            locked: false,
            installVersion: 0,
            hadUnackedWork: false,
            mixedDisplay: false,
        };
        await ParseMarkdown("{{img::picture}}", char, "normal", -1, {}, transform, controller.signal).catch(
            () => undefined,
        );
        expect(getFileSrc).toHaveBeenCalledExactlyOnceWith("assets/abort-first-pass.png");
        expect(captureTransform).toHaveBeenCalledTimes(0);
        expect(serverProcessScript).toHaveBeenCalledTimes(0);
        expect(inlays.getInlayMedia).toHaveBeenCalledTimes(0);
    });
});
