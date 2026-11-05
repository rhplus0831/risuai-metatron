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
import type { StreamingMessage } from "./jobs.ts";
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
 * incarnation, `revision` counts its writes), or null when it is not one. Hydration orders tokens;
 * boot expansion also uses `seq` to rebuild the plain read's order within each table.
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

/**
 * A whole chat read with the server's current generation locks, sampled synchronously with the
 * chat (the same per-chat list as the live-update `hello`). `[]` authoritatively means no locks;
 * omitted means unknown (an older server). Read metadata only, never persisted in `ChatRecord.data`.
 */
export type ChatReadRecord = ChatRecord & { streaming?: StreamingMessage[] };

export type ResourceReadKindsResult = {
    epoch: string;
    kinds: Record<string, ResourceRecord[]>;
    /** With `chats=1`: every chat and every chat order. */
    chats?: ChatReadRecord[];
    /** With `chatSummaries=1` (not with `chats=1`): every chat's summary, without messages. */
    chatSummaries?: ChatSummary[];
    /** With `chats=1` or `chatSummaries=1`: every chat order. */
    chatOrders?: ChatOrderRecord[];
};

export type ResourceReadRefsResult = {
    epoch: string;
    items: { kind: string; id: string; revision: string | null; data: unknown }[];
    /** The named chats; a missing one has revision and data null. */
    chats?: (ChatReadRecord | { characterId: string; id: string; revision: null; data: null })[];
    /** Named rows at exactly the requested revision; a moved or missing chat is an answer, not a deferral. */
    chatRows?: ChatRowsReadResult[];
    /** The named characters' orders (null: no order) and all their chats. */
    chatCollections?: { characterId: string; order: ChatOrderRecord | null; chats: ChatReadRecord[] }[];
    /** The named characters' orders (null: no order) and their chats' summaries. */
    chatSummaryCollections?: { characterId: string; order: ChatOrderRecord | null; chats: ChatSummary[] }[];
};

/** Stored rows and named metadata fields, or the current revision when that requested is no longer held. */
export type ChatRowsReadResult =
    | {
          characterId: string;
          id: string;
          revision: string;
          rows: { id: string; after: string | null; message: Record<string, unknown> }[];
          metaFields?: ChatMetaFields;
      }
    | { characterId: string; id: string; revision: string | null; moved: true };

/**
 * What one answer of `POST /api/resources/read` is charged at most, for a client that sent
 * `continue: true`: stored bytes (a record's text, a chat's metadata and message rows, a collection's
 * order and chats, a summary collection's order and stored projections, or named rows and metadata),
 * not the bytes on the wire. A soft budget: an answer's first group is served whatever its size, so nothing grows past
 * being readable.
 */
export const MAX_READ_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The entries a read names. `kind` is the resource kind name. */
export type ResourceReadEntries = {
    refs: readonly { kind: string; id: string }[];
    chats: readonly { characterId: string; id: string }[];
    chatRows: readonly { characterId: string; id: string; revision: string; messageIds: string[]; meta: string[] }[];
    chatCollections: readonly string[];
    chatSummaryCollections: readonly string[];
};

/**
 * The body of `POST /api/resources/read`. `continue: true` says the client re-sends what an answer
 * leaves `unanswered`. Without it the answer is whole: an older open tab takes an entry absent from
 * an answer for an entry absent from the server.
 */
export type ResourceReadRequest = Partial<ResourceReadEntries> & { continue?: boolean };

/**
 * The answer as the route sends it: `ResourceReadRefsResult`, each entry listed once, plus `unanswered`
 * when `continue: true` met the budget. `unanswered` names what was left out, in the request's
 * shapes and with every list present. A character's record and its two collection entries are served
 * or left out together; every other entry, including a chatRows entry, stands alone. A client
 * re-sends the lists as they are.
 */
export type ResourceReadRefsAnswer = ResourceReadRefsResult & { unanswered?: ResourceReadEntries };

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
 * Every resource kind's disk-cache policy. `eligible` means permitted but not worth a claim at its
 * measured size. A kind with a server `project` is never cached, whatever this table says.
 */
