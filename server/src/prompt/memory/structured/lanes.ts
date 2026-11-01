import { resolveHypaV3Budget } from "../../../../../shared/hypaV3Presets.ts";
import type { HypaV3Settings } from "../../../../../shared/memory.ts";
import {
    MEMORY_MANIFEST_LANES,
    type MemoryManifestItemKind,
    type MemoryManifestLane,
    normalizeStructuredMemorySettings,
} from "../../../../../shared/structuredMemory.ts";

export { coveredMessages, rawWindow } from "../../../../../shared/structuredMemory.ts";
export type { RawWindow, ReadEntry } from "../../../../../shared/structuredMemory.ts";

/**
 * The read path's pure rules: what stays raw in a send, what memory may spend, and how the lanes share it.
 *
 * - The window counts assistant turns, as the writer's windows do: a turn is one assistant message and
 *   what came since the one before it, so the user message that led to the oldest kept reply stays. A
 *   reply left blank by a script is no turn.
 * - History before the window leaves the prompt only where an active, unsuppressed event covers it.
 *   Everything else stays raw. Whether the writer already recorded a message says nothing here: that
 *   counts events of any status.
 * - The maximum is the only hard limit. Each lane first spends up to its target, then what is left is
 *   lent by score. Relevance is decided before spending, and spending adds no item that does not exist,
 *   so a quiet scene leaves room empty: the lanes are a cap, not a quota.
 */

/**
 * One record's line in a lane. `score` decides lending, on one scale across lanes. `order` is the item's
 * place within the lane on the card, where a lane's rank is its place in `items`. `requires` is the
 * `itemKey` of an item this one means nothing without. `tokens` is the whole line's count.
 */
export type LaneItem = {
    id: string;
    kind: MemoryManifestItemKind;
    lane: MemoryManifestLane;
    reason: string;
    score: number;
    order: number;
    line: string;
    tokens: number;
    requires?: string;
};

/** What a lane offers before its lines are counted. */
export type LaneCandidate = Omit<LaneItem, "tokens">;

/** A lane, its items in rank order: `target` is what its core round may spend, `limit` how many it may ever hold. */
export type Lane<Item extends LaneCandidate = LaneItem> = {
    lane: MemoryManifestLane;
    target: number;
    limit?: number;
    items: Item[];
};

/** A candidate a send left out, and why. */
export type ExcludedItem = Pick<LaneItem, "id" | "kind" | "lane"> & {
    reason: "budget" | "not-relevant" | "never" | "stale";
};

/** What a lane may spend and what it spent. */
export type LaneSpend = { lane: MemoryManifestLane; target: number; spent: number };

/**
 * What a send may spend on memory, in either budget mode, what fitting the context reduced of the
 * preset's amounts, and the lanes' targets.
 */
export function readBudget(settings: HypaV3Settings, maxContext: number, maxResponse: number) {
    const { memoryTokens, reduced } = resolveHypaV3Budget(settings, maxContext, maxResponse);
    return {
        maximum: memoryTokens,
        reduced,
        targets: normalizeStructuredMemorySettings(settings.structured).laneTargets,
    };
}

/** What `requires` names: the lane is part of it, so evidence needs its event's item there, never its flow title. */
export function itemKey({ lane, id }: Pick<LaneItem, "lane" | "id">): string {
    return `${lane}:${id}`;
}

/**
 * Shares `maximum`, which is what the frame left, among `lanes`, each item admitted whole or not at all.
 *
 * - Core round: lanes in `MEMORY_MANIFEST_LANES` order, each lane's items in rank order, holding the
 *   lane's target, its `limit`, and `maximum`. An item that does not fit is skipped, since a later
 *   smaller one may.
 * - Lending: the items left in every lane, by `score`, ties in lane order and then by rank, holding
 *   `limit` and `maximum` but no target. Nothing skipped here comes back: an item that requires another
 *   scores no higher than it and sits in a later lane, so this order reaches the required one first.
 * - A lane with target 0 is off: it admits nothing in either round.
 * - An item with `requires` is admitted only once that key is included; skipped, it stays for lending.
 *
 * `included` is in admission order. Everything else is `excluded`, as `budget`.
 */
export function spendLanes({ maximum, lanes }: { maximum: number; lanes: readonly Lane[] }): {
    included: LaneItem[];
    excluded: ExcludedItem[];
    spend: LaneSpend[];
} {
    const rows = MEMORY_MANIFEST_LANES.flatMap((name) =>
        lanes.filter(({ lane }) => lane === name).map((lane) => ({ lane, spent: 0, admitted: 0 })),
    );
    type Row = (typeof rows)[number];

    const included: LaneItem[] = [];
    const keys = new Set<string>();
    let total = 0;
    const admissible = ({ lane, admitted }: Row, item: LaneItem) =>
        lane.target > 0 &&
        total + item.tokens <= maximum &&
        (lane.limit === undefined || admitted < lane.limit) &&
        (item.requires === undefined || keys.has(item.requires));
    const admit = (row: Row, item: LaneItem) => {
        included.push(item);
        keys.add(itemKey(item));
        total += item.tokens;
        row.spent += item.tokens;
        row.admitted++;
    };

    for (const row of rows) {
        for (const item of row.lane.items) {
            if (row.spent + item.tokens <= row.lane.target && admissible(row, item)) {
                admit(row, item);
            }
        }
    }
    const left = rows
        .flatMap((row) => row.lane.items.map((item) => ({ row, item })))
        .filter(({ item }) => !keys.has(itemKey(item)));
    // The sort is stable and `left` is in lane order and rank order, which settles the ties.
    left.sort((a, b) => b.item.score - a.item.score);
    for (const { row, item } of left) {
        if (admissible(row, item)) {
            admit(row, item);
        }
    }

    return {
        included,
        excluded: rows
            .flatMap((row) => row.lane.items)
            .filter((item) => !keys.has(itemKey(item)))
            .map(({ id, kind, lane }) => ({ id, kind, lane, reason: "budget" })),
        spend: rows.map(({ lane: { lane, target }, spent }) => ({ lane, target, spent })),
    };
}
