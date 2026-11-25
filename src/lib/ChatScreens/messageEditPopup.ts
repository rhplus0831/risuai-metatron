/**
 * When `Chat.svelte`'s message editors open the popup editor by themselves, and when they keep a stable height
 * instead of growing with the text. These rules are pure: the row passes its state in. The setting only
 * decides the automatic popup: the inline editors keep their expand button and popup hotkey either way (the
 * `cardboard` theme's original editor is a plain textarea without them).
 */

export const MESSAGE_EDIT_POPUP_LENGTH_THRESHOLD = 600;

const MESSAGE_EDIT_POPUP_DISABLED_THEMES = new Set(["cardboard", "customHTML", "mobilechat"]);

export function shouldAutoPopupMessageEditor(input: {
    editMode: boolean;
    index: number;
    disableAutoPopupMessageEditor?: boolean | null;
}): boolean {
    return input.editMode && input.index >= 0 && input.disableAutoPopupMessageEditor !== true;
}

export function shouldAutoPopupTranslationEditor(input: {
    editTranslationMode: boolean;
    index: number;
    disableAutoPopupMessageEditor?: boolean | null;
    suppressAutoPopupTranslationEditor?: boolean | null;
}): boolean {
    return (
        input.editTranslationMode &&
        input.index >= 0 &&
        input.disableAutoPopupMessageEditor !== true &&
        input.suppressAutoPopupTranslationEditor !== true
    );
}

export function shouldUseStableMessageEditor(input: {
    editMode: boolean;
    index: number;
    message: string;
    theme?: string | null;
}): boolean {
    if (!input.editMode || input.index < 0) return false;
    if (MESSAGE_EDIT_POPUP_DISABLED_THEMES.has(input.theme ?? "")) return false;
    return input.message.includes("\n") || input.message.length > MESSAGE_EDIT_POPUP_LENGTH_THRESHOLD;
}