export const BOOT_CACHE_ELIGIBILITY = {
    characters: { decision: "cached", reason: "Whole records, except a non-empty oaiTTSConfig.apiKey." },
    modules: {
        decision: "cached",
        reason: "Array records with item hashes; no managed credential field or projection.",
    },
    presets: {
        decision: "cached",
        reason: "Prompt preset arrays with item hashes; no managed credential field or projection.",
    },
    inlays: { decision: "cached", reason: "Whole records; no managed credential field, no projection." },
    plugins: { decision: "never", reason: "Plugin values stay out of the boot cache." },
    pluginStorage: { decision: "never", reason: "Plugin values stay out of the boot cache." },
    pluginPermissions: { decision: "never", reason: "Host consent grants stay out of the boot cache." },
    providers: { decision: "never", reason: "additionalParams header lines can carry credentials." },
    secrets: { decision: "never", reason: "Client-readable auxiliary credentials." },
    llmSecrets: { decision: "never", reason: "Managed credentials and a masked server projection." },
    memoryTranslateMedia: {
        decision: "never",
        reason: "Endpoint URLs and workflow/config content can carry credentials.",
    },
    authRefreshes: { decision: "never", reason: "Refresh tokens." },
    customModels: { decision: "never", reason: "Model params and header lines can carry credentials." },
    credentials: { decision: "never", reason: "Credential records are excluded by policy; values live in llmSecrets." },
    modelProfiles: { decision: "never", reason: "Endpoint URLs and connection config can carry credentials." },
    ui: { decision: "eligible", reason: "Display preferences; measured payload under 3 KB." },
    loreBook: { decision: "eligible", reason: "Lore content; measured payload under 3 KB." },
    globalscript: { decision: "eligible", reason: "Script content; measured payload under 3 KB." },
    hotkeys: { decision: "eligible", reason: "Key bindings; measured payload under 3 KB." },
    characterOrder: { decision: "eligible", reason: "Character ordering; measured payload under 3 KB." },
    globalChatVariables: { decision: "eligible", reason: "Chat variables; measured payload under 3 KB." },
    personas: { decision: "eligible", reason: "Persona content; measured payload under 3 KB." },
    translatorPresets: {
        decision: "eligible",
        reason: "Translation prompts and options; measured payload under 3 KB.",
    },
    hypaV3Presets: { decision: "eligible", reason: "Memory prompts and options; measured payload under 3 KB." },
    togglePresets: { decision: "eligible", reason: "Toggle values; measured payload under 3 KB." },
    enabledModules: { decision: "eligible", reason: "Module ids; measured payload under 3 KB." },
    statics: { decision: "eligible", reason: "Static asset references; measured payload under 3 KB." },
    modelPresets: { decision: "eligible", reason: "Profile slot references and options; measured payload under 3 KB." },
} as const satisfies {
    readonly [K in ResourceKindName]: { decision: "cached" | "eligible" | "never"; reason: string };
};

/** Only measured worthwhile kinds are cached; eligible kinds remain full reads. Free-form content may contain secrets. */
export const BOOT_CACHED_KINDS: readonly string[] = Object.values(RESOURCE_KIND).filter(
    (kind) => BOOT_CACHE_ELIGIBILITY[kind].decision === "cached",
);

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
        /** Complete per-character summaries and order; conflicting claims for one character are a miss. */
        chatCollections?: { characterId: string; claim: string }[];
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
    /** Producer's summary projection format; present whenever summaries are requested. */
    chatSummaryFormat?: number;
    /** Characters whose summaries AND order were omitted for an exact collection claim. */
    cachedChatCollections?: string[];
};

/**
 * The top-level field change of one write of an object record (a field patch): the record at the
 * entry's revision equals the record at `baseRevision` (the same incarnation, one write earlier) with
 * every `set` field assigned its stored value and every `remove` field deleted. Values compare as
 * JSON values; top-level key order is not part of it. A client saves a changed character with one
 * (a `patch` batch op).
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
 * `message`. `count` is the final message count. Job socket patches also carry generated rows and
 * always carry the metadata whole.
 */
