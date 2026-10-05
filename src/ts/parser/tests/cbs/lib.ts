import fc from "fast-check";
import { DBState } from "src/ts/stores.svelte";
import { activePreset, settings } from "src/ts/storage/settingsViews.svelte";

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
