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
/** The memory algorithm and its options (`MemorySettings.svelte`); the HypaV3 modal's settings link opens it. */
export const MEMORY_SETTINGS_MENU = 2;
/** The image generation provider and its options (`ImageGenerationSettings.svelte`). */
export const IMAGE_GENERATION_SETTINGS_MENU = 19;
/** TTS keys and the emotion image method (`VoiceSettings.svelte`). */
export const VOICE_SETTINGS_MENU = 20;
/** The translator and its options (`TranslationSettings.svelte`); the UI language stays on menu 10. */
export const TRANSLATION_SETTINGS_MENU = 21;
