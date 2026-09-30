import type {
    ChatConflict,
    ChatGroupResult,
    ChatOrderConflict,
    ChatOrderRecord,
    ChatOrderResult,
    ChatRecord,
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
    root: "root",
    presets: "presets",
    modules: "modules",
    plugins: "plugins",
    pluginStorage: "pluginStorage",
    pluginPermissions: "pluginPermissions",
    characters: "characters",
    inlays: "inlays",
} as const;

export type ResourceKindName = (typeof RESOURCE_KIND)[keyof typeof RESOURCE_KIND];

/** The only id a singleton kind (every kind except `characters` and `inlays`) accepts. */
export const SINGLETON_RESOURCE_ID = "main";

/** `Database` fields that have a resource of their own; `root` holds every other field. */
export const ROOT_EXCLUDED_KEYS = ["characters", "botPresets", "modules", "plugins", "pluginCustomStorage"] as const;

export type RootResource = Omit<Database, (typeof ROOT_EXCLUDED_KEYS)[number]>;

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

/** A resource entry of a 409: `kind` is the resource kind name. */
export type ResourceConflict = { kind: string; id: string; revision: string | null };

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
    chatOrders?: ChatOrderRecord[];
};

export type ResourceReadRefsResult = {
    epoch: string;
    items: { kind: string; id: string; revision: string | null; data: unknown }[];
    /** The named chats; a missing one has revision and data null. */
    chats?: (ChatRecord | { characterId: string; id: string; revision: null; data: null })[];
    /** The named characters' orders (null: no order) and all their chats. */
    chatCollections?: { characterId: string; order: ChatOrderRecord | null; chats: ChatRecord[] }[];
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
 * Phase 3 payloads (the kinds are registered in slice 3). A section record holds its
 * `SECTION_FIELDS` under their `Database` names; `llmSecrets` also holds the per-preset `proxyKey`
 * map, keyed by preset id.
 */
export type SectionResource<K extends SectionKind> = Pick<Database, (typeof SECTION_FIELDS)[K][number]>;

export type LlmSecretsResource = SectionResource<"llmSecrets"> & {
    presets: Record<string, { proxyKey: string }>;
};

type SelectableCollection = keyof typeof COLLECTION_SELECTION_FIELDS;

/** A collection record: the field's value as-is, or `{ items, selectedId }` for the two preset lists. */
export type CollectionResource<K extends CollectionKind> = K extends SelectableCollection
    ? { items: Database[(typeof COLLECTION_FIELDS)[K]]; selectedId: string }
    : Database[(typeof COLLECTION_FIELDS)[K]];
