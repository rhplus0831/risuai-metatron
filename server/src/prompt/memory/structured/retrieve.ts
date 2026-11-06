import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import {
    type CharacterSectionSlot,
    MEMORY_STALE_REASONS,
    type MemoryEvent,
    memoryEventCovers,
    type MemoryKnowledge,
    type MemoryPage,
    type MemorySection,
    type MemoryThread,
    memoryThreadEnded,
    type StructuredMemorySettings,
} from "../../../../../shared/structuredMemory.ts";
import {
    cosineSimilarity,
    HypaProcesser,
    type EmbeddingEnv,
    type memoryVector,
    type VectorArray,
} from "../../embeddings.ts";
import type { MemoryHost } from "../host.ts";
import { eventLine, evidenceLine, flattened, flowLine, type PageKnowledge, pageLine, threadLine } from "./card.ts";
import { type ExcludedItem, itemKey, type Lane, type LaneCandidate, type RawWindow, type ReadEntry } from "./lanes.ts";
import { pageNamedInTexts, sectionVectorText } from "./pages.ts";

/**
 * What a send's lanes offer the card, from the records and the prompt's own entries.
 *
 * - Places: an event's place is the entry of its newest source. With no source among the entries it has
 *   no place, so neither flow nor the events lane lists it. That is not staleness: a source can simply
 *   be disabled in this send.
 * - Required is the scene page unless `never`, then the `always` pages in stored order, each with every
 *   nonblank, unsuppressed section, with character relationships filtered by the send's cast. The scene
 *   also says who is present, which no section holds. In this lane and the next, a page with nothing to
 *   show gives no item.
 * - Pages are found by four channels, in rank order: on stage, named in the last `pageNameMessages`
 *   messages by lore's matching, linked from either of those by one hop, and near the query by a
 *   section's similarity, which is a channel of its own and leads to no links. An `always` page finds
 *   others like any page but stays out of the lane, being required. Within a channel the newest section
 *   leads, then similarity. A character offers its whole `currentState` and the `relationships` lines
 *   naming another page in the send's cast or no visible page; a single-line body stays whole.
 * - Flow is the story's recent order, not retrieval: the last `flowEvents` events by place, never by
 *   storage order, since a backfill stores out of order, and whether or not they are inside the window.
 *   Flow has no token target; `Number.MAX_SAFE_INTEGER` is the sentinel passed to spending.
 * - Retrieval leaves out an event whose every source is inside the window with text, since the prompt
 *   holds that text already. An older source keeps the event in: uncovered history can be trimmed.
 * - The events lane opens when the user's messages read as past, causal, or chronological, or when an
 *   event's similarity is high. Open, it takes only events over a floor, so lending cannot turn its
 *   target into a quota.
 * - Evidence is the covered sources of the lane's events, then older messages that leave the prompt by
 *   coverage or context trimming, by lexical match. Each pass searches at most `evidencePoolMessages`
 *   older messages and embeds at most `lexicalCandidates` matching excerpts for semantic reranking.
 *   A selection makes at most two passes; widening the pool after trimming reuses the event ranks and
 *   query vectors. A paraphrase sharing no term is not found.
 * - Threads: any not ended, so a paused one stays. One naming nobody is listed low, as a thread recorded
 *   before its chat had pages is; one naming someone needs them on stage, which is the scene page's
 *   attendance.
 * - Selection prepares the placed records, page cast and required offer before embedding, so the card
 *   can refuse required pages or disable similarity when even its cheapest optional frame cannot fit.
 * - Every cached eligible event/auto-page text is scored. Cold records share `recordTexts` foreground
 *   misses per job; unembedded texts score zero until the detached task service warms them. This cold
 *   compromise is not a similarity failure. Queries use a document-disjoint cache namespace.
 * - A failed embedding never fails the send: the prompt stays valid without it and the answer says why.
 *   The events lane then opens by the reading alone, over events sharing someone with the stage, and the
 *   pages lane goes on without its similarity channel. A cancelled job or a latched failure still
 *   escapes through `host.fence()`.
 *
 * `excluded` holds every event, page, and open thread that is no candidate, however many: what reaches a
 * report is its reader's choice. Exclusions are per lane: flow can include an event that events excludes.
 * One past `eventCandidates`, `pageCandidates`, or `threadCandidates` is `budget`, since it passed
 * relevance and lost on rank. A stale event says why it is stale. A retracted
 * event and an ended thread are not listed, and neither is an `always` page the required lane shows.
 */

