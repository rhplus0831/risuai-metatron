import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { holdsCredential } from "./bootCache";

/**
 * What may enter the draft journal (`draftJournal.ts`): the one boundary every journal write goes
 * through (a mutation's layers, a recovery draft, an orphan adopted from a closed tab). A record that
 * fails it is not journaled at all, never stripped of a field, so a recovered text is always one the
 * tab would have sent; it is lost with the page as before, and the page-close warning still covers it.
 *
 * Never journaled: the kinds that hold credentials or arbitrary plugin values as such (`llmSecrets`,
 * the `secrets` section, `authRefreshes`, `pluginStorage`, `plugins`), a character holding a TTS API
 * key (`oaiTTSConfig.apiKey`, as the boot cache), and a `providers` or `customModels` record whose
 * `additionalParams` or `params` name a `header::` line (an `Authorization` header and the like,
 * `server/src/llm/shared.ts`). A secret typed into free text (a prompt, a lore entry, a module's
 * script or URL, a chat message) is journaled like any text, as the server already stores it.
 */

export const JOURNAL_EXCLUDED_KINDS: ReadonlySet<string> = new Set([
    RESOURCE_KIND.llmSecrets,
    RESOURCE_KIND.secrets,
    RESOURCE_KIND.authRefreshes,
    RESOURCE_KIND.pluginStorage,
    RESOURCE_KIND.plugins,
]);

/** What is to be journaled: a record's text (`null` for a delete) by its kind, or a chat, order, or composer value. */
export type JournalSubject =
    { scope: "record"; kind: string; text: string | null } | { scope: "chat" | "order" | "composer" };

const HEADER_MARKER = "header::";
/**
 * JSON can spell any character of a key as a `\u` escape, so a text without the field's name may still
 * hold it when it has one; such a text is parsed. Without one, a text that lacks the name cannot hold
 * the field, and is not parsed (a large character is checked on every journal write).
 */
const UNICODE_ESCAPE = "\\u";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `text` parsed, or `undefined` when it is not JSON. */
function parse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

const mayHold = (text: string, name: string) => text.includes(name) || text.includes(UNICODE_ESCAPE);

const namesHeader = (key: unknown) => typeof key === "string" && key.includes(HEADER_MARKER);

/** A `providers` section naming a `header::` parameter (`additionalParams`, `[key, value][]`). */
function providersHoldHeader(data: unknown): boolean {
    if (!isPlainObject(data)) {
        return true;
    }
    const params = data.additionalParams;
    return Array.isArray(params) && params.some((pair) => Array.isArray(pair) && namesHeader(pair[0]));
}

/** A `customModels` collection with a model whose `params` lines (`key=value`) name a `header::` key. */
function customModelsHoldHeader(data: unknown): boolean {
    if (!Array.isArray(data)) {
        return true;
    }
    return data.some(
        (model) =>
            isPlainObject(model) &&
            typeof model.params === "string" &&
            model.params.split("\n").some((line) => namesHeader(line.split("=")[0])),
    );
}

/**
 * Whether `subject` may be written to the journal (see the module comment). Pure. A record text of a
 * checked kind that is not JSON is refused once it has to be parsed.
 */
export function isJournalEligible(subject: JournalSubject): boolean {
    if (subject.scope !== "record") {
        return true;
    }
    const { kind, text } = subject;
    if (JOURNAL_EXCLUDED_KINDS.has(kind)) {
        return false;
    }
    if (text === null) {
        return true;
    }
    switch (kind) {
        case RESOURCE_KIND.characters: {
            if (!mayHold(text, "apiKey")) {
                return true;
            }
            const data = parse(text);
            return data !== undefined && !holdsCredential(kind, data);
        }
        case RESOURCE_KIND.providers: {
            if (!mayHold(text, HEADER_MARKER)) {
                return true;
            }
            const data = parse(text);
            return data !== undefined && !providersHoldHeader(data);
        }
        case RESOURCE_KIND.customModels: {
            if (!mayHold(text, HEADER_MARKER)) {
                return true;
            }
            const data = parse(text);
            return data !== undefined && !customModelsHoldHeader(data);
        }
        default:
            return true;
    }
}
