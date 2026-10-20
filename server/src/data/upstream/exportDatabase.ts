import type {
    Chat,
    Credential,
    CustomModel,
    Message,
    ModelPreset,
    ModelProfile,
    ModelSlot,
    RisuPersona,
    botPreset,
} from "../../../../shared/database.ts";
import { credentialSlotOf, type CredentialSlotName } from "../../../../shared/llm/credentialSlots.ts";
import { resolveModelInfo } from "../../../../shared/llm/models.ts";
import { FLAT_SECRET_FIELDS, NESTED_SECRET_FIELDS } from "../../../../shared/llmSecrets.ts";
import { normalizePersonas } from "../../../../shared/personas.ts";
import {
    normalizeModelPresets,
    normalizeModelProfiles,
    normalizePresets,
    plainClone,
    presetFieldValue,
    PROMPT_PRESET_FIELDS,
    type PresetField,
} from "../../../../shared/presets.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../../shared/resources.ts";
import {
    COLLECTION_FIELDS,
    DROPPED_FIELDS,
    maxContextOverrideOf,
    MODEL_PROFILE_ROOT_FIELDS,
    modelPresetRootValue,
    SECTION_FIELDS,
} from "../../../../shared/sections.ts";
import { UPSTREAM_REPORT_EXAMPLE_LIMIT, type UpstreamReportEntry } from "../../../../shared/upstreamBackup.ts";
import {
    createUpstreamExportReport,
    type UpstreamExportAsset,
    type UpstreamExportAssetRole,
    type UpstreamExportReport,
} from "../../../../shared/upstreamExportReport.ts";
import { isPlainObject } from "../../../../shared/valueKinds.ts";
import { DEFAULT_RESOURCE_KINDS } from "../kinds.ts";
import {
    characterShell,
    forwardPersonaRoots,
    forwardSelectedPreset,
    projectCollections,
    projectSections,
} from "../databaseProjection.ts";

/**
 * The metatron store → upstream RisuAI flat `Database` exporter (`docs/plan/upstream-bin-compat.md`
 * S6): the inverse of `importDatabase.ts`'s conversion, for a `.bin` upstream's "Load Backup" restores.
 * It reads the rows of a validated store copy (`store.readSnapshot` of a `backupTo` file: every
 * record normalized, the chat tables checked) and does no I/O; `encodeUpstreamDatabase` (`risuSave.ts`)
 * turns the result into `database.risudat`. Upstream behavior is read from RisuAI `669b12ce`; "U" below
 * is its `src/ts/`.
 *
 * - Settings: the sections and collections as a job's projection holds them (`databaseProjection.ts`),
 *   without metatron-only fields, with `formatversion: 5` so upstream's `checkNewFormat` runs no legacy
 *   migration, and with the translator and HypaV3 selections as list positions.
 * - Presets (D10): one upstream preset per prompt preset, each with the chosen model preset's slot
 *   model ids and main profile options; the chosen prompt preset also fills the root.
 * - Credentials (D7): only with `includeSecrets`. Upstream reads one key per field (U `setPreset`
 *   restores no preset key), so a named key bound by a chosen slot is written into the field its model
 *   reads, the main slot first; the reverse proxy key goes to `proxyKey` and a custom model's key to
 *   `customModels[].key`, as the import reads them back. Without it every credential field is `""`,
 *   auxiliary service keys included.
 * - Characters and chats: chats in `chatOrders` order, without metatron-only chat, message, and
 *   character fields (D12); inlays and device-local plugin storage are left out (D8) and counted.
 *
 * Every left-out or reshaped item is reported (`shared/upstreamExportReport.ts`). The rows are parsed
 * here, so the result shares no object with the input.
 */

export type UpstreamExportRows = readonly { kind: string; id: string; text: string }[];

export type UpstreamExportChats = {
    readonly chats: readonly { seq: number; characterId: string; id: string; meta: string }[];
    readonly messages: readonly { chatSeq: number; position: number; data: string }[];
    readonly chatOrders: readonly { characterId: string; ids: string }[];
};

export type UpstreamExportOptions = {
    /** The tab's selection: the prompt preset, model preset (D10), and persona the root holds. */
    promptPresetId: string;
    modelPresetId: string;
    personaId: string;
    /** D7: export the API keys (default of the client's question: no). */
    includeSecrets: boolean;
    /** The chat the tab has open: its character's `chatPage` points at it (0 for every other one). */
    selectedChat?: { characterId: string; chatId: string };
    /** Whether an asset exists; a referenced asset that does not is reported in `missing`. */
    hasAsset?: (key: string) => boolean;
    /** The current time (default `Date.now()`), for the trash times. */
    now?: number;
};

export type UpstreamExport = {
    /** The upstream flat `Database`, plain data for `encodeUpstreamDatabase`. */
    db: Record<string, unknown>;
    /** The referenced assets to write as records (the existing ones when `hasAsset` is given). */
    assetKeys: UpstreamExportAsset[];
    report: UpstreamExportReport;
};

type Root = Record<string, unknown>;

