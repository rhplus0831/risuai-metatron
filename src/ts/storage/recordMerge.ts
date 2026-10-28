import isEqual from "lodash/isEqual";
import { itemIds } from "../../../shared/recordPatch.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { CollectionKind, SectionKind } from "../../../shared/sections.ts";

export const ABSENT = Symbol("absent");
const CONFLICT = Symbol("conflict");
type Fields = Record<string, unknown>;
type Groups = readonly (readonly string[])[];

/** Selector/configuration tuples are atomic; every unlisted field is an independent unit. */
const SECTION_MERGE_GROUPS = {
    providers: [
        ["additionalParams", "applyAdditionalParamsToAll"],
        ["autoContinueChat", "autoContinueMinTokens"],
    ],
    secrets: [],
    ui: [
        ["colorScheme", "colorSchemeName", "customColorScheme"],
        ["textTheme", "customTextTheme"],
        ["font", "customFont"],
        ["customQuotes", "customQuotesData"],
        ["useAutoSuggestions", "autoSuggestClean"],
    ],
    memoryTranslateMedia: [["supaModelType", "hanuraiEnable", "hanuraiTokens", "hanuraiSplit", "hypav2", "hypaV3"]],
} as const satisfies Record<Exclude<SectionKind, "llmSecrets">, Groups>;

/** Parallel arrays, permission/configuration pairs, and authoring selectors stay together. */
const CHARACTER_MERGE_GROUPS: Groups = [
    ["characters", "characterTalks", "characterActive"],
    ["supaMemory", "supaMemoryOnCount"],
    ["viewScreen", "inlayViewScreen", "newGenData"],
    ["lowLevelAccess", "triggerscript"],
    [
        "ttsMode",
        "ttsSpeech",
        "voicevoxConfig",
        "naittsConfig",
        "gptSoVitsConfig",
        "fishSpeechConfig",
        "oaiVoice",
        "oaiTTSConfig",
        "hfTTS",
        "vits",
    ],
    ["alternateGreetings", "firstMsgIndex"],
];

/** Id shape alone does not grant item independence; required collections cannot merge to empty. */
const COLLECTION_MERGE_POLICIES = {
    presets: "nonemptyItems",
    modules: "items",
    personas: "nonemptyItems",
    credentials: "items",
    modelPresets: "nonemptyItems",
    modelProfiles: "nonemptyItems",
    togglePresets: "items",
    customModels: "items",
    translatorPresets: "selectedItems",
    hypaV3Presets: "selectedItems",
    loreBook: "whole",
    plugins: "whole",
    hotkeys: "whole",
    authRefreshes: "whole",
    characterOrder: "whole",
    globalscript: "whole",
    globalChatVariables: "whole",
    enabledModules: "whole",
    pluginStorage: "dictionary",
    statics: "counts",
} as const satisfies Record<CollectionKind | "presets" | "modules" | "plugins" | "pluginStorage", string>;

/** An absent own field differs from null, including for names inherited from Object.prototype. */
export function fieldOf(record: Fields, field: string): unknown {
    return Object.hasOwn(record, field) ? record[field] : ABSENT;
}

/** Unchanged or equal changes converge; different concurrent changes of one unit conflict. */
function mergeUnit(base: unknown, theirs: unknown, ours: unknown): unknown {
    if (isEqual(theirs, base) || isEqual(theirs, ours)) return ours;
    return isEqual(ours, base) ? theirs : CONFLICT;
}

/** Merges whole field values and declared tuples, preserving every present key as an own key. */
function mergeFields(
    base: Fields,
    theirs: Fields,
    ours: Fields,
    groups: Groups,
    mergeField: (field: string, base: unknown, theirs: unknown, ours: unknown) => unknown = (_field, b, t, o) =>
        mergeUnit(b, t, o),
    excluded: readonly string[] = [],
): Fields | null {
    const entries = new Map<string, unknown>();
    const grouped = new Set([...groups.flat(), ...excluded]);
    for (const group of groups) {
        const tuple = (record: Fields) => group.map((field) => fieldOf(record, field));
        const merged = mergeUnit(tuple(base), tuple(theirs), tuple(ours));
        if (merged === CONFLICT) return null;
        group.forEach((field, index) => entries.set(field, (merged as unknown[])[index]));
    }
    for (const field of new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(ours)])) {
        if (grouped.has(field)) continue;
        const value = mergeField(field, fieldOf(base, field), fieldOf(theirs, field), fieldOf(ours, field));
        if (value === CONFLICT) return null;
        entries.set(field, value);
    }
    return Object.fromEntries([...entries].filter(([, value]) => value !== ABSENT));
}

/** Sections merge unknown fields too; llmSecrets uses its separate sibling-body contract. */
export function mergeSectionFields(
    kind: Exclude<SectionKind, "llmSecrets">,
    base: unknown,
    theirs: unknown,
    ours: unknown,
): Fields | null {
    if (!isPlainObject(base) || !isPlainObject(theirs) || !isPlainObject(ours)) return null;
    return mergeFields(base, theirs, ours, SECTION_MERGE_GROUPS[kind]);
}

