import { eligibleHistory } from "../../../../../shared/contextReport.ts";
import type { Message } from "../../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { HypaV3Settings } from "../../../../../shared/memory.ts";
import {
    type MemoryAnchoredSource,
    type MemoryEvent,
    memoryRerecordTarget,
    memoryScreenReason,
    normalizeStructuredMemorySettings,
    storedMemorySources,
    type StructuredMemorySettings,
} from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import type { ResourceStore } from "../../../data/resourceStore.ts";
import type { MemoryTokenizer } from "../host.ts";

/**
 * Which confirmed messages the writer records next, computed from the chat as stored and the events
 * already stored, so a restart that loses the task queue loses nothing: the next send finds the same
 * windows open.
 *
 * - Confirmation: a reply is evidence once the user sends the next message, or presses to record it.
 *   The job names the message its windows stop before (`writerCeiling`), a manual task takes it from
 *   the chat as stored, and everything here reads only what lies before it, so the newest reply and
 *   one being generated or continued stay out. A press on a message is its confirmation, so that id
 *   is `inclusive`: the windows run through it, newest reply included. A reply's reroll candidates are
 *   stored on its message (`candidates`) but are never messages of their own: windows read only the
 *   message's `data`, the selected candidate, and the newest reply stays out until the user sends past
 *   it, so a discarded candidate is never writer input.
 * - A turn is one assistant message and the unrecorded messages since the turn before it: an event
 *   names one speaker, so two replies in a row are two turns.
 * - Recorded means cited by a stored event in any status: the writer must not automatically record it
 *   again, whatever became of the event. It says nothing about the raw history a send may drop, where
 *   only an active event counts.
 * - A window before another event's cited message uses the historical write path (`historicalWindow`)
 *   to preserve current state, whether it repairs an event or records previously unrecorded messages.
 * - Windows close in order over the turns left. A trailing partial one stays open unless a manual
 *   start closes it.
 * - What is recorded can be asked to be recorded again, one event at a time (`rerecord` on the event): a
 *   person's repair marks it, and so does an edit of a message it cites. That asks nothing of `recorded`:
 *   each event a start re-records gets one window of its own ahead of the rest, and the ordinary windows
 *   stay exactly as they were. A person's start takes every mark, an automatic task only the marks an
 *   edit explains (`automaticRerecords`).
 * - A reply the preset's screening lists match (`memoryScreenReason`) enters no window: it is dropped
 *   from the confirmed messages after the ceiling is found, so a press on it still confirms, and the user
 *   message before it folds into the next turn. A message an event already cites stays recorded. A
 *   person's start re-records a marked event through its screened messages, since they asked for them;
 *   an automatic start leaves that event and its mark.
 */

/**
 * One writer run's messages: `sources[i]` anchors `messages[i]`, its `index` the place in the stored
 * list. `rerecords` is the event the run replaces (`retireRerecorded`).
 */
export type WriterWindow = { sources: MemoryAnchoredSource[]; messages: Message[]; rerecords?: string };

/**
 * What decides when a window closes and what stays out of one: the writer's settings, the budget mode of
 * their preset, and the preset's screening lists.
 */
export type WriterCadence = Pick<
    StructuredMemorySettings,
    "cadence" | "cadenceTurns" | "cadenceTokens" | "cadenceRatio" | "screening"
> & { budgetMode?: HypaV3Settings["budgetMode"] };

/** Screening that keeps nothing out. */
const NO_SCREENING: WriterCadence["screening"] = { refusal: [], format: [] };

/** A confirmed message, with the id that anchors it and its place in the stored list. */
export type ConfirmedMessage = { id: string; message: Message; index: number };

/** Where windows stop: before the message `id`, or through it when a press confirmed it (`inclusive`). */
export type WriterCeiling = { id: string; inclusive: boolean };

/** The selected memory preset's cadence and screening settings. */
export function writerCadence(db: Parameters<typeof selectedHypaV3Preset>[0]): WriterCadence {
    const settings = selectedHypaV3Preset(db)?.settings;
    const { cadence, cadenceTurns, cadenceTokens, cadenceRatio, screening } = normalizeStructuredMemorySettings(
        settings?.structured,
    );
    return { cadence, cadenceTurns, cadenceTokens, cadenceRatio, screening, budgetMode: settings?.budgetMode };
}

