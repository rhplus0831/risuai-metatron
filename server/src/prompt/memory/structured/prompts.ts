import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import { eligibleHistory } from "../../../../../shared/contextReport.ts";
import type { Message } from "../../../../../shared/database.ts";
import type { OpenAIChat } from "../../../../../shared/openai.ts";
import {
    MEMORY_KNOWLEDGE_STANCES,
    MEMORY_PAGE_TYPES,
    MEMORY_PATCH_CONFLICTS,
    MEMORY_PATCH_OPS,
    MEMORY_THREAD_STATES,
    type MemoryPage,
    type MemoryThread,
    memorySectionBudget,
    memoryThreadEnded,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    type StructuredMemoryDefaultPromptsAnswer,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryEventWrite } from "../../../data/memoryStore.ts";
import type { MemoryHost } from "../host.ts";
import type { CompactionTarget } from "./compact.ts";
import { type CastRow, PROMPT_TAKEN_BACK, revertEntries, SCENE_SECTIONS } from "./pages.ts";
import type { PatchRow } from "./patches.ts";
import type { WriterWindow } from "./window.ts";

/**
 * The writer's three prompts: ChatML frames with named slots, read through the task host's parser. The
 * frame and the preset's `instructions` go through ChatML and CBS. The slot values are filled in
 * afterwards, in one pass over the parsed messages, so chat and model text never reach CBS and cannot
 * start a ChatML message, and a value that holds a slot's name stays as it is.
 *
 * Under the preset's `fineTuning`, its `analysisPrompt` and `patchPrompt` are the whole frame of their
 * call (`parseCustomFrame`): the same parser and the same filling, with `instructions` left out, since
 * the person writes the frame. A custom frame is checked after CBS and before filling, so a CBS branch
 * cannot hide a slot: it must quote the call's required slots, because a call without its messages or
 * its pages has nothing to validate against. The compaction frame stays code's in both modes, and so does
 * what the slots hold, which is why the answer's validation is the same whatever the frame.
 *
 * The analysis prompt's size is a cost on every recorded turn: its fixed parts stay short and everything
 * it lists is bounded. Only `messages` is not, because a quote must be found in the window's whole text.
 * The default patch prompt holds no message and everything in it is bounded, so it needs no size check
 * of its own; a custom one is checked by the writer, since its frame can be any length. Neither needs the
 * compaction prompt: it holds one section, and no run keeps it.
 */

/** The analysis prompt's slot names, in the default frame's order. */
export const ANALYSIS_SLOT_NAMES = [
    "format",
    "rules",
    "language",
    "cast",
    "scene",
    "threads",
    "previous",
    "messages",
] as const;

/** The patch prompt's slot names: the same names, where `cast` is its pages and `previous` the event. */
export const PATCH_SLOT_NAMES = ["format", "rules", "language", "cast", "previous"] as const;

/** The slots a custom frame must quote, by call: what the call records, and what its answer is checked against. */
export const REQUIRED_SLOT_NAMES = {
    analysis: ["messages", "scene"],
    patch: ["cast", "previous"],
} as const satisfies Record<"analysis" | "patch", readonly string[]>;

/** The prompt's named inputs. */
export type AnalysisSlots = Record<(typeof ANALYSIS_SLOT_NAMES)[number], string>;

/** The patch prompt's named inputs. */
export type PatchSlots = Record<(typeof PATCH_SLOT_NAMES)[number], string>;

/** The compaction prompt's named inputs: `page` says what the section is, and `section` is its body. */
export type CompactSlots = Record<"format" | "rules" | "language" | "page" | "section", string>;

/** What the slots are written from. */
export type AnalysisInput = {
    language: string;
    /** The pages to list (`castSlice`). */
    cast: readonly CastRow[];
    scene: MemoryPage | null;
    /** The open threads to show (`promptThreads`). */
    threads: readonly MemoryThread[];
    /** The open threads left out, which the slot states so the model knows the list is not all of them. */
    moreThreads?: number;
    /** The last recorded event's title. */
    previousTitle: string | undefined;
    /** The chat's stored messages. */
    messages: readonly Message[];
    window: WriterWindow;
    /** A message's speaker label. */
    speaker(message: Message): string;
};

