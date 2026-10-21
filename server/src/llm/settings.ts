import type { Credential, CredentialType, Database, ModelPreset } from "../../../shared/database.ts";
import { LLMFlags, type LLMModel } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import { PERSONA_DEFAULTS } from "../../../shared/personas.ts";
import { PERSONA_ROOT_ALIASES, type PromptPresetField } from "../../../shared/presets.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import { FORWARDED_MODEL_PRESET_KEYS, forwardPresetRoots, SECTION_FIELDS } from "../../../shared/sections.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import type { TokenCountScope } from "../prompt/tokens.ts";
import { collectSecrets } from "./redact.ts";

type ProvidersField = (typeof SECTION_FIELDS)["providers"][number];
type LlmSecretsField = (typeof SECTION_FIELDS)["llmSecrets"][number];
type RootOf<F> = F extends "NAISettings"
    ? "NAIsettings"
    : F extends "reasonEffort"
      ? "reasoningEffort"
      : F extends "regex"
        ? "presetRegex"
        : F;
type PresetRootField =
    Extract<RootOf<PromptPresetField>, keyof Database> | (typeof FORWARDED_MODEL_PRESET_KEYS)[number];

/**
 * What the server request layer reads of the database: the `providers` and `llmSecrets` sections,
 * the request's prompt and derived model/profile roots, the request persona's name and prompt,
 * `ui.autoSuggestPrefix`, custom model definitions, and the named credentials. The selected model
 * preset and profile collection are captured with these roots for request-local slot resolution.
 */
export type RequestDb = Pick<
    Database,
    | ProvidersField
    | LlmSecretsField
    | PresetRootField
    | "username"
    | "personaPrompt"
    | "autoSuggestPrefix"
    | "customModels"
    | "modelProfiles"
> & {
    /** The selected model preset; profile ids remain tagged until the slot is resolved. */
    modelPreset: ModelPreset;
    /** Server-only named credentials, including their display names for refusal messages. */
    credentials: Record<
        string,
        { name: string; type: CredentialType; key: string; clientEmail?: string; projectId?: string }
    >;
    /**
     * A job's plugin provider models: the descriptors its tab registered when it created
     * the job (`hooks.providers`), by which `pluginmodel:::<name>` resolves. Never stored.
     */
    pluginModels?: LLMModel[];
};

export type RequestScopeIds = {
    /** The prompt preset. */
    presetId: string;
    /** The model preset. */
    modelPresetId: string;
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

/**
 * Builds the request's `RequestDb` from one synchronous read of the store. The ids are the ones the
 * client resolved (its selection fallback included), so a missing preset, model preset, or persona is an error,
 * never a redirect to another record. A missing character reads as no name.
 */
export function loadRequestDb(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    ids: RequestScopeIds,
    names?: Pick<LoadedRequestDb, "selectedCharacterName" | "speakerName">,
): LoadedRequestDb {
    const kind = (name: string) => {
        const found = kinds.get(name);
        if (!found) {
            throw new Error(`Unknown resource kind ${name}`);
        }
        return found;
    };
    const characterIds = names ? [] : [ids.selectedCharacterId, ids.speakerId].filter((id): id is string => !!id);
    const read = store.readRefs([
        { kind: kind(RESOURCE_KIND.providers), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.llmSecrets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.ui), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.customModels), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.credentials), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.presets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.modelPresets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.modelProfiles), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.personas), id: SINGLETON_RESOURCE_ID },
        ...characterIds.map((id) => ({ kind: kind(RESOURCE_KIND.characters), id })),
    ]);
    const [
        providers,
        llmSecrets,
        ui,
        customModels,
        credentials,
        presets,
        modelPresets,
        modelProfiles,
        personas,
        ...characters
    ] = read.items.map((item) => item.data as any);
    if (!providers || !llmSecrets || !ui || !customModels || !presets || !modelPresets || !modelProfiles || !personas) {
        throw new Error("The server has no settings records yet");
    }
    const preset = (presets as Record<string, unknown>[]).find((record) => record?.id === ids.presetId);
    if (!preset) {
        throw new RequestTargetGoneError("preset");
    }
    const modelPreset = (modelPresets as ModelPreset[]).find((record) => record?.id === ids.modelPresetId);
    if (!modelPreset) {
        throw new RequestTargetGoneError("model preset");
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
    db.modelPreset = modelPreset;
    db.modelProfiles = modelProfiles;
    forwardPresetRoots(db, preset, modelPreset, modelProfiles);
    for (const rootKey of ["username", "personaPrompt"] as const) {
        const value = persona[PERSONA_ROOT_ALIASES[rootKey]];
        db[rootKey] = typeof value === "string" ? value : PERSONA_DEFAULTS[PERSONA_ROOT_ALIASES[rootKey]];
    }
    db.autoSuggestPrefix = ui.autoSuggestPrefix;
    db.customModels = customModels;
    db.credentials = mergeCredentials(credentials ?? [], llmSecrets);

    const nameOf = (id: string | null): string | null => {
        if (!id) {
            return null;
        }
        const record = characters[characterIds.indexOf(id)];
        return record ? `${record.name}` : null;
    };
    return {
        db: db as unknown as RequestDb,
        selectedCharacterName: names ? names.selectedCharacterName : nameOf(ids.selectedCharacterId),
        speakerName: names ? names.speakerName : nameOf(ids.speakerId),
        userName: typeof effective.name === "string" ? effective.name : PERSONA_DEFAULTS.name,
    };
}