/** Bounds and thresholds of retrieval; similarities are cosines in [0, 1]. */
export const RETRIEVAL_LIMITS = {
    /** The window's newest messages with text that make up the query, and what is read of each. */
    queryMessages: 4,
    /** Unique missing event/page texts submitted in the foreground across one job. */
    recordTexts: 100,
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
    /** The newest messages with text a page's title or alias is looked for in. */
    pageNameMessages: 8,
    /** The similarity that finds a page by itself. */
    pageSimilarity: 0.5,
    /** What the pages lane offers at most, for the same reason as the events lane. */
    pageCandidates: 24,
    /** The facts a page on stage shows, and the ones a character on stage is said not to know. */
    knowledgePerPage: 8,
    unawarePerCharacter: 6,
} as const;

/** Flow has no token target, `flowEvents` bounds it; a number, because a target reaches a report as JSON. */
const FLOW_TARGET = Number.MAX_SAFE_INTEGER;

/** The share of its event's score a source excerpt keeps, so an event always outranks its own evidence. */
const SOURCE_EXCERPT_WEIGHT = 0.9;
/** The share of its match an older message keeps, since no event vouches for it. */
const OLDER_MESSAGE_WEIGHT = 0.5;

/** How a page was found, best first. */
const PAGE_MATCHES = ["onStage", "named", "linked", "similarity"] as const;
type PageMatch = (typeof PAGE_MATCHES)[number];

/** A found page's score on the scale events use; a page found only by similarity scales under `linked`. */
const PAGE_MATCH_SCORES = { onStage: 1, named: 0.9, linked: 0.7 } as const;

/** The slots of a character page the pages lane offers. */
const RELATED_SLOTS: ReadonlySet<string> = new Set<CharacterSectionSlot>(["currentState", "relationships"]);

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

type RetrievalHost = Pick<MemoryHost, "db" | "embeddings" | "fence" | "recoverLocalModelFailure">;

type RetrievalInput = {
    events: readonly MemoryEvent[];
    threads: readonly MemoryThread[];
    /** Every page, in stored order. */
    pages: readonly MemoryPage[];
    entries: readonly ReadEntry[];
    window: RawWindow;
    /** The on-stage page ids; empty when unknown. */
    stage: readonly string[];
    settings: StructuredMemorySettings;
};

type RetrievedLanes = {
    /** In `MEMORY_MANIFEST_LANES` order. A lane with target 0 has no items. */
    lanes: Lane<LaneCandidate>[];
    /** Recompute evidence with uncovered message indices actually trimmed before the protected window. */
    evidence(trimmed?: ReadonlySet<number>): Promise<LaneCandidate[]>;
    excluded: ExcludedItem[];
    similarity: "used" | "off" | "failed";
    /** Why `similarity` is `failed`, without the embedding keys. */
    failure?: string;
    eventsOpen: boolean;
    /** Unique eligible record texts left without vectors; evidence is not included. */
    deferredRecordTexts: number;
};

/** An active, unsuppressed event with its sources' entries, newest first; `place` is the first of them. */
type PlacedEvent = { event: MemoryEvent; sources: number[]; place: number };
type RankedEvent = PlacedEvent & { reason: string; score: number };

type SendEmbeddings = ReturnType<typeof sendEmbeddings>;

/** One stored knowledge item. `place` is its event's, -1 with none, and `stored` counts in storage order. */
type FactRecord = { item: MemoryKnowledge; place: number; stored: number };

/** What every record of one fact says together. `secret` is that each gave `knowers`; `records` are newest first. */
type KnownFact = { text: string; knowers: Set<string>; secret: boolean; records: FactRecord[] };

