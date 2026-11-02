// The scoring and the ledger of the Structured Memory evaluation (not a test file itself). Pure: a
// probe is scored over a send's manifest and card text, labels resolve against the records a send read,
// and the ledger adds up what the scripted upstream saw. Nothing here reads a store or a clock.
//
// What a score says, and what it does not:
// - Capture and exclusion are over the selection manifest (`selected.items`, none of them verified by a
//   final prompt). A label that resolves to no record throws: it is a fixture error, never a miss.
// - A knowledge boundary is checked on the card's text, because a manifest item has no text: the
//   character's page line must hold the fact only after `does not know:`.
// - An unanswerable probe counts how many of its labelled distractors were selected. Lanes opening is
//   not a failure, and the count is reported as it is.
// - A stale or retracted event is checked as an excluded record only; its raw message may stay in the
//   prompt by design.
// The writer behind these records is scripted and the embedding is lexical, so the figures say how the
// read path treats known-good records: nothing here is a recall figure for a model.

import { itemTag, type MemoryEvent, type MemoryManifestItem } from "../../../../../../shared/structuredMemory.ts";
import type { MemoryRecords } from "../../../../prompt/memory/structured/step.ts";
import { lexicalEmbedding, type ScriptedCall, type ScriptedCallKind, unitCosine } from "./scriptedWriter.ts";
import { charMessageId, type Probe, type ProbeKind } from "./story.ts";

export type LabelKind = "event" | "page" | "thread";
export type ResolvedLabel = { label: string; kind: LabelKind; id: string };

type Records = Pick<MemoryRecords, "events" | "pages" | "threads">;

/**
 * The record a label names: `event:<turn>` the event citing that turn's reply (an active one first, since
 * a re-record retires its predecessor), `page:<title>` and `thread:<title>` by exact title. A label that
 * names nothing throws, so a typo cannot read as a miss.
 */
export function resolveLabel(label: string, records: Records): ResolvedLabel {
    const colon = label.indexOf(":");
    const kind = label.slice(0, colon);
    const name = label.slice(colon + 1);
    if (kind === "event") {
        const messageId = charMessageId(Number(name));
        const citing = records.events.filter((event) => event.sources.some((source) => source.messageId === messageId));
        const event = citing.find(({ status }) => status !== "retracted") ?? citing[0];
        if (event) {
            return { label, kind: "event", id: event.id };
        }
    } else if (kind === "page") {
        const page = records.pages.find(({ title }) => title === name);
        if (page) {
            return { label, kind: "page", id: page.id };
        }
    } else if (kind === "thread") {
        const thread = records.threads.find(({ title }) => title === name);
        if (thread) {
            return { label, kind: "thread", id: thread.id };
        }
    }
    throw new Error(`Unresolved label ${label}`);
}

export type ProbeScore = {
    id: string;
    kind: ProbeKind;
    query: string;
    needed: { label: string; id: string; found: boolean; lane?: string }[];
    forbidden: { label: string; id: string; leaked: boolean }[];
    distractors: { label: string; id: string; selected: boolean }[];
    boundary?: { label: string; id: string; lineFound: boolean; inUnaware: boolean; elsewhere: boolean; pass: boolean };
    /** A comparison: every needed record found. */
    allPartsPresent?: boolean;
    /** The best lexical cosine between the query and the texts of the records it mirrors. */
    bestSimilarity?: number;
    eventsOpen?: boolean;
    eventReasons?: string[];
    /** The lanes that selected anything: what an unanswerable probe retrieved on its own. */
    selectedByLane: Record<string, number>;
    /** Undefined for an unanswerable probe, which has nothing to pass. */
    pass?: boolean;
};

/** The texts retrieval embeds for an event. */
const eventTexts = (event: Pick<MemoryEvent, "summary" | "keyLines">) =>
    [event.summary, ...event.keyLines.map(({ text }) => text)].filter((text) => text.trim() !== "");

/** The highest lexical cosine between `query` and any text of the records `labels` name. */
export function bestSimilarity(query: string, labels: readonly string[], records: Records): number | undefined {
    if (labels.length === 0) {
        return undefined;
    }
    const vector = lexicalEmbedding(query);
    let best = 0;
    for (const label of labels) {
        const resolved = resolveLabel(label, records);
        const texts =
            resolved.kind === "event"
                ? eventTexts(records.events.find(({ id }) => id === resolved.id)!)
                : resolved.kind === "page"
                  ? [records.pages.find(({ id }) => id === resolved.id)!.title]
                  : [records.threads.find(({ id }) => id === resolved.id)!.title];
        for (const text of texts) {
            best = Math.max(best, unitCosine(vector, lexicalEmbedding(text)));
        }
    }
    return best;
}

/** The page line of `id` in a card's text, whichever lane holds it, or null when the card has none. */
function pageLineOf(cardText: string, id: string): string | null {
    const tag = `${itemTag({ lane: "pages", id })} `;
    return cardText.split("\n").find((line) => line.startsWith(tag)) ?? null;
}

/**
 * `probe` scored over what a send selected. `items` are the manifest, `cardText` the card the prompt
 * would hold, and the diagnostics are copied through.
 */
