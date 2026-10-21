import type {
    ChatConflict,
    ChatGroupResult,
    ChatOrderConflict,
    ChatOrderRecord,
    ChatOrderResult,
    ChatRecord,
    ChatSummary,
} from "./chats.ts";
import type { Database } from "./database.ts";
import type {
    COLLECTION_FIELDS,
    COLLECTION_SELECTION_FIELDS,
    CollectionKind,
    SECTION_FIELDS,
    SectionKind,
} from "./sections.ts";

/**
 * The server resource kinds and their payloads. The client assembles `Database` from them and
 * writes them back per collection.
 */
export const RESOURCE_KIND = {
    presets: "presets",
    modules: "modules",
    plugins: "plugins",
    pluginStorage: "pluginStorage",
    pluginPermissions: "pluginPermissions",
    characters: "characters",
    inlays: "inlays",
    // The settings sections (`SECTION_KIND`) and collections (`COLLECTION_KIND`), spelled out here
    // because `shared/sections.ts` imports this module; the `satisfies` below keeps the two in
    // step.
    providers: "providers",
    secrets: "secrets",
    llmSecrets: "llmSecrets",
    ui: "ui",
    memoryTranslateMedia: "memoryTranslateMedia",
    loreBook: "loreBook",
    globalscript: "globalscript",
    hotkeys: "hotkeys",
    characterOrder: "characterOrder",
    authRefreshes: "authRefreshes",
    globalChatVariables: "globalChatVariables",
    personas: "personas",
    translatorPresets: "translatorPresets",
    hypaV3Presets: "hypaV3Presets",
    togglePresets: "togglePresets",
    customModels: "customModels",
    credentials: "credentials",
    enabledModules: "enabledModules",
    statics: "statics",
    modelPresets: "modelPresets",
    modelProfiles: "modelProfiles",
} as const satisfies { readonly [K in SectionKind | CollectionKind]: K } & Record<string, string>;

export type ResourceKindName = (typeof RESOURCE_KIND)[keyof typeof RESOURCE_KIND];

/** The only id a singleton kind (every kind except `characters` and `inlays`) accepts. */
export const SINGLETON_RESOURCE_ID = "main";

/**
 * An inlay's metadata. Media bytes live in the `assets` storage namespace under `asset`; a signature
 * keeps its JSON text in `text`.
 */
export type InlayResource = {
    name: string;
    /** File extension */
    ext: string;
    type: "image" | "video" | "audio" | "signature";
    width?: number;
    height?: number;
    /** Asset key of the media bytes (`assets/inlay_<sha256>.<ext>`) */
    asset?: string;
    /** Byte size of the media */
    size?: number;
    /** A signature's JSON text */
    text?: string;
};

/** v3 plugin permission grants. Only the host's consent flow reads or writes this record. */
export type PluginPermissionGrants = {
    /** `<sha256 of the plugin script>_<permission>` → granted */
    grants: Record<string, true>;
    /** `<plugin name>_<permission>_lastGrantTime` → epoch milliseconds of the last periodic grant */
    lastGrantTime: Record<string, number>;
};

/** Request header naming the database epoch a mutation was based on. */
export const RESOURCE_EPOCH_HEADER = "x-resource-epoch";

export type ResourceRecord<T = unknown> = { id: string; revision: string; data: T };

export type ResourceBatchOp =
    | { kind: string; id: string; baseRevision: string | null; data: unknown }
    | { kind: string; id: string; baseRevision: string; delete: true };

export type ResourceBatchResult = {
    epoch: string;
    results: { kind: string; id: string; revision: string | null }[];
    /** One result per chat group sent. */
    chats?: ChatGroupResult[];
    /** Every chat order the batch changed, including through chat creates and deletes. */
    chatOrders?: ChatOrderResult[];
};

/**
 * A resource entry of a 409: `kind` is the resource kind name. `reason: "generating"`: a character
 * delete refused because a server generation job owns one of its messages.
 */
export type ResourceConflict = { kind: string; id: string; revision: string | null; reason?: "generating" };

const revisionTokenPattern =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;

/**
 * A revision token `<epoch>:<seq>:<revision>` (the store's format: `seq` is the record's
 * incarnation, `revision` counts its writes), or null when it is not one. Only hydration ordering
 * reads tokens; everything else treats them as opaque.
 */
export function parseRevisionToken(token: unknown): { epoch: string; seq: number; revision: number } | null {
    if (typeof token !== "string") {
        return null;
    }
    const match = revisionTokenPattern.exec(token);
    if (!match) {
        return null;
    }
    const seq = Number(match[2]);
    const revision = Number(match[3]);
    return Number.isSafeInteger(seq) && Number.isSafeInteger(revision) ? { epoch: match[1], seq, revision } : null;
}

/**
 * Orders two tokens of one epoch by `(seq, revision)`: negative when `a` is older, 0 when equal,
 * positive when newer. Null across epochs or when either is not a token.
 */
export function compareRevision(a: unknown, b: unknown): number | null {
    const left = parseRevisionToken(a);
    const right = parseRevisionToken(b);
    if (!left || !right || left.epoch !== right.epoch) {
        return null;
    }
    return left.seq !== right.seq ? left.seq - right.seq : left.revision - right.revision;
}

