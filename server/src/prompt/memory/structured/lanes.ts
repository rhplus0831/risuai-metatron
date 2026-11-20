import { resolveHypaV3Budget } from "../../../../../shared/hypaV3Presets.ts";
import type { HypaV3Settings } from "../../../../../shared/memory.ts";
import {
    MEMORY_MANIFEST_LANES,
    type MemoryManifestItemKind,
    type MemoryManifestLane,
    type MemoryStaleReason,
    normalizeStructuredMemorySettings,
    resolveLaneTargets,
} from "../../../../../shared/structuredMemory.ts";

/**
 * The read path's pure rules: what stays raw in a send, what memory may spend, and how the lanes share it.
 *
 * - The window counts assistant turns, as the writer's windows do: a turn is one assistant message and
 *   what came since the one before it, so the user message that led to the oldest kept reply stays. A
 *   reply left blank by a script is no turn.
 * - History before the window leaves the prompt only where an active, unsuppressed event covers it.
 *   Everything else stays raw. Whether the writer already recorded a message says nothing here: that
 *   counts events of any status.
 * - Lane targets follow `laneSplit`: shares of the applied maximum under `auto`, stored counts under
 *   `manual`. The maximum is the only hard limit. Flow reserves a contiguous run of recent summaries up to its
 *   target, then titles outside the run against the maximum alone. Other lanes spend up to their
 *   targets and borrow by score; flow extends its run with what remains. Relevance is decided before
 *   spending, which adds no candidate that does not exist. The required lane takes no part in this:
 *   `buildMemoryCard` reserves it first.
 */

export { coveredMessages, rawWindow } from "../../../../../shared/structuredMemory.ts";
export type { RawWindow, ReadEntry } from "../../../../../shared/structuredMemory.ts";

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
    /** A volatile event line whose generated date label refers to the story-date anchor. */
    relativeDate?: true;
    /** A full flow line without its optional key lines. */
    plain?: { line: string; tokens: number };
    requires?: string;
};

/** What a lane offers before its lines are counted. */
export type LaneCandidate = Omit<LaneItem, "tokens" | "plain"> & { plain?: { line: string } };

/**
 * A lane in rank order: `target` bounds its core round (full lines only for timeline flow), `limit`
 * bounds its item count. Flow titles spend against the maximum alone.
 */
export type Lane<Item extends LaneCandidate = LaneItem> = {
    lane: MemoryManifestLane;
    target: number;
    limit?: number;
    items: Item[];
    /** Flow titles are `items`; full forms are newest first. Without this metadata, spending is ordinary. */
    flow?: { timeline: boolean; titles: number; full: Item[] };
};

/** A candidate a send left out, and why. */
export type ExcludedItem = Pick<LaneItem, "id" | "kind" | "lane"> & {
    reason: "budget" | "not-relevant" | "never" | "stale";
    /** Why a `stale` event is stale. */
    staleReason?: MemoryStaleReason;
};

/** What a lane may spend and what it spent. */
export type LaneSpend = { lane: MemoryManifestLane; target: number; spent: number };

/**
 * What a send may spend on memory, in either budget mode, what fitting the context reduced of the
 * preset's amounts, and the lanes' targets from the split and the applied, possibly reduced maximum.
 */
export function readBudget(settings: HypaV3Settings, maxContext: number, maxResponse: number) {
    const { memoryTokens, reduced } = resolveHypaV3Budget(settings, maxContext, maxResponse);
    return {
        maximum: memoryTokens,
        reduced,
        targets: resolveLaneTargets(normalizeStructuredMemorySettings(settings.structured), memoryTokens),
    };
}

/** What `requires` names: an events key can also be satisfied by a full flow line, never by its title. */
export function itemKey({ lane, id }: Pick<LaneItem, "lane" | "id">): string {
    return `${lane}:${id}`;
}

/**
 * Shares `maximum`, which is what the frame left, among `lanes`, each item admitted whole or not at all.
 *
 * - Core round: lanes in `MEMORY_MANIFEST_LANES` order. Timeline flow tries a refused key-line form plain,
 *   stopping only when neither passes its target and admission checks, then offers the newest titles outside
 *   the run against `maximum` alone. Ordinary lanes skip an item that does not fit their target, `limit`,
 *   or `maximum`.
 * - Lending: the items left outside timeline flow, by `score`, ties in lane order and then by rank, holding
 *   `limit` and `maximum` but no target. Nothing skipped here comes back: an item that requires another
 *   scores no higher than it and sits in a later lane, so this order reaches the required one first.
 * - After lending, restore key lines on plain run items newest first where the difference fits the
 *   remaining maximum, in place. A refused restoration does not stop later ones or the extension.
 * - Extension: flow resumes its run against the remaining maximum, passing over events already shown
 *   by the events lane and trying refused key-line forms plain. A title turns full only if the difference
 *   fits, then the title window advances.
 * - A lane with target 0 is off: it admits nothing. Title-only flow uses a positive sentinel target.
 * - An item with `requires` needs that key or its event's full flow line; skipped, it stays for lending.
 *
 * `included` is in admission order. Unadmitted candidates are `budget`, restricted in timeline flow to
 * its final title window. Full flow lines and events items never show the same event in full twice.
 */
