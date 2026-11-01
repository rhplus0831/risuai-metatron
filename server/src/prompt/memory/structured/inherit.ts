import type { Message } from "../../../../../shared/database.ts";
import {
    type MemoryAnchoredSource,
    type MemoryEvent,
    type MemoryPage,
    type MemoryPageHistoryEntry,
    type MemorySection,
    type MemorySectionContent,
    type MemorySource,
    type MemoryThread,
    memoryThreadEnded,
    storedMemorySources,
} from "../../../../../shared/structuredMemory.ts";
import type { MemoryChanges, MemoryEventWrite } from "../../../data/memoryStore.ts";

/**
 * What a chat copied or branched from another starts with, without any I/O: the source chat's records as
 * far as the new chat's messages support them. The route owns the fence and the write.
 *
 * - A source maps by id, whatever its hash: a copy shares its source's ids, and reconciliation answers for
 *   a message that no longer matches, in the new chat as in the old. Else it maps by position: the two
 *   chats' messages there read alike, and the new chat's is no copy of another source-chat message. An
 *   unanchored source never maps. A mapped source keeps `hash` and `index`, and only `messageId` changes:
 *   the stored gaps are what show an insertion, so a current position would make such an event read whole.
 * - An event crosses when it has sources and every one maps. It crosses as stored, marks and `status`
 *   included: `recordedMessages` counts a retracted event, so leaving one out would let the writer record
 *   again what a person retracted, and a remapped `keptState` only reads stale, which asks a person. Only
 *   `rerecord` stays behind: it is a request about the source chat, and on a copy the next automatic
 *   hand-off would spend a model call nobody asked for. The event still reads `changed`, so the panel
 *   offers the repair.
 * - An event that does not cross is behind when a source that did not map names a message the source chat
 *   holds and the new chat does not: that is what lies after the branch point. Any other just stays out,
 *   so a plain copy, whose messages are all there, drops dead evidence and undoes nothing.
 * - Only a behind event undoes anything. A section's body is replaced whole while its `provenance`
 *   accumulates, and a send shows a section whatever its flags say, so a section is rewound by the page's
 *   own history rather than flagged. A change the bounded history lost cannot be undone: that text stays,
 *   and a section that still names a behind event is `unsupported`, as is one left with no standing
 *   evidence. No body is blanked and nothing is `suppressed`: `changeSection` keeps trust flags, so a
 *   suppressed slot would stay hidden past the writer's next text, and no edit clears it.
 * - A thread a behind event moved takes the state the crossing events give it.
 */

/** A build's input, all as stored: the source chat's records and both chats' messages. */
export type MemoryInheritance<M> = {
    pages: readonly MemoryPage[];
    events: readonly MemoryEvent[];
    threads: readonly MemoryThread[];
    sourceMessages: readonly M[];
    /** The new chat's messages. */
    messages: readonly M[];
    hashOf: (message: M) => string;
};

/** How one source chat's sources read in the new chat. */
type SourceMap = {
    /** `source` as the new chat cites it, or null when it does not map. */
    mapped(source: MemorySource): MemorySource | null;
    /** Whether the source chat holds the message `source` names and the new chat does not. */
    leftBehind(source: MemorySource): boolean;
};

/** Each chat's lookups are built once and each message is hashed at most once: a chat can hold thousands. */
function sourceMap<M extends Pick<Message, "chatId">>({
    sourceMessages,
    messages,
    hashOf,
}: Pick<MemoryInheritance<M>, "sourceMessages" | "messages" | "hashOf">): SourceMap {
    const positions = new Map<string, number>();
    sourceMessages.forEach(({ chatId }, index) => {
        if (chatId !== undefined) {
            positions.set(chatId, index);
        }
    });
    const ids = new Set(messages.map(({ chatId }) => chatId));
    const hashes = new Map<M, string>();
    const hashed = (message: M) => {
        const hash = hashes.get(message) ?? hashOf(message);
        hashes.set(message, hash);
        return hash;
    };
    /** The new chat's id for a message it has no id of: the message at the same place, reading alike. */
    const byPosition = (messageId: string): string | undefined => {
        const position = positions.get(messageId);
        if (position === undefined) {
            return undefined;
        }
        const message = messages[position];
        const id = message?.chatId;
        return typeof id === "string" && !positions.has(id) && hashed(message) === hashed(sourceMessages[position])
            ? id
            : undefined;
    };
    const mappedId = ({ messageId }: MemoryAnchoredSource) => (ids.has(messageId) ? messageId : byPosition(messageId));
    return {
        mapped(source) {
            const messageId = source.hash === null ? undefined : mappedId(source);
            return messageId === undefined ? null : { ...source, messageId };
        },
        leftBehind: ({ messageId }) => positions.has(messageId) && !ids.has(messageId),
    };
}

/** The events that cross, in contents order with their sources mapped, and the ids of those left behind. */
function sortEvents(
    events: readonly MemoryEvent[],
    map: SourceMap,
): { crossing: MemoryEventWrite[]; behind: Set<string> } {
    const crossing: MemoryEventWrite[] = [];
    const behind = new Set<string>();
    for (const event of events) {
        const sources = storedMemorySources(event.sources);
        const mapped = sources.flatMap((source) => map.mapped(source) ?? []);
        if (sources.length > 0 && mapped.length === sources.length) {
            const { createdRevision, rerecord, ...stored } = event;
            crossing.push({ ...stored, sources: mapped });
        } else if (sources.some((source) => map.mapped(source) === null && map.leftBehind(source))) {
            behind.add(event.id);
        }
    }
    return { crossing, behind };
}

