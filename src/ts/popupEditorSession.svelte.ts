/** The full-page popup editor (`PopupEditor.svelte`), shared without importing the UI's module effects. */
export const popUpEditorStore = $state({
    open: false,
    value: "",
    mode: "default" as "default",
    language: "markdown" as string,
    sessionId: 0,
});

let nextPopupEditorSessionId = 0;
/**
 * The current session's id outside the reactive graph. An effect teardown (a field's `onDestroy`)
 * runs against the `$state` values from before a still-unflushed batch, so a field that opens the
 * popup and is destroyed in the same synchronous turn would read the previous `sessionId` there and
 * leave the popup open with no owner. The checks compare against this plain value instead.
 */
let currentSessionId = 0;

export function openPopupEditorSession(value: string, language = "markdown"): number {
    const sessionId = ++nextPopupEditorSessionId;
    currentSessionId = sessionId;
    popUpEditorStore.value = value;
    popUpEditorStore.mode = "default";
    popUpEditorStore.language = language;
    popUpEditorStore.sessionId = sessionId;
    popUpEditorStore.open = true;
    return sessionId;
}

export function isPopupEditorSessionCurrent(sessionId: number): boolean {
    return currentSessionId === sessionId;
}

export function closePopupEditorSession(sessionId: number): boolean {
    if (!isPopupEditorSessionCurrent(sessionId)) return false;
    popUpEditorStore.open = false;
    return true;
}
