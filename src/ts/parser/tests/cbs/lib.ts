import fc from "fast-check";
import { DBState } from "src/ts/stores.svelte";
import { activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { assembleChats, chatList, setChatMeta } from "src/ts/storage/chatStore.svelte";
import type { Chat } from "src/ts/storage/database.svelte";

type MockedCharacter = { chaId: string; chats: Chat[] };

/**
 * Installs the mocked `DBState.db.characters` the way boot does (Phase 6 slice 9a: the chat module
 * checks a character through the records and holds the chats itself): copies of the characters
 * into the records, with the record fields `fields`, and the characters' chats into the chat module
 * (`assembleChats`). The mock keeps its plain data; the readers resolve the selected character over
 * it and its chat in the chat module.
 */
export const holdMockedChats = (fields: Record<string, unknown> = {}): void => {
    const characters = DBState.db.characters as unknown as MockedCharacter[];
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
 * as well as each character's all scriptstates and their default values.
 */
export const resetChatVariables = (): void => {
    for (const char of DBState.db.characters) {
        for (const chat of char.chats) {
            // The mocked mirror is plain data here (the module is the only writer in the app).
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
