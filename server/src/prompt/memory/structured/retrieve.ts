import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import {
    type MemoryEvent,
    type MemoryThread,
    memoryThreadEnded,
    type StructuredMemorySettings,
} from "../../../../../shared/structuredMemory.ts";
import { cosineSimilarity, HypaProcesser, type memoryVector, type VectorArray } from "../../embeddings.ts";
import type { MemoryHost } from "../host.ts";
import { eventLine, evidenceLine, flowLine, threadLine } from "./card.ts";
import { type ExcludedItem, itemKey, type Lane, type LaneCandidate, type RawWindow, type ReadEntry } from "./lanes.ts";

/**
 * What a send's lanes offer the card, from the records and the prompt's own entries.
 *
 * - Places: an event's place is the entry of its newest source. With no source among the entries it has
 *   no place, so neither flow nor the events lane lists it.
 * - Flow is the story's recent order, not retrieval: the last `flowEvents` events by place, never by
 *   storage order, since a backfill stores out of order, and whether or not they are inside the window.
 * - Retrieval leaves out an event whose every source is inside the window with text, since the prompt
 *   holds that text already. An older source keeps the event in: uncovered history can be trimmed.
 * - The events lane opens when the user's messages read as past, causal, or chronological, or when an
 *   event's similarity is high. Open, it takes only events over a floor, so lending cannot turn its
 *   target into a quota.
 * - Evidence is the sources of the lane's events, then older messages by lexical match. Semantic scoring
 *   only reranks those matches, so embedding stays at `lexicalCandidates` texts a send, and a paraphrase
 *   sharing no term is not found.
 * - Threads: any not ended, so a paused one stays. One naming nobody is listed low, as a thread recorded
 *   before its chat had pages is; one naming someone needs them on stage, which is the scene page's
 *   attendance.
 * - A failed embedding never fails the send: the prompt stays valid without it and the answer says why.
 *   The events lane then opens by the reading alone, over events sharing someone with the stage. A
 *   cancelled job or a latched failure still escapes through `host.fence()`.
 *
 * `excluded` holds every event and open thread that is no candidate, however many: what reaches a report
 * is its reader's choice. One past `eventCandidates` or `threadCandidates` is `budget`, since it passed
 * relevance and lost on rank. A retracted event and an ended thread are not listed.
 */

/** Bounds and thresholds of retrieval; similarities are cosines in [0, 1]. */
export const RETRIEVAL_LIMITS = {
    /** The window's newest messages with text that make up the query, and what is read of each. */
    queryMessages: 4,
    queryChars: 2000,
    /** The similarity that opens the events lane without a past reading. */
    eventOpenSimilarity: 0.6,
    /** The similarity an event needs in an open lane. */
    eventFloorSimilarity: 0.35,
    /**
     * What the events and threads lanes offer at most, because every candidate line is counted, one by
     * one, before spending.
     */
    eventCandidates: 48,
    threadCandidates: 40,
    /** The excerpts one event's sources give, and the evidence lane's items. */
    excerptsPerEvent: 2,
    evidenceItems: 6,
    excerptChars: 400,
    /** The older messages lexical matching reads, and what is read of each. */
    evidencePoolMessages: 400,
    lexicalTermChars: 4000,
    /** The lexical score a message needs, and how many go on to semantic scoring. */
    lexicalFloor: 0.2,
    lexicalCandidates: 16,
} as const;

/** Flow has no token target, `flowEvents` bounds it; a number, because a target reaches a report as JSON. */
const FLOW_TARGET = Number.MAX_SAFE_INTEGER;

/** The share of its event's score a source excerpt keeps, so an event always outranks its own evidence. */
const SOURCE_EXCERPT_WEIGHT = 0.9;
/** The share of its match an older message keeps, since no event vouches for it. */
const OLDER_MESSAGE_WEIGHT = 0.5;

/** Cue words of a past, causal, or chronological reading: English by word, the others as parts of words. */
const PAST_CUES = [
    /\b(?:remember|recall|remind)(?:s|ed|ing)?\b/i,
    /\b(?:forgot|forget|forgotten|earlier|before|previously|ago|yesterday)\b/i,
    /\b(?:last (?:time|night|week|month|year)|back (?:then|when)|used to|first time|in the past)\b/i,
    /\b(?:what happened|how come|why|because)\b/i,
    /기억|떠올|예전|옛날|과거|지난번|저번|아까|그때|그 때|전에|어제|왜|때문|어쩌다|무슨 일/,
    /覚えて|憶えて|思い出|昔|以前|この前|あの時|あのとき|あの頃|さっき|昨日|先日|なぜ|どうして|なんで|せいで/,
    /记得|記得|回忆|回憶|想起|从前|從前|以前|之前|当时|當時|那时|那時|上次|昨天|曾经|曾經/,
    /为什么|為什麼|为何|為何|因为|因為|怎么回事|怎麼回事/,
];