/** What the patch slots are written from. */
export type PatchInput = {
    language: string;
    rows: readonly PatchRow[];
    /** The event as admitted, so nothing unverified reaches a page. */
    event: MemoryEventWrite;
};

/** What the compaction slots are written from. */
export type CompactInput = {
    language: string;
    target: CompactionTarget;
};

/** `inlayTokenRegex` of `src/ts/util/inlayTokens.ts`. */
const INLAY_TOKEN_REGEX = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;
const SLOT_TOKEN_REGEX = /{{slot::([a-z]+)}}/g;
/** What an empty list shows, so the model does not read it as a gap in the prompt. */
const NONE = "(none)";

const FORMAT = `Answer with one JSON object and nothing else, with exactly these fields:
{
  "title": "a short title",
  "summary": "what happened, at most ${LIMITS.eventSummaryChars} characters",
  "participants": ["page id"],
  "storyTime": { "text": "when this happens in the story, or empty" },
  "keyLines": [{ "speaker": "speaker label", "text": "quote" }],
  "stateChanges": [{ "pageId": "page id", "section": "what changed", "before": "old value", "after": "new value", "quote": "quote" }],
  "knowledge": [{ "pageId": "page id of who learned it", "fact": "the fact", "stance": "${MEMORY_KNOWLEDGE_STANCES.join(" or ")}", "quote": "quote", "knowers": ["page id, only on a secret"], "axes": { "persistence": 0, "change": 0, "reach": 0 } }],
  "relationshipShifts": [{ "from": "page id", "to": "page id", "direction": "how it moved", "note": "why" }],
  "openThreads": {
    "add": [{ "title": "a new promise or open question", "who": ["page id"] }],
    "close": ["id of a thread this resolves"],
    "transitions": [{ "threadId": "thread id", "to": "${MEMORY_THREAD_STATES.join(" or ")}" }]
  },
  "axes": { "persistence": 0, "change": 0, "reach": 0 },
  "pageCandidates": [
    { "targetId": "page id", "reason": "what changes on it", "confidence": 0.9 },
    { "create": { "type": "${MEMORY_PAGE_TYPES.filter((type) => type !== "scene").join(" or ")}", "title": "its name", "aliases": ["another name"] }, "reason": "why it needs a page", "confidence": 0.9 }
  ],
  "scene": { "participants": ["page id"], "place": "where it is now", "time": "when it is now", "state": "what is going on now" }
}
Axes score how long it lasts, how much it changes, and how many it touches.
Empty lists stay as []. At most ${LIMITS.keyLinesPerEvent} keyLines, ${LIMITS.stateChangesPerEvent} stateChanges, ${LIMITS.knowledgePerEvent} knowledge, ${LIMITS.relationshipShiftsPerEvent} relationshipShifts, ${LIMITS.threadsPerEvent} of each thread list, and ${LIMITS.pageCandidates} pageCandidates.
"scene" is null when nothing about it changed; a blank field keeps what the scene says.`;

const RULES = `Rules:
- A quote (a key line's text and every "quote") is copied verbatim from one message under "Messages to record", at most ${LIMITS.keyLineChars} characters: never reworded, never joined across messages or across an [Image] mark, never taken from the context.
- Page and thread ids come only from the lists shown. Never invent an id: a lasting subject with no listed page gets a "create" in pageCandidates, and its exact title stands in for its id in this answer. Leave out the rest.
- pageCandidates name the pages whose facts these messages change: a listed page by "targetId", a new one by "create". Confidence runs from 0 to 1 and says how sure you are of it.
- Each axis is an integer from 0 to ${LIMITS.axisMax}.
- A scene field never repeats a text listed as taken back unless the messages establish it again.
- When these messages newly establish a lasting fact about a listed character (age, family, occupation, real name, origin, nature, who now owns or is responsible for them, where they now live, or that a situational role such as customer, visitor or patient has ended) that the page's identity summary lacks or contradicts, report it in stateChanges with section "identity", the quote that establishes it, and name that page in pageCandidates.
- Read each sentence of a listed page's identity against these messages: when a sentence describes a situation, condition or role that these messages show has ended or been resolved, report it in stateChanges with section "identity", a quote that establishes the end, and name that page in pageCandidates.`;

