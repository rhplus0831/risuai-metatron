import { writable } from "svelte/store";

/** Screens that replace the transcript, shared without importing the UI's module effects. */
export const settingsOpen = writable(false);
export const gridOpenStore = writable(false);
/** Full-page panels over the transcript (`BookmarkList`, `HypaV3Modal`). */
export const bookmarkListOpen = writable(false);
export const hypaV3ModalOpen = writable(false);