/**
 * Settings upstream's `Database` lacks (checked against U `storage/database.svelte.ts` `Database`).
 * The four model and credential collections are exported in upstream's shapes instead.
 */
const METATRON_ONLY_SETTINGS = [
    "chatScreenWidth",
    "googleSearchCredentials",
    "irisDialogue",
    "llmTranslationTarget",
    "newChatBinding",
    "requestHistoryContent",
    "requestHistoryLimit",
    "translatorHistoryMaxTokens",
    "togglePresets",
    "credentials",
    "modelPresets",
    "modelProfiles",
];
const UNREPORTED_SETTINGS = new Set(["credentials", "modelPresets", "modelProfiles"]);

/** Each field's fresh-boot value (its kind's normalizer on nothing), as JSON: a field still at it is not reported. */
const settingDefaults: ReadonlyMap<string, string | undefined> = (() => {
    const defaults = new Map<string, string | undefined>();
    const kindOf = new Map<string, string>([
        ...Object.entries(SECTION_FIELDS).flatMap(([kind, fields]) => fields.map((field) => [field, kind] as const)),
        ...Object.entries(COLLECTION_FIELDS).map(([kind, field]) => [field, kind] as const),
    ]);
    for (const field of METATRON_ONLY_SETTINGS) {
        const kind = DEFAULT_RESOURCE_KINDS.find((entry) => entry.name === kindOf.get(field));
        const record = kind?.normalize(undefined, { id: SINGLETON_RESOURCE_ID });
        const value = kindOf.get(field) === field ? record : (record as Root | undefined)?.[field];
        defaults.set(field, value === undefined ? undefined : JSON.stringify(value));
    }
    return defaults;
})();

/** Prompt preset fields upstream has no place for (the context size goes into `maxContext`). */
const PROMPT_ONLY_FIELDS = new Set<string>(["maxContextOverride", "maxContextOverrideSize"]);

/**
 * Profile options upstream keeps only at the root (U `setPreset` never reads them from a preset; the
 * import treats them as global): exported at the root from the chosen main profile, not per preset.
 */
const ROOT_ONLY_PROFILE_FIELDS = new Set<string>([
    "nanogptRequestModel",
    "nanogptRequestModelName",
    "nanogptProvider",
    "ollamaURL",
    "ollamaModel",
    "ollamaModelName",
    "ollamaModelSource",
    "ollamaInputMode",
    "ollamaRequestFormat",
    "ollamaCloudModel",
    "ollamaCloudModelName",
    "customTokenizer",
]);

/** Character fields upstream's `character` and `groupChat` lack. */
const METATRON_CHARACTER_FIELDS = ["customNotificationMessage", "supaMemoryOnCount"];

/** Chat fields upstream's `Chat` lacks (D12). */
const METATRON_CHAT_FIELDS = [
    "pinned",
    "memoryTrimAck",
    "bindingReview",
    "toolCalls",
    "togglePresetId",
    "promptPresetId",
    "modelPresetId",
    "translatorPresetId",
    "autoTranslate",
    "translateBotOnly",
    "bilingualDisplay",
    "bilingualEmphasis",
    "bilingualSentences",
];

/** Where `pluginCustomStorage` holds what upstream keeps in its device storage (LocalForage). */
const DEVICE_PLUGIN_STORAGE_KEYS = ["_pluginStorage", "_safeLocalPluginStorage"];

/** Credentials of the auxiliary services in the `secrets` section: flat fields, then nested leaves. */
const AUXILIARY_SECRET_FIELDS = [
    "NAIApiKey",
    "elevenLabKey",
    "voyageApiKey",
    "huggingfaceKey",
    "fishSpeechKey",
    "stabilityKey",
    "falToken",
];
const AUXILIARY_NESTED_SECRETS: Record<string, string> = {
    deeplOptions: "key",
    deeplXOptions: "token",
    hypaCustomSettings: "key",
    openaiCompatImage: "key",
    wavespeedImage: "key",
};

/** U `bootstrap.ts` `checkNewFormat` deletes a character trashed this long ago. */
const UPSTREAM_TRASH_MS = 1000 * 60 * 60 * 24 * 3;

