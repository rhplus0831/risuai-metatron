import type { CustomModel, Database } from "../../../shared/database.ts";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import {
    PERSONA_ROOT_ALIASES,
    PRESET_ROOT_ALIASES,
    presetFieldValue,
    type PresetField,
} from "../../../shared/presets.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { FORWARDED_PRESET_KEYS, SECTION_FIELDS } from "../../../shared/sections.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";

type ProvidersField = (typeof SECTION_FIELDS)["providers"][number];
type LlmSecretsField = (typeof SECTION_FIELDS)["llmSecrets"][number];
type RootOf<F> = F extends "NAISettings"
    ? "NAIsettings"
    : F extends "reasonEffort"
      ? "reasoningEffort"
      : F extends "regex"
        ? "presetRegex"
        : F;
type PresetRootField = Extract<RootOf<Exclude<PresetField, "name" | "image">>, keyof Database>;

/**
 * What the server request layer reads of the database: the `providers` and `llmSecrets` sections,
 * the request preset's fields under their root names (as the forwarding layer serves them), its
 * `proxyKey`, the request persona's name and prompt, `ui.autoSuggestPrefix`, and `customModels`.
 */
export type RequestDb = Pick<
    Database,
    ProvidersField | LlmSecretsField | PresetRootField | "proxyKey" | "username" | "personaPrompt" | "autoSuggestPrefix"
> & {
    /** The custom models, each with its key from `llmSecrets.customModels` (`""` for none). */
    customModels: (CustomModel & { key: string })[];
};

export type RequestScopeIds = {
    presetId: string;
    /** The effective persona (the chat's bound one, else the selected one): `getUserName()`. */
    personaId: string;
    /** The tab's selected persona: the forwarded `db.username` and `db.personaPrompt`. */
    selectedPersonaId: string;
    /** The tab's selected character (`getCurrentCharacter()`), or none. */
    selectedCharacterId: string | null;
    /** The replying character (`arg.currentChar`), or none. */
    speakerId: string | null;
};

export type LoadedRequestDb = {
    db: RequestDb;
    /** The names of the two characters of `RequestScopeIds`, `null` for none. */
    selectedCharacterName: string | null;
    speakerName: string | null;
    /** The effective persona's name. */
    userName: string;
};

export class RequestTargetGoneError extends Error {
    constructor(what: string) {
        super(`The request's ${what} no longer exists`);
        this.name = "RequestTargetGoneError";
    }
}

const presetFieldOf: Record<string, string> = PRESET_ROOT_ALIASES;

/**
 * Builds the request's `RequestDb` from one synchronous read of the store. The ids are the ones the
 * client resolved (its selection fallback included), so a missing preset or persona is an error,
 * never a redirect to another record. A missing character reads as no name.
 */
export function loadRequestDb(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    ids: RequestScopeIds,
): LoadedRequestDb {
    const kind = (name: string) => {
        const found = kinds.get(name);
        if (!found) {
            throw new Error(`Unknown resource kind ${name}`);
        }
        return found;
    };
    const characterIds = [ids.selectedCharacterId, ids.speakerId].filter((id): id is string => !!id);
    const read = store.readRefs([
        { kind: kind(RESOURCE_KIND.providers), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.llmSecrets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.ui), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.customModels), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.presets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.personas), id: SINGLETON_RESOURCE_ID },
        ...characterIds.map((id) => ({ kind: kind(RESOURCE_KIND.characters), id })),
    ]);
    const [providers, llmSecrets, ui, customModels, presets, personas, ...characters] = read.items.map(
        (item) => item.data as any,
    );
    if (!providers || !llmSecrets || !ui || !customModels || !presets || !personas) {
        throw new Error("The server has no settings records yet");
    }
    const preset = (presets as Record<string, unknown>[]).find((record) => record?.id === ids.presetId);
    if (!preset) {
        throw new RequestTargetGoneError("preset");
    }
    const personaById = (id: string) => {
        const found = (personas as Record<string, unknown>[]).find((record) => record?.id === id);
        if (!found) {
            throw new RequestTargetGoneError("persona");
        }
        return found;
    };
    const persona = personaById(ids.selectedPersonaId);
    const effective = personaById(ids.personaId);

    const db: Record<string, unknown> = {};
    for (const field of SECTION_FIELDS.providers) {
        if (Object.hasOwn(providers, field)) {
            db[field] = providers[field];
        }
    }
    for (const field of SECTION_FIELDS.llmSecrets) {
        if (Object.hasOwn(llmSecrets, field)) {
            db[field] = llmSecrets[field];
        }
    }
    for (const rootKey of FORWARDED_PRESET_KEYS) {
        db[rootKey] = presetFieldValue(preset, (presetFieldOf[rootKey] ?? rootKey) as PresetField);
    }
    db.proxyKey = (llmSecrets.presets?.[preset.id as string]?.proxyKey as string | undefined) ?? "";
    for (const rootKey of ["username", "personaPrompt"] as const) {
        const value = persona[PERSONA_ROOT_ALIASES[rootKey]];
        db[rootKey] = typeof value === "string" ? value : PERSONA_DEFAULTS[PERSONA_ROOT_ALIASES[rootKey]];
    }
    db.autoSuggestPrefix = ui.autoSuggestPrefix;
    const modelKeys = (llmSecrets.customModels ?? {}) as Record<string, { key?: unknown }>;
    db.customModels = (customModels as CustomModel[]).map((model) => {
        const entry = Object.prototype.hasOwnProperty.call(modelKeys, model.id) ? modelKeys[model.id] : undefined;
        return { ...model, key: typeof entry?.key === "string" ? entry.key : "" };
    });

    const nameOf = (id: string | null): string | null => {
        if (!id) {
            return null;
        }
        const record = characters[characterIds.indexOf(id)];
        return record ? `${record.name}` : null;
    };
    return {
        db: db as unknown as RequestDb,
        selectedCharacterName: nameOf(ids.selectedCharacterId),
        speakerName: nameOf(ids.speakerId),
        userName: typeof effective.name === "string" ? effective.name : PERSONA_DEFAULTS.name,
    };
}