/**
 * The id of the message the windows stop before: the last eligible user message, or the message a
 * continue extends when that comes first, since a continued reply is never recorded. Null with no
 * eligible user message: nothing is confirmed. An automatic task uses what its job computed from the
 * chat it read: derived later, this would count a message an output trigger appended after the reply.
 * Only a manual task derives it from the chat as stored, because a person's start confirms that chat.
 */
export function writerCeiling(messages: readonly Message[], continueMessageId?: string): string | null {
    const lastUser = eligibleHistory(messages).messages.findLast(
        (message) => message.role === "user" && message.chatId,
    );
    if (!lastUser?.chatId) {
        return null;
    }
    if (continueMessageId !== undefined) {
        const continued = messages.findIndex((message) => message.chatId === continueMessageId);
        if (continued !== -1 && continued < messages.indexOf(lastUser)) {
            return continueMessageId;
        }
    }
    return lastUser.chatId;
}

/**
 * The ids cited by any of `events`, retracted and stale ones included, so nothing automatically brings
 * back what the user retracted. A failed run writes no event, so its window stays open and is retried.
 */
export function recordedMessages(events: readonly Pick<MemoryEvent, "sources">[]): Set<string> {
    const recorded = new Set<string>();
    for (const { sources } of events) {
        for (const source of sources) {
            recorded.add(source.messageId);
        }
    }
    return recorded;
}

/** `recordedMessages` of every event stored for the chat; empty for a missing chat. */
export function readRecordedMessages(store: Pick<ResourceStore, "memory">, chaId: string, chatId: string): Set<string> {
    const stored = store.memory.readContents(chaId, chatId)?.events ?? [];
    return recordedMessages(
        stored.flatMap(({ id }) => store.memory.readRecord(chaId, chatId, "events", id)?.data ?? []),
    );
}

/**
 * Historical write options when an event other than the one `window` replaces cites a message after
 * its last source. Every event status counts: stale, retracted and adopted events also leave state
 * behind. Positions come from message ids in `messages`, never stored indexes or creation revisions;
 * sources no longer in the chat do not count. Read before each window's write, so earlier commits in
 * the same run count, and freeze every page that exists then. Undefined when no later evidence exists.
 */
export function historicalWindow(
    store: Pick<ResourceStore, "memory">,
    chaId: string,
    chatId: string,
    messages: readonly Message[],
    window: WriterWindow,
): { frozenPages: string[] } | undefined {
    const lastSource = window.sources.at(-1);
    if (!lastSource) {
        return undefined;
    }
    const positions = new Map(messages.map(({ chatId }, index) => [chatId, index]));
    const last = positions.get(lastSource.messageId);
    if (last === undefined) {
        return undefined;
    }
    const contents = store.memory.readContents(chaId, chatId);
    for (const { id } of contents?.events ?? []) {
        if (id === window.rerecords) {
            continue;
        }
        const event = store.memory.readRecord(chaId, chatId, "events", id)?.data;
        if (
            storedMemorySources(event?.sources).some(({ messageId }) => {
                const position = positions.get(messageId);
                return position !== undefined && position > last;
            })
        ) {
            return { frozenPages: contents?.pages.map(({ id }) => id) ?? [] };
        }
    }
    return undefined;
}

/** The chat's events waiting for a re-record: marked, and not retracted. Empty for a missing chat. */
export function readRerecordEvents(store: Pick<ResourceStore, "memory">, chaId: string, chatId: string): MemoryEvent[] {
    const stored = store.memory.readContents(chaId, chatId)?.events ?? [];
    return stored.flatMap(({ id, status }) => {
        const event = status === "retracted" ? undefined : store.memory.readRecord(chaId, chatId, "events", id)?.data;
        return event?.rerecord ? [event] : [];
    });
}

/** The messages a send reads that can be anchored, in chat order, positioned in the stored list. */
export function anchoredMessages(messages: readonly Message[]): ConfirmedMessage[] {
    const placed = messages.map((message, index) => ({ message, index, disabled: message.disabled }));
    return eligibleHistory(placed).messages.flatMap(({ message, index }) =>
        message.chatId ? [{ id: message.chatId, message, index }] : [],
    );
}

/**
 * The eligible messages before the ceiling, or through it when `inclusive`, in chat order, positioned
 * in the stored list (a message without a `chatId` cannot be anchored), screened replies included. Null
 * when the ceiling is not itself eligible: a message that is gone, disabled, or cut off by an `allBefore`
 * confirms nothing.
 */