const PATCH_FORMAT = `Answer with one JSON object and nothing else:
{ "patches": [{ "pageId": "page id", "heading": "section heading", "op": "${MEMORY_PATCH_OPS.join(" or ")}", "body": "the section's whole new text, on an upsert", "conflict": "${MEMORY_PATCH_CONFLICTS.join(" or ")}, when it replaces a value", "was": "the value it replaces, without its \\"(was: ...)\\" line", "confidence": 0.9 }] }
At most ${LIMITS.patchesPerCall} patches, each body at most ${LIMITS.sectionBodyChars} characters. With nothing to change, answer { "patches": [] }.`;

const PATCH_RULES = `Rules:
- Change only what the event establishes, on the pages listed. A section you do not name stays as it is.
- An upsert replaces the section's whole text, so repeat what stays true in it.
- A locked section shows at most a short excerpt for context; never patch it or a section listed under notShown, and never leave a page with no text.
- A page's "reason" is the analysis call's note of what changes on it: a lead to check against the event, not itself evidence.
- A character page uses only the headings it lists, and a heading marked empty has no text yet.
- identity holds what lasts about the character: name, what they are (species, occupation, nature, standing in the world), appearance, background, and defining traits. A role that comes from the situation (a customer, a visitor, a guest, someone at the shop today) is currentState, not identity. When the event shows such a role has ended, upsert identity without it, keeping every other fact; mention the past role only as background when it still matters.
- A fact with one current value (a version number, a rank or title, an affiliation, an age) is replaced by the new value, with conflict "change", when the event establishes that the same character's own value moved on. A recollection of an old value, another character's value, or a plan establishes nothing and changes identity nothing.
- identity grows: when the event establishes a lasting fact about the character that identity lacks (age, family, occupation, real name, origin, nature, who now owns or is responsible for them, where they now live), upsert identity with that fact added and every existing sentence kept, in at most a few sentences; it loses a sentence only when the event shows it is no longer true, such as a customer, visitor or patient role that has ended, or a place they have left for good.
- Whenever you upsert identity, re-read each existing sentence against the event and the page's currentState: keep every lasting fact, and leave out a sentence that describes a situation, condition or role the event shows has ended or been resolved, with conflict "change"; a past situation stays only as background when it still explains who the character is.
- currentState holds what is true of the character right now: where they are, what they are doing, how they feel. An upsert replaces it with the present state and keeps nothing that has passed.
- knowledge holds only facts the character will act on later, one short line each, and need not repeat the event's knowledge items, which are already recorded.
- relationships is one line per other character, - <name>: <current standing>, and a change replaces that character's line instead of adding another.
- goals holds what the character is pursuing, one short line each; remove a goal once it is reached or given up.
- inventory holds what the character carries or owns, one short line each; remove what is lost, spent, or given away.
- openContinuity holds unresolved details later scenes must stay consistent with (an injury, a debt, a promise, a thing left behind), one short line each; remove one once it is resolved.
- A "(was: ...)" line is code's record of the value a change replaced: never write one into a body, which holds only what is true now.
- A section marked disputed holds two values, the second on a "[disputed]" line, because an earlier event contradicted the first without settling it. When the event shows which is true, upsert the section with that one value and no "[disputed]" line; otherwise leave the section as it is.
- A section marked userCorrected holds a person's words: change it only when the event contradicts them.
- A person undid what a page lists under takenBack: do not write that text again, and do not delete a section marked deleted there.
- "conflict" is "change" when the story moved on from the old value, and "contradiction" when both cannot be true and the story does not say why, with "confidence" from 0 to 1 that the new value is right.`;

const COMPACT_FORMAT = `Answer with one JSON object and nothing else:
{ "body": "the section's whole shorter text" }`;