/** What both page lanes read of a send's pages. */
type PageReading = {
    /** Every page, in stored order. */
    pages: readonly MemoryPage[];
    scene: MemoryPage | undefined;
    /** Every page but the scene and those `never` hides. */
    visible: readonly MemoryPage[];
    /** What a line may name, by page id: no page `never` hides is here. */
    titles: ReadonlyMap<string, string>;
    stage: ReadonlySet<string>;
    /** Visible pages on stage, found by name or link, or always required; similarity alone adds none. */
    cast: ReadonlySet<string>;
    facts: readonly KnownFact[];
};

/** A page the pages lane found, with what ranks it. */
type RankedPage = { page: MemoryPage; match: PageMatch; updatedAt: number; similarity: number; line: string };

/** A lane's candidates and the records it passes over. */
type LaneOffer = { items: LaneCandidate[]; excluded: ExcludedItem[] };

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

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const newestRecord = (a: FactRecord, b: FactRecord) => b.place - a.place || b.stored - a.stored;

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

type RecordAllowance = { remaining: number };
const jobAllowances = new WeakMap<object, RecordAllowance>();
const environmentAllowances = new WeakMap<EmbeddingEnv, RecordAllowance>();

/** Binds a round's embedding environment to its job's shared foreground record allowance. */
export function shareRecordEmbeddingAllowance(env: EmbeddingEnv, job: object): void {
    let allowance = jobAllowances.get(job);
    if (!allowance) {
        allowance = { remaining: RETRIEVAL_LIMITS.recordTexts };
        jobAllowances.set(job, allowance);
    }
    environmentAllowances.set(env, allowance);
}

/**
 * One processor and cached query vectors for both evidence passes. All cached records are scored;
 * unique record misses share a bounded allowance, equally between active lanes with unused shares
 * lent. Missing records left over score zero, without invoking the failed-embedding fallback.
 * Evidence alone may embed through `best`, under its separate per-pass excerpt bound.
 */
