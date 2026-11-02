import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { Message } from "../../../../../shared/database.ts";
import {
    ADOPTED_WRITER_RUN,
    hypaV3DataHoldsSummaries,
    isSealedHypaV3Data,
    type MemoryAnchoredSource,
    type MemorySource,
    STRUCTURED_MEMORY_LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import type { MemoryEventWrite } from "../../../data/memoryStore.ts";

/**
 * The events a chat's HypaV3 summaries become, without any I/O and with no model call, so the chat keeps
 * its coverage from the start and the writer records only later turns. The route owns the fence and the
 * write, and `hypaV3Data` stays as it is.
 *
 * - A sealed value is a projection of records, never summaries, so it adopts nothing. Each summary with
 *   text that is not blank becomes one event, in stored order, and any other entry is skipped.
 * - `summary` is the text as stored, whatever its length. A covering event lets its messages leave the
 *   prompt and `hypaV3Data` can be reset later, so a cut would lose text for good. `eventSummaryChars`
 *   binds the writer's answer, and `restore.ts` already lets genuine records pass it.
 * - `title` is the text's first sentence. `3.5` ends none: `.!?…` end one only before whitespace or the end
 *   of the text, closing quotes and brackets allowed between, while a newline and `。！？` always do.
 * - `isImportant` becomes `pinned`. `categoryId` and `tags` have no place on an event and stay behind.
 * - Sources come from `chatMemos`, each id once. Only non-empty strings count: `assemble.ts` builds the
 *   greeting entry with no memo, so HypaV3's first summary normally holds a `null`, which is no stored
 *   message, and calling it missing would make the first summary of most chats stale.
 * - A cited message that is held is anchored as it stands now, and those sources sort by position, so a
 *   list in another order does not read `moved`. A cited message that is gone is unanchored, after them.
 * - An event with an unanchored source is stored `stale`, and so is one left with no source at all:
 *   reconciliation reads an event with no sources as active, and nothing could check it.
 */

/** A build's input: the chat's `hypaV3Data` and messages as stored. Chat data is stored largely as sent. */
export type HypaV3Adoption<M> = {
    data: unknown;
    messages: readonly M[];
    hashOf: (message: M) => string;
    newId: () => string;
};

const SENTENCE_END = /[\r\n。！？]|[.!?…]+["'”’)\]}»」』）］】》〉]*(?=\s|$)/;

/** A clamp can drop a trailing lead surrogate, which a sentence can be all of, so the title stays non-blank. */
function firstSentence(text: string): string {
    const trimmed = text.trim();
    const end = SENTENCE_END.exec(trimmed);
    const sentence = end ? trimmed.slice(0, end.index + end[0].length).trim() : trimmed;
    return clampText(sentence, STRUCTURED_MEMORY_LIMITS.eventTitleChars).trim() || sentence;
}

/** The message ids `chatMemos` cites, each once. */
function citedIds(memos: unknown): string[] {
    const ids = Array.isArray(memos) ? memos.filter((memo) => typeof memo === "string" && memo !== "") : [];
    return [...new Set<string>(ids)];
}

/**
 * The source of a cited id as `messages` hold it. The lookup is built once and each message is hashed at
 * most once: a chat can hold thousands, and summaries can overlap.
 */
function sourceReader<M extends Pick<Message, "chatId">>({
    messages,
    hashOf,
}: Pick<HypaV3Adoption<M>, "messages" | "hashOf">): (messageId: string) => MemorySource {
    const positions = new Map<string, number>();
    messages.forEach(({ chatId }, index) => {
        if (chatId !== undefined) {
            positions.set(chatId, index);
        }
    });
    const hashes = new Map<number, string>();
    return (messageId) => {
        const index = positions.get(messageId);
        if (index === undefined) {
            return { messageId, hash: null, index: null };
        }
        const hash = hashes.get(index) ?? hashOf(messages[index]);
        hashes.set(index, hash);
        return { messageId, hash, index };
    };
}

/** The events `data`'s summaries become, ready for `store.memory.write`: none when it holds no real summary. */
export function adoptedEvents<M extends Pick<Message, "chatId">>(arg: HypaV3Adoption<M>): MemoryEventWrite[] {
    const { data, newId } = arg;
    if (!hypaV3DataHoldsSummaries(data) || isSealedHypaV3Data(data)) {
        return [];
    }
    const sourceOf = sourceReader(arg);
    return (data as { summaries: unknown[] }).summaries.flatMap((entry): MemoryEventWrite[] => {
        if (!isPlainObject(entry) || typeof entry.text !== "string" || entry.text.trim() === "") {
            return [];
        }
        const cited = citedIds(entry.chatMemos).map(sourceOf);
        const anchored = cited.filter((source): source is MemoryAnchoredSource => source.hash !== null);
        const unanchored = cited.filter(({ hash }) => hash === null);
        return [
            {
                id: newId(),
                title: firstSentence(entry.text),
                summary: entry.text,
                participants: [],
                storyTime: { text: "" },
                keyLines: [],
                stateChanges: [],
                knowledge: [],
                relationshipShifts: [],
                openThreads: { add: [], close: [], transitions: [] },
                sources: [...anchored.sort((a, b) => a.index - b.index), ...unanchored],
                ...(anchored.length > 0 && unanchored.length === 0
                    ? { status: "active" as const }
                    : { status: "stale" as const, staleReason: "missing" as const }),
                writerRun: ADOPTED_WRITER_RUN,
                ...(entry.isImportant === true ? { pinned: true } : {}),
            },
        ];
    });
}