/** Hangul, Kana, and Han. U+30FC, the long vowel mark, is common script in Unicode but sits inside Katakana words. */
const CJK_RUN = /[\p{sc=Hangul}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}\u30fc]+/gu;
/** A letter's marks count with it: scripts that write vowels as marks would otherwise have no runs. */
const WORD_RUN = /[\p{L}\p{M}\p{N}]{2,}/gu;

type RetrievalHost = Pick<MemoryHost, "db" | "embeddings" | "fence">;

type RetrievalInput = {
    events: readonly MemoryEvent[];
    threads: readonly MemoryThread[];
    entries: readonly ReadEntry[];
    window: RawWindow;
    /** The on-stage page ids; empty when unknown. */
    stage: readonly string[];
    settings: StructuredMemorySettings;
};

type RetrievedLanes = {
    /** In `MEMORY_MANIFEST_LANES` order: flow, events, evidence, threads. A lane with target 0 has no items. */
    lanes: Lane<LaneCandidate>[];
    excluded: ExcludedItem[];
    similarity: "used" | "off" | "failed";
    /** Why `similarity` is `failed`, without the embedding keys. */
    failure?: string;
    eventsOpen: boolean;
};

/** An active, unsuppressed event with its sources' entries, newest first; `place` is the first of them. */
type PlacedEvent = { event: MemoryEvent; sources: number[]; place: number };
type RankedEvent = PlacedEvent & { reason: string; score: number };

type SendEmbeddings = ReturnType<typeof sendEmbeddings>;

/**
 * Whether `texts` read as past, causal, or chronological. A caller passes user messages only: narrative
 * replies are past tense throughout.
 */
export function readsAsPast(texts: readonly string[]): boolean {
    return texts.some((text) => PAST_CUES.some((cue) => cue.test(text)));
}

/**
 * The texts embedded for `event`, summary and key lines alike. The writer warms these same texts
 * (`warmRecords` in `writer.ts`), so the vectors it warms are the ones read here.
 */
export function eventVectorTexts({ summary, keyLines }: Pick<MemoryEvent, "summary" | "keyLines">): string[] {
    const texts = [summary, ...keyLines.map(({ text }) => text)].map((text) => text.trim());
    return [...new Set(texts)].filter(Boolean);
}

/** Lower-cased runs of letters and digits of two or more characters; a CJK run gives its character bigrams. */
export function lexicalTerms(text: string): Set<string> {
    const terms = new Set<string>();
    const lower = text.toLowerCase();
    for (const [run] of lower.matchAll(CJK_RUN)) {
        const characters = [...run];
        for (let index = 1; index < characters.length; index++) {
            terms.add(characters[index - 1] + characters[index]);
        }
    }
    for (const [word] of lower.replace(CJK_RUN, " ").matchAll(WORD_RUN)) {
        terms.add(word);
    }
    return terms;
}

const hasText = ({ text }: ReadEntry) => text.trim() !== "";

/** The share of `ids` on `stage`; 0 with no ids, as on a record written before its chat had pages. */
function stageShare(ids: readonly string[], stage: ReadonlySet<string>): number {
    const named = new Set(ids);
    return named.size === 0 ? 0 : [...named].filter((id) => stage.has(id)).length / named.size;
}

/** A cosine as a score in [0, 1]: thresholds need its scale, and a bare dot product has none. NaN is 0. */
function unitCosine(a: VectorArray, b: VectorArray): number {
    const cosine = cosineSimilarity(a, b);
    return Number.isNaN(cosine) ? 0 : Math.min(1, Math.max(0, cosine));
}

/** Each of `texts` with its best similarity over `queries`. */
function bestSimilarities(
    texts: readonly string[],
    vectors: readonly memoryVector[],
    queries: readonly VectorArray[],
): Map<string, number> {
    // By content: `addText` puts new vectors before cached ones.
    const byContent = new Map(vectors.map(({ content, embedding }) => [content, embedding]));
    const best = new Map<string, number>();
    for (const text of texts) {
        const vector = byContent.get(text);
        if (vector) {
            best.set(text, Math.max(0, ...queries.map((query) => unitCosine(query, vector))));
        }
    }
    return best;
}

