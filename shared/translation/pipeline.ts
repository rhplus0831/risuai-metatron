import type { TranslatorStep, TranslatorStepModel } from "../settings.ts";
import { defaultTranslatorPrompt } from "../translatorPresets.ts";

/**
 * The translator pipeline (`docs/plan/translation.md` slice 1.2): a preset's steps run in order, each
 * one a request whose prompt can name the source, the previous step's output, and earlier named
 * outputs. Pure: the caller sends each step's request (`runTranslatorPipeline`'s `runStep`). CBS is
 * not evaluated anywhere in a translator prompt.
 */

export interface TranslatorChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface TranslatorStepRequest {
    messages: TranslatorChatMessage[];
    maxResponse: number;
    model: TranslatorStepModel;
}

/** What one step's prompt is filled with. */
export interface TranslatorSlotValues {
    /** The text to translate: `{{slot::content}}` (and its `{{solt::content}}` misspelling). */
    sourceText: string;
    /** The previous step's output, the source text for the first step: `{{slot::prev}}`. */
    prevOutput: string;
    /** The outputs of earlier steps with an `outputKey`: `{{slot::out::KEY}}` (empty when none). */
    outputsByKey: ReadonlyMap<string, string>;
    /** The target language: `{{slot}}`. */
    to: string;
    /** The source language: `{{slot::from}}`. */
    from: string;
    /** The character's translator note: `{{slot::tnote}}`. */
    translatorNote: string;
}

/** Every slot, matched in one pass so a filled-in value is never read for slots again. */
const SLOT_PATTERN = /{{(slot|slot::from|slot::content|solt::content|slot::prev|slot::tnote|slot::out::([^}]+))}}/g;

/** The slots that carry the input: a prompt holding one sends no separate user message. */
const INPUT_SLOT_PATTERN = /{{(?:solt::content|slot::(?:content|prev|out::[^}]+))}}/;

/** The steps that run: the enabled ones, else the first step alone. */
export function translatorStepsToRun<T extends { readonly enabled: boolean }>(steps: readonly T[]): T[] {
    const enabled = steps.filter((step) => step.enabled);
    if (enabled.length > 0) {
        return enabled;
    }
    return steps.length > 0 ? [steps[0]] : [];
}

/**
 * A ChatML prompt (`<|im_start|>role<|im_sep|>content<|im_end|>`, or the role followed by a space or
 * a newline) as messages; null when `text` does not start with `<|im_start|>`. A part without a known
 * role is a user message.
 */
export function parseTranslatorChatML(text: string): TranslatorChatMessage[] | null {
    const starter = "<|im_start|>";
    const separator = "<|im_sep|>";
    const ender = "<|im_end|>";
    const trimmed = text.trim();
    if (!trimmed.startsWith(starter)) {
        return null;
    }

    return trimmed
        .split(starter)
        .filter((part) => part !== "")
        .map((part) => {
            let role: TranslatorChatMessage["role"] = "user";
            let content = part;
            for (const candidate of ["system", "user", "assistant"] as const) {
                if (content.startsWith(`${candidate}${separator}`)) {
                    role = candidate;
                    content = content.slice(candidate.length + separator.length);
                    break;
                }
                if (content.startsWith(`${candidate} `) || content.startsWith(`${candidate}\n`)) {
                    role = candidate;
                    content = content.slice(candidate.length + 1);
                    break;
                }
            }
            content = content.trim();
            if (content.endsWith(ender)) {
                content = content.slice(0, -ender.length);
            }
            return { role, content: content.trim() };
        });
}

/** `template` with its slots filled in; an unknown `{{...}}` is left as it is. */
export function fillTranslatorSlots(template: string, values: TranslatorSlotValues): string {
    return template.replace(SLOT_PATTERN, (_match, slot: string, outputKey: string | undefined) => {
        if (outputKey !== undefined) {
            return values.outputsByKey.get(outputKey) ?? "";
        }
        switch (slot) {
            case "slot":
                return values.to;
            case "slot::from":
                return values.from;
            case "slot::content":
            case "solt::content":
                return values.sourceText;
            case "slot::prev":
                return values.prevOutput;
            default:
                return values.translatorNote;
        }
    });
}

/**
 * One step's request messages. The prompt (blank: `defaultTranslatorPrompt`) with its slots filled
 * in is parsed as ChatML when it is ChatML. Otherwise it is the system message, followed by the
 * previous output as the user message unless the prompt holds an input slot (`{{slot::content}}`,
 * `{{solt::content}}`, `{{slot::prev}}`, or `{{slot::out::KEY}}`, even one that fills in empty).
 */
export function buildTranslatorStepMessages(
    step: Pick<TranslatorStep, "prompt">,
    values: TranslatorSlotValues,
): TranslatorChatMessage[] {
    const template = step.prompt || defaultTranslatorPrompt;
    const prompt = fillTranslatorSlots(template, values);
    const parsed = parseTranslatorChatML(prompt);
    if (parsed) {
        return parsed;
    }
    if (INPUT_SLOT_PATTERN.test(template)) {
        return [{ role: "system", content: prompt }];
    }
    return [
        { role: "system", content: prompt },
        { role: "user", content: values.prevOutput },
    ];
}

