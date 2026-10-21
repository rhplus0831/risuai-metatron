import { DEFAULT_MODEL_PROFILE_ID, normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets.ts";
import { FORWARDED_MODEL_PRESET_KEYS, FORWARDED_PRESET_KEYS } from "../../../../shared/sections.ts";
import { assembleChats } from "../chatStore.svelte";
import { initializeRecords, takeRecordFields } from "../records.svelte";
import { forwardedPresetField, reconcileSelection } from "../settingsViews.svelte";

/**
 * Takes the preset fields a flat fixture carries on its root (`FORWARDED_PRESET_KEYS` and
 * `FORWARDED_MODEL_PRESET_KEYS`, by their root names: `reasoningEffort`, `presetRegex`, `aiModel`,
 * ...) out of `raw`, and returns them under the preset's own field names, every owner together (the
 * installation splits them below). The derived model ids (`aiModel`, `subModel`, `seperateModels`)
 * keep their root names.
 */
export function takeRootPresetFields(raw: Record<string, unknown>): Record<string, unknown> {
    const preset: Record<string, unknown> = {};
    for (const rootKey of [...FORWARDED_PRESET_KEYS, ...FORWARDED_MODEL_PRESET_KEYS]) {
        if (Object.hasOwn(raw, rootKey)) {
            preset[forwardedPresetField(rootKey) ?? rootKey] = raw[rootKey];
            delete raw[rootKey];
        }
    }
    return preset;
}

/**
 * The model preset and profiles a legacy preset implies: the model preset keeps the preset's id and
 * name; its main slot names a profile of the same id holding `aiModel` and the profile fields, its
 * sub slot that profile or, for a different `subModel`, a `<id>-sub` profile with the same fields;
 * each non-empty `seperateModels` entry becomes a bare auxiliary slot. A preset without `aiModel`
 * uses the default profile.
 */
export function modelRecordsOf(preset: Record<string, unknown>): {
    modelPreset: Record<string, unknown>;
    profiles: Record<string, unknown>[];
} {
    const id = preset.id as string;
    const { aiModel, subModel, seperateModels, ...fields } = preset;
    const profiles: Record<string, unknown>[] = [];
    let mainId = DEFAULT_MODEL_PROFILE_ID;
    let subId = DEFAULT_MODEL_PROFILE_ID;
    if (typeof aiModel === "string") {
        mainId = subId = id;
        profiles.push({ ...normalizeModelProfile({ ...fields, modelId: aiModel }, { id }), name: preset.name ?? id });
        if (typeof subModel === "string" && subModel !== aiModel) {
            subId = `${id}-sub`;
            profiles.push(normalizeModelProfile({ ...fields, modelId: subModel, name: `${id} sub` }, { id: subId }));
        }
    }
    const auxSlots = Object.fromEntries(
        Object.entries((seperateModels ?? {}) as Record<string, unknown>)
            .filter(([, modelId]) => typeof modelId === "string" && modelId !== "")
            .map(([mode, modelId]) => [mode, { modelId }]),
    );
    const modelPreset = normalizeModelPreset(
        { ...fields, mainSlot: { profileId: mainId }, subSlot: { profileId: subId }, auxSlots },
        { id },
    ) as unknown as Record<string, unknown>;
    return { modelPreset, profiles };
}

/**
 * Installs a flat database fixture (the legacy whole-database shape older tests read: the selected
 * preset's fields on the root) into the records, as the removed `setDatabaseLite` installed one:
 * the root preset fields, if any, become the one preset's (`presetId`; a fixture with `botPresets`
 * has none on its root), every record field moves into the records
 * (`initializeRecords(takeRecordFields(raw))`: the fields are removed from `raw`), and the
 * selection is resolved (`reconcileSelection`). Nothing is normalized: a fixture gives valid data,
 * except the model presets and profiles of a fixture without `modelPresets`: one model preset per
 * `botPresets` entry under the same id, with the profiles its model fields imply
 * (`modelRecordsOf`), so a legacy fixture whose preset `a` carries `maxContext` reads it through
 * `activeMainProfile` once model preset `a` is selected; a fixture without presets gets one default
 * model preset. A fixture without `modelProfiles` gets those profiles plus the default one. The
 * test then reads the views (`settings`, `activePreset`, `activeModelPreset`, `activeMainProfile`,
 * `activePersona`, `characterList()`, `rootSnapshot()`), never `raw`. Returns the installed
 * preset's id.
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
    const implied: Record<string, unknown>[] = [];
    if (fields.modelPresets === undefined) {
        const presets = Array.isArray(fields.botPresets) ? (fields.botPresets as Record<string, unknown>[]) : [];
        const records = (presets.length > 0 ? presets : [{ id: presetId, name: presetId }]).map(modelRecordsOf);
        fields.modelPresets = records.map((record) => record.modelPreset);
        implied.push(...records.flatMap((record) => record.profiles));
    }
    if (fields.modelProfiles === undefined) {
        fields.modelProfiles = [normalizeModelProfile({}, { id: DEFAULT_MODEL_PROFILE_ID }), ...implied];
    }
    initializeRecords(takeRecordFields(fields));
    reconcileSelection();
    return presetId;
}

type FixtureChat = { id: string } & Record<string, unknown>;
type FixtureCharacter = { chaId: string; chats?: FixtureChat[]; chatPage?: number } & Record<string, unknown>;

/**
 * `installFlatDatabase` for a fixture whose characters carry their chats in the legacy shape
 * (`chats`, `chatPage`): the records hold no chats, so each character's chats are held in the chat
 * module as boot assembles them (`assembleChats`, every chat loaded, in the fixture's order),
 * before the installation strips them off the character objects. The chat selection is not made
 * here (`initializeChats` or `selectChat`).
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
