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
