// The named `SettingsMenuIndex` values, apart from `stores.svelte.ts` so the route table
// (`router/routes.ts`) can read them without the store graph. `stores.svelte.ts` re-exports them.

/** The Model menu's Preset tab: the model preset (`ModelSettings.svelte`). */
export const MODEL_SETTINGS_MENU = 1;
/** The Model menu's API Keys tab: the provider default keys, the named keys, and their bindings (`ApiKeysSettings.svelte`). */
export const API_KEYS_SETTINGS_MENU = 17;
/** The Model menu's Connections tab: the model profile list and editor (`ModelProfilesSettings.svelte`). */
export const MODEL_PROFILES_SETTINGS_MENU = 18;
/** The settings page of the prompt preset (`PromptPresetSettings.svelte`); its template editor is menu 13. */
export const PROMPT_SETTINGS_MENU = 16;
/** The translator and its options (`TranslationSettings.svelte`); the UI language stays on menu 10. */
export const TRANSLATION_SETTINGS_MENU = 21;
