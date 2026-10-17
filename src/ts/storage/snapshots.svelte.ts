import { untrack } from "svelte";
import type { character, Database, groupChat } from "../../../shared/database.ts";
import { plainClone } from "../../../shared/presets.ts";
import { SECTION_FIELDS } from "../../../shared/sections.ts";
import { characterList } from "./characterStore.svelte";
import { withChatsCopy } from "./chatStore.svelte";
import {
    isForwardedPresetRoot,
    isSettingsRootKey,
    readPresetFieldOf,
    readSettingsRoot,
    type PresetScope,
    SETTINGS_ROOT_KEYS,
    selectedLoreBookPage,
    selectedPersonaIndex,
    selectedPresetIndex,
} from "./settingsViews.svelte";

/**
 * The snapshot builders (Phase 6 slice 10): the consumers that need the legacy whole-database shape
 * (the plugin `getDatabase`, the settings report, the backup's asset inventory) get a fresh plain
 * object built from the records when they ask. None is reactive, cached, or written back: a builder
 * reads its records once, untracked, and copies every value it returns.
 */

/**
 * The legacy flat shape of the settings, as the removed facade answered a snapshot of it: every
 * root name the views serve (`SETTINGS_ROOT_KEYS`) and the three per-tab selection indexes. Each value is a plain copy (`undefined` kept as an
 * own key); the characters are not part of it. User-keyed maps go through JSON, so an own
 * `__proto__` key stays data.
 */
export function rootSnapshot(): Record<string, unknown> {
    return untrack(() => {
        const snapshot: Record<string, unknown> = {};
        for (const key of SETTINGS_ROOT_KEYS) {
            snapshot[key] = plainClone(readSettingsRoot(key));
        }
        snapshot.botPresetsId = selectedPresetIndex();
        snapshot.selectedPersona = selectedPersonaIndex();
        snapshot.loreBookPage = selectedLoreBookPage();
        return snapshot;
    });
}

/**
 * The plugin `getDatabase` subset (`allowedDbKeys`, filtered by the caller): `characters` in the
 * legacy shape with their chats (`withChatsCopy`: the caller loads and pins them first, and calls
 * this in the same synchronous pass), `selectedPersona` as the selected persona's index, and every
 * other key as its view reads it. With `scope` (a hook's captured presets, checked by the caller), a
 * preset field is its owning preset's of that pair. `pluginCustomStorage`, a user-keyed map, is copied through JSON.
 */
export function buildDatabaseSubset(keys: readonly string[], scope: PresetScope | null): Record<string, unknown> {
    return untrack(() => {
        const subset: Record<string, unknown> = {};
        for (const key of keys) {
            if (key === "characters") {
                subset[key] = characterList().map((character) => withChatsCopy($state.snapshot(character)));
                continue;
            }
            if (key === "selectedPersona") {
                subset[key] = selectedPersonaIndex();
                continue;
            }
            const value =
                scope !== null && isForwardedPresetRoot(key)
                    ? readPresetFieldOf(scope, key)
                    : isSettingsRootKey(key)
                      ? readSettingsRoot(key)
                      : undefined;
            subset[key] = key === "pluginCustomStorage" ? plainClone(value) : $state.snapshot(value);
        }
        return subset;
    });
}

/** The keys the settings report leaves out, besides the `llmSecrets` fields and the credential-like names. */
const REPORT_REMOVED_KEYS: ReadonlySet<string> = new Set([
    "characters",
    "irisDialogue",
    "googleSearchCredentials",
    "pluginCustomStorage",
    "loreBook",
    "plugins",
    "personas",
    "username",
    "userIcon",
    "userNote",
    "modules",
    "enabledModules",
    "botPresets",
    "modelPresets",
    "modelProfiles",
    "characterOrder",
    "webUiUrl",
    "hordeConfig",
    "novelai",
    "koboldURL",
    "ooba",
    "ainconfig",
    "personaPrompt",
    "promptTemplate",
    "deeplOptions",
    "google",
    "customPromptTemplateToggle",
    "globalChatVariables",
    "togglePresets",
    "comfyConfig",
    "comfyUiUrl",
    "translatorPrompt",
    "translatorPresets",
    "translatorPresetId",
    "customModels",
    "credentials",
    "mcpURLs",
    "authRefreshes",
]);

const llmSecretFields: ReadonlySet<string> = new Set(SECTION_FIELDS.llmSecrets as readonly string[]);

/**
 * The settings report for a bug report: the legacy flat settings (`rootSnapshot`) without the
 * personal and bulky keys (`REPORT_REMOVED_KEYS`), every `llmSecrets` field (its credentials are
 * `""` here anyway), and every key whose name contains `key`, `proxy`, or `hypa` (any case); then
 * `meta`.
 */
export function buildSettingsReport(): Record<string, unknown> {
    const report = rootSnapshot();
    for (const key of Object.keys(report)) {
        const lower = key.toLowerCase();
        if (
            REPORT_REMOVED_KEYS.has(key) ||
            llmSecretFields.has(key) ||
            lower.includes("key") ||
            lower.includes("proxy") ||
            lower.includes("hypa")
        ) {
            delete report[key];
        }
    }
    report.meta = {
        isNodeServer: true,
        protocol: location.protocol,
    };
    return report;
}

/** The asset fields of a character the backup inventory reads (a group has the first three). */
export type BackupCharacterAssets = Pick<character, "name" | "image" | "emotionImages"> &
    Partial<Pick<character, "additionalAssets" | "vits" | "ccAssets">> & {
        type: character["type"] | groupChat["type"];
    };

/** What the backup's missing-asset report and partial backup read (`drive/backuplocal.ts`). */
export type BackupInventory = {
    characters: BackupCharacterAssets[];
} & Pick<Database, "userIcon" | "customBackground" | "personas" | "characterOrder" | "botPresets">;

/** The backup inventory: the characters' asset fields and the settings that name assets, copied. */
export function buildBackupInventory(): BackupInventory {
    return untrack(() => ({
        characters: characterList()
            .filter((character) => !!character)
            .map((character) => {
                const assets = character as unknown as Record<string, unknown>;
                return plainClone({
                    name: assets.name,
                    type: assets.type,
                    image: assets.image,
                    emotionImages: assets.emotionImages,
                    additionalAssets: assets.additionalAssets,
                    vits: assets.vits,
                    ccAssets: assets.ccAssets,
                }) as BackupCharacterAssets;
            }),
        userIcon: plainClone(readSettingsRoot("userIcon")) as Database["userIcon"],
        customBackground: plainClone(readSettingsRoot("customBackground")) as Database["customBackground"],
        personas: plainClone(readSettingsRoot("personas")) as Database["personas"],
        characterOrder: plainClone(readSettingsRoot("characterOrder")) as Database["characterOrder"],
        botPresets: plainClone(readSettingsRoot("botPresets")) as Database["botPresets"],
    }));
}