/**
 * One processor and one read of the query vectors, whichever lanes ask. `best` embeds `texts` and answers
 * their similarities, or null when there is nothing to compare or embedding failed, which ends it for
 * the send.
 */
function sendEmbeddings(host: RetrievalHost, queries: string[]) {
    let processor: HypaProcesser | undefined;
    let queryVectors: VectorArray[] | undefined;
    const state: Pick<RetrievedLanes, "similarity" | "failure"> = { similarity: "off" };
    return {
        state,
        async best(texts: readonly string[]): Promise<ReadonlyMap<string, number> | null> {
            if (state.similarity === "failed" || queries.length === 0 || texts.length === 0) {
                return null;
            }
            const unique = [...new Set(texts)];
            try {
                processor ??= new HypaProcesser(host.embeddings, host.db.hypaModel);
                await processor.addText(unique);
                host.fence();
                queryVectors ??= await processor.getEmbeds(queries);
                host.fence();
                state.similarity = "used";
                return bestSimilarities(unique, processor.vectors, queryVectors);
            } catch (error) {
                host.fence();
                state.similarity = "failed";
                state.failure = host.embeddings.redact(error instanceof Error ? error.message : String(error));
                return null;
            }
        },
    };
}

/**
 * The flow lane, newest first so the oldest is cut. `turnsAgo` counts the replies with text since the
 * event's place, at least 1: a reply left blank is no turn, as in `rawWindow`.
 */
function flowItems(placed: readonly PlacedEvent[], entries: readonly ReadEntry[], flowEvents: number): LaneCandidate[] {
    const newestFirst = placed.toReversed().sort((a, b) => b.place - a.place);
    return newestFirst.slice(0, flowEvents).map(({ event, place }): LaneCandidate => {
        const turnsAgo = entries.slice(place).filter((entry) => entry.role === "char" && hasText(entry)).length;
        return {
            id: event.id,
            kind: "event",
            lane: "flow",
            reason: "recent",
            // Rank orders the lane, and no flow item is ever lent: one the core round skips still does not fit.
            score: 0,
            order: place,
            line: flowLine(event, Math.max(1, turnsAgo)),
        };
    });
}

/**
 * Whether the events lane opens over `eligible`, and its candidates in rank order: by score, ties by
 * newer place, then id. An event's similarity is its best over its texts and the queries, and its score
 * is 0.8 of that plus 0.2 of the share of its participants on stage. A target of 0 closes the lane with
 * nothing embedded, as the writer warms nothing then either.
 */
async function rankEvents(
    eligible: readonly PlacedEvent[],
    query: readonly ReadEntry[],
    stage: ReadonlySet<string>,
    target: number,
    embeddings: SendEmbeddings,
): Promise<{ open: boolean; ranked: RankedEvent[] }> {
    if (target === 0) {
        return { open: false, ranked: [] };
    }
    const best = await embeddings.best(eligible.flatMap(({ event }) => eventVectorTexts(event)));
    const scored = eligible.map((placed) => ({
        ...placed,
        similarity: Math.max(0, ...eventVectorTexts(placed.event).map((text) => best?.get(text) ?? 0)),
    }));
    const reached = scored.some(({ similarity }) => similarity >= RETRIEVAL_LIMITS.eventOpenSimilarity);
    if (!reached && !readsAsPast(query.filter(({ role }) => role === "user").map(({ text }) => text))) {
        return { open: false, ranked: [] };
    }
    const failed = embeddings.state.similarity === "failed";
    const reason = failed ? "participants" : reached ? "similarity" : "pastReading";
    const ranked = scored.flatMap((placed): RankedEvent[] => {
        const overlap = stageShare(placed.event.participants, stage);
        const relevant = failed ? overlap > 0 : placed.similarity >= RETRIEVAL_LIMITS.eventFloorSimilarity;
        return relevant ? [{ ...placed, reason, score: 0.8 * placed.similarity + 0.2 * overlap }] : [];
    });
    const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    ranked.sort((a, b) => b.score - a.score || b.place - a.place || byId(a.event.id, b.event.id));
    return { open: true, ranked };
}

/** The paragraph of `text`, or with no blank line its line, holding the most of `terms`, the earliest on a tie. */
function excerptOf(text: string, terms: ReadonlySet<string>): string {
    const pieces = (separator: RegExp) => text.split(separator).filter((piece) => piece.trim() !== "");
    const paragraphs = pieces(/\n\s*\n/);
    let excerpt = "";
    let most = -1;
    for (const paragraph of paragraphs.length > 1 ? paragraphs : pieces(/\n/)) {
        const found = [...lexicalTerms(paragraph)].filter((term) => terms.has(term)).length;
        if (found > most) {
            excerpt = paragraph;
            most = found;
        }
    }
    return clampText(excerpt.trim(), RETRIEVAL_LIMITS.excerptChars);
}

