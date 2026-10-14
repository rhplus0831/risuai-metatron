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
 * The server resource kinds and their payloads (Phase 1 of `docs/plan/PLAN.md`). The client
 * assembles `Database` from them and writes them back per collection.
 */
export const RESOURCE_KIND = {
    presets: "presets",
    modules: "modules",
    plugins: "plugins",
    pluginStorage: "pluginStorage",
    pluginPermissions: "pluginPermissions",
    characters: "characters",
    inlays: "inlays",
    // Phase 3 sections (`SECTION_KIND`) and collections (`COLLECTION_KIND`), spelled out here because
    // `shared/sections.ts` imports this module; the `satisfies` below keeps the two in step.
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
    /** One result per chat group sent (Phase 2). */
    chats?: ChatGroupResult[];
    /** Every chat order the batch changed, including through chat creates and deletes. */
    chatOrders?: ChatOrderResult[];
};

/**
 * A resource entry of a 409: `kind` is the resource kind name. `reason: "generating"`: a character
 * delete refused because a server generation job owns one of its messages (Phase 5).
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
 * The top-level field change of one write of an object record (a field patch): the record at the
 * entry's revision equals the record at `baseRevision` (the same incarnation, one write earlier) with
 * every `set` field assigned its stored value and every `remove` field deleted. Values compare as
 * JSON values; top-level key order is not part of it. The store writes one with a `patch` batch op
 * (store-internal for now; a send job's `lastInteraction` stamp). Array records (`modules`) have
 * none; a later variant would name its items by id.
 */
export type RecordFieldPatch = { baseRevision: string; set: Record<string, unknown>; remove: string[] };

/** The largest field patch (UTF-8 bytes of its JSON) a change-feed entry carries; a larger one is a plain ref. */
export const MAX_FEED_PATCH_BYTES = 64 * 1024;

/**
 * What one committed write changed (Phase 6 live updates): refs and their new revisions, and data
 * only as a field patch. A `null` revision is a deletion. A record that changed more than once in the
 * write appears once, with its final revision and no patch. `patch`: the write was a field patch (see
 * `RecordFieldPatch`); a client holding exactly its base revision may apply it instead of reading the
 * record, any other client reads the record as for a plain ref.
 */
export type ChangeSet = {
    resources: { kind: string; id: string; revision: string | null; patch?: RecordFieldPatch }[];
    chats: { characterId: string; id: string; revision: string | null }[];
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
    /** Requested asset keys that were not found. */
    missing: string[];
};

/**
 * Phase 3 payloads. A section record holds its `SECTION_FIELDS` under their `Database` names;
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
