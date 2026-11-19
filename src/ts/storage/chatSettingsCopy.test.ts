// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import { chatSettingsCopy, SETTINGS_COPY_CHAT_FIELDS } from "./chatSettingsCopy";

const lore = { key: "castle", comment: "Castle", content: "A castle.", mode: "normal", insertorder: 100 };

/** A chat with a conversation behind it: every kind of field the copy has to decide. */
const source = {
    id: "source",
    name: "Source",
    pinned: true,
    lastDate: 1,
    message: [{ role: "user", data: "hello", chatId: "m1" }],
    note: "Stay in character.",
    localLore: [lore],
    loreOverrides: [{ entry: { id: "l1" }, off: true }],
    modules: ["mod-1"],
    GLGlobalVariables: { toggle_mood: "1", toggle_title: "", score: "7" },
    togglePresetId: "tp-1",
    oocToggles: { mood: "0" },
    bindedPersona: "u1",
    promptPresetId: "p1",
    modelPresetId: "m1",
    bindingReview: true,
    draftHookId: "hook-1",
    translatorPresetId: "tr-1",
    autoTranslate: true,
    bilingualSentences: 2,
    memoryEnabled: false,
    memoryMode: "structuredMemory",
    memoryPresetId: "mp-1",
    memoryProfileId: "prof-1",
    memoryTrimAck: 3,
    loreBudgetWarnOff: true,
    structuredMemoryLanguage: "ko",
    folderId: "f1",
    fmIndex: 2,
    scriptstate: { $hp: 10 },
    hypaV3Data: { summaries: [] },
    lastMemory: "summary",
    bookmarks: ["m1"],
    bookmarkNames: { m1: "Start" },
    toolCalls: {},
    suggestMessages: ["Go on"],
    oocLog: { exchanges: [] },
    oocSegment: { id: "s1" },
} as unknown as Chat;

describe("chatSettingsCopy", () => {
    it("keeps the setup and leaves out the conversation, its variables, and its memory data", () => {
        expect(chatSettingsCopy(source, "Source (Settings)", "copy")).toEqual({
            id: "copy",
            name: "Source (Settings)",
            message: [],
            note: "Stay in character.",
            localLore: [lore],
            loreOverrides: [{ entry: { id: "l1" }, off: true }],
            modules: ["mod-1"],
            GLGlobalVariables: { toggle_mood: "1", toggle_title: "" },
            togglePresetId: "tp-1",
            oocToggles: { mood: "0" },
            bindedPersona: "u1",
            promptPresetId: "p1",
            modelPresetId: "m1",
            bindingReview: true,
            draftHookId: "hook-1",
            translatorPresetId: "tr-1",
            autoTranslate: true,
            bilingualSentences: 2,
            memoryEnabled: false,
            memoryMode: "structuredMemory",
            memoryPresetId: "mp-1",
            memoryProfileId: "prof-1",
            loreBudgetWarnOff: true,
            structuredMemoryLanguage: "ko",
            folderId: "f1",
            fmIndex: 2,
        });
    });

    it("leaves a variable map without prompt toggles out, and starts a bare source with an empty note and lore", () => {
        const bare = { name: "Bare", message: [], GLGlobalVariables: { score: "7" } } as unknown as Chat;
        expect(chatSettingsCopy(bare, "Bare (Settings)", "copy")).toEqual({
            id: "copy",
            name: "Bare (Settings)",
            message: [],
            note: "",
            localLore: [],
        });
    });

    it("carries no field the source does not hold, whatever the table says", () => {
        const copy = chatSettingsCopy({ name: "N", note: "", localLore: [], message: [] }, "N (Settings)", "copy");
        const copied = Object.keys(SETTINGS_COPY_CHAT_FIELDS).filter((key) => Object.hasOwn(copy, key));
        expect(copied.sort()).toEqual(["id", "localLore", "name", "note"]);
    });
});