/** The compaction call's rules for a slot whose budget is `budget`; other headings keep every true fact. */
function compactRules(heading: string, budget: number): string {
    const rules =
        heading === "knowledge"
            ? `- Keep secrets, facts other characters do not know, and facts that still change what the character will do, and add nothing.
- Drop facts the story has moved past and details a broader fact already implies; each fact remains on the timeline.
- Keep one fact per line.`
            : heading === "relationships"
              ? `- Keep one line per other character in the form - <name>: <current standing>.
- Keep only the current standing, dropping how it changed and why (the timeline keeps that) and every "(was: ...)" line, and add nothing.`
              : `- Keep every fact that is still true and each current value, and add nothing.
- Drop repetition and superseded "(was: ...)" lines first.`;
    return `Rules:\n${rules}\n- Aim for at most ${budget} characters.`;
}

/** The default frame, with the preset's text after the fixed instructions. */
function analysisFrame(instructions: string): string {
    const added = instructions.trim() === "" ? "" : `\n\n${instructions.trim()}`;
    return `<|im_start|>system<|im_sep|>You keep the memory of a long roleplay. Record what the messages to record establish, and nothing else.

{{slot::format}}

{{slot::rules}}

Write all text but quotes and ids in this language: {{slot::language}}${added}<|im_end|>
<|im_start|>user<|im_sep|>Pages:
{{slot::cast}}

Scene:
{{slot::scene}}

Open threads:
{{slot::threads}}

Before these messages:
{{slot::previous}}

Messages to record:
{{slot::messages}}<|im_end|>`;
}

/**
 * The preset's text as the patch and compaction frames add it, cut to `promptPatchChars`, which is what
 * keeps the patch prompt within the run's margin.
 */
function addedInstructions(instructions: string): string {
    const text = clampText(instructions.trim(), LIMITS.promptPatchChars);
    return text === "" ? "" : `\n\n${text}`;
}

/** The patch call's frame: the same shape, with its pages and the event in place of the chat. */
function patchFrame(instructions: string): string {
    return `<|im_start|>system<|im_sep|>You keep the pages of a long roleplay's memory. Update them to say what the event establishes, and nothing else.

{{slot::format}}

{{slot::rules}}

Write all text but ids in this language: {{slot::language}}${addedInstructions(instructions)}<|im_end|>
<|im_start|>user<|im_sep|>Pages:
{{slot::cast}}

Event:
{{slot::previous}}<|im_end|>`;
}

/** The compaction call's frame: the same shape, with one section of one page and nothing else. */
function compactFrame(instructions: string): string {
    return `<|im_start|>system<|im_sep|>You keep the pages of a long roleplay's memory. Make one section of a page shorter without changing what it says.

{{slot::format}}

{{slot::rules}}

Write all text but ids in this language: {{slot::language}}${addedInstructions(instructions)}<|im_end|>
<|im_start|>user<|im_sep|>Page:
{{slot::page}}

Section:
{{slot::section}}<|im_end|>`;
}

/** A message's text as the prompt shows it: raw, so a quote can match, with inlays as `[Image]`. */
const shownText = (message: Message) => message.data.replace(INLAY_TOKEN_REGEX, "[Image]");

/** The last recorded event and the eligible messages before the window: what the model may read but not quote. */
function previousSlot(input: AnalysisInput): string {
    const eligible = eligibleHistory(input.messages).messages;
    const first = eligible.findIndex(({ chatId }) => chatId === input.window.sources[0]?.messageId);
    const context = eligible.slice(Math.max(0, first - LIMITS.contextMessages), Math.max(0, first));
    const lines = [
        ...(input.previousTitle !== undefined ? [`Last recorded event: ${input.previousTitle}`] : []),
        ...context.map(
            (message) => `${input.speaker(message)}: ${clampText(shownText(message), LIMITS.contextMessageChars)}`,
        ),
    ];
    return lines.length === 0 ? NONE : `Context only: never quote it.\n${lines.join("\n")}`;
}

/**
 * What the scene slot lists of what a person took back of the scene, newest first, `PROMPT_TAKEN_BACK` at
 * most: each line says so itself, because the text alone is what a prompt from before the revert shows as
 * the scene.
 */