export function spendLanes({
    maximum,
    lanes,
    volatileAnchorTokens = 0,
}: {
    maximum: number;
    lanes: readonly Lane[];
    /** Shared frame cost, charged once if a relative date is admitted to the volatile part. */
    volatileAnchorTokens?: number;
}): {
    included: LaneItem[];
    excluded: ExcludedItem[];
    spend: LaneSpend[];
} {
    const rows = MEMORY_MANIFEST_LANES.flatMap((name) =>
        lanes
            .filter(({ lane }) => lane === name)
            .map((lane) => ({ lane, spent: 0, admitted: 0, run: new Set<string>(), next: 0 })),
    );
    type Row = (typeof rows)[number];

    const included: LaneItem[] = [];
    const keys = new Set<string>();
    const satisfied = new Set<string>();
    const fullFlow = new Set<string>();
    let total = 0;
    let unspentAnchor = volatileAnchorTokens;
    const itemCost = (item: LaneItem) => item.tokens + (item.relativeDate ? unspentAnchor : 0);
    const timeline = ({ lane }: Row) => lane.lane === "flow" && lane.flow?.timeline === true;
    const titleWindow = ({ lane, run }: Row) => lane.items.filter(({ id }) => !run.has(id)).slice(0, lane.flow!.titles);
    const admissible = ({ lane, admitted }: Row, item: LaneItem, replaced?: LaneItem) =>
        lane.target > 0 &&
        total + itemCost(item) - (replaced?.tokens ?? 0) <= maximum &&
        (lane.limit === undefined || admitted - (replaced ? 1 : 0) < lane.limit) &&
        !(item.lane === "events" && fullFlow.has(item.id)) &&
        (item.requires === undefined || satisfied.has(item.requires));
    const admit = (row: Row, item: LaneItem) => {
        included.push(item);
        keys.add(itemKey(item));
        satisfied.add(itemKey(item));
        total += itemCost(item);
        if (item.relativeDate) unspentAnchor = 0;
        row.spent += item.tokens;
        row.admitted++;
    };
    const admitFull = (row: Row, item: LaneItem) => {
        admit(row, item);
        row.run.add(item.id);
        fullFlow.add(item.id);
        satisfied.add(itemKey({ lane: "events", id: item.id }));
    };
    const fullForm = (item: LaneItem, fits: (form: LaneItem) => boolean): LaneItem | undefined => {
        if (fits(item)) return item;
        if (item.plain) {
            const plain = { ...item, ...item.plain };
            if (fits(plain)) return plain;
        }
        return undefined;
    };

    for (const row of rows) {
        if (timeline(row)) {
            const full = row.lane.flow!.full;
            for (; row.next < full.length; row.next++) {
                const item = fullForm(
                    full[row.next],
                    (form) => row.spent + form.tokens <= row.lane.target && admissible(row, form),
                );
                if (!item) break;
                admitFull(row, item);
            }
            for (const item of titleWindow(row)) {
                if (admissible(row, item)) admit(row, item);
            }
            continue;
        }
        for (const item of row.lane.items) {
            if (row.spent + item.tokens <= row.lane.target && admissible(row, item)) {
                admit(row, item);
            }
        }
    }
    const left = rows
        .filter((row) => !timeline(row))
        .flatMap((row) => row.lane.items.map((item) => ({ row, item })))
        .filter(({ item }) => !keys.has(itemKey(item)));
    // The sort is stable and `left` is in lane order and rank order, which settles the ties.
    left.sort((a, b) => b.item.score - a.item.score);
    for (const { row, item } of left) {
        if (admissible(row, item)) {
            admit(row, item);
        }
    }

    for (const row of rows.filter(timeline)) {
        const full = row.lane.flow!.full;
        for (const item of full.slice(0, row.next)) {
            if (!item.plain) continue;
            const index = included.findIndex((admitted) => itemKey(admitted) === itemKey(item));
            const admitted = included[index];
            if (!admitted || admitted.line === item.line) continue;
            const difference = item.tokens - admitted.tokens;
            if (total + difference > maximum) continue;
            included[index] = { ...admitted, line: item.line, tokens: item.tokens };
            total += difference;
            row.spent += difference;
        }
        for (; row.next < full.length; row.next++) {
            const candidate = full[row.next];
            if (keys.has(itemKey({ lane: "events", id: candidate.id }))) continue;
            const titleIndex = included.findIndex((title) => itemKey(title) === itemKey(candidate));
            const title = titleIndex < 0 ? undefined : included[titleIndex];
            // Check the net cost before touching the title: a failed upgrade leaves it in place.
            const item = fullForm(candidate, (form) => admissible(row, form, title));
            if (!item) break;
            const previousTitles = new Set(titleWindow(row).map(({ id }) => id));
            if (title) {
                included.splice(titleIndex, 1);
                keys.delete(itemKey(title));
                satisfied.delete(itemKey(title));
                total -= title.tokens;
                row.spent -= title.tokens;
                row.admitted--;
            }
            admitFull(row, item);
            for (const nextTitle of titleWindow(row)) {
                if (!previousTitles.has(nextTitle.id) && admissible(row, nextTitle)) admit(row, nextTitle);
            }
        }
    }

    return {
        included,
        excluded: rows
            .flatMap((row) => (timeline(row) ? titleWindow(row) : row.lane.items))
            .filter((item) => !keys.has(itemKey(item)))
            .map(({ id, kind, lane }) => ({ id, kind, lane, reason: "budget" })),
        spend: rows.map(({ lane: { lane, target }, spent }) => ({ lane, target, spent })),
    };
}
