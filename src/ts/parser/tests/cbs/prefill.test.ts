import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { risuChatParser } from "../../parser.svelte";
import { selectChat } from "../../../storage/chatStore.svelte";
import { selectCharacter } from "../../../storage/selection.svelte";
import { installFlatDatabaseWithChats } from "../../../storage/tests/installFlatDatabase";
import { cbs } from "./lib";

beforeEach(() => {
    // Keep the tab parser's production deadline independent of test scheduling.
    vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
    vi.restoreAllMocks();
});

function selectModel(aiModel: string) {
    installFlatDatabaseWithChats({
        aiModel,
        enableCustomFlags: false,
        characters: [
            {
                chaId: "character",
                type: "character",
                name: "Character",
                chats: [{ id: "chat", message: [] }],
            },
        ],
    });
    selectCharacter("character");
    selectChat("character", "chat");
}

test("prefillsupported returns 1 for a Claude catalog model with hasPrefill", () => {
    selectModel("claude-opus-4-5-20251101");

    expect(risuChatParser(cbs("prefillsupported"))).toBe("1");
});

test("prefillsupported returns 0 for adaptive-only Claude 4.8 Opus", () => {
    selectModel("claude-opus-4-8");

    expect(risuChatParser(cbs("prefillsupported"))).toBe("0");
    expect(risuChatParser(cbs("prefill"))).toBe("0");
});

test("prefillsupported keeps the model-name prefix rule for non-Anthropic formats", () => {
    for (const [model, expected] of [
        ["gpt4o", "0"],
        ["claude-not-in-catalog", "1"],
    ]) {
        selectModel(model);

        expect(risuChatParser(cbs("prefillsupported")), model).toBe(expected);
    }
});
