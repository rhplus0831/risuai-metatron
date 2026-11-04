import {
    itemTag,
    MEMORY_MANIFEST_LANES,
    type MemoryEvent,
    type MemoryKnowledge,
    type MemoryManifestItem,
    type MemoryManifestLane,
    type MemoryPage,
    type MemorySection,
    type MemoryThread,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryTokenizer } from "../host.ts";
import {
    type ExcludedItem,
    type Lane,
    type LaneCandidate,
    type LaneItem,
    type LaneSpend,
    type ReadEntry,
    spendLanes,
} from "./lanes.ts";

/**
 * The memory card: a stable part and a volatile part, in that order, each one text the prompt can place
 * on its own. The stable part (required pages, recent flow) opens with the rule header; the volatile
 * part (pages, events, evidence, threads) stands alone, and is empty when no lane of it has an item.
 *
 * - One line per item, led by a tag a send can look for in its final prompt. A flow title has a tag of
 *   its own, so it never verifies the event's full text. A page has one item, so what it knows and does
 *   not know is part of its line.
 * - The card's own words are English, for the model. Field values stay in whatever language the record
 *   was written.
 * - `maximum` bounds both parts counted as one system chat each, wherever the volatile part goes.
 *   A wrapper the prompt puts around the card is not part of it.
 * - The required lane is whole or there is no card: nothing may cut it, so it refuses instead.
 */

export { itemTag } from "../../../../../shared/structuredMemory.ts";

type CardParts = { stable: string; volatile: string };

/** The card's answer. `items` are in admission order, none verified yet. */
export type MemoryCard = CardParts & {
    type: "card";
    tokens: number;
    items: MemoryManifestItem[];
    excluded: ExcludedItem[];
    spend: LaneSpend[];
};

/** The required lane over what it may take: each page's tokens, what the lane needs, and that limit. */
export type RequiredOverLimit = {
    type: "requiredOverLimit";
    pages: { id: string; tokens: number }[];
    tokens: number;
    limit: number;
};

/** A knowledge item on a page's line. `privateTo` is a secret's knowers by title, the holder first. */
export type PageKnowledge = Pick<MemoryKnowledge, "fact" | "stance"> & { privateTo?: readonly string[] };

/** What a page's line says after its title, in this order. */
export type PageLineParts = {
    /** The scene's attendance, by title. */
    present: readonly string[];
    sections: readonly Pick<MemorySection, "heading" | "body" | "disputed">[];
    knowledge: readonly PageKnowledge[];
    /** The secrets of others that a character does not know. */
    unaware: readonly string[];
};

const RULE_HEADER =
    "These records are authoritative for the past, and the scene for the present; recent messages win over both. " +
    "Never repeat the bracketed tags.";

/** Each lane's part and heading. `MEMORY_MANIFEST_LANES` orders the lanes within a part. */
const CARD_LANES: Record<MemoryManifestLane, { part: keyof CardParts; heading: string }> = {
    required: { part: "stable", heading: "Current facts:" },
    flow: { part: "stable", heading: "Recent events:" },
    pages: { part: "volatile", heading: "Related pages:" },
    events: { part: "volatile", heading: "Earlier events:" },
    evidence: { part: "volatile", heading: "Original messages:" },
    threads: { part: "volatile", heading: "Open threads:" },
};

/** Normalize record text before comparison and rendering; whitespace differences do not make a distinct fact. */
export const flattened = (text: string) => text.replace(/\s+/g, " ").trim();

/** `body` flattened to one line behind the tag, added after so an id is never altered. */
const taggedLine = (item: Pick<LaneItem, "lane" | "id">, body: string) => `${itemTag(item)} ${flattened(body)}`;

/** A flow title with how far back it is. */
export function flowLine({ id, title }: Pick<MemoryEvent, "id" | "title">, turnsAgo: number): string {
    return taggedLine({ lane: "flow", id }, `${turnsAgo} ${turnsAgo === 1 ? "turn" : "turns"} ago: ${title}`);
}

/** An event whole: its story time when it has one, its title and summary, then its key lines. */
export function eventLine({
    id,
    storyTime,
    title,
    summary,
    keyLines,
}: Pick<MemoryEvent, "id" | "storyTime" | "title" | "summary" | "keyLines">): string {
    const time = flattened(storyTime.text);
    const lines = keyLines.map(({ text, speaker }) => {
        const said = flattened(speaker);
        return ` "${flattened(text)}"${said && ` (${said})`}`;
    });
    return taggedLine({ lane: "events", id }, `${time && `(${time}) `}${title}: ${summary}${lines.join("")}`);
}

/** An excerpt of the message `id`. */
export function evidenceLine(id: string, role: ReadEntry["role"], excerpt: string): string {
    return taggedLine({ lane: "evidence", id }, `${role === "user" ? "user" : "character"}: "${flattened(excerpt)}"`);
}

/** A thread with its state, so a paused one reads as paused. */
export function threadLine({ id, title, state }: Pick<MemoryThread, "id" | "title" | "state">): string {
    return taggedLine({ lane: "threads", id }, `${title} (${state})`);
}

function knowledgeClause({ fact, stance, privateTo: [holder, ...others] = [] }: PageKnowledge): string {
    const also = others.length > 0 ? `, also known to ${others.join(", ")}` : "";
    return `${stance}: "${fact}"${holder === undefined ? "" : ` (private to ${holder}${also})`}`;
}

/**
 * A page on one line, in either lane, whose tags are the same. A disputed section says so, since its body
 * holds two values. Bodies are whole, with whitespace collapsed to one line.
 */