export type ChatPatchBody = {
    baseRevision: string;
    meta?: Record<string, unknown>;
    removed?: string[];
    messages?: { after: string | null; message: unknown }[];
    count: number;
};

/**
 * A chat's metadata change by field, from the stored metadata at a `ChatDeltaBody`'s base to the
 * stored metadata at its entry's revision: `remove` names the top-level fields gone, `set` the ones
 * added or changed (each whole). For a `CHAT_META_MERGE_KEYS` field that is a map at both revisions,
 * `mergeUnset` names its entries gone and `merge` its entries added or changed (each whole), and the
 * field is in neither `set` nor `remove`; a field that becomes or stops being a map, or appears or
 * disappears whole, is in `set` or `remove`. Values compare as JSON values; key order is not part of it.
 */
export type ChatMetaFields = {
    set: Record<string, unknown>;
    remove: string[];
    merge?: Record<string, Record<string, unknown>>;
    mergeUnset?: Record<string, string[]>;
};

/**
 * A `ChatPatchBody` whose metadata comes by field (`metaFields`; absent: unchanged) instead of whole.
 * A feed entry carries it when the whole metadata would pass `MAX_FEED_PATCH_BYTES`.
 */
export type ChatDeltaBody = Omit<ChatPatchBody, "meta"> & { metaFields?: ChatMetaFields };

/**
 * One existing row's change from the stored base to the group's result. Fields compare as JSON
 * values, without key order: `set` holds added or changed values whole, `unset` names fields gone.
 * `data` comes separately as its common prefix length in UTF-16 code units and the remaining text.
 * Optional feed-only data for older clients: `fields` and `text` are independently absent when
 * unchanged; the id needs no anchor because surviving existing rows never reorder in a by-id group.
 */
export type ChatRowDiff = {
    id: string;
    fields?: { set: Record<string, unknown>; unset: string[] };
    text?: { keep: number; text: string };
};

/**
 * An optional feed body older clients ignore: metadata by field, eligible existing rows in
 * `rowDiffs`, other changed rows whole in `messages` with their anchors. Never a job socket body.
 * `rowDiffs` is required within this body; older servers omit the entire `rowDelta` field.
 */
export type ChatRowDeltaBody = ChatDeltaBody & { rowDiffs: ChatRowDiff[] };

/**
 * Optional for older clients and servers: a body-less chat entry names the stored rows and metadata
 * fields to read at its revision. Mutually exclusive with `patch`, `delta`, and `rowDelta`.
 */
export type ChatRowsManifest = {
    baseRevision: string;
    changed: string[];
    removed: string[];
    count: number;
    meta: string[];
};

/**
 * The largest record patch, chat body, or row manifest (UTF-8 bytes of its JSON) a feed entry carries.
 * A chat has at most one body of `patch`, `delta`, `rowDelta`: a patch below `SMALL_FEED_PATCH_BYTES`,
 * else a fitting rowDelta with row diffs smaller than the whole patch, else a fitting patch, else a
 * fitting delta.
 * If none fits, the entry carries a `rows` manifest only if it fits this same cap.
 */
export const MAX_FEED_PATCH_BYTES = 64 * 1024;

/** Selection threshold, not a cap: whole-row patches below it take precedence over row diffs. */
export const SMALL_FEED_PATCH_BYTES = 8 * 1024;

/**
 * The most optional-payload bytes one `change` frame carries: the UTF-8 bytes of the JSON of each
 * record `patch`, chat `patch`, `delta`, `rowDelta`, `rows`, `summary`, and `summaryBase`, summed in wire
 * order. A chat carries at most one body or manifest, selected as `MAX_FEED_PATCH_BYTES` describes.
 * A payload that would pass this budget is left out.
 */
export const MAX_FEED_PUBLICATION_PATCH_BYTES = 256 * 1024;

