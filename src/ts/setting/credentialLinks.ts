import { tick } from "svelte";
import { language } from "src/lang";
import type { SecretPath } from "../../../shared/llmSecrets.ts";
import { settings } from "../storage/settingsViews.svelte";
import {
    API_KEYS_SETTINGS_MENU,
    IMAGE_GENERATION_SETTINGS_MENU,
    MEMORY_SETTINGS_MENU,
    SettingsMenuIndex,
    settingsOpen,
} from "../stores.svelte";

/**
 * A credential shared by features has one editing place, its owning page; other places show its status
 * and a link (`src/lib/Setting/CredentialStatusLink.svelte`). Owners may hide fields by condition:
 * the API Keys tab's provider-default fields follow the model slots and image provider in use;
 * Image Generation shows the NovelAI key for its NovelAI provider. A link asks the owner to show
 * the field on its next mount and scrolls to it.
 */

export type SharedCredential = "openAIKey" | "google" | "NAIApiKey" | "supaMemoryKey";

interface CredentialOwner {
    /** The write-only `llmSecrets` path; or, for a plain `secrets` field, its current value. */
    path?: SecretPath;
    value?: () => unknown;
    menu: number;
    /** The owning page, as the link names it. */
    place: () => string;
}

/**
 * One editing place per shared key: `openAIKey`/`google` on API Keys, `NAIApiKey` in Image Generation's
 * NovelAI block, and `supaMemoryKey` on Memory.
 */
export const CREDENTIAL_OWNERS: Record<SharedCredential, CredentialOwner> = {
    openAIKey: {
        path: { kind: "flat", field: "openAIKey" },
        menu: API_KEYS_SETTINGS_MENU,
        place: () => `${language.model} › ${language.apiKeys}`,
    },
    google: {
        path: { kind: "nested", field: "google" },
        menu: API_KEYS_SETTINGS_MENU,
        place: () => `${language.model} › ${language.apiKeys}`,
    },
    NAIApiKey: {
        value: () => settings.secrets.NAIApiKey,
        menu: IMAGE_GENERATION_SETTINGS_MENU,
        place: () => `${language.imageGeneration} › Novel AI`,
    },
    supaMemoryKey: {
        path: { kind: "flat", field: "supaMemoryKey" },
        menu: MEMORY_SETTINGS_MENU,
        place: () => language.memorySettings,
    },
};

/** The credential a link asked its owner to show, until that owner's next mount takes it. */
let requested: SharedCredential | null = null;

/** Open the credential's owning page, requesting its field even when its usual condition would hide it. */
export function openCredentialOwner(credential: SharedCredential): void {
    requested = credential;
    settingsOpen.set(true);
    SettingsMenuIndex.set(CREDENTIAL_OWNERS[credential].menu);
}

/**
 * Whether a link asked for this credential; the request is used up. An owner calls it once at mount and
 * shows the field even if normally hidden for the rest of that mount, then `scrollToCredential` after it rendered.
 */
export function takeCredentialRequest(credential: SharedCredential): boolean {
    if (requested !== credential) return false;
    requested = null;
    return true;
}

/**
 * Scroll the owner's field (its `data-credential` wrapper) into view once it rendered, and move the focus
 * into its first input, textarea, or select, so focus follows the link to the field it opened.
 */
export async function scrollToCredential(credential: SharedCredential): Promise<void> {
    await tick();
    const field = document.querySelector<HTMLElement>(`[data-credential="${credential}"]`);
    if (!field) return;
    field.scrollIntoView({ block: "center" });
    field.querySelector<HTMLElement>("input, textarea, select")?.focus({ preventScroll: true });
}
