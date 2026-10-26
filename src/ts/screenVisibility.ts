import { writable } from "svelte/store";

/** Screens that replace the transcript, shared without importing the UI's module effects. */
export const settingsOpen = writable(false);
export const gridOpenStore = writable(false);