/**
 * An entry of a batch 409. `kind` is `"chat"` or `"chatOrder"` for chat entries (both reserved as
 * resource kind names) and the resource kind name otherwise; `isChatConflict` and
 * `isChatOrderConflict` tell them apart.
 */
export type BatchConflict = ResourceConflict | ChatConflict | ChatOrderConflict;

export function isChatConflict(conflict: BatchConflict): conflict is ChatConflict {
    return conflict.kind === "chat";
}

export function isChatOrderConflict(conflict: BatchConflict): conflict is ChatOrderConflict {
    return conflict.kind === "chatOrder";
}

/** Body of a 409 from the batch route. */
export type ResourceBatchConflictBody = { error: string; conflicts: BatchConflict[] };

/** Body of a 412: the mutation named another database epoch (a restore happened). */
export type ResourceEpochMismatchBody = { error: "EpochMismatch"; epoch: string };

export type ResourceReadKindsResult = {
    epoch: string;
    kinds: Record<string, ResourceRecord[]>;
    /** With `chats=1`: every chat and every chat order. */
    chats?: ChatRecord[];
    /** With `chatSummaries=1` (not with `chats=1`): every chat's summary, without messages. */
    chatSummaries?: ChatSummary[];
    /** With `chats=1` or `chatSummaries=1`: every chat order. */
    chatOrders?: ChatOrderRecord[];
};

export type ResourceReadRefsResult = {
    epoch: string;
    items: { kind: string; id: string; revision: string | null; data: unknown }[];
    /** The named chats; a missing one has revision and data null. */
    chats?: (ChatRecord | { characterId: string; id: string; revision: null; data: null })[];
    /** The named characters' orders (null: no order) and all their chats. */
    chatCollections?: { characterId: string; order: ChatOrderRecord | null; chats: ChatRecord[] }[];
    /** The named characters' orders (null: no order) and their chats' summaries. */
    chatSummaryCollections?: { characterId: string; order: ChatOrderRecord | null; chats: ChatSummary[] }[];
};

/**
 * The boot read that skips what the client already holds: `POST RESOURCE_BOOT_PATH` with a
 * `ResourceBootRequest`, answered with a `ResourceBootResult`.
 */
export const RESOURCE_BOOT_PATH = "/api/resources/boot";

/** The boot answer's format. A client accepts omissions (`cached`, an item without `data`) only from this one. */
export const BOOT_RESOURCE_FORMAT = 1;

/** Most bytes a boot request body may have (413 past it). */
export const MAX_BOOT_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The kinds whose records a boot answer may leave out as `cached` (their revision is the known one).
 * A kind with a server `project` never is, whatever this list says.
 */
export const BOOT_CACHED_KINDS: readonly string[] = [
    RESOURCE_KIND.characters,
    RESOURCE_KIND.modules,
    RESOURCE_KIND.presets,
];

/**
 * The cached kinds whose array records a boot answer sends item by item (`items`) when their revision
 * is not the known one, leaving out the data of every item whose hash the client named.
 */
export const BOOT_ITEM_KINDS: readonly string[] = [RESOURCE_KIND.modules, RESOURCE_KIND.presets];

/**
 * An item hash: SHA-256 of the UTF-8 bytes of `JSON.stringify(item)` for the item as `JSON.parse` of
 * the stored record gives it (the item as a full read sends it, so the client's `JSON.stringify` of a
 * received item is the same text), base64url, first 22 characters (132 bits).
 */
export const BOOT_ITEM_HASH_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type ResourceBootRequest = {
    /** As `GET /api/resources?kinds=`: at least one, every one registered; duplicates count once. */
    kinds: string[];
    /** As `chatSummaries=1`: every chat's summary and every chat order. */
    chatSummaries?: true;
    /**
     * What the client holds. Entries of kinds not requested, not cached, or unknown are ignored. A
     * record named twice with two revisions is a miss; hashes of one kind named in several entries add up.
     */
    known?: {
        records?: { kind: string; id: string; revision: string }[];
        items?: { kind: string; hashes: string[] }[];
    };
};

/** One array position of an item record: `data` present (as a property) unless the client named `hash`. */
export type ResourceBootItem = { hash: string; data?: unknown };

/**
 * A boot answer's record: whole (`data`); `cached` (the client's copy at `revision` is current); or,
 * for a `BOOT_ITEM_KINDS` array record, one `items` entry per array position in order (duplicates
 * kept), whose `data` values in order rebuild the record's array.
 */
export type ResourceBootRecord =
    | (ResourceRecord & { cached?: never; items?: never })
    | { id: string; revision: string; cached: true; data?: never; items?: never }
    | { id: string; revision: string; items: ResourceBootItem[]; cached?: never; data?: never };

