import { normalizeModelPreset } from "../../../../shared/presets.ts";
import { FORWARDED_MODEL_PRESET_KEYS, FORWARDED_PRESET_KEYS } from "../../../../shared/sections.ts";
import { assembleChats } from "../chatStore.svelte";
import { initializeRecords, takeRecordFields } from "../records.svelte";
import { forwardedPresetField, reconcileSelection } from "../settingsViews.svelte";

/**
 * Takes the preset fields a flat fixture carries on its root (`FORWARDED_PRESET_KEYS` and
 * `FORWARDED_MODEL_PRESET_KEYS`, by their root names: `reasoningEffort`, `presetRegex`, `aiModel`,
 * ...) out of `raw`, and returns them under the preset's own field names, both owners together (the
 * installation splits them by owner below).
 */
export function takeRootPresetFields(raw: Record<string, unknown>): Record<string, unknown> {
    const preset: Record<string, unknown> = {};
    for (const rootKey of [...FORWARDED_PRESET_KEYS, ...FORWARDED_MODEL_PRESET_KEYS]) {
        if (Object.hasOwn(raw, rootKey)) {
            preset[forwardedPresetField(rootKey)!] = raw[rootKey];
            delete raw[rootKey];
        }
    }
    return preset;
}

/**
 * The model preset a legacy preset implies (`docs/plan/split-preset.md`): the same id and name, its
 * model fields (`normalizeModelPreset` keeps those and drops the prompt fields), the defaults for
 * the rest.
 */
export function modelPresetOf(preset: Record<string, unknown>): Record<string, unknown> {
    return normalizeModelPreset(preset, { id: preset.id as string }) as unknown as Record<string, unknown>;
}

/**
 * Installs a flat database fixture (the legacy whole-database shape the pre-slice-10 tests read:
 * the selected preset's fields on the root) into the records, as the removed `setDatabaseLite`
 * installed one: the root preset fields, if any, become the one preset's (`presetId`; a fixture
 * with `botPresets` has none on its root), every record field moves into the records
 * (`initializeRecords(takeRecordFields(raw))`: the fields are removed from `raw`), and the
 * selection is resolved (`reconcileSelection`). Nothing is normalized: a fixture gives valid data,
 * except the model presets of a fixture without `modelPresets`: one per `botPresets` entry under the
 * same id (`modelPresetOf`, the entry's model fields split off), so a legacy fixture whose preset
 * `a` carries `maxContext` reads it through `activeModelPreset` once model preset `a` is selected;
 * a fixture without presets gets one default model preset. The test then reads the views
 * (`settings`, `activePreset`, `activeModelPreset`, `activePersona`, `characterList()`,
 * `rootSnapshot()`), never `raw`. Returns the installed preset's id.
 */
export function installFlatDatabase(raw: object, presetId = "fixture-preset"): string {
    const fields = raw as Record<string, unknown>;
    const preset = takeRootPresetFields(fields);
    if (Object.keys(preset).length > 0) {
        if (fields.botPresets !== undefined) {
            throw new Error("a fixture with presets carries its preset fields in them, not on its root");
        }
        fields.botPresets = [{ ...preset, id: presetId, name: presetId }];
    }
    if (fields.modelPresets === undefined) {
        const presets = Array.isArray(fields.botPresets) ? (fields.botPresets as Record<string, unknown>[]) : [];
        fields.modelPresets =
            presets.length > 0 ? presets.map(modelPresetOf) : [modelPresetOf({ id: presetId, name: presetId })];
    }
    initializeRecords(takeRecordFields(fields));
    reconcileSelection();
    return presetId;
}

type FixtureChat = { id: string } & Record<string, unknown>;
type FixtureCharacter = { chaId: string; chats?: FixtureChat[]; chatPage?: number } & Record<string, unknown>;

/**
 * `installFlatDatabase` for a fixture whose characters carry their chats in the legacy shape
 * (`chats`, `chatPage`): the records hold no chats (Phase 6 slice 9a), so each character's chats
 * are held in the chat module as boot assembles them (`assembleChats`, every chat loaded, in the
 * fixture's order), before the installation strips them off the character objects. The chat
 * selection is not made here (`initializeChats` or `selectChat`).
 */
export function installFlatDatabaseWithChats(raw: object, presetId = "fixture-preset"): string {
    const fields = raw as Record<string, unknown>;
    const characters = (Array.isArray(fields.characters) ? fields.characters : []).filter(
        (entry): entry is FixtureCharacter => !!entry && typeof entry === "object",
    );
    const chats = characters.flatMap((character) =>
        (character.chats ?? []).map((chat) => ({
            characterId: character.chaId,
            id: chat.id,
            revision: "r1",
            data: chat as any,
        })),
    );
    const orders = characters.map((character) => ({
        characterId: character.chaId,
        revision: "o1",
        ids: (character.chats ?? []).map((chat) => chat.id),
    }));
    const id = installFlatDatabase(raw, presetId);
    assembleChats(characters, chats, orders);
    return id;
}
