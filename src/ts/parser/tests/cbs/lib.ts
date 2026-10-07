import fc from "fast-check";
import { activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { assembleChats, chatList, setChatMeta } from "src/ts/storage/chatStore.svelte";
import type { Chat } from "src/ts/storage/database.svelte";

/** A CBS test's fixture character in the legacy shape: its chats on it (the test keeps the objects). */
export type MockedCharacter = { chaId: string; chatPage?: number; chats: Chat[]; defaultVariables?: string };

/**
 * Installs the test's fixture `characters` the way boot does (Phase 6 slice 9a: the chat module
 * checks a character through the records and holds the chats itself): copies of the characters
 * into the records, with the record fields `fields`, and the characters' chats into the chat module
 * (`assembleChats`). The fixture keeps its plain chat objects (the test's variable storage lives on
 * them); the readers resolve the selected character over the records and its chat in the chat module.
 * (Until Phase 6 slice 10 the fixture sat on the removed aggregate's mocked holder.)
 */
export const holdMockedChats = (characters: MockedCharacter[], fields: Record<string, unknown> = {}): void => {
    initializeRecords(
        takeRecordFields({
            ...fields,
            characters: characters.map(({ chats: _chats, ...rest }) => structuredClone(rest)),
        }),
    );
    assembleChats(
        characters,
        characters.flatMap((char) =>
            char.chats.map((chat) => ({ characterId: char.chaId, id: chat.id!, revision: "r1", data: chat })),
        ),
        characters.map((char) => ({
            characterId: char.chaId,
            revision: "o1",
            ids: char.chats.map((chat) => chat.id!),
        })),
    );
};

export const cbs = (op: string, ...args: string[]): string =>
    `{{${op}${args.length > 0 ? "::" : ""}${args.join("::")}}}`;

/**
 * Resets globalChatVariables and its default values,
 * as well as each fixture character's all scriptstates and their default values.
 */
export const resetChatVariables = (characters: MockedCharacter[]): void => {
    for (const char of characters) {
        for (const chat of char.chats) {
            // The fixture chat is plain data here (the module is the only writer in the app).
            (chat as { scriptstate?: Record<string, unknown> }).scriptstate = {};
        }
        // The chats `holdMockedChats` put into the chat module (Phase 6 slice 9a).
        for (const entry of chatList(char.chaId)) {
            setChatMeta({ chaId: char.chaId, chatId: entry.id }, { scriptstate: {} });
        }
        char.defaultVariables = "";
    }

    // The settings are read through the record views (Phase 6 slice 7): reset there.
    settings.globalChatVariables = {};
    activePreset.templateDefaultVariables = "";
};

export const trimVarPrefix = (key: unknown): string => {
    if (typeof key !== "string") {
        return "null";
    }

    if (key.startsWith("$")) {
        return key.slice(1);
    }

    if (key.startsWith("toggle_")) {
        return key.slice("toggle_".length);
    }

    return "null";
};

/** No hashes, colons, curly braces, line breaks */
export const validCBSArgRegExp = /^[^#:{}\r\n]+$/;
/** {@link validCBSArgRegExp `validCBSArgRegExp`} */
export const validCBSArgProp = fc.oneof(
    fc.stringMatching(validCBSArgRegExp),
    fc.string({ unit: "grapheme" }).filter((s) => validCBSArgRegExp.test(s)),
);