/**
 * The entries at `pool` whose lexical score reaches the floor, best first, ties in `pool` order. The
 * score is the IDF-weighted share of `queryTerms` found in the entry, the IDF taken over the pool.
 */
function lexicalMatches(
    pool: readonly number[],
    entries: readonly ReadEntry[],
    queryTerms: ReadonlySet<string>,
): { index: number; lexical: number }[] {
    if (pool.length === 0 || queryTerms.size === 0) {
        return [];
    }
    const found = pool.map((index) => {
        const terms = lexicalTerms(clampText(entries[index].text, RETRIEVAL_LIMITS.lexicalTermChars));
        return [...terms].filter((term) => queryTerms.has(term));
    });
    const frequency = new Map<string, number>();
    for (const term of found.flat()) {
        frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
    const weight = (terms: Iterable<string>) => {
        let sum = 0;
        for (const term of terms) {
            sum += Math.log(1 + pool.length / (1 + (frequency.get(term) ?? 0)));
        }
        return sum;
    };
    const whole = weight(queryTerms);
    return pool
        .map((index, position) => ({ index, lexical: weight(found[position]) / whole }))
        .filter(({ lexical }) => lexical >= RETRIEVAL_LIMITS.lexicalFloor)
        .sort((a, b) => b.lexical - a.lexical)
        .slice(0, RETRIEVAL_LIMITS.lexicalCandidates);
}

/**
 * The evidence lane in rank order. First the sources of `ranked` events that leave the prompt, newest
 * first, each message once, each needing its event's item. Then older messages, whether or not the
 * events lane opened: entries that leave the prompt and nothing above used, newest first, by lexical
 * match, reranked by similarity when there are vectors. Only an excerpt is ever embedded.
 */
async function evidenceItems(
    ranked: readonly RankedEvent[],
    query: readonly ReadEntry[],
    { entries, window }: Pick<RetrievalInput, "entries" | "window">,
    embeddings: SendEmbeddings,
): Promise<LaneCandidate[]> {
    const queryTerms = new Set(query.flatMap(({ text }) => [...lexicalTerms(text)]));
    const item = (
        index: number,
        excerpt: string,
        fields: Pick<LaneCandidate, "reason" | "score" | "requires">,
    ): LaneCandidate => {
        // Every index here came from a message id: a source's, or one `rawWindow` found covered.
        const id = entries[index].messageId!;
        const line = evidenceLine(id, entries[index].role, excerpt);
        return { id, kind: "evidence", lane: "evidence", order: index, line, ...fields };
    };

    const items: LaneCandidate[] = [];
    const used = new Set<number>();
    for (const { event, sources, score } of ranked) {
        const fresh = sources.filter(
            (index) => window.dropped.has(index) && !used.has(index) && hasText(entries[index]),
        );
        for (const index of [...new Set(fresh)].slice(0, RETRIEVAL_LIMITS.excerptsPerEvent)) {
            used.add(index);
            items.push(
                item(index, excerptOf(entries[index].text, queryTerms), {
                    reason: "eventSource",
                    score: score * SOURCE_EXCERPT_WEIGHT,
                    requires: itemKey({ lane: "events", id: event.id }),
                }),
            );
        }
    }

    const pool = [...window.dropped]
        .filter((index) => !used.has(index))
        .sort((a, b) => b - a)
        .slice(0, RETRIEVAL_LIMITS.evidencePoolMessages);
    const matches = lexicalMatches(pool, entries, queryTerms).map((match) => ({
        ...match,
        excerpt: excerptOf(entries[match.index].text, queryTerms),
    }));
    const best = await embeddings.best(matches.map(({ excerpt }) => excerpt));
    const older = matches.map(({ index, lexical, excerpt }) =>
        best
            ? item(index, excerpt, {
                  reason: "matchedMessage",
                  score: ((lexical + (best.get(excerpt) ?? 0)) / 2) * OLDER_MESSAGE_WEIGHT,
              })
            : item(index, excerpt, { reason: "lexicalMessage", score: lexical * OLDER_MESSAGE_WEIGHT }),
    );
    older.sort((a, b) => b.score - a.score);
    return [...items, ...older];
}

/** The threads lane in rank order, by score, ties newest first by list order, and the open threads it passes over. */
function threadItems(
    threads: readonly MemoryThread[],
    stage: ReadonlySet<string>,
    target: number,
): { items: LaneCandidate[]; excluded: ExcludedItem[] } {
    const items: LaneCandidate[] = [];
    const excluded: ExcludedItem[] = [];
    threads.forEach((thread, position) => {
        if (memoryThreadEnded(thread.state)) {
            return;
        }
        const { id } = thread;
        const share = stageShare(thread.who, stage);
        if (target === 0 || (thread.who.length > 0 && share === 0)) {
            excluded.push({ id, kind: "thread", lane: "threads", reason: "not-relevant" });
            return;
        }
        items.push({
            id,
            kind: "thread",
            lane: "threads",
            reason: share > 0 ? "onStage" : "unassigned",
            score: share > 0 ? 0.5 + 0.5 * share : 0.25,
            order: position,
            line: threadLine(thread),
        });
    });
    items.sort((a, b) => b.score - a.score || b.order - a.order);
    for (const { id } of items.slice(RETRIEVAL_LIMITS.threadCandidates)) {
        excluded.push({ id, kind: "thread", lane: "threads", reason: "budget" });
    }
    return { items: items.slice(0, RETRIEVAL_LIMITS.threadCandidates), excluded };
}

/** The lanes this send can offer, and every other record they reach, with why it is not offered. */
export async function retrieveLanes(host: RetrievalHost, input: RetrievalInput): Promise<RetrievedLanes> {
    const { events, threads, entries, window, settings } = input;
    const targets = settings.laneTargets;
    const stage = new Set(input.stage);
    const positions = new Map<string, number>();
    entries.forEach(({ messageId }, index) => {
        if (messageId !== undefined) {
            positions.set(messageId, index);
        }
    });

    const excluded: ExcludedItem[] = [];
    const leaveOut = ({ id }: MemoryEvent, reason: ExcludedItem["reason"]) => {
        excluded.push({ id, kind: "event", lane: "events", reason });
    };
    const placed: PlacedEvent[] = [];
    for (const event of events) {
        const sources = event.sources.flatMap(({ messageId }) => positions.get(messageId) ?? []).sort((a, b) => b - a);
        if (event.status === "retracted") {
            continue;
        }
        if (event.status === "stale") {
            leaveOut(event, "stale");
        } else if (event.suppressed) {
            leaveOut(event, "never");
        } else if (sources.length === 0) {
            leaveOut(event, "not-relevant");
        } else {
            placed.push({ event, sources, place: sources[0] });
        }
    }

    const query = entries
        .slice(window.start)
        .filter(hasText)
        .slice(-RETRIEVAL_LIMITS.queryMessages)
        .map((entry) => ({ ...entry, text: clampText(entry.text.trim(), RETRIEVAL_LIMITS.queryChars) }));
    const embeddings = sendEmbeddings(
        host,
        query.map(({ text }) => text),
    );

    const eligible = placed.filter(
        ({ event, sources }) =>
            sources.length < event.sources.length ||
            sources.some((index) => index < window.start || !hasText(entries[index])),
    );
    const { open, ranked } = await rankEvents(eligible, query, stage, targets.events, embeddings);
    const relevant = new Set(ranked.map(({ event }) => event.id));
    for (const { event } of placed) {
        if (!relevant.has(event.id)) {
            leaveOut(event, "not-relevant");
        }
    }
    const candidates = ranked.slice(0, RETRIEVAL_LIMITS.eventCandidates);
    for (const { event } of ranked.slice(RETRIEVAL_LIMITS.eventCandidates)) {
        leaveOut(event, "budget");
    }

    const evidence =
        targets.evidence > 0 ? await evidenceItems(candidates, query, { entries, window }, embeddings) : [];
    const openThreads = threadItems(threads, stage, targets.threads);
    return {
        lanes: [
            { lane: "flow", target: FLOW_TARGET, items: flowItems(placed, entries, settings.flowEvents) },
            {
                lane: "events",
                target: targets.events,
                items: candidates.map(({ event, place, reason, score }) => ({
                    id: event.id,
                    kind: "event",
                    lane: "events",
                    reason,
                    score,
                    order: place,
                    line: eventLine(event),
                })),
            },
            { lane: "evidence", target: targets.evidence, limit: RETRIEVAL_LIMITS.evidenceItems, items: evidence },
            { lane: "threads", target: targets.threads, items: openThreads.items },
        ],
        excluded: [...excluded, ...openThreads.excluded],
        ...embeddings.state,
        eventsOpen: open,
    };
}
