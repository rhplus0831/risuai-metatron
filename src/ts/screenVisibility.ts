import { writable } from "svelte/store";

/** Screens that replace the transcript, shared without importing the UI's module effects. */
export const settingsOpen = writable(false);
/**
 * The character grid layer (`/characters`). Settings win over it: open settings close the grid (`normalize` in
 * `src/ts/router/router.svelte.ts`), so one layer shows at a time.
 */
export const gridOpenStore = writable(false);
/** Full-page panels over the transcript (`BookmarkList`, `HypaV3Modal`). */
export const bookmarkListOpen = writable(false);
/**
 * The selected chat's memory panel: `App.svelte` mounts `StructuredMemoryPanel` or `HypaV3Modal` by
 * `settings.ui.memoryAlgorithmType`, and only once that chat is loaded.
 */
export const hypaV3ModalOpen = writable(false);
