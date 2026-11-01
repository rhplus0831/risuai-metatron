import { eligibleHistory } from "../../../../../shared/contextReport.ts";
import type { Message } from "../../../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { HypaV3Settings } from "../../../../../shared/memory.ts";
import {
    type MemoryAnchoredSource,
    type MemoryEvent,
    memoryRerecordTarget,
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
 *   is `inclusive`: the windows run through it, newest reply included. Swipe candidates are not stored
 *   messages at all.
 * - A turn is one assistant message and the unrecorded messages since the turn before it: an event
 *   names one speaker, so two replies in a row are two turns.
 * - Recorded means cited by a stored event in any status: the writer must not automatically record it
 *   again, whatever became of the event. It says nothing about the raw history a send may drop, where
 *   only an active event counts.
 * - Windows close in order over the turns left. A trailing partial one stays open unless a manual
 *   start closes it.
 * - A person can ask for what is recorded to be recorded again, one event at a time (`rerecord` on the
 *   event). That asks nothing of `recorded`: a person's start reads the marks, gives each marked event
 *   one window of its own ahead of the rest, and the ordinary windows stay exactly as they were.
 */

/**
 * One writer run's messages: `sources[i]` anchors `messages[i]`, its `index` the place in the stored
 * list. `rerecords` is the event the run replaces (`retireRerecorded`).
 */
export type WriterWindow = { sources: MemoryAnchoredSource[]; messages: Message[]; rerecords?: string };

/** What decides when a window closes: the writer's settings and the budget mode of their preset. */
export type WriterCadence = Pick<
    StructuredMemorySettings,
    "cadence" | "cadenceTurns" | "cadenceTokens" | "cadenceRatio"
> & { budgetMode?: HypaV3Settings["budgetMode"] };

/** A confirmed message, with the id that anchors it and its place in the stored list. */
type ConfirmedMessage = { id: string; message: Message; index: number };

/** Where windows stop: before the message `id`, or through it when a press confirmed it (`inclusive`). */
export type WriterCeiling = { id: string; inclusive: boolean };

/** The selected memory preset's cadence settings. */
export function writerCadence(db: Parameters<typeof selectedHypaV3Preset>[0]): WriterCadence {
    const settings = selectedHypaV3Preset(db)?.settings;
    const { cadence, cadenceTurns, cadenceTokens, cadenceRatio } = normalizeStructuredMemorySettings(
        settings?.structured,
    );
    return { cadence, cadenceTurns, cadenceTokens, cadenceRatio, budgetMode: settings?.budgetMode };
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

/** The chat's events a person asked to re-record: marked, and not retracted. Empty for a missing chat. */
export function readRerecordEvents(store: Pick<ResourceStore, "memory">, chaId: string, chatId: string): MemoryEvent[] {
    const stored = store.memory.readContents(chaId, chatId)?.events ?? [];
    return stored.flatMap(({ id, status }) => {
        const event = status === "retracted" ? undefined : store.memory.readRecord(chaId, chatId, "events", id)?.data;
        return event?.rerecord ? [event] : [];
    });
}

/**
 * The eligible messages before the ceiling, or through it when `inclusive`, in chat order, positioned
 * in the stored list (a message without a `chatId` cannot be anchored). Null when the ceiling is not
 * itself eligible: a message that is gone, disabled, or cut off by an `allBefore` confirms nothing.
 */
function confirmedMessages(
    messages: readonly Message[],
    confirmedBefore: string,
    inclusive: boolean,
): ConfirmedMessage[] | null {
    const placed = messages.map((message, index) => ({ message, index, disabled: message.disabled }));
    const eligible = eligibleHistory(placed).messages;
    const ceiling = eligible.findIndex(({ message }) => message.chatId === confirmedBefore);
    if (ceiling === -1) {
        return null;
    }
    const confirmed: ConfirmedMessage[] = [];
    for (const { message, index } of eligible.slice(0, inclusive ? ceiling + 1 : ceiling)) {
        if (message.chatId) {
            confirmed.push({ id: message.chatId, message, index });
        }
    }
    return confirmed;
}

/**
 * The id of the newest reply `confirmedBefore` confirms: the last eligible assistant message with a
 * `chatId` before it. Undefined with no ceiling, no such reply, or a ceiling that is not eligible.
 */
export function confirmedThrough(messages: readonly Message[], confirmedBefore: string | null): string | undefined {
    if (confirmedBefore === null) {
        return undefined;
    }
    return confirmedMessages(messages, confirmedBefore, false)?.findLast(({ message }) => message.role === "char")?.id;
}

/** The turns of `confirmed`; user messages with no assistant message after them belong to none. */
function turnsOf(confirmed: readonly ConfirmedMessage[]): ConfirmedMessage[][] {
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

function windowOf(entries: readonly ConfirmedMessage[]): WriterWindow {
    return {
        sources: entries.map(({ id, message, index }) => ({ messageId: id, hash: messageSourceHash(message), index })),
        messages: entries.map(({ message }) => message),
    };
}

/**
 * One window for each of `events` that can run, by its first message still present. An event's window is
 * exactly its sources a send still reads, in chat order, with fresh anchors. It runs when `confirmed`
 * holds every one of them and `memoryRerecordTarget` names a reply: any other is left out and keeps its
 * mark.
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
 * `rerecord` are the events a person's start re-records (`readRerecordEvents`): their windows
 * (`rerecordWindows`) come first and count toward `limit`.
 *
 * `tokenizer` counts a stored message as `role` and `data` alone, so the job's step and its task decide
 * alike; `maxContext` is the input's in both. Only the `tokens` cadence counts: there the turns
 * accumulate until their messages reach the threshold.
 *
 * `manual` (a manual start) also closes the trailing partial window, and under the `manual` cadence,
 * which closes none on its own, makes one window of each turn. `inclusive` reads `confirmedBefore` as
 * the last confirmed message instead of the one after it.
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
    const confirmed = confirmedMessages(arg.messages, arg.confirmedBefore, arg.inclusive ?? false);
    if (!confirmed) {
        return null;
    }
    const threshold = tokenThreshold(cadence, arg.maxContext);
    const windows = rerecordWindows(rerecord, arg.messages, confirmed).slice(0, limit);
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
    const confirmed = confirmedMessages(messages, confirmedBefore, options.inclusive ?? false);
    if (!confirmed) {
        return false;
    }
    const byId = new Map(confirmed.map(({ id, message }) => [id, message]));
    return window.sources.every((source) => {
        const message = byId.get(source.messageId);
        return message !== undefined && messageSourceHash(message) === source.hash;
    });
}
