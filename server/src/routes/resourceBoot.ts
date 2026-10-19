import { createHash } from "node:crypto";
import {
    BOOT_CACHED_KINDS,
    BOOT_ITEM_HASH_PATTERN,
    BOOT_ITEM_KINDS,
    BOOT_RESOURCE_FORMAT,
    type ResourceBootItem,
    type ResourceBootRecord,
    type ResourceBootResult,
} from "../../../shared/resources.ts";
import type { ResourceKind, ResourceKindRegistry } from "../data/kinds.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";

/**
 * The boot read that skips what the client holds (`POST /api/resources/boot`,
 * `docs/plan/boot-resource-cache.md` slice 2): request parsing and the read. The route in
 * `resources.ts` adds auth, the body cap, and compression.
 */

/** Most kinds, record claims plus item hashes, and item entries one boot request may name (each). */
export const MAX_BOOT_ENTRIES = 5000;
/** Longest revision string a record claim may carry (a token is ~50 characters). */
const MAX_BOOT_REVISION_LENGTH = 256;

export type BootRequest = {
    /** The requested kinds, first occurrence order. */
    kinds: ResourceKind[];
    chatSummaries: boolean;
    /** `kind\0id` → the claimed revision, or null when the record was claimed with two revisions (a miss). */
    revisions: Map<string, string | null>;
    /** Kind name → every hash the client named for it. */
    hashes: Map<string, Set<string>>;
};