/**
 * What one committed write changed (live updates): refs and their new revisions, and data only as
 * optional payloads: a record patch (`RecordPatch`), and for a chat a by-id change (`patch`, `delta`
 * with metadata by field, or `rowDelta` with row diffs too), or a `rows` manifest, plus summary
 * knowledge. A `null` revision is a deletion. A record or chat recorded more than once in the write
 * appears once with its final revision and no body or manifest. A client holding exactly a body's base revision may
 * apply it when idle (a chat must also be loaded and not stale); otherwise it handles the plain
 * notice as before. Chat revisions advance by the applied op count, not necessarily one. Whole-chat
 * writes, no-op groups and remove-and-reappend groups carry no body or manifest. An entry carries
 * at most one of `patch`, `delta`, `rowDelta`, `rows`: a whole-row patch below
 * `SMALL_FEED_PATCH_BYTES`; else a rowDelta with at least one row diff that fits the cap and is
 * strictly smaller than the patch; else a fitting patch; else a fitting delta; else a fitting `rows`
 * manifest. A loaded, idle chat at the manifest's base reads those rows and named metadata fields at
 * the entry's revision; a moved answer or apply miss reads the chat whole. These bodies and manifests
 * are optional for older clients and servers: a client that does not know `rowDelta` or `rows` takes
 * the notice and reads whole, without advancing its revision from a body it cannot apply.
 *
 * A chat entry carries at most one of `summary` (the chat's summary at the entry's revision, when
 * the write changed it) and `summaryBase` (a revision, the stored one right before the write: the
 * summary, `revision` aside, is the same as at that revision). Neither means unknown: a whole-chat
 * write, a no-op group, a deletion, a payload left out, or a chat recorded twice without that proof.
 * The payloads of one publication share `MAX_FEED_PUBLICATION_PATCH_BYTES`: taken in wire order
 * (resources, then chats; within a chat entry `patch`, `delta`, `rowDelta`, `rows`, `summary`, `summaryBase`),
 * one that does not fit is left out of its entry, and a later smaller one may still fit.
 */
export type ChangeSet = {
    resources: { kind: string; id: string; revision: string | null; patch?: RecordPatch }[];
    chats: {
        characterId: string;
        id: string;
        revision: string | null;
        patch?: ChatPatchBody;
        delta?: ChatDeltaBody;
        /** Optional for older clients and servers; mutually exclusive with `patch`, `delta`, and `rows`. */
        rowDelta?: ChatRowDeltaBody;
        /** Optional for older clients and servers; mutually exclusive with all three bodies. */
        rows?: ChatRowsManifest;
        summary?: ChatSummary;
        summaryBase?: string;
    }[];
    chatOrders: { characterId: string; revision: string | null }[];
};

/** `GET /api/resources/revisions`: every record, chat, and chat order the server holds, with its revision. */
export type ResourceRevisionListing = {
    epoch: string;
    resources: { kind: string; id: string; revision: string }[];
    chats: { characterId: string; id: string; revision: string }[];
    chatOrders: { characterId: string; revision: string }[];
};

/**
 * `GET /api/resources/revisions?since=&until=&epoch=`: refs with `since < cursor <= until`,
 * coalesced per key, without payloads. A different epoch returns only its epoch and current cursor.
 * Older servers omit the replay fields; callers then use the whole revision listing.
 */
export type ResourceChangesSince = {
    epoch: string;
    /** Optional on older servers. The requested `until`, or the high-water cursor if unavailable. */
    cursor?: number;
    /** Optional on older servers and unavailable replays; null revisions are deletion tombstones. */
    changes?: ChangeSet;
    /** Optional on older servers; true when the bounds are outside the retained coverage. */
    expired?: boolean;
};

const revisionEncoder = new TextEncoder();
const murmurMultipliers = [0x239b961b, 0xab0e9789, 0x38b34ae5, 0xa1e38b93];
const murmurAddends = [0x561ccd1b, 0x0bcaa747, 0x96cd1c35, 0x32ac3b17];

function rotateLeft32(value: number, bits: number): number {
    return (value << bits) | (value >>> (32 - bits));
}

