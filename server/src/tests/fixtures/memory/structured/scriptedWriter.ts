// The two `fetch` boundaries of the Structured Memory evaluation (not a test file itself): a chat
// upstream that answers the writer's calls from a story, and an embedding upstream that answers with a
// lexical vector. Everything between them, the request layer, the writer, admission, the store, and
// the embeddings processor, is the real code.
//
// The chat upstream tells the call kinds apart by their fixed frames (`prompts.ts`): the analysis call
// carries the raw window, and only it is checked to hold its window's text; the patch call is checked
// against the event it was admitted for; the compaction call against the section body the patch
// answered. A request that matches none, or matches with other text, throws, so a run cannot pass on a
// prompt the script did not expect. A HypaV3 summary request is answered with a fixed share of its
// window. Every request and its answer are kept, and that record is what the ledger counts, because
// compaction prompts and answers are not stored on runs.

import { createHash } from "node:crypto";
import type { MemoryPageCandidate, MemoryPageType } from "../../../../../../shared/structuredMemory.ts";
import { lexicalTerms } from "../../../../prompt/memory/structured/retrieve.ts";
import { pageTypeOf, type Story, type TurnScript, turnOfMessageId } from "./story.ts";

export const SCRIPTED_CHAT_URL = "https://mock.test/v1/chat/completions";
export const SCRIPTED_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";

/** The hashed bag of terms has this many dimensions. */
export const LEXICAL_DIMENSIONS = 256;

/** What a HypaV3 summary keeps of its window's text. */
export const SUMMARY_SHARE = 0.3;

export type ScriptedCallKind = "analysis" | "patch" | "compaction" | "summary";

/** One request to the chat upstream, as sent, with the answer the script gave. */
export type ScriptedCall = {
    index: number;
    kind: ScriptedCallKind;
    /** The story turn the call records; none on a summary. */
    turn?: number;
    messages: { role: string; content: string }[];
    answer: string;
};

export class ScriptedRequestMismatch extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScriptedRequestMismatch";
    }
}

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * A text's lexical vector: each term of `lexicalTerms` hashed to one of `LEXICAL_DIMENSIONS` slots with a
 * sign, the whole normalized to unit length. Two texts are similar as far as they share terms, and
 * nothing more: no model is behind it.
 */
export function lexicalEmbedding(text: string): number[] {
    const vector = new Array<number>(LEXICAL_DIMENSIONS).fill(0);
    for (const term of lexicalTerms(text)) {
        const digest = createHash("sha256").update(term, "utf8").digest();
        const slot = (digest[0] | (digest[1] << 8)) % LEXICAL_DIMENSIONS;
        vector[slot] += digest[2] & 1 ? 1 : -1;
    }
    const norm = Math.hypot(...vector);
    return norm === 0 ? vector : vector.map((value) => value / norm);
}

/** The cosine of two vectors as retrieval reads it: in [0, 1], NaN as 0. */
export function unitCosine(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let index = 0; index < a.length && index < b.length; index++) {
        dot += a[index] * b[index];
        na += a[index] * a[index];
        nb += b[index] * b[index];
    }
    const cosine = dot / (Math.sqrt(na) * Math.sqrt(nb));
    return Number.isNaN(cosine) ? 0 : Math.min(1, Math.max(0, cosine));
}

/** The embedding upstream: a lexical vector per input, in one answer, counting what it was asked. */
export function createScriptedEmbeddings() {
    const counts = { requests: 0, texts: 0 };
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
        if (String(url) !== SCRIPTED_EMBEDDING_URL) {
            throw new ScriptedRequestMismatch(`Unexpected embedding upstream ${String(url)}`);
        }
        const body = JSON.parse(String(init.body)) as { input: string | string[] };
        const input = Array.isArray(body.input) ? body.input : [body.input];
        counts.requests++;
        counts.texts += input.length;
        return json({ data: input.map((text) => ({ embedding: lexicalEmbedding(text) })) });
    }) as typeof fetch;
    return { fetchImpl, counts };
}