/** A stamp is a finite number; absent and non-numeric values retain the existing refusal rules. */
function isStamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** Fixed identity/kind fields must agree; the server clock wins an untouched stamp, else the later stamp wins. */
function mergeCharacterField(field: string, base: unknown, theirs: unknown, ours: unknown): unknown {
    if (field === "chaId" || field === "type") return isEqual(theirs, ours) ? ours : CONFLICT;
    if (field !== "lastInteraction") return mergeUnit(base, theirs, ours);
    if (isEqual(theirs, ours) || (isStamp(theirs) && (ours === ABSENT || isEqual(ours, base)))) return theirs;
    if (!isStamp(theirs) && theirs === base) return ours;
    if (!isStamp(theirs) || !isStamp(ours)) return CONFLICT;
    return Math.max(theirs, ours);
}

/** Stored character fields merge atomically by tuple or field, with the send stamp kept separate. */
export function mergeCharacterFields(base: Fields, theirs: Fields, ours: Fields): Fields | null {
    return mergeFields(base, theirs, ours, CHARACTER_MERGE_GROUPS, mergeCharacterField);
}

/** Only explicitly id-addressed kinds participate in item merging. */
export function isItemMergeKind(kind: string): kind is keyof typeof COLLECTION_MERGE_POLICIES {
    if (!Object.hasOwn(COLLECTION_MERGE_POLICIES, kind)) return false;
    const policy = COLLECTION_MERGE_POLICIES[kind as keyof typeof COLLECTION_MERGE_POLICIES];
    return policy === "items" || policy === "nonemptyItems" || policy === "selectedItems";
}

/** Whole items merge by id; both reorders conflict, one reorder wins, otherwise server order wins. */
function mergeItems(base: unknown, theirs: unknown, ours: unknown): Fields[] | null {
    const [baseIds, theirIds, ourIds] = [itemIds(base), itemIds(theirs), itemIds(ours)];
    if (!baseIds || !theirIds || !ourIds) return null;
    const byId = (list: unknown, ids: string[]) => new Map(ids.map((id, index) => [id, (list as Fields[])[index]]));
    const [saved, remote, local] = [byId(base, baseIds), byId(theirs, theirIds), byId(ours, ourIds)];
    const merged = new Map<string, Fields>();
    for (const id of new Set([...baseIds, ...theirIds, ...ourIds])) {
        const value = mergeUnit(saved.get(id) ?? ABSENT, remote.get(id) ?? ABSENT, local.get(id) ?? ABSENT);
        if (value === CONFLICT) return null;
        if (value !== ABSENT) merged.set(id, value as Fields);
    }
    const surviving = baseIds.filter((id) => merged.has(id));
    const survivingSet = new Set(surviving);
    const reordered = (ids: string[]) =>
        !isEqual(
            ids.filter((id) => survivingSet.has(id)),
            surviving,
        );
    const theirReorder = reordered(theirIds);
    const ourReorder = reordered(ourIds);
    if (theirReorder && ourReorder) return null;
    const [first, second] = ourReorder ? [ourIds, theirIds] : [theirIds, ourIds];
    return [...new Set([...first, ...second])].filter((id) => merged.has(id)).map((id) => merged.get(id)!);
}

/** Selectable lists keep a sole surviving local selection change; otherwise remote selection must survive. */
function mergeSelectedItems(base: unknown, theirs: unknown, ours: unknown): Fields | null {
    if (!isPlainObject(base) || !isPlainObject(theirs) || !isPlainObject(ours)) return null;
    const items = mergeItems(fieldOf(base, "items"), fieldOf(theirs, "items"), fieldOf(ours, "items"));
    if (!items || items.length === 0) return null;
    const [b, t, o] = [base, theirs, ours].map((record) => fieldOf(record, "selectedId"));
    const exists = (id: unknown) => items.some((item) => item.id === id);
    const selectedId = !isEqual(o, b) && isEqual(t, b) && exists(o) ? o : t;
    if (!exists(selectedId)) return null;
    const fields = mergeFields(base, theirs, ours, [], undefined, ["items", "selectedId"]);
    return fields && { ...fields, items, selectedId };
}

/** Item collections allow concurrent creation against an empty base; malformed ids or invalid results conflict. */
export function mergeItemCollection(
    kind: keyof typeof COLLECTION_MERGE_POLICIES,
    base: unknown,
    theirs: unknown,
    ours: unknown,
): Fields[] | Fields | null {
    const policy = COLLECTION_MERGE_POLICIES[kind];
    if (policy === "selectedItems") return mergeSelectedItems(base === ABSENT ? { items: [] } : base, theirs, ours);
    if (policy !== "items" && policy !== "nonemptyItems") return null;
    const items = mergeItems(base === ABSENT ? [] : base, theirs, ours);
    return items && (items.length > 0 || policy === "items") ? items : null;
}