const INLAY_REFERENCE = /\{\{inlay(?:ed|eddata)?::/;

/** The upstream field a model's named-key slot reads (U `process/request/*`). */
const SLOT_FIELDS: Partial<Record<CredentialSlotName, string>> = {
    openai: "openAIKey",
    anthropic: "claudeAPIKey",
    bedrock: "claudeAPIKey",
    openrouter: "openrouterKey",
    nanogpt: "nanogptKey",
    ollama: "ollamaApiKey",
    mistral: "mistralKey",
    cohere: "cohereAPIKey",
};
const SLOT_NESTED_FIELDS: Partial<Record<CredentialSlotName, [string, string]>> = {
    google: ["google", "accessToken"],
    novelai: ["novelai", "token"],
};

export function buildUpstreamDatabase(
    rows: UpstreamExportRows,
    chats: UpstreamExportChats,
    options: UpstreamExportOptions,
): UpstreamExport {
    const report = createUpstreamExportReport();
    const now = options.now ?? Date.now();
    const records = new Map<string, any>();
    const characterRecords: Root[] = [];
    for (const row of rows) {
        if (row.kind === RESOURCE_KIND.characters) {
            characterRecords.push(JSON.parse(row.text) as Root);
        } else if (row.id === SINGLETON_RESOURCE_ID) {
            records.set(row.kind, JSON.parse(row.text));
        }
    }
    const storedSecrets: Root = isPlainObject(records.get(RESOURCE_KIND.llmSecrets))
        ? records.get(RESOURCE_KIND.llmSecrets)
        : {};

    const db: Root = {};
    projectSections(db, (section) => records.get(section), {
        llmSecrets: options.includeSecrets ? "stored" : "mirror",
    });
    projectCollections(db, (collection) => records.get(collection));

    // Presets (D10) and the chosen records.
    let promptPresets = asList<botPreset>(records.get(RESOURCE_KIND.presets));
    if (promptPresets.length === 0) {
        promptPresets = normalizePresets([]);
    }
    let modelPresets = asList<ModelPreset>(db.modelPresets);
    if (modelPresets.length === 0) {
        modelPresets = normalizeModelPresets([]);
    }
    let profiles = asList<ModelProfile>(db.modelProfiles);
    if (profiles.length === 0) {
        profiles = normalizeModelProfiles([]);
    }
    let personas = asList<RisuPersona>(db.personas);
    if (personas.length === 0) {
        personas = normalizePersonas([]);
    }
    const promptPreset = chosen(promptPresets, options.promptPresetId, report);
    const modelPreset = chosen(modelPresets, options.modelPresetId, report);
    const persona = chosen(personas, options.personaId, report);
    for (const other of modelPresets) {
        if (other !== modelPreset) {
            addEntry(report.converted, "model-presets-flattened", [other.name]);
        }
    }

    // Credentials (D7).
    const customModels = asList<CustomModel>(db.customModels).map((model) => ({ ...model, key: "" }));
    const keys = options.includeSecrets
        ? placeNamedKeys(
              db,
              modelPreset,
              profiles,
              customModels,
              asList<Credential>(db.credentials),
              storedSecrets,
              report,
          )
        : { proxyKey: "" };
    if (!options.includeSecrets) {
        reportOmittedKeys(storedSecrets, report);
        db.vertexAccessToken = "";
        db.vertexAccessTokenExpires = 0;
    }
    db.customModels = customModels;
    db.proxyKey = keys.proxyKey;

    const mainProfile = profiles.find((profile) => profile.id === modelPreset.mainSlot?.profileId);
    const flattenedFields = MODEL_PROFILE_ROOT_FIELDS.filter(
        (field) => !ROOT_ONLY_PROFILE_FIELDS.has(field) && field !== "maxContext",
    );
    for (const { name, profile } of chosenSlotProfiles(modelPreset, profiles)) {
        if (
            name !== "main" &&
            flattenedFields.some(
                (field) =>
                    JSON.stringify(presetFieldValue(profile as unknown as Root, field)) !==
                    JSON.stringify(presetFieldValue(mainProfile as unknown as Root | undefined, field)),
            )
        ) {
            addEntry(report.excluded, "slot-options-flattened", [name]);
        }
    }
    db.botPresets = promptPresets.map((preset) =>
        upstreamPreset(preset, modelPreset, profiles, mainProfile, db.openAIKey, keys.proxyKey),
    );
    forwardSelectedPreset(db, promptPresets, promptPreset, modelPreset, profiles);

    // Personas.
    for (const entry of personas) {
        if (Array.isArray(entry.modules) && entry.modules.length > 0) {
            addEntry(report.excluded, "persona-modules", [entry.name]);
        }
        delete entry.modules;
        if (entry.embeddedModule) {
            repairModule(entry.embeddedModule as unknown as Root, `personas[${entry.name}].embeddedModule`, report);
        }
    }
    db.personas = personas;
    forwardPersonaRoots(db, persona, personas);

    db.translatorPresets = upstreamTranslatorPresets(db, report);
    db.hypaV3PresetId = positionOf(db.hypaV3Presets, db.hypaV3PresetId);
    db.characterOrder = repairCharacterOrder(db.characterOrder, report);
    db.loreBook = asList<Root>(db.loreBook).map((page, index) => ({
        ...page,
        data: repairLore(page.data, `loreBook[${index}]`, report),
    }));

    // Modules, plugins, and plugin storage.
    const modules = asList<Root>(records.get(RESOURCE_KIND.modules));
    modules.forEach((module, index) => repairModule(module, `modules[${index}]`, report));
    db.modules = modules;
    const plugins = asList<Root>(records.get(RESOURCE_KIND.plugins));
    db.plugins = plugins;
    db.pluginCustomStorage = upstreamPluginStorage(records.get(RESOURCE_KIND.pluginStorage), plugins, report);

    db.characters = upstreamCharacters(characterRecords, chats, options, now, report);

    if (!options.includeSecrets) {
        clearAuxiliaryKeys(db, report);
    }

    // Settings cleanup, after every step that forwards roots.
    for (const field of METATRON_ONLY_SETTINGS) {
        if (
            !UNREPORTED_SETTINGS.has(field) &&
            Object.hasOwn(db, field) &&
            JSON.stringify(db[field]) !== settingDefaults.get(field)
        ) {
            addEntry(report.excluded, "metatron-settings", [field]);
        }
        delete db[field];
    }
    for (const field of [...DROPPED_FIELDS, ...PROMPT_ONLY_FIELDS]) {
        if (field !== "proxyKey") {
            delete db[field];
        }
    }
    db.formatversion = 5;

    const assets = collectUpstreamAssetReferences(db);
    const assetKeys: UpstreamExportAsset[] = [];
    for (const asset of assets) {
        if (options.hasAsset && !options.hasAsset(asset.key)) {
            report.missing.push(asset);
        } else {
            assetKeys.push(asset);
        }
    }

    const characters = db.characters as Root[];
    report.counts.characters = characters.length;
    report.counts.groups = characters.filter((entry) => entry.type === "group").length;
    report.counts.chats = characters.reduce((sum, entry) => sum + (entry.chats as Chat[]).length, 0);
    report.counts.messages = characters.reduce(
        (sum, entry) => sum + (entry.chats as Chat[]).reduce((inner, chat) => inner + chat.message.length, 0),
        0,
    );
    report.counts.promptPresets = promptPresets.length;
    report.counts.personas = personas.length;
    report.counts.modules = modules.length;
    report.counts.plugins = plugins.length;
    report.counts.assets = assetKeys.length;
    return { db, assetKeys, report };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function asList<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

/** The record with `id`, or the first one, reported as a fallback. */
function chosen<T extends { id: string; name?: string }>(
    list: readonly T[],
    id: string,
    report: UpstreamExportReport,
): T {
    const found = list.find((entry) => entry?.id === id);
    if (found) {
        return found;
    }
    addEntry(report.converted, "selection-fallback", [list[0].name ?? list[0].id]);
    return list[0];
}

/**
 * Counts `count` occurrences of `code` (one entry per code) and records each new example while the
 * entry lists fewer than `UPSTREAM_REPORT_EXAMPLE_LIMIT`.
 */
function addEntry<Code extends string>(
    list: UpstreamReportEntry<Code>[],
    code: Code,
    examples: readonly string[] = [],
    count = 1,
): void {
    let entry = list.find((candidate) => candidate.code === code);
    if (!entry) {
        entry = { code, count: 0, examples: [] };
        list.push(entry);
    }
    entry.count += count;
    for (const example of examples) {
        if (entry.examples.length < UPSTREAM_REPORT_EXAMPLE_LIMIT && !entry.examples.includes(example)) {
            entry.examples.push(example);
        }
    }
}

function isKey(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

/** The position of the item with `id` in a list (0 when it is not there), as upstream selects. */
function positionOf(items: unknown, id: unknown): number {
    return Math.max(
        0,
        asList<Root>(items).findIndex((item) => item?.id === id),
    );
}

// ---------------------------------------------------------------------------------------------
// Presets and credentials

/** Profiles of the chosen slots in main, sub, then enabled auxiliary order. */
function chosenSlotProfiles(
    modelPreset: ModelPreset,
    profiles: readonly ModelProfile[],
): { name: string; profile: ModelProfile }[] {
    const slots: [string, ModelSlot | undefined][] = [
        ["main", modelPreset.mainSlot],
        ["sub", modelPreset.subSlot],
    ];
    if (modelPreset.seperateModelsForAxModels) {
        for (const mode of ["memory", "translate", "emotion", "otherAx"] as const) {
            slots.push([mode, modelPreset.auxSlots?.[mode]]);
        }
    }
    return slots.flatMap(([name, slot]) => {
        const profile =
            slot && "profileId" in slot ? profiles.find((profile) => profile.id === slot.profileId) : undefined;
        return profile ? [{ name, profile }] : [];
    });
}

/**
 * One upstream preset: the prompt preset's fields under their stored names, the model preset's slot
 * model ids, the main profile's options except the root-only ones, and the effective context size.
 */
function upstreamPreset(
    preset: botPreset,
    modelPreset: ModelPreset,
    profiles: readonly ModelProfile[],
    mainProfile: ModelProfile | undefined,
    openAIKey: unknown,
    proxyKey: string,
): Root {
    const record = preset as unknown as Root;
    const out: Root = { name: record.name ?? "", image: record.image ?? "" };
    for (const field of PROMPT_PRESET_FIELDS) {
        if (!PROMPT_ONLY_FIELDS.has(field)) {
            out[field] = plainClone(presetFieldValue(record, field));
        }
    }
    for (const field of ["aiModel", "subModel", "seperateModels", "seperateModelsForAxModels"] as const) {
        out[field] = plainClone(modelPresetRootValue(modelPreset, profiles, field));
    }
    const profileRecord = mainProfile as unknown as Root | undefined;
    for (const field of MODEL_PROFILE_ROOT_FIELDS) {
        if (!ROOT_ONLY_PROFILE_FIELDS.has(field)) {
            out[field] = plainClone(presetFieldValue(profileRecord, field as PresetField));
        }
    }
    out.maxContext = maxContextOverrideOf(record) ?? presetFieldValue(profileRecord, "maxContext");
    // U `saveCurrentPreset` stores the root keys in each preset.
    out.openAIKey = typeof openAIKey === "string" ? openAIKey : "";
    out.proxyKey = proxyKey;
    return out;
}

/**
 * Writes the named keys the chosen model preset's slots bind into the upstream fields their models
 * read (main, then sub, then the auxiliary slots when they are on; default-backed slots reserve fields too),
 * and each custom model's key from the profiles that use it. Returns the proxy key. Every named key
 * holding a value that no field received is reported.
 */
function placeNamedKeys(
    db: Root,
    modelPreset: ModelPreset,
    profiles: readonly ModelProfile[],
    customModels: (CustomModel & { key: string })[],
    credentials: readonly Credential[],
    storedSecrets: Root,
    report: UpstreamExportReport,
): { proxyKey: string } {
    const stored = isPlainObject(storedSecrets.credentials) ? (storedSecrets.credentials as Record<string, any>) : {};
    const keyOf = (id: string): string | undefined => {
        const key = stored[id]?.key;
        return isKey(key) ? key : undefined;
    };
    const placed = new Map<string, string>();
    const used = new Set<string>();
    let proxyKey = "";
    const place = (profile: ModelProfile, target: "chosen" | "customModel") => {
        const modelInfo = resolveModelInfo(profile.modelId, { customModels });
        const slot = credentialSlotOf(profile.modelId, modelInfo);
        if (!slot) {
            return;
        }
        if (target === "customModel" && slot.slot !== "customModel") {
            return;
        }
        const field =
            slot.slot === "reverseProxy"
                ? "proxyKey"
                : slot.slot === "customModel"
                  ? `customModels:${profile.modelId}`
                  : slot.slot === "keyIdentifier"
                    ? `OaiCompAPIKeys:${modelInfo.keyIdentifier}`
                    : slot.slot === "vertex"
                      ? "vertex"
                      : (SLOT_FIELDS[slot.slot] ?? SLOT_NESTED_FIELDS[slot.slot]?.join("."));
        if (field === undefined || placed.has(field)) {
            return;
        }
        if (!profile.credentialId) {
            if (target === "chosen") {
                placed.set(field, "default");
            }
            return;
        }
        const credential = credentials.find((entry) => entry.id === profile.credentialId);
        const key = credential ? keyOf(credential.id) : undefined;
        if (
            !credential ||
            key === undefined ||
            !slot.accepts.includes(credential.type) ||
            (slot.slot === "vertex" && !isKey(credential.clientEmail))
        ) {
            return;
        }
        if (slot.slot === "reverseProxy") {
            proxyKey = key;
            placed.set(field, credential.id);
            used.add(credential.id);
            return;
        }
        if (slot.slot === "customModel") {
            for (const model of customModels) {
                if (model.id === profile.modelId && model.key === "") {
                    model.key = key;
                    placed.set(field, credential.id);
                    used.add(credential.id);
                    break;
                }
            }
            return;
        }
        if (slot.slot === "keyIdentifier") {
            db.OaiCompAPIKeys = {
                ...(isPlainObject(db.OaiCompAPIKeys) ? db.OaiCompAPIKeys : {}),
                [modelInfo.keyIdentifier!]: key,
            };
        } else if (slot.slot === "vertex") {
            db.vertexPrivateKey = key;
            db.vertexClientEmail = credential.clientEmail ?? "";
            if (credential.projectId) {
                db.google = {
                    ...(isPlainObject(db.google) ? db.google : {}),
                    projectId: credential.projectId,
                };
            }
            db.vertexAccessToken = "";
            db.vertexAccessTokenExpires = 0;
        } else if (SLOT_FIELDS[slot.slot]) {
            db[SLOT_FIELDS[slot.slot]!] = key;
        } else {
            const [container, leaf] = SLOT_NESTED_FIELDS[slot.slot]!;
            db[container] = { ...(isPlainObject(db[container]) ? db[container] : {}), [leaf]: key };
        }
        placed.set(field, credential.id);
        used.add(credential.id);
        addEntry(report.converted, "named-key-to-field", [credential.name]);
    };

    for (const { profile } of chosenSlotProfiles(modelPreset, profiles)) {
        place(profile, "chosen");
    }
    // A custom model's key is the definition's own upstream, whichever preset uses the model.
    for (const profile of profiles) {
        place(profile, "customModel");
    }
    for (const id of Object.keys(stored)) {
        if (!used.has(id) && keyOf(id) !== undefined) {
            addEntry(report.excluded, "named-keys", [credentials.find((entry) => entry.id === id)?.name ?? id]);
        }
    }
    return { proxyKey };
}

/** Without `includeSecrets`: reports the `llmSecrets` fields that held a key. */
function reportOmittedKeys(stored: Root, report: UpstreamExportReport): void {
    const fields: string[] = [];
    for (const field of FLAT_SECRET_FIELDS) {
        if (isKey(stored[field])) {
            fields.push(field);
        }
    }
    for (const [field, leaf] of Object.entries(NESTED_SECRET_FIELDS)) {
        if (isPlainObject(stored[field]) && isKey(stored[field][leaf])) {
            fields.push(`${field}.${leaf}`);
        }
    }
    if (isPlainObject(stored.OaiCompAPIKeys) && Object.values(stored.OaiCompAPIKeys).some(isKey)) {
        fields.push("OaiCompAPIKeys");
    }
    if (
        isPlainObject(stored.credentials) &&
        Object.values(stored.credentials).some((entry: any) => isKey(entry?.key))
    ) {
        fields.push("credentials");
    }
    if (fields.length > 0) {
        addEntry(report.excluded, "api-keys", fields, fields.length);
    }
}

/**
 * Without `includeSecrets`: blanks the auxiliary service keys (the `secrets` section), each
 * character's TTS key, and the MCP OAuth secrets, and reports the ones that held a value.
 */
function clearAuxiliaryKeys(db: Root, report: UpstreamExportReport): void {
    const fields: string[] = [];
    for (const field of AUXILIARY_SECRET_FIELDS) {
        if (isKey(db[field])) {
            fields.push(field);
        }
        if (Object.hasOwn(db, field)) {
            db[field] = "";
        }
    }
    for (const [field, leaf] of Object.entries(AUXILIARY_NESTED_SECRETS)) {
        const container = db[field];
        if (isPlainObject(container)) {
            if (isKey(container[leaf])) {
                fields.push(`${field}.${leaf}`);
            }
            db[field] = { ...container, [leaf]: "" };
        }
    }
    for (const character of db.characters as Root[]) {
        const config = character.oaiTTSConfig;
        if (isPlainObject(config) && Object.hasOwn(config, "apiKey")) {
            if (isKey(config.apiKey)) {
                fields.push("oaiTTSConfig.apiKey");
            }
            character.oaiTTSConfig = { ...config, apiKey: "" };
        }
    }
    db.authRefreshes = asList<Root>(db.authRefreshes).map((entry) => {
        if (isKey(entry.refreshToken) || isKey(entry.clientSecret)) {
            fields.push("authRefreshes");
        }
        const { refreshToken: _token, clientSecret: _secret, ...rest } = entry;
        return rest;
    });
    if (fields.length > 0) {
        addEntry(report.excluded, "api-keys", [...new Set(fields)], fields.length);
    }
}

/**
 * Upstream translator presets (`{ name, prompt, maxResponse }`, U `translator/presets.ts`): the
 * first enabled step's prompt and response size (the first step when none is enabled). A preset
 * whose other steps, step models, output keys, or options are lost is reported. The selection becomes
 * the chosen preset's position.
 */
function upstreamTranslatorPresets(db: Root, report: UpstreamExportReport): Root[] {
    const items = asList<Root>(db.translatorPresets);
    db.translatorPresetId = positionOf(items, db.translatorPresetId);
    return items.map((item) => {
        const steps = asList<Root>(item.steps);
        const step = steps.find((entry) => entry.enabled === true) ?? steps[0];
        const lossy =
            steps.length > 1 ||
            steps.some(
                (entry) =>
                    entry.enabled === false ||
                    entry.outputKey !== undefined ||
                    (isPlainObject(entry.model) && entry.model.mode !== "inherit"),
            ) ||
            item.sendTextAsIs === true ||
            item.excludeThoughts === true;
        const name = typeof item.name === "string" ? item.name : "";
        if (lossy) {
            addEntry(report.excluded, "translator-steps", [name]);
        }
        return {
            name,
            prompt: typeof step?.prompt === "string" ? step.prompt : "",
            maxResponse: typeof step?.maxResponse === "number" ? step.maxResponse : 1000,
        };
    });
}

// ---------------------------------------------------------------------------------------------
// Shapes upstream's boot reads without checking

/**
 * A lorebook entry list upstream maps without checks (U `characters.ts` `updateLorebooks`): a
 * non-list becomes `[]`, a non-object entry is dropped, and a non-string `content` becomes `""`.
 */
function repairLore(value: unknown, path: string, report: UpstreamExportReport): Root[] {
    if (!Array.isArray(value)) {
        if (value !== undefined) {
            addEntry(report.converted, "shape-repaired", [path]);
        }
        return [];
    }
    const out: Root[] = [];
    let repaired = false;
    for (const entry of value) {
        if (!isPlainObject(entry)) {
            repaired = true;
            continue;
        }
        if (typeof entry.content !== "string") {
            repaired = true;
            out.push({ ...entry, content: "" });
        } else {
            out.push(entry);
        }
    }
    if (repaired) {
        addEntry(report.converted, "shape-repaired", [path]);
    }
    return out;
}

/** A module's lorebook (U `checkNewFormat` runs `updateLorebooks` on a present one). */
function repairModule(module: Root, path: string, report: UpstreamExportReport): void {
    if (module.lorebook !== undefined && module.lorebook !== null) {
        module.lorebook = repairLore(module.lorebook, `${path}.lorebook`, report);
    }
}

/**
 * The character order upstream's `checkCharOrder` walks (U `globalApi.svelte.ts`): ids and folders
 * whose `data` is a list of ids; anything else is dropped or emptied.
 */
function repairCharacterOrder(value: unknown, report: UpstreamExportReport): unknown[] {
    const out: unknown[] = [];
    asList<unknown>(value).forEach((entry, index) => {
        if (typeof entry === "string") {
            out.push(entry);
        } else if (isPlainObject(entry)) {
            const data = asList<unknown>(entry.data).filter((id) => typeof id === "string");
            if (!Array.isArray(entry.data) || data.length !== entry.data.length) {
                addEntry(report.converted, "shape-repaired", [`characterOrder[${index}]`]);
            }
            out.push({ ...entry, data });
        } else {
            addEntry(report.converted, "shape-repaired", [`characterOrder[${index}]`]);
        }
    });
    return out;
}

// ---------------------------------------------------------------------------------------------
// Plugins

/**
 * `pluginCustomStorage` without what upstream keeps in its device storage (`_pluginStorage`,
 * `_safeLocalPluginStorage`) or as cold storage (`_coldplugin`); the left-out entries are counted.
 */
function upstreamPluginStorage(value: unknown, plugins: readonly Root[], report: UpstreamExportReport): Root {
    const storage: Root = isPlainObject(value) ? { ...value } : {};
    let count = 0;
    for (const key of DEVICE_PLUGIN_STORAGE_KEYS) {
        if (Object.hasOwn(storage, key)) {
            const inner = storage[key];
            count += isPlainObject(inner) || Array.isArray(inner) ? Object.keys(inner).length : 1;
            delete storage[key];
        }
    }
    delete storage._coldplugin;
    if (count > 0) {
        const names = plugins.map((plugin) => plugin.name).filter((name): name is string => typeof name === "string");
        addEntry(report.excluded, "plugin-storage", names, count);
    }
    return storage;
}

// ---------------------------------------------------------------------------------------------
// Characters and chats

function upstreamCharacters(
    records: readonly Root[],
    snapshot: UpstreamExportChats,
    options: UpstreamExportOptions,
    now: number,
    report: UpstreamExportReport,
): Root[] {
    const messagesBySeq = new Map<number, { position: number; data: string }[]>();
    for (const message of snapshot.messages) {
        let list = messagesBySeq.get(message.chatSeq);
        if (!list) {
            list = [];
            messagesBySeq.set(message.chatSeq, list);
        }
        list.push(message);
    }
    const chatsByCharacter = new Map<string, Map<string, (typeof snapshot.chats)[number]>>();
    for (const chat of snapshot.chats) {
        let map = chatsByCharacter.get(chat.characterId);
        if (!map) {
            map = new Map();
            chatsByCharacter.set(chat.characterId, map);
        }
        map.set(chat.id, chat);
    }
    const orders = new Map<string, string[]>();
    for (const order of snapshot.chatOrders) {
        orders.set(order.characterId, JSON.parse(order.ids) as string[]);
    }

    return records.map((character) => {
        const chaId = character.chaId as string;
        const name = typeof character.name === "string" ? character.name : chaId;
        const stripped = METATRON_CHARACTER_FIELDS.filter((field) => Object.hasOwn(character, field));
        for (const field of stripped) {
            delete character[field];
        }
        if (stripped.length > 0) {
            addEntry(report.excluded, "character-fields", stripped);
        }
        if (Object.hasOwn(character, "globalLore")) {
            character.globalLore = repairLore(character.globalLore, `characters[${name}].globalLore`, report);
        }
        const stored = chatsByCharacter.get(chaId) ?? new Map();
        const ids = orders.get(chaId) ?? [...stored.keys()];
        const chats = ids.flatMap((id) => {
            const row = stored.get(id);
            if (!row) {
                return [];
            }
            const messages = (messagesBySeq.get(row.seq) ?? []).sort((a, b) => a.position - b.position);
            const chat = upstreamChat(row.meta, messages, `characters[${name}]`, report);
            if (
                chat.message.some((message) => typeof message.data === "string" && INLAY_REFERENCE.test(message.data))
            ) {
                addEntry(report.excluded, "inlays", [name]);
            }
            return [chat];
        });
        const chatPage =
            options.selectedChat?.characterId === chaId ? Math.max(0, ids.indexOf(options.selectedChat.chatId)) : 0;
        if (
            typeof character.trashTime === "number" &&
            Number.isFinite(character.trashTime) &&
            character.trashTime > 0 &&
            character.trashTime + UPSTREAM_TRASH_MS < now
        ) {
            character.trashTime = now;
            addEntry(report.converted, "trash-time-refreshed", [name]);
        }
        // U `makeColdData` sends a character whose `lastInteraction` is older than ten days to cold
        // storage: it is kept as recent as its newest chat.
        if (typeof character.lastInteraction === "number") {
            let lastInteraction = character.lastInteraction;
            for (const chat of chats) {
                if (typeof chat.lastDate === "number" && chat.lastDate > lastInteraction) {
                    lastInteraction = chat.lastDate;
                }
            }
            character.lastInteraction = lastInteraction;
        }
        return characterShell(character, chats, chatPage) as unknown as Root;
    });
}

/**
 * One upstream chat: the stored metadata without metatron's fields (D12), the messages in order
 * without their translations, `useLocallySetGlobalVariables` when the chat holds toggle values (so
 * upstream keeps writing them to the chat, as metatron does), and `lastDate` at least as recent as its
 * newest message.
 */
function upstreamChat(
    metaText: string,
    rows: readonly { data: string }[],
    path: string,
    report: UpstreamExportReport,
): Chat {
    const chat = JSON.parse(metaText) as Root;
    const stripped = METATRON_CHAT_FIELDS.filter((field) => Object.hasOwn(chat, field));
    for (const field of stripped) {
        delete chat[field];
    }
    if (stripped.length > 0) {
        addEntry(report.excluded, "chat-fields", stripped);
    }
    let translations = 0;
    let newest: number | undefined;
    const message = rows.map((row) => {
        const entry = JSON.parse(row.data) as Message & Root;
        if (Object.hasOwn(entry, "translation")) {
            delete entry.translation;
            translations++;
        }
        if (
            typeof entry.time === "number" &&
            Number.isFinite(entry.time) &&
            (newest === undefined || entry.time > newest)
        ) {
            newest = entry.time;
        }
        return entry as Message;
    });
    if (translations > 0) {
        addEntry(report.excluded, "message-translations", [], translations);
    }
    chat.message = message;
    if (isPlainObject(chat.GLGlobalVariables) && Object.keys(chat.GLGlobalVariables).length > 0) {
        chat.useLocallySetGlobalVariables = true;
    }
    if (newest !== undefined && !(typeof chat.lastDate === "number" && chat.lastDate >= newest)) {
        chat.lastDate = newest;
    }
    chat.localLore = repairLore(chat.localLore, `${path}.localLore`, report);
    return chat as unknown as Chat;
}

// ---------------------------------------------------------------------------------------------
// Assets

/**
 * Every `assets/...` key an upstream `Database` references, once, with the first owner and role that
 * names it: character and group images, emotions, additional assets, VITS files, card assets, the
 * GPT-SoVITS reference audio, the user icon and background, persona icons and embedded modules,
 * folder images, preset images, and module assets and icons (U `globalApi.svelte.ts` lists the same).
 */
export function collectUpstreamAssetReferences(db: Readonly<Record<string, unknown>>): UpstreamExportAsset[] {
    const found = new Map<string, UpstreamExportAsset>();
    const add = (key: unknown, owner: unknown, role: UpstreamExportAssetRole) => {
        if (typeof key === "string" && key.startsWith("assets/") && !found.has(key)) {
            found.set(key, { key, owner: typeof owner === "string" ? owner : "", role });
        }
    };
    const addModule = (module: unknown, owner: string) => {
        if (!isPlainObject(module)) {
            return;
        }
        for (const asset of asList<unknown[]>(module.assets)) {
            add(Array.isArray(asset) ? asset[1] : undefined, owner, "module");
        }
        add(module.icon, owner, "moduleIcon");
    };
    for (const entry of asList<Root>(db.characters)) {
        const owner = entry.name;
        add(entry.image, owner, "profile");
        for (const emotion of asList<unknown[]>(entry.emotionImages)) {
            add(Array.isArray(emotion) ? emotion[1] : undefined, owner, "emotion");
        }
        for (const asset of asList<unknown[]>(entry.additionalAssets)) {
            add(Array.isArray(asset) ? asset[1] : undefined, owner, "additional");
        }
        if (isPlainObject(entry.vits) && isPlainObject(entry.vits.files)) {
            for (const file of Object.values(entry.vits.files)) {
                add(file, owner, "vits");
            }
        }
        for (const asset of asList<Root>(entry.ccAssets)) {
            add(asset?.uri, owner, "ccAsset");
        }
        const sovits = entry.gptSoVitsConfig;
        if (isPlainObject(sovits) && isPlainObject(sovits.ref_audio_data)) {
            add(sovits.ref_audio_data.assetId, owner, "sovitsReference");
        }
    }
    add(db.userIcon, "", "userIcon");
    add(db.customBackground, "", "background");
    for (const persona of asList<Root>(db.personas)) {
        add(persona.icon, persona.name, "persona");
        addModule(persona.embeddedModule, typeof persona.name === "string" ? persona.name : "");
    }
    for (const folder of asList<unknown>(db.characterOrder)) {
        if (isPlainObject(folder)) {
            add(folder.img, folder.name, "folder");
            add(folder.imgFile, folder.name, "folder");
        }
    }
    for (const preset of asList<Root>(db.botPresets)) {
        add(preset.image, preset.name, "preset");
    }
    for (const module of asList<Root>(db.modules)) {
        addModule(module, typeof module.name === "string" ? module.name : "");
    }
    return [...found.values()];
}