export function sceneTakenBackLines(scene: MemoryPage | null): string[] {
    const headings: readonly string[] = SCENE_SECTIONS;
    return (scene ? revertEntries(scene) : [])
        .flatMap(({ heading, before }) =>
            before && headings.includes(heading)
                ? [`taken back from ${heading}: ${clampText(before.body, LIMITS.promptSectionSummaryChars)}`]
                : [],
        )
        .slice(0, PROMPT_TAKEN_BACK);
}

/**
 * What the scene page says: its fixed sections and who is present, by page id, and past the clamp, so a
 * long scene cannot cut them, what a person took back of it.
 */
function sceneSlot(scene: MemoryPage | null): string {
    const lines = SCENE_SECTIONS.flatMap((heading) => {
        const body = scene?.sections.find((section) => section.heading === heading)?.body;
        return body ? [`${heading}: ${body}`] : [];
    });
    if (scene?.participants?.length) {
        lines.push(`participants: ${JSON.stringify(scene.participants)}`);
    }
    const shown = clampText(lines.join("\n"), LIMITS.promptSceneChars);
    return [...(shown === "" ? [] : [shown]), ...sceneTakenBackLines(scene)].join("\n") || NONE;
}

/**
 * The open threads the analysis prompt lists, `promptThreads` at most, in list order: first those naming
 * someone on `stage`, the scene's attendance, newest first, then the rest newest first. The writer can
 * close only a thread it is shown, so the threads whose people are present come before older ones that
 * would otherwise hold the newest places for good; `more` counts the open threads left out.
 */
export function promptThreads(
    threads: readonly MemoryThread[],
    stage: ReadonlySet<string>,
): { listed: MemoryThread[]; more: number } {
    const open = threads.filter(({ state }) => !memoryThreadEnded(state));
    const ranked = open
        .map((thread, index) => ({ thread, index, present: thread.who.some((id) => stage.has(id)) }))
        .toSorted((a, b) => Number(b.present) - Number(a.present) || b.index - a.index)
        .slice(0, LIMITS.promptThreads)
        .toSorted((a, b) => a.index - b.index);
    return { listed: ranked.map(({ thread }) => thread), more: open.length - ranked.length };
}

/**
 * The slot values of one recording. Window text stays raw for quote verification, except that inlays
 * show as `[Image]`; filling after ChatML and CBS parsing prevents that text becoming prompt syntax.
 */
export function analysisSlots(input: AnalysisInput): AnalysisSlots {
    return {
        format: FORMAT,
        rules: RULES,
        language: input.language,
        cast: input.cast.map((row) => JSON.stringify(row)).join("\n") || NONE,
        scene: sceneSlot(input.scene),
        threads:
            [
                ...input.threads.map(({ id, title, who, state }) => JSON.stringify({ id, title, who, state })),
                ...(input.moreThreads ? [`(${input.moreThreads} more open threads are not listed)`] : []),
            ].join("\n") || NONE,
        previous: previousSlot(input),
        messages: input.window.messages
            .map(
                (message, index) =>
                    `[m:${input.window.sources[index].messageId}] ${input.speaker(message)}:\n${shownText(message)}`,
            )
            .join("\n\n"),
    };
}

/** The slot values of one patch call. */
export function patchSlots({ language, rows, event }: PatchInput): PatchSlots {
    const { title, summary, participants, storyTime, keyLines, stateChanges, knowledge, relationshipShifts } = event;
    return {
        format: PATCH_FORMAT,
        rules: PATCH_RULES,
        language: clampText(language, LIMITS.labelChars),
        cast: rows.map((row) => JSON.stringify(row)).join("\n"),
        previous: JSON.stringify({
            title,
            summary,
            participants,
            storyTime,
            keyLines,
            stateChanges,
            knowledge,
            relationshipShifts,
        }),
    };
}

/** The slot values of one compaction call. */
export function compactSlots({ language, target }: CompactInput): CompactSlots {
    const { page, heading, body } = target;
    const { type, title } = page;
    return {
        format: COMPACT_FORMAT,
        rules: compactRules(heading, memorySectionBudget(type, heading)),
        language: clampText(language, LIMITS.labelChars),
        page: JSON.stringify({ type, title, heading }),
        section: body,
    };
}