function messagesUnderCeiling(
    messages: readonly Message[],
    confirmedBefore: string,
    inclusive: boolean,
): ConfirmedMessage[] | null {
    const anchored = anchoredMessages(messages);
    const ceiling = anchored.findIndex(({ id }) => id === confirmedBefore);
    return ceiling === -1 ? null : anchored.slice(0, inclusive ? ceiling + 1 : ceiling);
}

/** `confirmed` without the replies `screening` keeps out of the writer's windows. */
function unscreened(confirmed: readonly ConfirmedMessage[], screening: WriterCadence["screening"]): ConfirmedMessage[] {
    return confirmed.filter(({ message }) => memoryScreenReason(message, screening) === null);
}

/**
 * `messagesUnderCeiling` without the screened replies: the ceiling is found first, so a press on a
 * screened reply, or a ceiling that is one, confirms what lies before it.
 */
function confirmedMessages(
    messages: readonly Message[],
    confirmedBefore: string,
    inclusive: boolean,
    screening: WriterCadence["screening"],
): ConfirmedMessage[] | null {
    const confirmed = messagesUnderCeiling(messages, confirmedBefore, inclusive);
    return confirmed && unscreened(confirmed, screening);
}

/**
 * The id of the newest reply `confirmedBefore` confirms: the last eligible assistant message with a
 * `chatId` before it that `screening` leaves in. Undefined with no ceiling, no such reply, or a ceiling
 * that is not eligible. A screened newest reply is skipped, or it would read pending for ever.
 */
export function confirmedThrough(
    messages: readonly Message[],
    confirmedBefore: string | null,
    screening: WriterCadence["screening"],
): string | undefined {
    if (confirmedBefore === null) {
        return undefined;
    }
    return confirmedMessages(messages, confirmedBefore, false, screening)?.findLast(
        ({ message }) => message.role === "char",
    )?.id;
}

/** The turns of `confirmed`; user messages with no assistant message after them belong to none. */
export function turnsOf(confirmed: readonly ConfirmedMessage[]): ConfirmedMessage[][] {
    const turns: ConfirmedMessage[][] = [];
    let turn: ConfirmedMessage[] = [];
    for (const entry of confirmed) {
        turn.push(entry);
        if (entry.message.role === "char") {
            turns.push(turn);
            turn = [];
        }
    }
    return turns;
}

/** The `tokens` cadence's threshold; any `budgetMode` but `"tokens"` is ratio mode, as in `resolveHypaV3Budget`. */
function tokenThreshold(cadence: WriterCadence, maxContext: number): number {
    const context = Number.isFinite(maxContext) && maxContext > 0 ? maxContext : 0;
    return Math.max(1, cadence.budgetMode === "tokens" ? cadence.cadenceTokens : cadence.cadenceRatio * context);
}

/**
 * Paired messages and fresh anchors: hashes use `messageSourceHash` from
 * `server/src/data/memoryStore.ts`, and indexes refer to the stored list, never the eligible subset.
 */
export function windowOf(entries: readonly ConfirmedMessage[]): WriterWindow {
    return {
        sources: entries.map(({ id, message, index }) => ({ messageId: id, hash: messageSourceHash(message), index })),
        messages: entries.map(({ message }) => message),
    };
}

/**
 * One window for each of `events` that can run, by its first message still present. An event's window is
 * exactly its sources a send still reads, in chat order, with fresh anchors. It runs when `confirmed`
 * holds every one of them and `memoryRerecordTarget` names a reply: any other is left out and keeps its
 * mark. `confirmed` is what the start reads: a person's start passes the messages with the screened
 * replies in, an automatic one without them, so an event over a screened reply waits for a person.
 */
function rerecordWindows(
    events: readonly MemoryEvent[],
    messages: readonly Message[],
    confirmed: readonly ConfirmedMessage[],
): WriterWindow[] {
    const positions = new Map(messages.map(({ chatId }, index) => [chatId, index]));
    const eligible = eligibleHistory(messages).messages;
    const ready = events.flatMap((event) => {
        const cited = new Set(storedMemorySources(event.sources).map(({ messageId }) => messageId));
        const read = eligible.filter(({ chatId }) => chatId !== undefined && cited.has(chatId));
        const entries = confirmed.filter(({ id }) => cited.has(id));
        if (entries.length < read.length || memoryRerecordTarget(event.sources, messages) === null) {
            return [];
        }
        const first = Math.min(...[...cited].flatMap((id) => positions.get(id) ?? []));
        return [{ rerecords: event.id, entries, first }];
    });
    ready.sort((a, b) => a.first - b.first);
    return ready.map(({ rerecords, entries }) => ({ ...windowOf(entries), rerecords }));
}