/** MurmurHash3 x86_128 (Austin Appleby's public-domain algorithm), with h1 as the low word. */
function murmurHash128(bytes: Uint8Array, seed = 0): bigint {
    const h = [seed, seed, seed, seed];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.length - (bytes.length % 16);
    for (let offset = 0; offset < end; offset += 16) {
        for (let lane = 0; lane < 4; lane++) {
            const next = (lane + 1) % 4;
            const word = Math.imul(view.getUint32(offset + lane * 4, true), murmurMultipliers[lane]);
            h[lane] ^= Math.imul(rotateLeft32(word, 15 + lane), murmurMultipliers[next]);
            h[lane] = (Math.imul(rotateLeft32(h[lane], 19 - lane * 2) + h[next], 5) + murmurAddends[lane]) | 0;
        }
    }
    // The tail has up to four little-endian words, with no body-state rotation or addition.
    for (let offset = end, lane = 0; offset < bytes.length; offset += 4, lane++) {
        let word = 0;
        for (let byte = 0; byte < Math.min(4, bytes.length - offset); byte++) {
            word |= bytes[offset + byte] << (byte * 8);
        }
        word = Math.imul(word, murmurMultipliers[lane]);
        h[lane] ^= Math.imul(rotateLeft32(word, 15 + lane), murmurMultipliers[(lane + 1) % 4]);
    }
    for (let lane = 0; lane < 4; lane++) h[lane] ^= bytes.length;
    h[0] = (h[0] + h[1] + h[2] + h[3]) | 0;
    for (let lane = 1; lane < 4; lane++) h[lane] = (h[lane] + h[0]) | 0;
    for (let lane = 0; lane < 4; lane++) {
        let word = h[lane];
        word = Math.imul(word ^ (word >>> 16), 0x85ebca6b);
        word = Math.imul(word ^ (word >>> 13), 0xc2b2ae35);
        h[lane] = word ^ (word >>> 16);
    }
    h[0] = (h[0] + h[1] + h[2] + h[3]) | 0;
    for (let lane = 1; lane < 4; lane++) h[lane] = (h[lane] + h[0]) | 0;
    return BigInt(h[0] >>> 0) | (BigInt(h[1] >>> 0) << 32n) | (BigInt(h[2] >>> 0) << 64n) | (BigInt(h[3] >>> 0) << 96n);
}

/**
 * Order-independent fingerprint of the server's advertised revisions, for reconnect reconciliation.
 * Each domain-separated JSON tuple is hashed as UTF-8 with MurmurHash3 x86_128 (seed 0), using
 * 32-bit arithmetic for speed in both runtimes. The epoch and row hashes are summed mod 2^128 and
 * encoded as 32 lowercase hex digits. This detects accidental differences, not adversarial input.
 */
export function revisionDigest(listing: ResourceRevisionListing): string {
    const hash = (term: string[]) => murmurHash128(revisionEncoder.encode(JSON.stringify(term)));
    let sum = hash(["e", listing.epoch]);
    for (const { kind, id, revision } of listing.resources) sum += hash(["r", kind, id, revision]);
    for (const { characterId, id, revision } of listing.chats) sum += hash(["c", characterId, id, revision]);
    for (const { characterId, revision } of listing.chatOrders) sum += hash(["o", characterId, revision]);
    return BigInt.asUintN(128, sum).toString(16).padStart(32, "0");
}

/**
 * A complete collection in chat seq order, hashed as a domain-separated JSON tuple with the
 * producer's summary format. MurmurHash3 x86_128 detects accidental differences, not hostile input.
 */
export function chatCollectionClaim(
    format: number,
    characterId: string,
    orderRevision: string | null,
    chats: readonly { id: string; revision: string }[],
): string {
    const tuple = [
        "chatCollection",
        format,
        characterId,
        orderRevision,
        chats.map(({ id, revision }) => [id, revision]),
    ];
    return murmurHash128(revisionEncoder.encode(JSON.stringify(tuple)))
        .toString(16)
        .padStart(32, "0");
}

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