export function scoreProbe(
    probe: Probe,
    send: { items: readonly MemoryManifestItem[]; cardText: string; eventsOpen?: boolean; eventReasons?: string[] },
    records: Records,
): ProbeScore {
    const byId = new Map<string, MemoryManifestItem>();
    for (const item of send.items) {
        byId.set(item.id, item);
    }
    const needed = probe.needed.map((label) => {
        const { id } = resolveLabel(label, records);
        const item = byId.get(id);
        return { label, id, found: item !== undefined, ...(item ? { lane: item.lane } : {}) };
    });
    const forbidden = probe.forbidden.map((label) => {
        const { id } = resolveLabel(label, records);
        return { label, id, leaked: byId.has(id) };
    });
    const distractors = probe.distractors.map((label) => {
        const { id } = resolveLabel(label, records);
        return { label, id, selected: byId.has(id) };
    });
    const selectedByLane: Record<string, number> = {};
    for (const { lane } of send.items) {
        selectedByLane[lane] = (selectedByLane[lane] ?? 0) + 1;
    }
    const score: ProbeScore = {
        id: probe.id,
        kind: probe.kind,
        query: probe.query,
        needed,
        forbidden,
        distractors,
        selectedByLane,
        ...(send.eventsOpen !== undefined ? { eventsOpen: send.eventsOpen } : {}),
        ...(send.eventReasons ? { eventReasons: send.eventReasons } : {}),
    };
    const similarity = bestSimilarity(probe.query, probe.mirrors, records);
    if (similarity !== undefined) {
        score.bestSimilarity = similarity;
    }
    if (probe.boundary) {
        const { id } = resolveLabel(probe.boundary.page, records);
        const line = pageLineOf(send.cardText, id);
        const marker = " | does not know: ";
        const at = line?.indexOf(marker) ?? -1;
        const quoted = `"${probe.boundary.fact}"`;
        const before = line === null ? "" : at === -1 ? line : line.slice(0, at);
        const after = line === null || at === -1 ? "" : line.slice(at + marker.length);
        const inUnaware = after.includes(quoted);
        const elsewhere = before.includes(probe.boundary.fact);
        score.boundary = {
            label: probe.boundary.page,
            id,
            lineFound: line !== null,
            inUnaware,
            elsewhere,
            pass: line !== null && inUnaware && !elsewhere,
        };
    }
    const allFound = needed.every(({ found }) => found);
    const noneLeaked = forbidden.every(({ leaked }) => !leaked);
    switch (probe.kind) {
        case "needed":
            score.pass = allFound;
            break;
        case "mustNotLeak":
            score.pass = noneLeaked;
            break;
        case "comparison":
            score.allPartsPresent = allFound;
            score.pass = allFound;
            break;
        case "knowledge":
            score.pass = allFound && score.boundary?.pass === true;
            break;
        case "unanswerable":
            break;
    }
    return score;
}

export type KindSummary = {
    kind: ProbeKind;
    probes: number;
    /** Needed records found, over distinct needed records. */
    capture: { found: number; total: number };
    /** Forbidden records absent, over distinct forbidden records. */
    exclusion: { absent: number; total: number };
    /** Comparisons with every part present. */
    allParts: { present: number; total: number };
    /** Knowledge boundaries that held. */
    boundary: { held: number; total: number };
    /** Distractors selected, over labelled distractors. */
    distractors: { selected: number; total: number };
};

/** The rates per probe kind, over distinct records: a record two probes need counts once. */
export function summarizeScores(scores: readonly ProbeScore[]): KindSummary[] {
    const kinds: ProbeKind[] = ["needed", "mustNotLeak", "knowledge", "comparison", "unanswerable"];
    return kinds.flatMap((kind) => {
        const of = scores.filter((score) => score.kind === kind);
        if (of.length === 0) {
            return [];
        }
        const needed = new Map<string, boolean>();
        const forbidden = new Map<string, boolean>();
        const distractors = new Map<string, boolean>();
        for (const score of of) {
            for (const { id, found } of score.needed) {
                needed.set(id, (needed.get(id) ?? false) || found);
            }
            for (const { id, leaked } of score.forbidden) {
                forbidden.set(id, (forbidden.get(id) ?? false) || leaked);
            }
            for (const { id, selected } of score.distractors) {
                distractors.set(id, (distractors.get(id) ?? false) || selected);
            }
        }
        const count = (map: Map<string, boolean>, value: boolean) =>
            [...map.values()].filter((v) => v === value).length;
        const comparisons = of.filter((score) => score.allPartsPresent !== undefined);
        const boundaries = of.filter((score) => score.boundary !== undefined);
        return [
            {
                kind,
                probes: of.length,
                capture: { found: count(needed, true), total: needed.size },
                exclusion: { absent: count(forbidden, false), total: forbidden.size },
                allParts: { present: comparisons.filter((s) => s.allPartsPresent).length, total: comparisons.length },
                boundary: { held: boundaries.filter((s) => s.boundary!.pass).length, total: boundaries.length },
                distractors: { selected: count(distractors, true), total: distractors.size },
            },
        ];
    });
}