export function pageLine(
    { id, title }: Pick<MemoryPage, "id" | "title">,
    { present, sections, knowledge, unaware }: PageLineParts,
): string {
    const clauses = [
        ...(present.length > 0 ? [`present: ${present.join(", ")}`] : []),
        ...sections.map(({ heading, body, disputed }) => `${heading}${disputed ? " (disputed)" : ""}: ${body}`),
        ...knowledge.map(knowledgeClause),
        ...(unaware.length > 0 ? [`does not know: ${unaware.map((fact) => `"${fact}"`).join("; ")}`] : []),
    ];
    return taggedLine({ lane: "pages", id }, [title, ...clauses].join(" | "));
}

/** The card's text around `lines`, the lanes with an entry there under their headings. */
function renderParts(lines: ReadonlyMap<MemoryManifestLane, readonly string[]>): CardParts {
    const blocks = (part: keyof CardParts) =>
        MEMORY_MANIFEST_LANES.filter((lane) => CARD_LANES[lane].part === part && lines.has(lane)).map((lane) =>
            [CARD_LANES[lane].heading, ...lines.get(lane)!].join("\n"),
        );
    return { stable: [RULE_HEADER, ...blocks("stable")].join("\n\n"), volatile: blocks("volatile").join("\n\n") };
}

/** Within a lane the card lists items by `order`, which is chat order for events and rank for pages. */
function linesOf(items: readonly LaneItem[]): Map<MemoryManifestLane, string[]> {
    const lines = new Map<MemoryManifestLane, string[]>();
    for (const { lane, line } of items.toSorted((a, b) => a.order - b.order)) {
        const listed = lines.get(lane);
        if (listed) {
            listed.push(line);
        } else {
            lines.set(lane, [line]);
        }
    }
    return lines;
}

/**
 * The card of `lanes` under `maximum`, or the required lane's refusal. That lane is reserved first: over
 * its target, or rendered alone over `maximum`, it refuses, because nothing may cut it.
 *
 * Every other line is counted, the frame (the rule header, the required lines, the headings of the other
 * lanes with items, and each part's own message) comes off `maximum`, and `spendLanes` shares the rest.
 * Lines counted apart need not add up to the text they make, so the rendered parts are counted too, each
 * as one system chat, and while their sum is over `maximum` the last admitted item goes as `budget`.
 * Required items are admitted first and fit alone, so none of them goes. Admission order means the
 * newest flow title is the last of the flow to go, and evidence goes before the event it requires. With
 * no item left, both parts are empty and the card costs nothing.
 *
 * A lane's lines are counted together, so a tokenizer that goes over the network uses its own queue.
 */
export async function buildMemoryCard(
    tokenizer: MemoryTokenizer,
    { maximum, lanes }: { maximum: number; lanes: readonly Lane<LaneCandidate>[] },
): Promise<MemoryCard | RequiredOverLimit> {
    const count = (content: string) => tokenizer.tokenizeChat({ role: "system", content });
    const partTokens = async ({ stable, volatile }: CardParts) =>
        (await count(stable)) + (volatile === "" ? 0 : await count(volatile));

    const counted: Lane[] = [];
    for (const lane of lanes) {
        // `Promise.all` answers in input order, however the counts finish, so `items` keep their rank.
        const items = await Promise.all(lane.items.map(async (item) => ({ ...item, tokens: await count(item.line) })));
        counted.push({ ...lane, items });
    }

    const required = counted.find(({ lane }) => lane === "required");
    const reserved = required?.items ?? [];
    const reservedTokens = reserved.reduce((sum, { tokens }) => sum + tokens, 0);
    const overLimit = (tokens: number, limit: number): RequiredOverLimit => ({
        type: "requiredOverLimit",
        pages: reserved.map(({ id, tokens: pageTokens }) => ({ id, tokens: pageTokens })),
        tokens,
        limit,
    });
    if (required && reservedTokens > required.target) {
        return overLimit(reservedTokens, required.target);
    }
    const reservedLines = linesOf(reserved);
    if (reserved.length > 0) {
        const alone = await partTokens(renderParts(reservedLines));
        if (alone > maximum) {
            return overLimit(alone, maximum);
        }
    }

    const spending = counted.filter((lane) => lane !== required);
    const frameLines = new Map<MemoryManifestLane, readonly string[]>(reservedLines);
    for (const { lane, target, items } of spending) {
        if (target > 0 && items.length > 0) {
            frameLines.set(lane, []);
        }
    }
    const frame = await partTokens(renderParts(frameLines));

    const { included: admitted, excluded, spend } = spendLanes({ maximum: maximum - frame, lanes: spending });
    const included = [...reserved, ...admitted];
    if (required) {
        spend.unshift({ lane: "required", target: required.target, spent: reservedTokens });
    }
    while (included.length > 0) {
        const parts = renderParts(linesOf(included));
        const whole = await partTokens(parts);
        if (whole <= maximum) {
            const items = included.map(({ id, kind, lane, reason, tokens }) => {
                return { id, kind, lane, reason, tokens, verified: false };
            });
            return { type: "card", ...parts, tokens: whole, items, excluded, spend };
        }
        const { id, kind, lane, tokens } = included.pop()!;
        excluded.push({ id, kind, lane, reason: "budget" });
        spend.find((row) => row.lane === lane)!.spent -= tokens;
    }
    return { type: "card", stable: "", volatile: "", tokens: 0, items: [], excluded, spend };
}
