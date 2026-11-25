/**
 * Whether the popup editor uses Monaco or a plain textarea. The choice belongs to the device (Monaco is
 * hard to use on a touch screen), so it lives in this browser's storage, not in the synced settings.
 * Without a stored choice a touch-first device starts on the plain textarea.
 */
const STORAGE_KEY = "risu-popup-editor-monaco";

/** The choice made on this page when storage refused it, so the editor keeps it until reload. */
let unsaved: boolean | null = null;

export function readPopupEditorMonaco(): boolean {
    if (unsaved !== null) return unsaved;
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === "true") return true;
        if (stored === "false") return false;
    } catch {}
    try {
        return !window.matchMedia("(pointer: coarse)").matches;
    } catch {
        return true;
    }
}

export function writePopupEditorMonaco(useMonaco: boolean) {
    try {
        localStorage.setItem(STORAGE_KEY, String(useMonaco));
        unsaved = null;
    } catch {
        unsaved = useMonaco;
    }
}