// ---------------------------------------------------------------------------------------------
// The chat upstream

/** The opening words of each default frame's system message (`prompts.ts`). */
const FRAMES = {
    analysis: "You keep the memory of a long roleplay.",
    patch: "You keep the pages of a long roleplay's memory. Update them",
    compaction: "You keep the pages of a long roleplay's memory. Make one section",
    summary: "[Summarize the ongoing role story",
} as const;

/** The text between `from` and `to` in `content`; `to` absent means to the end. */
function slice(content: string, from: string, to: string | null): string {
    const start = content.indexOf(from);
    if (start === -1) {
        throw new ScriptedRequestMismatch(`The prompt has no "${from.trim()}" slot`);
    }
    const begin = start + from.length;
    const end = to === null ? content.length : content.indexOf(to, begin);
    if (end === -1) {
        throw new ScriptedRequestMismatch(`The prompt's "${from.trim()}" slot has no end`);
    }
    return content.slice(begin, end);
}

/** One JSON object per line, or none for `(none)`. */
function rows<T>(text: string): T[] {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === "(none)") {
        return [];
    }
    return trimmed.split("\n").map((line) => JSON.parse(line) as T);
}

type CastRow = { id: string; type: MemoryPageType; title: string; aliases: string[] };
type ThreadRow = { id: string; title: string; who: string[]; state: string };
type PatchRow = {
    id: string;
    type: MemoryPageType;
    title: string;
    sections: { heading: string; body?: string; empty?: true; locked?: true }[];
    notShown: string[];
};

/** The most lines an appended section keeps: a place's visits may pass its budget, the rest never do. */
const APPEND_LINES = { visits: 40, other: 12 } as const;
/** What a compaction keeps of a section. */
const COMPACTED_LINES = 5;

const key = (title: string, heading: string) => `${title}\u0000${heading}`;

/**
 * The chat upstream over `story`. `calls` is every request answered, in order. `unresolvedCloses` counts
 * the thread closes the story asked for whose thread the prompt did not list, which the script then
 * leaves open rather than naming an id it was not shown.
 */