/**
 * The windows `cadence` closes over the turns before `confirmedBefore` that `recorded` leaves, oldest
 * first, at most `limit` of them; null when the ceiling is not an eligible message of the chat (gone,
 * disabled, or cut off by an `allBefore`). A turn whose assistant message is recorded drops out; any
 * other lists its unrecorded messages.
 *
 * `rerecord` are the events this start re-records, every mark on a person's start
 * (`readRerecordEvents`) and what an edit explains on an automatic one (`automaticRerecords`): their
 * windows (`rerecordWindows`) come first and count toward `limit`.
 *
 * `tokenizer` counts a stored message as `role` and `data` alone, so the job's step and its task decide
 * alike; `maxContext` is the input's in both. Only the `tokens` cadence counts: there the turns
 * accumulate until their messages reach `cadenceTokens` under budget mode `tokens`, otherwise
 * `cadenceRatio` of `maxContext`, at least 1. `everyTurn` closes each turn, `everyK` closes each
 * `cadenceTurns` turns, and `manual` closes nothing without a person's start.
 *
 * `manual` (a manual start) also closes the trailing partial window, under the `manual` cadence, which
 * closes none on its own, makes one window of each turn, and re-records a marked event through the
 * replies `cadence.screening` would keep out, which the ordinary windows never hold. `inclusive` reads
 * `confirmedBefore` as the last confirmed message instead of the one after it.
 */
export async function confirmedWindows(arg: {
    messages: readonly Message[];
    confirmedBefore: string;
    inclusive?: boolean;
    recorded: ReadonlySet<string>;
    cadence: WriterCadence;
    maxContext: number;
    tokenizer: MemoryTokenizer;
    limit: number;
    manual?: boolean;
    rerecord?: readonly MemoryEvent[];
}): Promise<WriterWindow[] | null> {
    const { recorded, cadence, tokenizer, limit, manual = false, rerecord = [] } = arg;
    const underCeiling = messagesUnderCeiling(arg.messages, arg.confirmedBefore, arg.inclusive ?? false);
    if (!underCeiling) {
        return null;
    }
    const confirmed = unscreened(underCeiling, cadence.screening);
    const threshold = tokenThreshold(cadence, arg.maxContext);
    const windows = rerecordWindows(rerecord, arg.messages, manual ? underCeiling : confirmed).slice(0, limit);
    if (windows.length >= limit) {
        return windows;
    }
    let open: ConfirmedMessage[] = [];
    let turns = 0;
    let tokens = 0;
    for (const turn of turnsOf(confirmed)) {
        if (recorded.has(turn.at(-1)!.id)) {
            continue;
        }
        const unrecorded = turn.filter(({ id }) => !recorded.has(id));
        open.push(...unrecorded);
        turns++;
        if (cadence.cadence === "tokens") {
            for (const { message } of unrecorded) {
                tokens += await tokenizer.tokenizeChat({
                    role: message.role === "user" ? "user" : "assistant",
                    content: message.data,
                });
            }
        }
        const closes = {
            everyTurn: true,
            everyK: turns >= cadence.cadenceTurns,
            tokens: tokens >= threshold,
            manual,
        }[cadence.cadence];
        if (closes) {
            windows.push(windowOf(open));
            if (windows.length >= limit) {
                return windows;
            }
            open = [];
            turns = 0;
            tokens = 0;
        }
    }
    if (manual && open.length > 0) {
        windows.push(windowOf(open));
    }
    return windows;
}

/**
 * Whether `window` still reads from the chat as stored in `messages`: `confirmedBefore` is still an
 * eligible message, and every source's message is there, still confirmed under it, with the same hash.
 * A message that only moved keeps its window; its source's `index` is not compared. `inclusive` is
 * what the window was computed under.
 */
export function windowStillConfirmed(
    window: Pick<WriterWindow, "sources">,
    messages: readonly Message[],
    confirmedBefore: string,
    options: { inclusive?: boolean } = {},
): boolean {
    const confirmed = confirmedMessages(messages, confirmedBefore, options.inclusive ?? false, NO_SCREENING);
    if (!confirmed) {
        return false;
    }
    const byId = new Map(confirmed.map(({ id, message }) => [id, message]));
    return window.sources.every((source) => {
        const message = byId.get(source.messageId);
        return message !== undefined && messageSourceHash(message) === source.hash;
    });
}