/** The parsed `messages` with their slots filled in one pass; a name that is no slot stays as it is. */
export function fillSlots(messages: readonly OpenAIChat[], slots: Record<string, string>): OpenAIChat[] {
    return messages.map((message) => ({
        ...message,
        content: message.content.replace(SLOT_TOKEN_REGEX, (token, name: string) =>
            Object.hasOwn(slots, name) ? slots[name] : token,
        ),
    }));
}

/** `frame` parsed with its slots in place, then the slots filled in one pass. */
function assemblePrompt<Slots extends Record<string, string>>(
    host: Pick<MemoryHost, "parseChatML">,
    frame: string,
    slots: Slots,
): OpenAIChat[] {
    // Each frame starts with a ChatML marker, so it always parses.
    return fillSlots(host.parseChatML(frame)!, slots);
}

/** A preset's own frame, parsed and checked, or why it cannot be a call's prompt. */
export type CustomFrame =
    | {
          ok: true;
          /** The frame as parsed, with its slots still in place. */
          messages: OpenAIChat[];
          /** The call's slots the frame does not quote: a warning, since the model then lacks them. */
          unquoted: string[];
          /** The names the frame quotes that are no slot of the call: they stay literal in the prompt. */
          unknown: string[];
      }
    | { ok: false; error: string };

/**
 * The preset's own frame for `call`, through ChatML and CBS as the default frame goes, with its slots
 * still in place. Blank text, text the parser gives no message for (it needs a leading ChatML marker),
 * and a frame that does not quote every slot of `REQUIRED_SLOT_NAMES[call]` are refused with the reason:
 * a run on one would record nothing it could check. The slots are read from the parsed messages, after
 * CBS, so no CBS branch can hide one.
 */
export function parseCustomFrame(
    host: Pick<MemoryHost, "parseChatML">,
    text: string,
    call: keyof typeof REQUIRED_SLOT_NAMES,
): CustomFrame {
    if (text.trim() === "") {
        return { ok: false, error: `The ${call} prompt is blank` };
    }
    const messages = host.parseChatML(text);
    if (!messages || messages.length === 0) {
        return { ok: false, error: `The ${call} prompt is not ChatML: it holds no <|im_start|> message` };
    }
    const names: readonly string[] = call === "analysis" ? ANALYSIS_SLOT_NAMES : PATCH_SLOT_NAMES;
    const quoted = new Set<string>();
    for (const { content } of messages) {
        for (const match of content.matchAll(SLOT_TOKEN_REGEX)) {
            quoted.add(match[1]);
        }
    }
    const missing = REQUIRED_SLOT_NAMES[call].filter((name) => !quoted.has(name));
    if (missing.length > 0) {
        const list = missing.map((name) => `{{slot::${name}}}`).join(" and ");
        return { ok: false, error: `The ${call} prompt does not quote ${list}` };
    }
    return {
        ok: true,
        messages,
        unquoted: names.filter((name) => !quoted.has(name)),
        unknown: [...quoted].filter((name) => !names.includes(name)),
    };
}

/** Each call's default frame as stored text, with no preset text, and the slot texts the validator reads. */
export function defaultPrompts(): StructuredMemoryDefaultPromptsAnswer {
    return {
        analysis: { frame: analysisFrame(""), format: FORMAT, rules: RULES },
        patch: { frame: patchFrame(""), format: PATCH_FORMAT, rules: PATCH_RULES },
    };
}

/** The analysis call's messages. */
export function assembleAnalysisPrompt(
    host: Pick<MemoryHost, "parseChatML">,
    instructions: string,
    slots: AnalysisSlots,
): OpenAIChat[] {
    return assemblePrompt(host, analysisFrame(instructions), slots);
}

/** The patch call's messages. */
export function assemblePatchPrompt(
    host: Pick<MemoryHost, "parseChatML">,
    instructions: string,
    slots: PatchSlots,
): OpenAIChat[] {
    return assemblePrompt(host, patchFrame(instructions), slots);
}

/** The compaction call's messages. */
export function assembleCompactPrompt(
    host: Pick<MemoryHost, "parseChatML">,
    instructions: string,
    slots: CompactSlots,
): OpenAIChat[] {
    return assemblePrompt(host, compactFrame(instructions), slots);
}