const recordKey = (kind: string, id: string) => `${kind}\u0000${id}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether records of `kind` may be answered `cached`: listed, and no projection (the client sees projected data). */
function isCachedKind(kind: ResourceKind): boolean {
    return BOOT_CACHED_KINDS.includes(kind.name) && !kind.project;
}

/**
 * The request body checked and indexed, or the 400 message. Every entry's shape is checked and
 * counted before entries of kinds that do not take part are dropped.
 */
export function parseBootRequest(body: unknown, kinds: ResourceKindRegistry): BootRequest | string {
    if (!isPlainObject(body)) {
        return "Body must be a JSON object";
    }
    const { kinds: names, chatSummaries, known } = body;
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_BOOT_ENTRIES) {
        return `kinds must be an array of 1 to ${MAX_BOOT_ENTRIES} kind names`;
    }
    const selected: ResourceKind[] = [];
    for (const name of names) {
        if (typeof name !== "string") {
            return "kinds must be kind names";
        }
        const kind = kinds.get(name);
        if (!kind) {
            return `Unknown resource kind: ${name}`;
        }
        if (!selected.includes(kind)) {
            selected.push(kind);
        }
    }
    if (chatSummaries !== undefined && chatSummaries !== true) {
        return "chatSummaries must be true when present";
    }
    if (known !== undefined && !isPlainObject(known)) {
        return "known must be an object";
    }
    const records = known?.records === undefined ? [] : known.records;
    const items = known?.items === undefined ? [] : known.items;
    if (!Array.isArray(records) || !Array.isArray(items)) {
        return "known.records and known.items must be arrays";
    }
    if (items.length > MAX_BOOT_ENTRIES) {
        return `known.items must have at most ${MAX_BOOT_ENTRIES} entries`;
    }
    let count = records.length;
    for (const [index, entry] of records.entries()) {
        if (
            !isPlainObject(entry) ||
            typeof entry.kind !== "string" ||
            !isValidResourceId(entry.id) ||
            typeof entry.revision !== "string" ||
            entry.revision.length === 0 ||
            entry.revision.length > MAX_BOOT_REVISION_LENGTH
        ) {
            return `known.records[${index}] must be { kind, id, revision } with a valid id`;
        }
    }
    for (const [index, entry] of items.entries()) {
        if (!isPlainObject(entry) || typeof entry.kind !== "string" || !Array.isArray(entry.hashes)) {
            return `known.items[${index}] must be { kind, hashes }`;
        }
        count += entry.hashes.length;
        if (count > MAX_BOOT_ENTRIES) {
            break;
        }
        if (!entry.hashes.every((hash) => typeof hash === "string" && BOOT_ITEM_HASH_PATTERN.test(hash))) {
            return `known.items[${index}].hashes must be item hashes`;
        }
    }
    if (count > MAX_BOOT_ENTRIES) {
        return `known must name at most ${MAX_BOOT_ENTRIES} records and hashes in all`;
    }

    const cachedNames = new Set(selected.filter(isCachedKind).map((kind) => kind.name));
    const revisions = new Map<string, string | null>();
    for (const entry of records as { kind: string; id: string; revision: string }[]) {
        if (!cachedNames.has(entry.kind)) {
            continue;
        }
        const key = recordKey(entry.kind, entry.id);
        const previous = revisions.get(key);
        revisions.set(key, previous === undefined || previous === entry.revision ? entry.revision : null);
    }
    const hashes = new Map<string, Set<string>>();
    for (const entry of items as { kind: string; hashes: string[] }[]) {
        if (!cachedNames.has(entry.kind) || !BOOT_ITEM_KINDS.includes(entry.kind)) {
            continue;
        }
        const set = hashes.get(entry.kind) ?? new Set<string>();
        for (const hash of entry.hashes) {
            set.add(hash);
        }
        hashes.set(entry.kind, set);
    }
    return { kinds: selected, chatSummaries: chatSummaries === true, revisions, hashes };
}

/** An item's hash (`BOOT_ITEM_HASH_PATTERN`). */
export function bootItemHash(item: unknown): string {
    return createHash("sha256").update(JSON.stringify(item)).digest("base64url").slice(0, 22);
}

function bootItems(items: readonly unknown[], known: ReadonlySet<string> | undefined): ResourceBootItem[] {
    return items.map((item) => {
        const hash = bootItemHash(item);
        return known?.has(hash) ? { hash } : { hash, data: item };
    });
}

/**
 * The boot answer, read in one synchronous block (the store's reads are synchronous, so no write or
 * restore lands between them): the cached kinds' revisions without data, then the stale records of
 * those kinds by ref, then every other kind (projected) with the chat summaries. Throws the store's
 * errors (a closed store) for the route to map.
 */
export function readBoot(
    store: ResourceStore,
    request: BootRequest,
    project: (kind: ResourceKind, data: unknown) => unknown,
): ResourceBootResult {
    const cachedKinds = request.kinds.filter(isCachedKind);
    const otherKinds = request.kinds.filter((kind) => !isCachedKind(kind));
    const listing = store.readKindRevisions(cachedKinds);
    const stale: { kind: ResourceKind; id: string }[] = [];
    for (const kind of cachedKinds) {
        for (const row of listing.kinds[kind.name]) {
            if (request.revisions.get(recordKey(kind.name, row.id)) !== row.revision) {
                stale.push({ kind, id: row.id });
            }
        }
    }
    const read = stale.length > 0 ? store.readRefs(stale).items : [];
    const rest = store.readKinds(otherKinds, { chatSummaries: request.chatSummaries });

    const fresh = new Map(read.map((item) => [recordKey(item.kind, item.id), item]));
    const result: ResourceBootResult["kinds"] = Object.create(null);
    for (const kind of request.kinds) {
        if (!isCachedKind(kind)) {
            result[kind.name] = rest.kinds[kind.name].map((record) => ({
                ...record,
                data: project(kind, record.data),
            }));
            continue;
        }
        const itemKind = BOOT_ITEM_KINDS.includes(kind.name);
        result[kind.name] = listing.kinds[kind.name].map((row): ResourceBootRecord => {
            const item = fresh.get(recordKey(kind.name, row.id));
            if (!item) {
                return { id: row.id, revision: row.revision, cached: true };
            }
            const revision = item.revision ?? row.revision;
            if (itemKind && Array.isArray(item.data)) {
                return { id: row.id, revision, items: bootItems(item.data, request.hashes.get(kind.name)) };
            }
            return { id: row.id, revision, data: item.data };
        });
    }
    return {
        format: BOOT_RESOURCE_FORMAT,
        epoch: rest.epoch,
        kinds: result,
        ...(request.chatSummaries ? { chatSummaries: rest.chatSummaries, chatOrders: rest.chatOrders } : {}),
    };
}