// ---------------------------------------------------------------------------------------------
// The ledger

export type TokenCount = (text: string) => Promise<number>;

export type CallTotals = {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    inputChars: number;
    outputChars: number;
};

export type WriterLedger = Record<ScriptedCallKind, CallTotals>;

/** The text a call's input comes to: its messages' contents, which is what every family counts. */
export const callInputText = (call: Pick<ScriptedCall, "messages">) =>
    call.messages.map(({ content }) => content).join("\n");

/** Every call's input and output by kind, counted with `count`. */
export async function writerLedger(calls: readonly ScriptedCall[], count: TokenCount): Promise<WriterLedger> {
    const empty = (): CallTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, inputChars: 0, outputChars: 0 });
    const ledger: WriterLedger = { analysis: empty(), patch: empty(), compaction: empty(), summary: empty() };
    for (const call of calls) {
        const input = callInputText(call);
        const totals = ledger[call.kind];
        totals.calls++;
        totals.inputChars += input.length;
        totals.outputChars += call.answer.length;
        totals.inputTokens += await count(input);
        totals.outputTokens += await count(call.answer);
    }
    return ledger;
}

export type SendLedger = { cardTokens: number; rawTokens: number; rawEntries: number };

/** What one send puts in the prompt: the card and the raw history it keeps, counted with `count`. */
export async function sendLedger(
    send: { cardText: string; rawTexts: readonly string[] },
    count: TokenCount,
): Promise<SendLedger> {
    let rawTokens = 0;
    for (const text of send.rawTexts) {
        rawTokens += await count(text);
    }
    return {
        cardTokens: send.cardText === "" ? 0 : await count(send.cardText),
        rawTokens,
        rawEntries: send.rawTexts.length,
    };
}

/** The four slots of an analysis prompt's user message, by character count. */
export function analysisSlotSizes(call: Pick<ScriptedCall, "messages">): {
    cast: number;
    scene: number;
    threads: number;
    previous: number;
    messages: number;
} {
    const user = call.messages.find(({ role }) => role === "user")?.content ?? "";
    const between = (from: string, to: string | null) => {
        const start = user.indexOf(from);
        if (start === -1) {
            return 0;
        }
        const begin = start + from.length;
        const end = to === null ? user.length : user.indexOf(to, begin);
        return Math.max(0, (end === -1 ? user.length : end) - begin);
    };
    return {
        cast: between("Pages:\n", "\n\nScene:\n"),
        scene: between("Scene:\n", "\n\nOpen threads:\n"),
        threads: between("Open threads:\n", "\n\nBefore these messages:\n"),
        previous: between("Before these messages:\n", "\n\nMessages to record:\n"),
        messages: between("Messages to record:\n", null),
    };
}

export type OverheadRow = {
    part: "first tenth" | "last tenth" | "all";
    calls: number;
    inputTokens: number;
    windowTokens: number;
    /** (input − window) / calls. */
    overheadPerCall: number;
    slots: { cast: number; scene: number; threads: number; previous: number };
};

/**
 * The analysis calls' overhead over their windows' raw text: per call, for the first and last tenth of
 * the calls and for all of them, with the mean slot sizes beside. `windowText` gives a call's raw
 * message text, which `count` counts the same way as the call.
 */
export async function analysisOverhead(
    calls: readonly ScriptedCall[],
    windowText: (call: ScriptedCall) => string,
    count: TokenCount,
): Promise<OverheadRow[]> {
    const analysis = calls.filter(({ kind }) => kind === "analysis");
    const tenth = Math.max(1, Math.floor(analysis.length / 10));
    const parts: [OverheadRow["part"], ScriptedCall[]][] = [
        ["first tenth", analysis.slice(0, tenth)],
        ["last tenth", analysis.slice(-tenth)],
        ["all", analysis],
    ];
    const counted = new Map<ScriptedCall, { input: number; window: number }>();
    for (const call of analysis) {
        counted.set(call, { input: await count(callInputText(call)), window: await count(windowText(call)) });
    }
    return parts.map(([part, list]) => {
        let inputTokens = 0;
        let windowTokens = 0;
        const slots = { cast: 0, scene: 0, threads: 0, previous: 0 };
        for (const call of list) {
            const { input, window } = counted.get(call)!;
            inputTokens += input;
            windowTokens += window;
            const sizes = analysisSlotSizes(call);
            slots.cast += sizes.cast;
            slots.scene += sizes.scene;
            slots.threads += sizes.threads;
            slots.previous += sizes.previous;
        }
        const n = Math.max(1, list.length);
        return {
            part,
            calls: list.length,
            inputTokens,
            windowTokens,
            overheadPerCall: (inputTokens - windowTokens) / n,
            slots: {
                cast: slots.cast / n,
                scene: slots.scene / n,
                threads: slots.threads / n,
                previous: slots.previous / n,
            },
        };
    });
}

/** The median of `values`; NaN for none. */
export function median(values: readonly number[]): number {
    if (values.length === 0) {
        return NaN;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The `share` quantile of `values` by nearest rank; NaN for none. */
export function quantile(values: readonly number[], share: number): number {
    if (values.length === 0) {
        return NaN;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
}
