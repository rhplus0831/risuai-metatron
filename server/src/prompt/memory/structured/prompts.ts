import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import { eligibleHistory } from "../../../../../shared/contextReport.ts";
import type { Message } from "../../../../../shared/database.ts";
import type { OpenAIChat } from "../../../../../shared/openai.ts";
import {
    MEMORY_KNOWLEDGE_STANCES,
    MEMORY_THREAD_STATES,
    type MemoryPage,
    type MemoryThread,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryContents } from "../../../data/memoryStore.ts";
import type { MemoryHost } from "../host.ts";
import type { WriterWindow } from "./window.ts";

/**
 * The writer's analysis prompt: a ChatML frame with named slots, read through the task host's parser.
 * The frame and the preset's `instructions` go through ChatML and CBS. The slot values are filled in
 * afterwards, in one pass over the parsed messages, so chat text never reaches CBS and cannot start a
 * ChatML message, and a value that holds a slot's name stays as it is.
 *
 * The prompt's size is a cost on every recorded turn: its fixed parts stay short and everything it
 * lists is bounded. Only `messages` is not, because a quote must be found in the window's whole text.
 */

/** The prompt's named inputs. */
export type AnalysisSlots = Record<
    "format" | "rules" | "language" | "cast" | "scene" | "threads" | "previous" | "messages",
    string
>;

/** What the slots are written from. */
export type AnalysisInput = {
    language: string;
    /** The chat's pages, in contents order. */
    pages: MemoryContents["pages"];
    scene: MemoryPage | null;
    /** The open threads to show. */
    threads: readonly MemoryThread[];
    /** The last recorded event's title. */
    previousTitle: string | undefined;
    /** The chat's stored messages. */
    messages: readonly Message[];
    window: WriterWindow;
    /** A message's speaker label. */
    speaker(message: Message): string;
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
  "axes": { "persistence": 0, "change": 0, "reach": 0 }
}
Axes score how long it lasts, how much it changes, and how many it touches.
Empty lists stay as []. At most ${LIMITS.keyLinesPerEvent} keyLines, ${LIMITS.stateChangesPerEvent} stateChanges, ${LIMITS.knowledgePerEvent} knowledge, ${LIMITS.relationshipShiftsPerEvent} relationshipShifts, and ${LIMITS.threadsPerEvent} of each thread list.`;

const RULES = `Rules:
- A quote (a key line's text and every "quote") is copied verbatim from one message under "Messages to record", at most ${LIMITS.keyLineChars} characters: never reworded, never joined across messages or across an [Image] mark, never taken from the context.
- Page and thread ids come only from the lists shown. Never invent an id: leave out what has no id in a list.
- Each axis is an integer from 0 to ${LIMITS.axisMax}.`;

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

/** The slot values of one recording. */
export function analysisSlots(input: AnalysisInput): AnalysisSlots {
    const scene = input.scene?.sections.map(({ body }) => body).join("\n") ?? "";
    return {
        format: FORMAT,
        rules: RULES,
        language: input.language,
        cast:
            input.pages
                .slice(0, LIMITS.promptPages)
                .map(({ id, type, title }) => JSON.stringify({ id, type, title }))
                .join("\n") || NONE,
        scene: clampText(scene, LIMITS.promptSceneChars) || NONE,
        threads:
            input.threads.map(({ id, title, who, state }) => JSON.stringify({ id, title, who, state })).join("\n") ||
            NONE,
        previous: previousSlot(input),
        messages: input.window.messages
            .map(
                (message, index) =>
                    `[m:${input.window.sources[index].messageId}] ${input.speaker(message)}:\n${shownText(message)}`,
            )
            .join("\n\n"),
    };
}

/** The analysis call's messages: the frame parsed with its slots in place, then the slots filled. */
export function assembleAnalysisPrompt(
    host: Pick<MemoryHost, "parseChatML">,
    instructions: string,
    slots: AnalysisSlots,
): OpenAIChat[] {
    // The frame starts with a ChatML marker, so it always parses.
    const frame = host.parseChatML(analysisFrame(instructions))!;
    return frame.map((message) => ({
        ...message,
        content: message.content.replace(SLOT_TOKEN_REGEX, (token, name: keyof AnalysisSlots) =>
            Object.hasOwn(slots, name) ? slots[name] : token,
        ),
    }));
}