/** The same metadata/value merge for generation and profile-scoped auxiliary calls. */
export function mergeCredentials(
    credentials: Credential[],
    llmSecrets: Record<string, unknown>,
): RequestDb["credentials"] {
    const credentialKeys = (llmSecrets.credentials ?? {}) as Record<string, { key?: unknown }>;
    return Object.fromEntries(
        credentials.map((credential) => {
            const entry = Object.hasOwn(credentialKeys, credential.id) ? credentialKeys[credential.id] : undefined;
            return [
                credential.id,
                {
                    name: credential.name,
                    type: credential.type,
                    key: typeof entry?.key === "string" ? entry.key : "",
                    ...(credential.clientEmail !== undefined ? { clientEmail: credential.clientEmail } : {}),
                    ...(credential.projectId !== undefined ? { projectId: credential.projectId } : {}),
                },
            ];
        }),
    );
}

/**
 * Every LLM credential the store holds now (`collectSecrets`' fields of the `providers` and
 * `llmSecrets` sections), for a second redaction pass over captured content (the request history's
 * shared copies). Unlike `loadRequestDb`, a named key is taken from the `llmSecrets.credentials`
 * map itself, whether or not the `credentials` collection still names it; the collection adds the
 * client emails. Throws when a record is missing or unreadable, so a caller never redacts with an
 * empty set by mistake.
 */
export function loadStoredSecrets(store: ResourceStore, kinds: ResourceKindRegistry): string[] {
    const kind = (name: string) => {
        const found = kinds.get(name);
        if (!found) {
            throw new Error(`Unknown resource kind ${name}`);
        }
        return found;
    };
    const read = store.readRefs([
        { kind: kind(RESOURCE_KIND.providers), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.llmSecrets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.credentials), id: SINGLETON_RESOURCE_ID },
    ]);
    const [providers, llmSecrets, credentials] = read.items.map((item) => item.data as any);
    if (
        !providers ||
        typeof providers !== "object" ||
        !llmSecrets ||
        typeof llmSecrets !== "object" ||
        !Array.isArray(credentials)
    ) {
        throw new Error("The server has no settings records yet");
    }
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
    const emails = new Map<string, unknown>(
        (credentials as Credential[]).map((credential) => [credential?.id, credential?.clientEmail]),
    );
    const entries =
        llmSecrets.credentials && typeof llmSecrets.credentials === "object"
            ? (llmSecrets.credentials as Record<string, { key?: unknown }>)
            : {};
    const named: Record<string, { key?: string; clientEmail?: string }> = Object.create(null);
    for (const [id, entry] of Object.entries(entries)) {
        named[id] = {
            ...(typeof entry?.key === "string" ? { key: entry.key } : {}),
            ...(typeof emails.get(id) === "string" ? { clientEmail: emails.get(id) as string } : {}),
        };
    }
    for (const [id, email] of emails) {
        if (typeof id === "string" && typeof email === "string" && !Object.hasOwn(named, id)) {
            named[id] = { clientEmail: email };
        }
    }
    db.credentials = named;
    return collectSecrets(db as Partial<RequestDb>);
}

/** The main model (`db.aiModel`) in the catalogue, the custom models, and the custom flags. */
export function mainModelOf(db: RequestDb): LLMModel {
    return resolveModelInfo(db.aiModel ?? "", {
        enableCustomFlags: db.enableCustomFlags,
        customFlags: db.customFlags,
        customModels: db.customModels,
        pluginModels: db.pluginModels,
    });
}

/**
 * The client's `encode` scope (`src/ts/process/request/transport.ts` builds it for
 * `/api/llm/request`), derived on the server for a job's own requests and counts: the job's
 * settings' main model and tokenizer fields, with the stored Google key. A plugin provider's
 * tokenizer is not used (`"none"`: plugin tokenizers do not count on the server, Safety Contract).
 */
export function tokenScopeFor(db: RequestDb): TokenCountScope {
    const mainModel = mainModelOf(db);
    return {
        aiModel: db.aiModel ?? "",
        currentPluginProvider: db.currentPluginProvider ?? "",
        model: {
            tokenizer: mainModel.tokenizer,
            ...(mainModel.internalID !== undefined ? { internalID: mainModel.internalID } : {}),
        },
        pluginTokenizer: "none",
        customTokenizer: db.customTokenizer ?? "",
        googleClaudeTokenizing: !!db.googleClaudeTokenizing,
        useTokenizerCaching: !!db.useTokenizerCaching,
        googleAccessToken: db.google?.accessToken,
    };
}

/** `supportsInlayImage()`: whether the main model takes image input. */
export function mainModelTakesImages(db: RequestDb): boolean {
    return mainModelOf(db).flags.includes(LLMFlags.hasImageInput);
}