/**
 * The section `before` holds, as a cut at `at` restores it: `live` keeps its heading and its marks, which
 * are a person's, and loses `disputed` and `unsupported`, which spoke of the body it no longer has.
 */
function restoredSection(
    heading: string,
    before: MemorySectionContent,
    at: number,
    live?: MemorySection,
): MemorySection {
    const { disputed, unsupported, ...kept }: Partial<MemorySection> = live ?? {};
    return { locked: false, ...kept, ...before, heading, updatedAt: at };
}

/**
 * `page` as it stood before the first change of each heading that a behind event made, or null for a page
 * such an event created. That change and every later one of its heading go, a person's edits included:
 * they edited text from after the branch point. A section whose first such change replaced nothing goes
 * with them, and one that change deleted comes back.
 */
function rewoundPage(page: MemoryPage, behind: ReadonlySet<string>): MemoryPage | null {
    const cuts = new Map<string, MemoryPageHistoryEntry>();
    const history: MemoryPageHistoryEntry[] = [];
    for (const entry of page.history) {
        const { heading, eventId } = entry;
        const isBehind = eventId !== undefined && behind.has(eventId);
        if (heading === null && isBehind) {
            return null;
        }
        if (heading !== null && isBehind && !cuts.has(heading)) {
            cuts.set(heading, entry);
        } else if (heading === null || !cuts.has(heading)) {
            history.push(entry);
        }
    }
    const sections = page.sections.flatMap((section) => {
        const cut = cuts.get(section.heading);
        if (!cut) {
            return [section];
        }
        return cut.before ? [restoredSection(section.heading, cut.before, cut.at, section)] : [];
    });
    for (const [heading, { before, at }] of cuts) {
        if (before && !page.sections.some((section) => section.heading === heading)) {
            sections.push(restoredSection(heading, before, at));
        }
    }
    return { ...page, sections, history };
}

/**
 * The state the crossing events give each thread they name, as `admitAnalysis` commits them: `close`, then
 * `transitions`, the last naming winning. An ended state names the event that ended it.
 */
function replayedThreads(crossing: readonly MemoryEventWrite[]) {
    const replayed = new Map<string, Pick<MemoryThread, "state" | "closedBy">>();
    for (const { id, openThreads } of crossing) {
        for (const threadId of openThreads.close) {
            replayed.set(threadId, { state: "done", closedBy: id });
        }
        for (const { threadId, to } of openThreads.transitions) {
            replayed.set(threadId, memoryThreadEnded(to) ? { state: to, closedBy: id } : { state: to });
        }
    }
    return replayed;
}

/**
 * The records a new chat starts with: what `store.memory.write` takes for a chat with none, in the source
 * chat's contents order. Runs stay out: the new chat's Log starts empty, and its coverage comes from its
 * events' `sources`.
 */
export function inheritedRecords<M extends Pick<Message, "chatId">>(arg: MemoryInheritance<M>): MemoryChanges {
    const { pages, events, threads } = arg;
    const map = sourceMap(arg);
    const { crossing, behind } = sortEvents(events, map);
    const crossingIds = new Set(crossing.map(({ id }) => id));
    const standing = new Set(crossing.filter(({ status }) => status !== "retracted").map(({ id }) => id));

    const rewound = pages.flatMap((page) => rewoundPage(page, behind) ?? []);
    const kept = new Set(rewound.map(({ id }) => id));
    const dropped = new Set(pages.flatMap(({ id }) => (kept.has(id) ? [] : [id])));

    /** `content` with only the evidence that crossed. */
    const withEvidence = <T extends MemorySectionContent>(content: T): T => ({
        ...content,
        provenance: content.provenance.filter((id) => crossingIds.has(id)),
        sources: storedMemorySources(content.sources).flatMap((source) => map.mapped(source) ?? []),
    });
    /**
     * `section` as rewound, so one that still names a behind event holds a change the history lost. That
     * one is flagged, and so is one that had evidence and has none standing, each with its body kept.
     */
    const inheritedSection = (section: MemorySection): MemorySection => {
        const inherited = withEvidence(section);
        const noneStanding = section.provenance.length > 0 && !inherited.provenance.some((id) => standing.has(id));
        return noneStanding || section.provenance.some((id) => behind.has(id))
            ? { ...inherited, unsupported: true }
            : inherited;
    };

    const movedThreads = new Set(
        events
            .filter(({ id }) => behind.has(id))
            .flatMap(({ openThreads: { close, transitions } }) => [
                ...close,
                ...transitions.map(({ threadId }) => threadId),
            ]),
    );
    const replayed = replayedThreads(crossing);

    return {
        pages: rewound.map((page) => ({
            ...page,
            sections: page.sections.map(inheritedSection),
            links: page.links.filter((id) => !dropped.has(id)),
            history: page.history.map((entry) =>
                entry.before ? { ...entry, before: withEvidence(entry.before) } : entry,
            ),
            // The attendance has no history; the writer's next scene fills it again.
            ...(page.type === "scene" && behind.size > 0 ? { participants: [] } : {}),
        })),
        events: crossing,
        threads: threads.flatMap((thread) => {
            const { closedBy, ...open } = thread;
            if (thread.openedBy !== undefined && behind.has(thread.openedBy)) {
                return [];
            }
            const who = thread.who.filter((id) => !dropped.has(id));
            const moved = movedThreads.has(thread.id) || (closedBy !== undefined && behind.has(closedBy));
            return [moved ? { ...open, who, state: "open" as const, ...replayed.get(thread.id) } : { ...thread, who }];
        }),
    };
}