function sendEmbeddings(host: RetrievalHost, queries: string[], enabled: boolean) {
    let processor: HypaProcesser | undefined;
    let queryVectors: VectorArray[] | undefined;
    let deferred = 0;
    const allowance = environmentAllowances.get(host.embeddings) ?? { remaining: RETRIEVAL_LIMITS.recordTexts };
    const state: Pick<RetrievedLanes, "similarity" | "failure"> = { similarity: "off" };
    const failed = (error: unknown) => {
        host.fence();
        host.recoverLocalModelFailure?.();
        state.similarity = "failed";
        state.failure = host.embeddings.redact(error instanceof Error ? error.message : String(error));
    };
    return {
        state,
        get deferred() {
            return deferred;
        },
        async records(lanes: { events: string[]; pages: string[] }): Promise<void> {
            if (!enabled || queries.length === 0) return;
            const texts = [...new Set([...lanes.events, ...lanes.pages])];
            if (texts.length === 0) return;
            try {
                host.fence();
                processor = new HypaProcesser(host.embeddings, host.db.hypaModel);
                const missing = new Set(processor.loadCachedDocuments(texts));
                deferred = missing.size;
                const groups = [lanes.events, lanes.pages].map((lane) => lane.filter((text) => missing.has(text)));
                const selected = new Set<string>();
                const active = groups.filter((group) => group.length > 0);
                const share = Math.floor(allowance.remaining / Math.max(1, active.length));
                for (const group of active) {
                    let taken = 0;
                    for (const text of group) {
                        if (taken >= share) break;
                        if (!selected.has(text)) {
                            selected.add(text);
                            taken++;
                        }
                    }
                }
                for (const group of active) {
                    for (const text of group) {
                        if (selected.size >= allowance.remaining) break;
                        selected.add(text);
                    }
                }
                allowance.remaining -= selected.size;
                await processor.addText([...selected]);
                host.fence();
                deferred -= selected.size;
            } catch (error) {
                failed(error);
            }
        },
        async best(texts: readonly string[], embed = false): Promise<ReadonlyMap<string, number> | null> {
            if (!enabled || state.similarity === "failed" || queries.length === 0 || texts.length === 0) return null;
            const unique = [...new Set(texts)];
            try {
                host.fence();
                processor ??= new HypaProcesser(host.embeddings, host.db.hypaModel);
                if (embed) await processor.addText(unique);
                host.fence();
                if (processor.vectors.length === 0) return new Map();
                queryVectors ??= await processor.getCachedQueries(queries);
                host.fence();
                state.similarity = "used";
                return bestSimilarities(unique, processor.vectors, queryVectors);
            } catch (error) {
                failed(error);
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
 * events lane opened: covered entries in `window.dropped` plus uncovered message indices in `trimmed`
 * that the caller actually removed, excluding anything above used. That pool is bounded newest first,
 * then matched lexically and reranked by similarity when there are vectors. The protected window and
 * pinned continue target stay out of both sets. Only an excerpt is ever embedded.
 */
async function evidenceItems(
    ranked: readonly RankedEvent[],
    query: readonly ReadEntry[],
    { entries, window, trimmed }: Pick<RetrievalInput, "entries" | "window"> & { trimmed?: ReadonlySet<number> },
    embeddings: SendEmbeddings,
): Promise<LaneCandidate[]> {
    const queryTerms = new Set(query.flatMap(({ text }) => [...lexicalTerms(text)]));
    const item = (
        index: number,
        excerpt: string,
        fields: Pick<LaneCandidate, "reason" | "score" | "requires">,
    ): LaneCandidate => {
        // Every index here names a message: covered by an event or removed by the caller's trim.
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

    const pool = [...(trimmed ? new Set([...window.dropped, ...trimmed]) : window.dropped)]
        .filter((index) => !used.has(index))
        .sort((a, b) => b - a)
        .slice(0, RETRIEVAL_LIMITS.evidencePoolMessages);
    const matches = lexicalMatches(pool, entries, queryTerms).map((match) => ({
        ...match,
        excerpt: excerptOf(entries[match.index].text, queryTerms),
    }));
    const best = await embeddings.best(
        matches.map(({ excerpt }) => excerpt),
        true,
    );
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

/**
 * Every fact of the events that cover their messages, its records newest first: by place, an event with
 * no place last, then storage order reversed.
 */
function knownFacts(events: readonly MemoryEvent[], positions: ReadonlyMap<string, number>): KnownFact[] {
    const facts = new Map<string, KnownFact>();
    let stored = 0;
    for (const event of events.filter(memoryEventCovers)) {
        const place = Math.max(-1, ...event.sources.map(({ messageId }) => positions.get(messageId) ?? -1));
        for (const item of event.knowledge) {
            const text = flattened(item.fact);
            if (text === "") {
                continue;
            }
            const fact: KnownFact = facts.get(text) ?? { text, knowers: new Set(), secret: true, records: [] };
            facts.set(text, fact);
            for (const id of [item.pageId, ...(item.knowers ?? [])]) {
                fact.knowers.add(id);
            }
            fact.secret &&= item.knowers !== undefined;
            fact.records.push({ item, place, stored: stored++ });
        }
    }
    const listed = [...facts.values()];
    for (const { records } of listed) {
        records.sort(newestRecord);
    }
    return listed;
}

/**
 * The newest facts of `page`, one each, with the stance of its own newest record of the fact. That
 * record's `knowers` label the fact private even where another record leaves them out, which only keeps
 * the fact out of denials.
 */
function pageKnowledge(page: MemoryPage, { facts, titles }: PageReading): PageKnowledge[] {
    const own = facts.flatMap((fact) => {
        const record = fact.records.find(({ item }) => item.pageId === page.id);
        return record ? [{ fact, record }] : [];
    });
    own.sort((a, b) => newestRecord(a.record, b.record));
    return own.slice(0, RETRIEVAL_LIMITS.knowledgePerPage).map(({ fact, record: { item } }) => {
        const others = [...fact.knowers].flatMap((id) => (id === page.id ? [] : (titles.get(id) ?? [])));
        return {
            fact: fact.text,
            stance: item.stance,
            ...(item.knowers ? { privateTo: [page.title, ...others] } : {}),
        };
    });
}

/**
 * The secrets `page` is no knower of, among those held by a page a line may name: held on stage first,
 * then newest.
 */
function unawareFacts(page: MemoryPage, { facts, titles, stage }: PageReading): string[] {
    const secrets = facts.flatMap((fact) => {
        const holders = fact.records.map(({ item }) => item.pageId).filter((id) => titles.has(id));
        return fact.secret && !fact.knowers.has(page.id) && holders.length > 0
            ? [{ fact, onStage: holders.some((id) => stage.has(id)) }]
            : [];
    });
    secrets.sort((a, b) => Number(b.onStage) - Number(a.onStage) || newestRecord(a.fact.records[0], b.fact.records[0]));
    return secrets.slice(0, RETRIEVAL_LIMITS.unawarePerCharacter).map(({ fact }) => fact.text);
}

/** The sections of `page` that can show: a suppressed one never does, and a blank one has nothing to. */
const shownSections = ({ sections }: Pick<MemoryPage, "sections">) =>
    sections.filter(({ suppressed, body }) => !suppressed && body.trim() !== "");

/**
 * Record texts shared by retrieval and background warming. The caller orders events by newest place;
 * pages prefer on-stage, named and linked pages, then newest sections. No lexical shortlist is used.
 */
export function recordVectorTexts(
    records: { events: readonly MemoryEvent[]; pages: readonly MemoryPage[] },
    targets: Pick<StructuredMemorySettings["laneTargets"], "events" | "pages">,
    found: ReadonlyMap<string, PageMatch> = new Map(),
): { events: string[]; pages: string[] } {
    const scene = records.pages.find(({ type }) => type === "scene");
    const sections =
        targets.pages > 0
            ? records.pages
                  .filter((page) => page !== scene && page.contextMode !== "always" && page.contextMode !== "never")
                  .flatMap((page) => shownSections(page).map((section) => ({ page, section })))
            : [];
    const priority = (page: MemoryPage) => PAGE_MATCHES.indexOf(found.get(page.id) ?? "similarity");
    sections.sort((a, b) => priority(a.page) - priority(b.page) || b.section.updatedAt - a.section.updatedAt);
    return {
        events:
            targets.events > 0 ? [...new Set(records.events.filter(memoryEventCovers).flatMap(eventVectorTexts))] : [],
        pages: [...new Set(sections.map(({ page, section }) => sectionVectorText(page, section)))],
    };
}

/** What the pages lane shows of `page`: all it can, or on a character the lane's slots. */
function relatedSections(page: MemoryPage): MemorySection[] {
    const sections = shownSections(page);
    return page.type === "character" ? sections.filter(({ heading }) => RELATED_SLOTS.has(heading)) : sections;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const CJK_CHAR = /[\p{sc=Hangul}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/u;
/** Whether `char` continues a word of a script that separates words with spaces. */
const joinsWord = (char: string | undefined) => char !== undefined && WORD_CHAR.test(char) && !CJK_CHAR.test(char);

/**
 * Whether `text` names `key`, both lowercased and whitespace-collapsed: as a substring, but not inside a
 * longer word of a space-separated script ("eve" in "even"), while a particle after a Hangul, Kana, or
 * Han name still matches.
 */
function namesKey(text: string, key: string): boolean {
    for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
        if (!joinsWord(text[at - 1]) && !joinsWord(text[at + key.length])) {
            return true;
        }
    }
    return false;
}

/** Relationship lines keep their text; only matching strips bullets, collapses whitespace, and ignores case. */
function relationshipBody(body: string, page: MemoryPage, { visible, cast }: PageReading): string {
    const lines = body.split("\n").filter((line) => line.trim() !== "");
    if (lines.length < 2) return body;
    return lines
        .filter((line) => {
            const text = flattened(line.trim().replace(/^[-*] /, "")).toLowerCase();
            const named = visible.filter(({ title, aliases }) =>
                [title, ...aliases].some((name) => {
                    const key = flattened(name).toLowerCase();
                    return key !== "" && namesKey(text, key);
                }),
            );
            return named.length === 0 || named.some(({ id }) => id !== page.id && cast.has(id));
        })
        .join("\n");
}

/** The line of `page` showing `sections` and, on stage, what it knows; null when it would say nothing. */
function shownLine(
    reading: PageReading,
    page: MemoryPage,
    sections: readonly MemorySection[],
    present: readonly string[] = [],
): string | null {
    if (page.type === "character") {
        sections = sections.flatMap((section) => {
            if (section.heading !== "relationships") return [section];
            const body = relationshipBody(section.body, page, reading);
            return body.trim() === "" ? [] : [{ ...section, body }];
        });
    }
    const onStage = reading.stage.has(page.id);
    const knowledge = onStage ? pageKnowledge(page, reading) : [];
    const unaware = onStage && page.type === "character" ? unawareFacts(page, reading) : [];
    return present.length + sections.length + knowledge.length + unaware.length > 0
        ? pageLine(page, { present, sections, knowledge, unaware })
        : null;
}

/** The required lane: the scene, then the `always` pages in stored order. */
function requiredPages(reading: PageReading): LaneOffer {
    const { pages, scene, titles } = reading;
    const items: LaneCandidate[] = [];
    const excluded: ExcludedItem[] = [];
    const offer = (page: MemoryPage, reason: string, present?: readonly string[]) => {
        const { id } = page;
        const line = shownLine(reading, page, shownSections(page), present);
        if (line === null) {
            excluded.push({ id, kind: "page", lane: "required", reason: "not-relevant" });
        } else {
            items.push({ id, kind: "page", lane: "required", reason, score: 1, order: items.length, line });
        }
    };
    if (scene?.contextMode === "never") {
        excluded.push({ id: scene.id, kind: "page", lane: "required", reason: "never" });
    } else if (scene) {
        const present = [...new Set(scene.participants)].flatMap((id) => titles.get(id) ?? []);
        offer(scene, "scene", present);
    }
    for (const page of pages) {
        if (page !== scene && page.contextMode === "always") {
            offer(page, "always");
        }
    }
    return { items, excluded };
}

/** The pages found on stage or by name, and those one link from them, by id. */
function foundPages(
    { visible, stage }: Pick<PageReading, "visible" | "stage">,
    entries: readonly ReadEntry[],
): Map<string, PageMatch> {
    // Keep the last pageNameMessages texts; `pageNamedInTexts` scans them all.
    const texts = entries
        .filter(hasText)
        .slice(-RETRIEVAL_LIMITS.pageNameMessages)
        .map(({ text }) => text);

    const found = new Map<string, PageMatch>();
    for (const page of visible) {
        if (stage.has(page.id)) {
            found.set(page.id, "onStage");
        } else if (pageNamedInTexts(page, texts)) {
            found.set(page.id, "named");
        }
    }
    const visibleIds = new Set(visible.map(({ id }) => id));
    for (const { links } of visible.filter(({ id }) => found.has(id))) {
        for (const link of links) {
            if (visibleIds.has(link) && !found.has(link)) {
                found.set(link, "linked");
            }
        }
    }
    return found;
}

/**
 * The pages lane in rank order, and the pages it passes over. A target of 0 closes the lane with nothing
 * embedded, as the writer warms nothing then either. `order` is the rank, so the card lists by it.
 */
async function relatedPages(
    reading: PageReading,
    found: ReadonlyMap<string, PageMatch>,
    target: number,
    embeddings: SendEmbeddings,
): Promise<LaneOffer> {
    const leaveOut = ({ id }: MemoryPage, reason: ExcludedItem["reason"]): ExcludedItem => {
        return { id, kind: "page", lane: "pages", reason };
    };
    const { pages, scene, visible } = reading;
    const excluded = pages.flatMap((page) =>
        page !== scene && page.contextMode === "never" ? [leaveOut(page, "never")] : [],
    );
    const auto = visible.filter(({ contextMode }) => contextMode !== "always");
    if (target === 0) {
        return { items: [], excluded: [...excluded, ...auto.map((page) => leaveOut(page, "not-relevant"))] };
    }

    const best = await embeddings.best(
        auto.flatMap((page) => shownSections(page).map((section) => sectionVectorText(page, section))),
    );
    const ranked: RankedPage[] = [];
    for (const page of auto) {
        const shown = shownSections(page);
        const similarity = Math.max(0, ...shown.map((section) => best?.get(sectionVectorText(page, section)) ?? 0));
        const match = found.get(page.id) ?? (similarity >= RETRIEVAL_LIMITS.pageSimilarity ? "similarity" : null);
        const line = match && shownLine(reading, page, relatedSections(page));
        if (match && line) {
            const updatedAt = Math.max(0, ...shown.map((section) => section.updatedAt));
            ranked.push({ page, match, updatedAt, similarity, line });
        } else {
            excluded.push(leaveOut(page, "not-relevant"));
        }
    }
    ranked.sort(
        (a, b) =>
            PAGE_MATCHES.indexOf(a.match) - PAGE_MATCHES.indexOf(b.match) ||
            b.updatedAt - a.updatedAt ||
            b.similarity - a.similarity ||
            byId(a.page.id, b.page.id),
    );
    for (const { page } of ranked.slice(RETRIEVAL_LIMITS.pageCandidates)) {
        excluded.push(leaveOut(page, "budget"));
    }
    const items = ranked
        .slice(0, RETRIEVAL_LIMITS.pageCandidates)
        .map(({ page: { id }, match, similarity, line }, order): LaneCandidate => ({
            id,
            kind: "page",
            lane: "pages",
            reason: match,
            score: match === "similarity" ? PAGE_MATCH_SCORES.linked * similarity : PAGE_MATCH_SCORES[match],
            order,
            line,
        }));
    return { items, excluded };
}

/**
 * Embedding-free placement and page reading, including the required offer and enabled lane targets.
 * Required pages never also enter the pages lane, so a page has only one item and tag.
 *
 * - Both page lanes filter a character's relationship lines against the same cast: visible pages on
 *   stage, found by name or one link, and `always` pages. A line naming another cast page or no visible
 *   page stays; other lines go. Bodies with fewer than two nonblank lines stay whole.
 * - Knowledge is stored on events, so what a page knows comes from every event that covers its messages,
 *   before any cap. Facts are one by their text with whitespace collapsed. A fact's knowers are every
 *   record's page and `knowers` list, and a fact that any record states without `knowers` is no secret,
 *   since a false "does not know" is worse than a missing one. A page on stage shows its own newest
 *   facts, a secret labelled private, and a character on stage says which secrets of others it does not
 *   know, those held on stage first, the holder not having to be on stage. Both belong to the page's one
 *   line, so an `always` page counts them against the required cap.
 * - `never` hides a page everywhere: it has no item, its title is in no attendance or private label, its
 *   links are not followed, its names never match relationship lines, and a secret only it holds reaches
 *   nobody's line. A `never` scene still gives the stage.
 *
 * `MemoryKnowledge.pageId` is the learner; no field identifies the subject of a fact. Presence of
 * `knowers`, including an empty list, makes that record private. The writer in
 * server/src/prompt/memory/structured/writer.ts does not reconcile knowledge across records, so this
 * read joins by whitespace-collapsed fact text before caps: learning a secret later must prevent a
 * false denial of it.
 */
export async function prepareRetrieval(input: RetrievalInput) {
    const { events, pages, entries, window, settings } = input;
    const targets = settings.laneTargets;
    const stage = new Set(input.stage);
    const positions = new Map<string, number>();
    entries.forEach(({ messageId }, index) => {
        if (messageId !== undefined) {
            positions.set(messageId, index);
        }
    });

    const excluded: ExcludedItem[] = [];
    const leaveOut = ({ id, staleReason }: MemoryEvent, reason: ExcludedItem["reason"]) => {
        // A report with a stale reason it does not know is no report, and the store checks no record's shape.
        const known = reason === "stale" ? MEMORY_STALE_REASONS.find((entry) => entry === staleReason) : undefined;
        excluded.push({ id, kind: "event", lane: "events", reason, ...(known ? { staleReason: known } : {}) });
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
    const eligible = placed.filter(
        ({ event, sources }) =>
            sources.length < event.sources.length ||
            sources.some((index) => index < window.start || !hasText(entries[index])),
    );
    const scene = pages.find(({ type }) => type === "scene");
    const visible = pages.filter((page) => page !== scene && page.contextMode !== "never");
    const found = foundPages({ visible, stage }, entries);
    const reading: PageReading = {
        pages,
        scene,
        visible,
        titles: new Map(pages.filter(({ contextMode }) => contextMode !== "never").map(({ id, title }) => [id, title])),
        stage,
        cast: new Set(
            visible
                .filter(({ id, contextMode }) => stage.has(id) || found.has(id) || contextMode === "always")
                .map(({ id }) => id),
        ),
        facts: knownFacts(events, positions),
    };
    const required = requiredPages(reading);
    const lanes: Lane<LaneCandidate>[] = [
        { lane: "required", target: settings.requiredCap, items: required.items },
        { lane: "flow", target: settings.flowEvents > 0 ? FLOW_TARGET : 0, items: [] },
        ...(["pages", "events", "evidence", "threads"] as const).map((lane) => ({
            lane,
            target: targets[lane],
            items: [],
        })),
    ];
    return { input, stage, excluded, leaveOut, placed, query, eligible, reading, found, required, lanes };
}

/**
 * Scores a prepared send (or prepares a direct call). With embeddings disabled it does no vector
 * cache or provider work, including evidence. Direct calls receive their own bounded allowance.
 */
export async function retrieveLanes(
    host: RetrievalHost,
    input: RetrievalInput,
    options: { prepared?: Awaited<ReturnType<typeof prepareRetrieval>>; embeddings?: boolean } = {},
): Promise<RetrievedLanes> {
    const prepared = options.prepared ?? (await prepareRetrieval(input));
    const { stage, excluded, leaveOut, placed, query, eligible, reading, found, required } = prepared;
    const { threads, entries, window, settings } = input;
    const targets = settings.laneTargets;
    const embeddings = sendEmbeddings(
        host,
        query.map(({ text }) => text),
        options.embeddings !== false,
    );
    await embeddings.records(
        recordVectorTexts(
            {
                events: eligible.toSorted((a, b) => b.place - a.place).map(({ event }) => event),
                pages: input.pages,
            },
            targets,
            found,
        ),
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

    const evidence = async (trimmed?: ReadonlySet<number>): Promise<LaneCandidate[]> =>
        targets.evidence > 0 ? evidenceItems(candidates, query, { entries, window, trimmed }, embeddings) : [];
    const evidenceCandidates = await evidence();
    const openThreads = threadItems(threads, stage, targets.threads);

    const related = await relatedPages(reading, found, targets.pages, embeddings);
    return {
        lanes: [
            { lane: "required", target: settings.requiredCap, items: required.items },
            { lane: "flow", target: FLOW_TARGET, items: flowItems(placed, entries, settings.flowEvents) },
            { lane: "pages", target: targets.pages, items: related.items },
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
            {
                lane: "evidence",
                target: targets.evidence,
                limit: RETRIEVAL_LIMITS.evidenceItems,
                items: evidenceCandidates,
            },
            { lane: "threads", target: targets.threads, items: openThreads.items },
        ],
        excluded: [...excluded, ...openThreads.excluded, ...required.excluded, ...related.excluded],
        evidence,
        get similarity() {
            return embeddings.state.similarity;
        },
        get failure() {
            return embeddings.state.failure;
        },
        eventsOpen: open,
        deferredRecordTexts: embeddings.deferred,
    };
}
