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
 * - One line per item, led by a tag a send finds its final entries by, then takes out before the request.
 *   Both flow forms share a tag distinct from the events lane's tag; their reasons distinguish a title
 *   from a full timeline line. A page has one item, including what it knows and does not know.
 * - Flow is rendered by place under a timeline heading when enabled, including summaries and the
 *   newest candidates' key lines. A zero flow target keeps the title-only form and heading.
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
    "These records are authoritative for the past, and the scene for the present; recent messages win over both.";

/** Each lane's part and heading. `MEMORY_MANIFEST_LANES` orders the lanes within a part. */
const CARD_LANES: Record<MemoryManifestLane, { part: keyof CardParts; heading: string }> = {
    required: { part: "stable", heading: "Current facts:" },
    flow: { part: "stable", heading: "Recent events:" },
    pages: { part: "volatile", heading: "Related pages:" },
    events: { part: "volatile", heading: "Earlier events:" },
    evidence: { part: "volatile", heading: "Original messages:" },
    threads: { part: "volatile", heading: "Open threads:" },
};
const TIMELINE_HEADING = "Recent events (oldest first; the last is just before the messages below):";

/** Normalize record text before comparison and rendering; whitespace differences do not make a distinct fact. */
export const flattened = (text: string) => text.replace(/\s+/g, " ").trim();

/** `body` flattened to one line behind the tag, added after so an id is never altered. */
const taggedLine = (item: Pick<LaneItem, "lane" | "id">, body: string) => `${itemTag(item)} ${flattened(body)}`;

/** A flow title with how far back it is. */
export function flowLine({ id, title }: Pick<MemoryEvent, "id" | "title">, turnsAgo: number): string {
    return taggedLine({ lane: "flow", id }, `${turnsAgo} ${turnsAgo === 1 ? "turn" : "turns"} ago: ${title}`);
}

/** The shared body of a full event, with its story time when present and its supplied key lines. */
function eventBody({
    storyTime,
    title,
    summary,
    keyLines,
}: Pick<MemoryEvent, "storyTime" | "title" | "summary" | "keyLines">): string {
    const time = flattened(storyTime.text);
    const lines = keyLines.map(({ text, speaker }) => {
        const said = flattened(speaker);
        return ` "${flattened(text)}"${said && ` (${said})`}`;
    });
    return `${time && `(${time}) `}${title}: ${summary}${lines.join("")}`;
}

/** An event whole: its story time when it has one, its title and summary, then its key lines. */
export function eventLine(event: Pick<MemoryEvent, "id" | "storyTime" | "title" | "summary" | "keyLines">): string {
    return taggedLine({ lane: "events", id: event.id }, eventBody(event));
}

/** A full timeline line with the flow tag and how far back the event is. */
export function flowEventLine(
    event: Pick<MemoryEvent, "id" | "storyTime" | "title" | "summary" | "keyLines">,
    turnsAgo: number,
): string {
    return taggedLine(
        { lane: "flow", id: event.id },
        `${turnsAgo} ${turnsAgo === 1 ? "turn" : "turns"} ago: ${eventBody(event)}`,
    );
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
function renderParts(lines: ReadonlyMap<MemoryManifestLane, readonly string[]>, timeline = false): CardParts {
    const blocks = (part: keyof CardParts) =>
        MEMORY_MANIFEST_LANES.filter((lane) => CARD_LANES[lane].part === part && lines.has(lane)).map((lane) =>
            [lane === "flow" && timeline ? TIMELINE_HEADING : CARD_LANES[lane].heading, ...lines.get(lane)!].join("\n"),
        );
    return { stable: [RULE_HEADER, ...blocks("stable")].join("\n\n"), volatile: blocks("volatile").join("\n\n") };
}

/** Within a lane the card lists items by `order`, which is chat order for events and rank for pages. */
function linesOf(items: readonly Pick<LaneItem, "lane" | "line" | "order">[]): Map<MemoryManifestLane, string[]> {
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

/** The real frame, including required lines and each nonempty part's own system message. */
async function frameTokens(
    tokenizer: MemoryTokenizer,
    reserved: readonly LaneCandidate[],
    headings: readonly MemoryManifestLane[],
    timeline = false,
): Promise<number> {
    const lines = linesOf(reserved);
    for (const lane of headings) lines.set(lane, []);
    const { stable, volatile } = renderParts(lines, timeline);
    const count = (content: string) => tokenizer.tokenizeChat({ role: "system", content });
    return (await count(stable)) + (volatile === "" ? 0 : await count(volatile));
}

/**
 * Checks both required-page refusal rules through the card builder before retrieval embeds anything.
 * Even the cheapest enabled optional lane needs its heading and the required frame. If that frame
 * exhausts the budget, no optional item can enter. This is sufficient, not an exact item-fit test.
 */
export async function preflightMemoryCard(
    tokenizer: MemoryTokenizer,
    { maximum, lanes }: { maximum: number; lanes: readonly Lane<LaneCandidate>[] },
): Promise<RequiredOverLimit | { type: "ready"; embeddings: boolean }> {
    const required = lanes.filter(({ lane }) => lane === "required");
    const card = await buildMemoryCard(tokenizer, { maximum, lanes: required });
    if (card.type === "requiredOverLimit") return card;
    const frames = await Promise.all(
        lanes
            .filter(
                ({ lane, target, flow }) =>
                    lane !== "required" && (lane === "flow" && flow ? flow.timeline || flow.titles > 0 : target > 0),
            )
            .map(({ lane, flow }) => frameTokens(tokenizer, required[0]?.items ?? [], [lane], flow?.timeline)),
    );
    return { type: "ready", embeddings: maximum > Math.min(...frames) };
}

/**
 * The card of `lanes` under `maximum`, or the required lane's refusal. That lane is reserved first: over
 * its target, or rendered alone over `maximum`, it refuses, because nothing may cut it.
 *
 * Every other line is counted, the frame (the rule header, the required lines, the headings of the other
 * lanes with items, and each part's own message) comes off `maximum`, and `spendLanes` shares the rest.
 * Lines counted apart need not add up to the text they make, so the rendered parts are counted too, each
 * as one system chat, and while their sum is over `maximum` the last admitted item goes as `budget`.
 * Required items are admitted first and fit alone, so none of them goes. Then come the flow core run
 * newest first, its titles, other lanes' core items, lending, and the flow extension with the titles
 * it moved. Evidence goes before the full line it requires, and extension admissions before core
 * ones. Nothing is downgraded. With no item left, both parts are empty and the card costs nothing.
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
    const timeline = lanes.some(({ lane, flow }) => lane === "flow" && flow?.timeline);
    const countItems = (items: readonly LaneCandidate[]) =>
        Promise.all(items.map(async (item) => ({ ...item, tokens: await count(item.line) })));
    for (const lane of lanes) {
        // `Promise.all` answers in input order, however the counts finish, so `items` keep their rank.
        const [items, full] = await Promise.all([countItems(lane.items), countItems(lane.flow?.full ?? [])]);
        counted.push({ ...lane, items, flow: lane.flow ? { ...lane.flow, full } : undefined });
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
    const frame = await frameTokens(
        tokenizer,
        reserved,
        spending.filter(({ target, items }) => target > 0 && items.length > 0).map(({ lane }) => lane),
        timeline,
    );

    const { included: admitted, excluded, spend } = spendLanes({ maximum: maximum - frame, lanes: spending });
    const included = [...reserved, ...admitted];
    if (required) {
        spend.unshift({ lane: "required", target: required.target, spent: reservedTokens });
    }
    while (included.length > 0) {
        const parts = renderParts(linesOf(included), timeline);
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