export function createScriptedChat(options: { story?: Story; clock?: { now: number } } = {}) {
    const { story } = options;
    const calls: ScriptedCall[] = [];
    const turns = new Map<number, TurnScript>(story?.turns.map((turn) => [turn.turn, turn]) ?? []);
    /** The turn whose analysis was answered last: its patch call comes next, in the same run. */
    let patching: TurnScript | undefined;
    /** The last body the script answered for each page section, which a compaction call must show. */
    const bodies = new Map<string, string>();
    const counts = { unresolvedCloses: 0 };

    const answerAnalysis = (messages: ScriptedCall["messages"]): { turn: number; answer: string } => {
        if (!story) {
            throw new ScriptedRequestMismatch("An analysis request reached a provider with no story");
        }
        const user = messages.find(({ role }) => role === "user")?.content ?? "";
        const cast = rows<CastRow>(slice(user, "Pages:\n", "\n\nScene:\n"));
        const threads = rows<ThreadRow>(slice(user, "Open threads:\n", "\n\nBefore these messages:\n"));
        const recorded = slice(user, "Messages to record:\n", null);
        const ids = [...recorded.matchAll(/^\[m:([^\]]+)\] /gm)].map((match) => match[1]);
        const turnNumbers = new Set(ids.map((id) => turnOfMessageId(id)));
        if (ids.length === 0 || turnNumbers.size !== 1 || turnNumbers.has(null)) {
            throw new ScriptedRequestMismatch(`An analysis window spans ${JSON.stringify(ids)}, not one turn`);
        }
        const [turnNumber] = turnNumbers;
        const turn = turns.get(turnNumber!);
        if (!turn) {
            throw new ScriptedRequestMismatch(`No story turn ${turnNumber}`);
        }
        for (const text of ids.map((id) => (id === turn.userId ? turn.user : id === turn.charId ? turn.char : null))) {
            if (text === null || !recorded.includes(text)) {
                throw new ScriptedRequestMismatch(`The analysis prompt of turn ${turn.turn} lacks its message text`);
            }
        }
        const byTitle = new Map<string, string>();
        for (const { id, title, aliases } of cast) {
            byTitle.set(title, id);
            for (const alias of aliases) {
                byTitle.set(alias, id);
            }
        }
        const plan = turn.analysis;
        const referenced = new Set<string>([
            ...plan.participants,
            ...plan.scene.participants,
            ...plan.stateChanges.map(({ pageId }) => pageId),
            ...plan.knowledge.flatMap(({ pageId, knowers }) => [pageId, ...(knowers ?? [])]),
            ...plan.relationshipShifts.flatMap(({ from, to }) => [from, to]),
            ...plan.openThreads.add.flatMap(({ who }) => who),
            ...plan.pages.map(({ title }) => title),
        ]);
        // The format's rule: a listed page by its id, a new subject by a create whose title stands in for it.
        const ref = (title: string) => byTitle.get(title) ?? title;
        const candidates: MemoryPageCandidate[] = [];
        for (const title of referenced) {
            const id = byTitle.get(title);
            const target = plan.pages.find((page) => page.title === title);
            if (id !== undefined && target) {
                candidates.push({ targetId: id, reason: plan.title, confidence: 1 });
            } else if (id === undefined) {
                candidates.push({
                    create: { type: pageTypeOf(story, title), title, aliases: [] },
                    reason: plan.title,
                    confidence: 1,
                });
            }
        }
        const close: string[] = [];
        for (const title of plan.openThreads.close) {
            const thread = threads.find((row) => row.title === title);
            if (thread) {
                close.push(thread.id);
            } else {
                counts.unresolvedCloses++;
            }
        }
        const answer = {
            title: plan.title,
            summary: plan.summary,
            participants: plan.participants.map(ref),
            storyTime: plan.storyTime,
            keyLines: plan.keyLines,
            stateChanges: plan.stateChanges.map((change) => ({ ...change, pageId: ref(change.pageId) })),
            knowledge: plan.knowledge.map((item) => ({
                ...item,
                pageId: ref(item.pageId),
                ...(item.knowers ? { knowers: item.knowers.map(ref) } : {}),
                axes: plan.axes,
            })),
            relationshipShifts: plan.relationshipShifts.map((shift) => ({
                ...shift,
                from: ref(shift.from),
                to: ref(shift.to),
            })),
            openThreads: {
                add: plan.openThreads.add.map(({ title, who }) => ({ title, who: who.map(ref) })),
                close,
                transitions: [],
            },
            axes: plan.axes,
            pageCandidates: candidates,
            scene: { ...plan.scene, participants: plan.scene.participants.map(ref) },
        };
        patching = turn;
        return { turn: turn.turn, answer: JSON.stringify(answer) };
    };

    const answerPatch = (messages: ScriptedCall["messages"]): { turn: number; answer: string } => {
        const user = messages.find(({ role }) => role === "user")?.content ?? "";
        const shown = rows<PatchRow>(slice(user, "Pages:\n", "\n\nEvent:\n"));
        const event = JSON.parse(slice(user, "\n\nEvent:\n", null)) as { title: string; summary: string };
        const turn = patching;
        if (!turn || event.title !== turn.analysis.title || event.summary !== turn.analysis.summary) {
            throw new ScriptedRequestMismatch(`A patch call for "${event.title}" follows no analysis of it`);
        }
        const patches: { pageId: string; heading: string; op: "upsert"; body: string }[] = [];
        for (const row of shown) {
            const script = turn.patches.find(({ title }) => title === row.title);
            if (!script) {
                continue;
            }
            for (const { heading, op, text } of script.sections) {
                if (row.notShown.includes(heading) || row.sections.some((s) => s.heading === heading && s.locked)) {
                    continue;
                }
                const current = row.sections.find((section) => section.heading === heading)?.body ?? "";
                const lines = current === "" ? [] : current.split("\n");
                let body: string;
                switch (op) {
                    case "replace":
                        body = text;
                        break;
                    case "append": {
                        const keep = heading === "visits" ? APPEND_LINES.visits : APPEND_LINES.other;
                        body = [...lines, `- ${text}`].slice(-keep).join("\n");
                        break;
                    }
                    case "addLine":
                        body = lines.includes(`- ${text}`) ? current : [...lines, `- ${text}`].join("\n");
                        break;
                    case "removeLine":
                        body = lines.filter((line) => line !== `- ${text}`).join("\n");
                        break;
                }
                if (body.trim() === "" || body === current) {
                    continue;
                }
                patches.push({ pageId: row.id, heading, op: "upsert", body });
                bodies.set(key(row.title, heading), body);
            }
        }
        return { turn: turn.turn, answer: JSON.stringify({ patches }) };
    };

    const answerCompaction = (messages: ScriptedCall["messages"]): { turn: number | undefined; answer: string } => {
        const user = messages.find(({ role }) => role === "user")?.content ?? "";
        const page = JSON.parse(slice(user, "Page:\n", "\n\nSection:\n")) as { title: string; heading: string };
        const body = slice(user, "\n\nSection:\n", null);
        const expected = bodies.get(key(page.title, page.heading));
        if (expected !== body) {
            throw new ScriptedRequestMismatch(
                `A compaction call for ${page.title}: ${page.heading} shows a body the script did not write`,
            );
        }
        const lines = body.split("\n");
        let shorter = lines.slice(-COMPACTED_LINES).join("\n");
        if (shorter.length >= body.length) {
            shorter = body.slice(Math.floor(body.length / 2)).trimStart();
        }
        bodies.set(key(page.title, page.heading), shorter);
        return { turn: patching?.turn, answer: JSON.stringify({ body: shorter }) };
    };

    const answerSummary = (messages: ScriptedCall["messages"]): string => {
        const text = messages.find(({ role }) => role === "user")?.content ?? "";
        const cut = Math.max(1, Math.floor(text.length * SUMMARY_SHARE));
        const space = text.lastIndexOf(" ", cut);
        return text.slice(0, space > cut / 2 ? space : cut).trim() || text.slice(0, cut);
    };

    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
        if (String(url) !== SCRIPTED_CHAT_URL) {
            throw new ScriptedRequestMismatch(`Unexpected chat upstream ${String(url)}`);
        }
        const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
        const messages = body.messages.map(({ role, content }) => ({ role, content }));
        const system = messages.find(({ role }) => role === "system")?.content ?? "";
        let call: Omit<ScriptedCall, "index" | "messages">;
        if (system.startsWith(FRAMES.analysis)) {
            call = { kind: "analysis", ...answerAnalysis(messages) };
        } else if (system.startsWith(FRAMES.patch)) {
            call = { kind: "patch", ...answerPatch(messages) };
        } else if (system.startsWith(FRAMES.compaction)) {
            const { turn, answer } = answerCompaction(messages);
            call = { kind: "compaction", ...(turn === undefined ? {} : { turn }), answer };
        } else if (system.startsWith(FRAMES.summary)) {
            call = { kind: "summary", answer: answerSummary(messages) };
        } else {
            throw new ScriptedRequestMismatch(`A chat request matches no scripted call: ${system.slice(0, 60)}`);
        }
        calls.push({ index: calls.length, messages, ...call });
        if (options.clock) {
            options.clock.now += 1;
        }
        return json({ choices: [{ message: { role: "assistant", content: call.answer } }] });
    }) as typeof fetch;

    return { fetchImpl, calls, counts };
}