const REASONING_TAG_PATTERN = /<\s*(\/?)\s*(?:Thoughts|think)\b[^>]*>/giu;

/**
 * `text` without its `<Thoughts>` and `<think>` blocks (any case, attributes allowed, nested blocks
 * counted, an unclosed block hidden to the end; a closing tag outside any block is kept as text),
 * trimmed. Text with no opening tag is returned unchanged.
 */
export function stripTranslatorReasoning(text: string): string {
    let visible = "";
    let visibleFrom = 0;
    let depth = 0;
    let foundOpening = false;

    for (const match of text.matchAll(REASONING_TAG_PATTERN)) {
        const index = match.index;
        if (match[1] !== "/") {
            foundOpening = true;
            if (depth === 0) {
                visible += text.slice(visibleFrom, index);
            }
            depth += 1;
            continue;
        }
        if (depth === 0) {
            continue;
        }
        depth -= 1;
        if (depth === 0) {
            visibleFrom = index + match[0].length;
        }
    }

    if (!foundOpening) {
        return text;
    }
    if (depth === 0) {
        visible += text.slice(visibleFrom);
    }
    return visible.trim();
}

/**
 * Whether a source line is kept out of translation when a preset does not send its text as is
 * (`translateProtectingLines`): an exactly empty line, or an asset line (`{{img`, `{{raw`, `{{video` at
 * its start, or `{{audio` … `}}` as the whole line). Case-sensitive, as the tab's `runTranslator`.
 */
export function isProtectedTranslationLine(line: string): boolean {
    return (
        line.startsWith("{{img") ||
        line.startsWith("{{raw") ||
        line.startsWith("{{video") ||
        (line.startsWith("{{audio") && line.endsWith("}}")) ||
        line.length === 0
    );
}

/**
 * `text` translated chunk by chunk around its protected lines (`isProtectedTranslationLine`), the
 * Fastify fork's rule (`docs/plan/translation.md` slice 3.2, a preset without Send Text As-Is): the
 * lines between two protected lines are one chunk (joined with `\n`), translated trimmed by
 * `translateChunk` and trimmed again; a protected line is kept as it is, and each one is followed by
 * an empty chunk, so the parts joined with `\n` put an extra blank line between two protected lines
 * in a row (`{{img::a}}\n{{img::b}}` gets one, three newlines become four). A blank or
 * whitespace-only chunk is kept without a call. The whole result is trimmed. Chunks run one after another; an error from `translateChunk` ends the run.
 */
export async function translateProtectingLines(
    text: string,
    translateChunk: (chunk: string) => Promise<string>,
): Promise<string> {
    const chunks: { text: string; translatable: boolean }[] = [{ text: "", translatable: true }];
    for (const line of text.split("\n")) {
        if (isProtectedTranslationLine(line)) {
            chunks.push({ text: line, translatable: false }, { text: "", translatable: true });
            continue;
        }
        const current = chunks[chunks.length - 1];
        current.text += current.text.length === 0 ? line : `\n${line}`;
    }

    const translated: string[] = [];
    for (const chunk of chunks) {
        if (!chunk.translatable) {
            translated.push(chunk.text);
            continue;
        }
        const trimmed = chunk.text.trim();
        if (trimmed.length === 0) {
            translated.push(chunk.text);
            continue;
        }
        translated.push((await translateChunk(trimmed)).trim());
    }
    return translated.join("\n").trim();
}

/** What decides a pipeline's result besides its input: the steps that run, by their request fields. */
export function translatorPipelineSignature(steps: readonly TranslatorStep[]) {
    return translatorStepsToRun(steps).map((step) => ({
        prompt: step.prompt,
        maxResponse: step.maxResponse,
        model:
            step.model.mode === "profile" ? { mode: "profile", profileId: step.model.profileId } : { mode: "inherit" },
        outputKey: step.outputKey ?? null,
    }));
}

/**
 * Runs the steps that run (`translatorStepsToRun`) in order and returns the last step's output. Each
 * step's output has its reasoning stripped (`stripTranslatorReasoning`) before the next step or a
 * named output sees it. An error from `runStep` ends the run.
 */
export async function runTranslatorPipeline(
    input: {
        steps: readonly TranslatorStep[];
        sourceText: string;
        to: string;
        from: string;
        translatorNote: string;
    },
    runStep: (request: TranslatorStepRequest) => Promise<string>,
): Promise<string> {
    let prevOutput = input.sourceText;
    const outputsByKey = new Map<string, string>();

    for (const step of translatorStepsToRun(input.steps)) {
        const messages = buildTranslatorStepMessages(step, {
            sourceText: input.sourceText,
            prevOutput,
            outputsByKey,
            to: input.to,
            from: input.from,
            translatorNote: input.translatorNote,
        });
        const output = stripTranslatorReasoning(
            await runStep({ messages, maxResponse: step.maxResponse, model: step.model }),
        );
        prevOutput = output;
        if (step.outputKey !== undefined) {
            outputsByKey.set(step.outputKey, output);
        }
    }

    return prevOutput;
}
