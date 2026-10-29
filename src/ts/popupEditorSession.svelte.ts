/** The full-page popup editor (`PopupEditor.svelte`), shared without importing the UI's module effects. */
export const popUpEditorStore = $state({
    open: false,
    value: "",
    mode: "default" as "default",
    language: "markdown" as string,
    sessionId: 0,
});

let nextPopupEditorSessionId = 0;

export function openPopupEditorSession(value: string, language = "markdown"): number {
    const sessionId = ++nextPopupEditorSessionId;
    popUpEditorStore.value = value;
    popUpEditorStore.mode = "default";
    popUpEditorStore.language = language;
    popUpEditorStore.sessionId = sessionId;
    popUpEditorStore.open = true;
    return sessionId;
}

export function isPopupEditorSessionCurrent(sessionId: number): boolean {
    return popUpEditorStore.sessionId === sessionId;
}

export function closePopupEditorSession(sessionId: number): boolean {
    if (!isPopupEditorSessionCurrent(sessionId)) return false;
    popUpEditorStore.open = false;
    return true;
}