/** `ResourceReadKindsResult` with `chatSummaries` as asked, and records that may be `cached` or `items`. */
export type ResourceBootResult = {
    format: typeof BOOT_RESOURCE_FORMAT;
    epoch: string;
    /** Every requested kind, each record in creation order (as `GET /api/resources`). */
    kinds: Record<string, ResourceBootRecord[]>;
    chatSummaries?: ChatSummary[];
    chatOrders?: ChatOrderRecord[];
};

/**
 * The top-level field change of one write of an object record (a field patch): the record at the
 * entry's revision equals the record at `baseRevision` (the same incarnation, one write earlier) with
 * every `set` field assigned its stored value and every `remove` field deleted. Values compare as
 * JSON values; top-level key order is not part of it. A client saves a changed character with one
 * (a `patch` batch op), and a send job stamps `lastInteraction` with one.
 */
export type RecordFieldPatch = { baseRevision: string; set: Record<string, unknown>; remove: string[] };

/** One item's top-level field change inside a `RecordItemPatch` (the item keeps its `id`). */
export type RecordItemFieldPatch = { id: string; set: Record<string, unknown>; remove: string[] };

/**
 * The item change of one write of an array record whose items are objects with unique non-empty
 * string `id`s (`modules`): the record at the entry's revision is the record at `baseRevision` with
 * every `items` element put whole in place of the item of its id (or added), and every `changes`
 * entry applied to the base item of its id as a field patch. With `order` (also `[]`) the result is
 * exactly the items of `order` in that order (a base id it leaves out is removed); without it the ids
 * and their order are the base's. Values compare as JSON values; an item's key order is not part of it.
 */
export type RecordItemPatch = {
    baseRevision: string;
    items: Record<string, unknown>[];
    changes: RecordItemFieldPatch[];
    order?: string[];
};

/** A record patch: by top-level field (object records) or by item id (array records). */
export type RecordPatch = RecordFieldPatch | RecordItemPatch;

/**
 * A chat's stored changes from `baseRevision` to the containing entry's revision. `messages` holds
 * new or changed rows once each, in final stored order, with the preceding row's id (`after`, null
 * at the start). `removed` names deleted ids; `meta`, when present, replaces all chat fields except
 * `message`. `count` is the final message count. Job socket patches also carry generated rows.
 */
export type ChatPatchBody = {
    baseRevision: string;
    meta?: Record<string, unknown>;
    removed?: string[];
    messages?: { after: string | null; message: unknown }[];
    count: number;
};

/** The largest record or chat patch (UTF-8 bytes of its JSON) a feed entry carries; larger ones are plain refs. */
export const MAX_FEED_PATCH_BYTES = 64 * 1024;

/**
 * What one committed write changed (live updates): refs and their new revisions, and data only as a
 * record patch (`RecordPatch`) or a by-id chat patch (`ChatPatchBody`). A `null` revision is a
 * deletion. A record or chat recorded more than once in the write appears once with its final
 * revision and no patch. A client holding exactly a patch's base revision may apply it when idle (a
 * chat must also be loaded and not stale); otherwise it handles the plain notice as before. Chat
 * revisions advance by the applied op count, not necessarily one. Whole-chat writes, no-op groups,
 * remove-and-reappend groups, and patches over `MAX_FEED_PATCH_BYTES` carry no chat patch.
 */
export type ChangeSet = {
    resources: { kind: string; id: string; revision: string | null; patch?: RecordPatch }[];
    chats: { characterId: string; id: string; revision: string | null; patch?: ChatPatchBody }[];
    chatOrders: { characterId: string; revision: string | null }[];
};

/** `GET /api/resources/revisions`: every record, chat, and chat order the server holds, with its revision. */
export type ResourceRevisionListing = {
    epoch: string;
    resources: { kind: string; id: string; revision: string }[];
    chats: { characterId: string; id: string; revision: string }[];
    chatOrders: { characterId: string; revision: string }[];
};

export type BackupSnapshotInfo = { id: string; createdAt: string; size: number };

/** First record of a local backup archive (format version 2). */
export type BackupArchiveManifest = {
    version: 2;
    createdAt: string;
    partial: boolean;
    /** Logical asset keys stored in the archive, in record order. */
    assets: string[];
    /** Requested or selected asset keys that were not found. */
    missing: string[];
};

/**
 * The section payloads. A section record holds its `SECTION_FIELDS` under their `Database` names;
 * `llmSecrets` also holds the named credential values by credential record id.
 */
export type SectionResource<K extends SectionKind> = Pick<Database, (typeof SECTION_FIELDS)[K][number]>;

/** The stored record (the server's view); a client reads `MaskedLlmSecrets` (`shared/llmSecrets.ts`). */
export type LlmSecretsResource = SectionResource<"llmSecrets"> & {
    /** Named credential values, by credential record id. */
    credentials: Record<string, { key: string }>;
};

type SelectableCollection = keyof typeof COLLECTION_SELECTION_FIELDS;

/** A collection record: the field's value as-is, or `{ items, selectedId }` for the two preset lists. */
export type CollectionResource<K extends CollectionKind> = K extends SelectableCollection
    ? { items: Database[(typeof COLLECTION_FIELDS)[K]]; selectedId: string }
    : Database[(typeof COLLECTION_FIELDS)[K]];
