import { randomUUID } from "node:crypto";
import { writerGreeting } from "../prompt/memory/structured/window.ts";
import { resolveChatBinding } from "../../../shared/chatBinding.ts";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Chat, Message, character, groupChat } from "../../../shared/database.ts";
import { RESOURCE_KIND, RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    ADOPTED_WRITER_RUN,
    type MemoryGreetingSource,
    storedMemoryGreeting,
    hypaV3DataHoldsSummaries,
    isSealedHypaV3Data,
    MEMORY_FIND_EXCERPT_CHARS,
    MEMORY_FIND_HITS_MAX,
    MEMORY_FIND_QUERY_CHARS,
    MEMORY_HEALTH_CHATS_MAX,
    MEMORY_HEALTH_ROUND_BYTES,
    MEMORY_KNOWLEDGE_STANCES,
    MEMORY_RECORD_KINDS,
    MEMORY_REVISION_CHATS_MAX,
    MEMORY_RUNS_ROUND_ROWS,
    MEMORY_THREAD_STATES,
    STRUCTURED_MEMORY_LIMITS,
    STRUCTURED_MEMORY_PATH,
    STRUCTURED_MEMORY_REBUILD_MODES,
    storedMemorySources,
    type MemoryEvent,
    type MemoryPage,
    type StructuredMemoryAbandonAnswer,
    type StructuredMemoryAdoptAnswer,
    type StructuredMemoryChapterCostAnswer,
    type StructuredMemoryChapterRemoveAnswer,
    type StructuredMemoryChaptersAnswer,
    type StructuredMemoryContentsAnswer,
    type StructuredMemoryCostAnswer,
    type StructuredMemoryCostMode,
    type StructuredMemoryCoverageEvent,
    type StructuredMemoryCoverageRound,
    type StructuredMemoryCoverageRun,
    type StructuredMemoryDeclineAnswer,
    type StructuredMemoryDefaultPromptsAnswer,
    type StructuredMemoryEdit,
    type StructuredMemoryEditAnswer,
    type StructuredMemoryFindHit,
    type StructuredMemoryFindRound,
    type StructuredMemoryHealthAnswer,
    type StructuredMemoryImportAnswer,
    type StructuredMemoryImportFile,
    type StructuredMemoryInheritAnswer,
    type StructuredMemoryLogRun,
    type StructuredMemoryPackageRound,
    type StructuredMemoryPageMention,
    type StructuredMemoryPageToolAnswer,
    type StructuredMemoryProjectionAnswer,
    type StructuredMemoryRecordAnswer,
    type StructuredMemoryRecordKind,
    type StructuredMemoryRecordOf,
    type StructuredMemoryResetAnswer,
    type StructuredMemoryRestoreAnswer,
    type StructuredMemoryRevertAnswer,
    type StructuredMemoryRevisionsAnswer,
    type StructuredMemoryRunsRound,
    type StructuredMemoryStoryEvent,
    type StructuredMemoryStoryRound,
    type StructuredMemoryThreadsRound,
} from "../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import { messageSourceHash, type MemoryChatRef, type MemoryContents } from "../data/memoryStore.ts";
import { isValidResourceId, type ResourceStore } from "../data/resourceStore.ts";
import type { MaintenanceGate } from "../data/snapshots.ts";
import { readJsonBody } from "../http/body.ts";
import { compressedJson } from "../http/compressedJson.ts";
import { readChatBindingLookup } from "../jobs/chatBinding.ts";
import { loadJobScope } from "../jobs/jobScope.ts";
import { jobMemoryBlockingReason } from "../prompt/runner.ts";
import { adoptedEvents } from "../prompt/memory/structured/adopt.ts";
import { chapterUnits } from "../prompt/memory/structured/chapters.ts";
import {
    applyEventRepair,
    applyEventRelease,
    applyEventText,
    applyPageEdit,
    applyThreadEdit,
    flagUnsupportedSections,
    MemoryEditRefusal,
    parseMemoryEdit,
} from "../prompt/memory/structured/edits.ts";
import { parseMemoryPackage } from "../prompt/memory/structured/importPackage.ts";
import { inheritedRecords } from "../prompt/memory/structured/inherit.ts";
import {
    applyPageTool,
    laterEventCount,
    MemoryPageToolRefusal,
    MemoryRevertRefusal,
    pageToolIds,
    parseMemoryPageTool,
    revertChange,
} from "../prompt/memory/structured/pages.ts";
import { defaultPrompts } from "../prompt/memory/structured/prompts.ts";
import { memoryWorkCost } from "../prompt/memory/structured/rebuild.ts";
import { withRetractedEvidence } from "../prompt/memory/structured/reconcile.ts";
import { parseRestoredRecords } from "../prompt/memory/structured/restore.ts";
import { chatAdoptionHold } from "../prompt/memory/structured/writer.ts";
import type { AppEnv } from "../types.ts";
import type { AuthStore } from "./auth.ts";
import { limitedBody } from "./limitedBody.ts";
import { storeErrorResponse } from "./resources.ts";

export { STRUCTURED_MEMORY_PATH };

/** An edit holds one section at `sectionBodyChars`, which JSON's escapes can lengthen, and its ids. */
const MAX_EDIT_BODY_BYTES = 64 * 1024;
const MAX_CHAPTER_REMOVE_IDS = 256;

/** A revisions request holds `MEMORY_REVISION_CHATS_MAX` chats named by two UUIDs, about 200 KiB of JSON. */
const MAX_REVISIONS_BODY_BYTES = 256 * 1024;

const REFUSAL_TEXT = {
    chatGone: "Chat not found",
    recordGone: "Record not found",
    fenced: "Something is writing this chat's memory",
    tooLarge: "The chat's memory is too large to project",
    chaptersTooLarge: "The chat's chapters are too large to read",
    chapterIds: `ids must contain 1 to ${MAX_CHAPTER_REMOVE_IDS} valid chapter ids`,
    trashed: "This page is in the trash",
} as const;

/** The current bound writer rule, without message reads; an unresolvable binding leaves contents readable. */
function writerBlockingReason(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    characterId: string,
    chatId: string,
): StructuredMemoryContentsAnswer["writerBlockingReason"] {
    try {
        const chat = store.chatMeta(characterId, chatId);
        if (!chat) return undefined;
        const binding = resolveChatBinding(chat.data, readChatBindingLookup(store, kinds));
        if (!binding.ok) return undefined;
        const { promptPresetId: presetId, modelPresetId, personaId } = binding.ids;
        const scope = loadJobScope(
            store,
            kinds,
            {
                characterId,
                chatId,
                presetId,
                modelPresetId,
                personaId,
                chatRevision: chat.revision,
                mode: "manual",
                input: "",
            },
            { metadataOnly: true, chatMetadata: chat },
        );
        return jobMemoryBlockingReason(scope);
    } catch {
        // This optional settings observation must not prevent reading the chat's memory records.
        return undefined;
    }
}

/** The files an import request holds, or null for a body of another shape. */
function parseImportFiles(value: unknown): StructuredMemoryImportFile[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const files: StructuredMemoryImportFile[] = [];
    for (const file of value as unknown[]) {
        if (!isPlainObject(file) || typeof file.path !== "string" || typeof file.text !== "string") {
            return null;
        }
        files.push({ path: file.path, text: file.text });
    }
    return files;
}

/** Whether a chat's contents list a row of any kind, the trash and the runs included. */
function holdsRows(contents: MemoryContents): boolean {
    return [contents.pages, contents.trash, contents.events, contents.threads, contents.runs].some(
        ({ length }) => length > 0,
    );
}

function isRecordKind(kind: string): kind is StructuredMemoryRecordKind {
    return (MEMORY_RECORD_KINDS as readonly string[]).includes(kind);
}

function isCostMode(mode: string | undefined): mode is StructuredMemoryCostMode {
    return mode === "record" || (STRUCTURED_MEMORY_REBUILD_MODES as readonly (string | undefined)[]).includes(mode);
}

/** The chats a revisions or health request names, or null for a body of another shape, a bad id, or a list past `max`. */
function parseChatRefs(body: unknown, max: number): MemoryChatRef[] | null {
    const chats = isPlainObject(body) ? body.chats : undefined;
    if (!Array.isArray(chats) || chats.length > max) {
        return null;
    }
    const refs: MemoryChatRef[] = [];
    for (const chat of chats as unknown[]) {
        if (!isPlainObject(chat) || !isValidResourceId(chat.characterId) || !isValidResourceId(chat.chatId)) {
            return null;
        }
        refs.push({ characterId: chat.characterId, chatId: chat.chatId });
    }
    return refs;
}

/** A round's cursor: 0 when absent, null for anything but a non-negative safe integer. */
function parseCursor(value: string | undefined): number | null {
    if (value === undefined) {
        return 0;
    }
    const cursor = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(cursor) ? cursor : null;
}

/**
 * The rows of one round over `listed` from position `cursor`, each charged its stored `bytes` before
 * anything reads its record: the first is served whatever its size, and the round stops before the row
 * that would pass `budget` or `rowCap`. `next` is the position to continue from, null at the list's end.
 */
function roundOf<Row extends { bytes: number }>(
    listed: readonly Row[],
    cursor: number,
    budget: number,
    rowCap = Infinity,
): { rows: Row[]; next: number | null } {
    let charged = 0;
    let index = cursor;
    for (; index < listed.length; index += 1) {
        const { bytes } = listed[index];
        if (index > cursor && (index - cursor >= rowCap || charged + bytes > budget)) {
            break;
        }
        charged += bytes;
    }
    return { rows: listed.slice(cursor, index), next: index < listed.length ? index : null };
}

/** The message ids of a stored source list, which the store does not check the shape of. */
function sourceIds(sources: unknown): string[] {
    return storedMemorySources(sources).map(({ messageId }) => messageId);
}

/** The first source position, resolved against current messages when `positions` is supplied. */
function firstSourceIndex(
    sources: unknown,
    positions?: ReadonlyMap<string, number>,
    greeting?: unknown,
): number | null {
    if (storedMemoryGreeting(greeting)) return -1;
    let first: number | null = null;
    for (const source of Array.isArray(sources) ? sources : []) {
        const index: unknown = isPlainObject(source)
            ? positions
                ? positions.get(source.messageId as string)
                : source.index
            : null;
        if (Number.isSafeInteger(index) && (first === null || (index as number) < first)) {
            first = index as number;
        }
    }
    return first;
}

/** Per-code-point lowercase, with each resulting code unit mapped to its original code point's start. */
function lowerFindText(value: string): { text: string; offsets: number[] } {
    let text = "";
    let offset = 0;
    const offsets: number[] = [];
    for (const point of value) {
        const lower = point.toLowerCase();
        text += lower;
        for (let index = 0; index < lower.length; index += 1) {
            offsets.push(offset);
        }
        offset += point.length;
    }
    return { text, offsets };
}

/** A bounded display field, with neither edge cutting between the halves of a surrogate pair. */
function findTextWindow(value: unknown, start = 0, max: number = MEMORY_FIND_EXCERPT_CHARS): string {
    if (typeof value !== "string") {
        return "";
    }
    const splitsPair = (index: number) =>
        index > 0 &&
        value.charCodeAt(index - 1) >= 0xd800 &&
        value.charCodeAt(index - 1) <= 0xdbff &&
        value.charCodeAt(index) >= 0xdc00 &&
        value.charCodeAt(index) <= 0xdfff;
    start = Math.max(0, Math.min(start, value.length - max));
    if (splitsPair(start)) {
        start -= 1;
    }
    let end = Math.min(value.length, start + max);
    if (splitsPair(end)) {
        end -= 1;
    }
    return value.slice(start, end);
}

/** A plain substring match's excerpt, centered on its original position even when lowercase expands. */
function findExcerpt(value: unknown, query: string): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const lowered = lowerFindText(value);
    const index = lowered.text.indexOf(query);
    if (index < 0) {
        return null;
    }
    const start = lowered.offsets[index];
    const end = lowered.offsets[index + query.length] ?? value.length;
    return findTextWindow(value, start - Math.floor(Math.max(0, MEMORY_FIND_EXCERPT_CHARS - (end - start)) / 2));
}

/** Title and aliases share one hit; each matching section adds one, bounded even for restored pages. */
function findPageHits(id: string, page: unknown, query: string): StructuredMemoryFindHit[] {
    if (!isPlainObject(page)) {
        return [];
    }
    const title = findTextWindow(page.title);
    const hits: StructuredMemoryFindHit[] = [];
    for (const field of [page.title, ...(Array.isArray(page.aliases) ? page.aliases : [])]) {
        const excerpt = findExcerpt(field, query);
        if (excerpt !== null) {
            hits.push({ kind: "page", id, title, heading: null, excerpt });
            break;
        }
    }
    for (const section of Array.isArray(page.sections) ? page.sections : []) {
        if (!isPlainObject(section)) {
            continue;
        }
        const excerpt = findExcerpt(section.body, query);
        if (excerpt !== null) {
            hits.push({ kind: "page", id, title, heading: findTextWindow(section.heading), excerpt });
            if (hits.length === MEMORY_FIND_HITS_MAX) {
                break;
            }
        }
    }
    return hits;
}

/** An event names a page through participants, state, knowledge (including knowers), or relationships. */
function eventNamesPage(event: Record<string, unknown>, pageId: string): boolean {
    return (
        (Array.isArray(event.participants) && event.participants.includes(pageId)) ||
        (Array.isArray(event.stateChanges) &&
            event.stateChanges.some((item) => isPlainObject(item) && item.pageId === pageId)) ||
        (Array.isArray(event.knowledge) &&
            event.knowledge.some(
                (item) =>
                    isPlainObject(item) &&
                    (item.pageId === pageId || (Array.isArray(item.knowers) && item.knowers.includes(pageId))),
            )) ||
        (Array.isArray(event.relationshipShifts) &&
            event.relationshipShifts.some(
                (item) => isPlainObject(item) && (item.from === pageId || item.to === pageId),
            ))
    );
}

/**
 * What `event` says of `pageId` for that page's view. A knowledge item counts when the page learned it
 * or is one of a secret's knowers; a shift counts in either direction. Lists and texts are bounded as
 * `StructuredMemoryPageMention` says, whatever a restored record holds.
 */
function pageMention(event: Record<string, unknown>, pageId: string): StructuredMemoryPageMention {
    const { factChars, labelChars, knowledgePerEvent, relationshipShiftsPerEvent } = STRUCTURED_MEMORY_LIMITS;
    const items = (value: unknown) => (Array.isArray(value) ? value.filter(isPlainObject) : []);
    const knowledge = items(event.knowledge)
        .flatMap((item): StructuredMemoryPageMention["knowledge"] => {
            const knowers = Array.isArray(item.knowers) ? item.knowers : [];
            const stance = MEMORY_KNOWLEDGE_STANCES.find((known) => known === item.stance);
            return stance !== undefined && (item.pageId === pageId || knowers.includes(pageId))
                ? [{ fact: findTextWindow(item.fact, 0, factChars), stance, secret: knowers.length > 0 }]
                : [];
        })
        .slice(0, knowledgePerEvent);
    const shifts = items(event.relationshipShifts)
        .flatMap(({ from, to, direction, note }): StructuredMemoryPageMention["shifts"] =>
            typeof from === "string" && typeof to === "string" && (from === pageId || to === pageId)
                ? [
                      {
                          from,
                          to,
                          direction: findTextWindow(direction, 0, labelChars),
                          note: findTextWindow(note, 0, factChars),
                      },
                  ]
                : [],
        )
        .slice(0, relationshipShiftsPerEvent);
    const storyTime = isPlainObject(event.storyTime) ? findTextWindow(event.storyTime.text, 0, labelChars) : "";
    return { grade: Number.isSafeInteger(event.grade) ? (event.grade as number) : null, storyTime, knowledge, shifts };
}

/** A thread hit when its `who` names the page. */
function findThreadHits(id: string, thread: unknown, pageId: string): StructuredMemoryFindHit[] {
    if (!isPlainObject(thread) || !Array.isArray(thread.who) || !thread.who.includes(pageId)) {
        return [];
    }
    const state = MEMORY_THREAD_STATES.find((known) => known === thread.state);
    return state === undefined ? [] : [{ kind: "thread", id, title: findTextWindow(thread.title), state }];
}

/**
 * One hit per event; text excerpts prefer summary, then key lines, then the already displayed title. A
 * page lookup's hit carries what the event says of that page.
 */
function findEventHits(
    id: string,
    event: unknown,
    query: { q: string } | { page: string },
    positions?: ReadonlyMap<string, number>,
): StructuredMemoryFindHit[] {
    if (!isPlainObject(event)) {
        return [];
    }
    let excerpt: string | null = null;
    let mention: StructuredMemoryPageMention | undefined;
    if ("page" in query) {
        if (eventNamesPage(event, query.page)) {
            excerpt = "";
            mention = pageMention(event, query.page);
        }
    } else {
        excerpt = findExcerpt(event.summary, query.q);
        for (const line of Array.isArray(event.keyLines) ? event.keyLines : []) {
            if (excerpt !== null) {
                break;
            }
            if (isPlainObject(line)) {
                excerpt = findExcerpt(line.text, query.q);
            }
        }
        excerpt ??= findExcerpt(event.title, query.q);
    }
    return excerpt === null
        ? []
        : [
              {
                  kind: "event",
                  id,
                  title: findTextWindow(event.title),
                  sourceIndex: firstSourceIndex(event.sources, positions, event.greeting),
                  excerpt,
                  ...(mention ? { mention } : {}),
              },
          ];
}

/** The id of the record `edit` addresses. */
function editedRecordId(edit: StructuredMemoryEdit): string {
    switch (edit.kind) {
        case "thread":
            return edit.threadId;
        case "event":
        case "eventText":
        case "eventRelease":
            return edit.eventId;
        default:
            return edit.pageId;
    }
}

/** A round's chat, memory revision, cursor, and a reader for records admitted by its metadata listing. */
type RoundRead = {
    characterId: string;
    chatId: string;
    revision: string;
    cursor: number;
    read: <K extends StructuredMemoryRecordKind>(kind: K, id: string) => StructuredMemoryRecordOf[K];
};

/**
 * The per-chat structured memory routes (`shared/structuredMemory.ts`):
 *
 * - `GET /api/memory/structured/:characterId/:chatId`: the table of contents, answered
 *   `StructuredMemoryContentsAnswer`, with `adoption`, what the panel offers for the chat's stored HypaV3
 *   summaries as the server sees them, `rebuild`, the chat's rebuild if it holds one, `recordedLanguage`,
 *   the language of the newest recorded run, one record read, and `health`, the chat's health entry as the
 *   health route answers it: facts, or `"unavailable"` when its live pages, events, and runs exceed
 *   `MEMORY_HEALTH_ROUND_BYTES` in stored bytes; 404 `chatGone`. Pages in the trash are listed apart
 *   (`trash`), so every round and route that starts from `pages` leaves them out; the record route still
 *   reads one by id. `unsupportedPages` lists live flagged pages in contents order, computed in SQLite
 *   without parsing records, or an empty list when health is unavailable.
 * - `GET /api/memory/structured/:characterId/:chatId/records/:kind/:id`: one record as stored, answered
 *   `StructuredMemoryRecordAnswer`; 400 for an unknown kind, 404 `chatGone` or `recordGone`.
 * - `GET /api/memory/structured/:characterId/:chatId/package?cursor=N&revision=R`: one round of the
 *   list of the chat's pages followed by its events, in contents order from position `cursor` (default
 *   0), answered `StructuredMemoryPackageRound`. Records are sent whole. Each is charged its stored
 *   bytes: a round's first record is served whatever its size, and the round stops before the record
 *   that would pass `packageRoundBytes`. `next` is null when the list is done, and a cursor past its
 *   end answers empty lists. 400 for a cursor that is not a non-negative safe integer, 404 `chatGone`,
 *   and 409 `{ error, revision }` when `revision` is given and is not the current token, compared
 *   whole.
 * - `GET /api/memory/structured/:characterId/:chatId/coverage?cursor=N&revision=R`: one round of the
 *   list of the chat's events followed by its runs that are not `recorded`, in contents order, answered
 *   `StructuredMemoryCoverageRound`: message and greeting citations, with no error or source text. An
 *   event includes its normalized `greeting` and `greetingKept`; a run says whether it read the greeting.
 *   Events also carry message sources, `keptState`, and `rerecord` as stored: the tab reconciles
 *   them with the messages it holds, so this reads no chat. The list comes from the contents, so a
 *   recorded run's body is never read. Bytes, `cursor`, `revision`, and the refusals work as in the
 *   package round.
 * - `GET /api/memory/structured/:characterId/:chatId/story?cursor=N&revision=R`: one round of the chat's
 *   events in contents order, including retracted events, answered `StructuredMemoryStoryRound`: each
 *   event's id, summary, story time, participants, and optional grade as stored, without cutting or
 *   normalizing. Title, status, and order are not repeated: the tab joins by id with the coverage facts
 *   it holds. Rounds charge stored bytes like the package round. Bytes, `cursor`, `revision`, and
 *   refusals work as in the package round.
 * - `GET /api/memory/structured/:characterId/:chatId/find?cursor=N&revision=R`: exactly one of `q` (trimmed,
 *   1..MEMORY_FIND_QUERY_CHARS characters) and `page` (a resource id), otherwise 400. Text search walks
 *   live pages then non-retracted events; page lookup walks non-retracted events then threads, in
 *   contents order.
 *   Retracted events are neither charged nor read. Plain substring matching lowercases per code point:
 *   pages give one title/alias hit together, then one per matching section body; events give one hit,
 *   preferring summary, key lines, then title for the excerpt. Page lookup matches participants, state
 *   pageIds, knowledge pageIds/knowers, and relationship from/to, with an empty excerpt and a `mention`
 *   (`pageMention`), then gives one hit per thread whose `who` names the page. Answers are
 *   StructuredMemoryFindRound. Every display field but a mention's is capped at MEMORY_FIND_EXCERPT_CHARS; excerpts
 *   center on the first match mapped to original offsets, with no split surrogate pairs. A page adds
 *   at most MEMORY_FIND_HITS_MAX hits; a round ends after the row that reaches that cap, with next at
 *   the following row (null at the end), so an answer has fewer than twice the cap. Stored bytes,
 *   cursor, revision, and refusals work as in the package round; keep the same query on every round.
 * - `GET /api/memory/structured/:characterId/:chatId/runs?cursor=N&revision=R`: one round of the chat's
 *   runs, newest first, answered `StructuredMemoryRunsRound`, each without `input` and
 *   `settingsFingerprint`. A round also stops at `MEMORY_RUNS_ROUND_ROWS` runs. Cursor 0 starts at the
 *   newest run; otherwise it is the inclusive starting `seq`, descending. `next` is the first unserved
 *   older seq, or null when done. `total` counts all the chat's runs. Only this kind's metadata is read,
 *   stopping in SQL at the row or byte budget. Bytes, `revision`, and refusals work as in the package round.
 * - `GET /api/memory/structured/:characterId/:chatId/threads?cursor=N&revision=R`: one round of the chat's
 *   threads, in ascending storage order, whole as stored, answered `StructuredMemoryThreadsRound`: what
 *   a chat file takes beside the package rounds. Cursor is the inclusive starting `seq` (0 starts the
 *   list); `next` is the first unserved seq, or null when done. Only thread metadata is read, stopping
 *   in SQL at the byte budget. Bytes, `revision`, and refusals work as in the package round. A cursor
 *   past the end of either seq-cursored list answers an empty list and null `next`.
 * - `POST /api/memory/structured/revisions` `{ chats: { characterId, chatId }[] }`: at most
 *   `MEMORY_REVISION_CHATS_MAX` chats' memory revisions, answered `StructuredMemoryRevisionsAnswer`, by
 *   position. An entry is null unless the algorithm is selected, the chat exists, its stored `hypaV3Data`
 *   holds no summaries, and it has an event row: what a whole read projects. It reads no message, so a
 *   plugin read that finds nothing new costs this request alone. 400 for a body of another shape, a list
 *   past the cap, or an id that is not a resource id. The body is read after authentication and capped at
 *   256 KiB.
 * - `POST /api/memory/structured/health` `{ chats: { characterId, chatId }[] }`: at most
 *   `MEMORY_HEALTH_CHATS_MAX` chats' health entries (`StructuredMemoryHealthEntry`), answered
 *   `StructuredMemoryHealthAnswer`: a prefix of the request, by position, null for a chat that does not
 *   exist. Each chat is charged the stored bytes of its live pages, events, and runs. A chat over
 *   `MEMORY_HEALTH_ROUND_BYTES` answers `"unavailable"` without a scan or charge, and the round continues.
 *   After at least one entry, the list stops before the chat whose charge would take the scan past that
 *   budget, so a tab asks again from there. Live tables only, pages in the trash left out, and no message
 *   read: what the memory health badge shows for the pinned chats and the open one. Refusals and the
 *   body cap are the revisions route's.
 * - `GET /api/memory/structured/:characterId/:chatId/projection`: the chat's projection as a whole read
 *   would overlay it, reconciled against its stored messages, answered
 *   `StructuredMemoryProjectionAnswer`; `hypaV3Data` is null for a chat that read leaves as stored, and
 *   `revision` too under another algorithm, which reads no memory table. Stored events over
 *   `packageRoundBytes` are 413 `{ error, reason: "tooLarge" }` before any message is read. 404 `chatGone`.
 * - `GET /api/memory/structured/:characterId/:chatId/chapters` answers `StructuredMemoryChaptersAnswer`:
 *   the current memory revision and well-shaped chapters in storage order. 404 `chatGone`, or 413
 *   `tooLarge` if the chapters' total stored bytes exceed `packageRoundBytes`, checked before reading bodies.
 * - `GET /api/memory/structured/:characterId/:chatId/chapters/cost` counts the eligible chapter units
 *   (`StructuredMemoryChapterCostAnswer`) from stored events, chapters and writer settings. 404 `chatGone`.
 * - `POST /api/memory/structured/:characterId/:chatId/chapters/remove` accepts `{ ids }`, 1 to 256
 *   resource ids under the 64 KiB edit body cap. Other shapes or invalid ids are 400. After the epoch,
 *   fence and maintenance checks, it removes matching rows and answers `StructuredMemoryChapterRemoveAnswer`
 *   with the number removed (possibly zero). 404 `chatGone`, 409 `fenced`. The memory revision stays.
 * - `POST /api/memory/structured/:characterId/:chatId/edits` `{ revision, edit }`: one person's edit
 *   (`StructuredMemoryEdit`, `server/src/prompt/memory/structured/edits.ts`), answered
 *   `StructuredMemoryEditAnswer`. Admission checks ids, the body, then the edit shape (`parseMemoryEdit`,
 *   including blank or over-long section and event text) before the epoch and fence; only then is the record read,
 *   edited, and written. An edit that changes nothing still names a revision, so a stale one is refused
 *   like any other. An event's repair reads the chat as stored, a `retract` excepted, which reads none.
 *   A `sectionKeep` clears the unsupported flag and retracted provenance using contents' event statuses,
 *   optionally marks it user-corrected for a rebuild, and changes no body, timestamp, or history.
 *   A `sectionRelease` takes that mark off and changes nothing else.
 *   A `sectionAdd` appends a user-corrected section with empty evidence and an `edit` history entry
 *   with no prior text or event; scene and character pages, existing headings, and full pages refuse it.
 *   An `eventText` changes only title, summary, and `userCorrected`, refusing retracted events; an
 *   `eventRelease` removes only the mark, including on retracted events. Neither reads the chat or
 *   reconciles evidence.
 *   400 for a malformed edit or one the record refuses, a page in the trash included, 404 `chatGone` or
 *   `recordGone` (a heading the page lacks too), 409 `{ error, reason: "fenced" }` while `fenced` holds,
 *   409 `{ error, reason: "changed" }` when a `keep` names a state the chat has left, and
 *   409 `{ error, revision }` when `revision` is not the current token. The body is read after
 *   authentication and capped at 64 KiB.
 * - `POST /api/memory/structured/:characterId/:chatId/revert` `{ revision, pageId, historyId }`: a person's
 *   undoing of one writer's change of a section (`revertChange`, `structured/pages.ts`), answered
 *   `StructuredMemoryRevertAnswer`, with the events after the change's own that are not retracted. A change
 *   already undone, which is what a repeat finds, answers `reverted: false` and goes through as an empty
 *   change set, so a stale one is still refused. The restored evidence can leave a section with only
 *   retracted events behind it, which flags it (`flagUnsupportedSections`). 400 for a body of another
 *   shape, an entry that is no writer's change of a section, a section the page has no room for, or a
 *   page in the trash, 404 `chatGone` or `recordGone` (an entry the bounded history lost too), 409
 *   `{ error, reason: "fenced" }` while `fenced` holds, 409 `{ error, reason: "superseded" }` when a later
 *   change of the section stands on this one or a compaction's patch left the history, and 409
 *   `{ error, revision }` when `revision` is not the current token. The body is read after authentication
 *   and capped at 64 KiB.
 * - `POST /api/memory/structured/:characterId/:chatId/page-tools` `{ revision, tool }`: one person's tool over a page
 *   as a whole (`StructuredMemoryPageTool`, `applyPageTool` in `server/src/prompt/memory/structured/pages.ts`): to the
 *   trash and back, deleted for good, merged into another page of its type, split into two, renamed, or given a
 *   replacement alias list, or a new note created with one user-corrected section and user naming preserved through
 *   a rebuild. A create has no evidence and a whole-page `create` history entry with no event. The tool is answered
 *   `StructuredMemoryPageToolAnswer` with the page the tab shows next, null after a purge.
 *   A merge moves references in events, threads, and live pages in the same write, which reads the chat's events
 *   and threads; a restored page is flagged against the events as they stand (`flagUnsupportedSections`). A tool that
 *   changes nothing, a trash of a trashed page or a restore of a live one, still names a revision. 400 for a malformed
 *   tool or one the pages refuse (the scene page, a trashed page in a merge, split, rename, or alias edit, two types, a
 *   joined section or a page past its limit, a title or alias another live page of the type goes by). A create also
 *   refuses 400 while `chatAdoptionHold` waits for a choice on HypaV3 summaries, so creating a page cannot silently
 *   clear that choice. This check and the write share the synchronous step after the epoch and fence checks.
 *   404 `chatGone` or `recordGone`, 409 `{ error, reason: "fenced" }` while `fenced` holds, and 409 `{ error, revision }` when
 *   `revision` is not the current token. The body is read after authentication and capped at 64 KiB.
 * - `POST /api/memory/structured/:characterId/:chatId/import` `{ revision, files: { path, text }[] }`: gives a chat the
 *   records of a Markdown package the tab unzipped, answered `StructuredMemoryImportAnswer`. The files are read back by
 *   the package's grammar (`server/src/prompt/memory/structured/importPackage.ts`), each record's shape by
 *   `parseRestoredRecords` in `server/src/prompt/memory/structured/restore.ts`, and what a file gets wrong refuses that
 *   file, or one event of the timeline, and is listed; what stands goes in one write at the client's `revision`. From
 *   parsing through the epoch, fence, and emptiness checks to that write there is no await, so another request cannot
 *   enter between admission and the write. Like a restore it takes only a chat with no row of any kind, trash and runs
 *   included, and not one that waits for a choice on its HypaV3 summaries (`chatAdoptionHold`): those, and files with
 *   no record, answer `imported: false` and write nothing. Add-only import is refused because copies keep ids
 *   (`server/src/prompt/memory/structured/inherit.ts`): accepting a page beside a refused, different event of the same
 *   id would bind them. Importing even one page into a held chat would also clear its adoption hold without a choice.
 *   400 for a body of another shape or a record the store refuses, 404 `chatGone`, 409 `{ error, reason: "fenced" }`
 *   while `fenced` holds, and 409 `{ error, revision }` when `revision` is not the current token. The body is read
 *   after authentication and capped at `restoreBodyBytes`, 413 past it.
 * - `POST /api/memory/structured/:characterId/:chatId/inherit` `{ sourceChatId }`: gives a copied or
 *   branched chat the records of the character's chat it came from, as far as its messages support them
 *   (`structured/inherit.ts`), answered `StructuredMemoryInheritAnswer`. The server builds them from the
 *   source chat, whose runs stay behind, and the tab sends no record. After the record write, the server
 *   copies chapters whose events all crossed and are unclaimed in the target. This is best effort.
 *   A target that already holds a memory record, trash included, answers `inherited: false` and writes nothing.
 *   This target-row check precedes reading the source chat: a repeat answers 200 `inherited: false`
 *   even when the source is gone, while an empty target with a missing source answers 404 `chatGone`.
 *   A source's decline of adoption crosses in the write that takes its records, also with no record to take,
 *   so a copy of a declined chat is not held; a repeat finds it there and writes nothing. `inherited` says
 *   whether records crossed: a source that holds no page, event, or thread answers false, and so does one
 *   the new chat's messages support none of. 400 for a `sourceChatId` that is no id or is the chat itself,
 *   404 `chatGone` for either chat, and 409 `{ error, reason: "fenced" }` while `fenced` holds for the new
 *   chat. The source chat is not fenced. The body is read after authentication and capped at 64 KiB.
 * - `POST /api/memory/structured/:characterId/:chatId/restore` `{ pages, events, threads }`: gives an
 *   imported chat the records its file held, answered `StructuredMemoryRestoreAnswer`. It is the one route
 *   beside the import that writes records the tab sent, so it takes only their whole shape
 *   (`structured/restore.ts`) and only a chat with no rows: a chat that holds a row of any kind, trash and
 *   runs included, and a request with no record answer `restored: false` and write nothing. Sources are not
 *   compared with the chat's messages, and a run never gets through. No decline is in a file, and a decline
 *   the chat holds stays. 400 for a body of another shape or a record the store refuses, 404 `chatGone`, and
 *   409 `{ error, reason: "fenced" }` while `fenced` holds. The body is read after authentication and capped
 *   at `restoreBodyBytes`, 413 past it.
 * - `POST /api/memory/structured/:characterId/:chatId/adopt`, with no body: turns the summaries of the
 *   chat's stored `hypaV3Data` into events, with no model call (`structured/adopt.ts`), answered
 *   `StructuredMemoryAdoptAnswer`. The server reads the chat as stored, and the tab sends nothing. It
 *   writes no run and leaves `hypaV3Data` as it is. A chat that holds a page, event, or thread, which is
 *   what a repeat finds, one that declined, and one with nothing adoptable answer `adopted: 0` and write
 *   nothing. Runs do not count, unlike the two routes above: a failed writer run leaves a run row and no
 *   record, so counting one would refuse adoption for good, and a pending run's task is what the fence
 *   holds off. 404 `chatGone`, and 409 `{ error, reason: "fenced" }` while `fenced` holds.
 * - `POST /api/memory/structured/:characterId/:chatId/decline`, with no body: a person's lasting no to
 *   adopting the chat's stored summaries, so the writer starts from the oldest turn, answered
 *   `StructuredMemoryDeclineAnswer`. Only a chat that waits for that choice (`chatAdoptionHold`) writes,
 *   and the write moves the memory revision; any other answers `declined: false` and writes nothing, which
 *   is what a repeat finds. 404 `chatGone`, and 409 `{ error, reason: "fenced" }` while `fenced` holds.
 * - `POST /api/memory/structured/:characterId/:chatId/reset-summaries`, with no body: empties the stored
 *   `hypaV3Data` of an adopted chat, answered `StructuredMemoryResetAnswer`, so a whole read overlays the
 *   projection from then on. It takes a chat that has not declined, holds an event adopted from the
 *   summaries or rebuilt over one, and holds real summaries (`resettable`, which the contents route
 *   answers too); any other answers `reset: false` and writes nothing. A chat write at the chat's stored revision, unlike every
 *   other route here, so the change feed publishes it and other tabs let their held summaries go; the
 *   memory revision stays. 404 `chatGone`, and 409 `{ error, reason: "fenced" }` while `fenced` holds.
 * - `GET /api/memory/structured/:characterId/:chatId/cost?mode=rebuild|backfill|record&turns=1|2&through=ID`:
 *   what a rebuild, a backfill, or a press of record now through `through` would cost, reading only,
 *   answered `StructuredMemoryCostAnswer`: an estimate, because a route has no job scope to reach a real
 *   tokenizer. A backfill with `omitUserMessages` on also answers `folds`, an upper bound on uncited user
 *   messages it may attach to live events, counted by stored status without hashing or reconciliation.
 *   400 for another `mode` or `turns` or a `through` that is no id, 404 `chatGone`.
 * - `GET /api/memory/structured/default-prompts`: the writer's default analysis and patch frames as stored
 *   text, with their slots in place and no preset text, and the texts of each call's `format` and `rules`
 *   slots, answered `StructuredMemoryDefaultPromptsAnswer` (`structured/prompts.ts`). It names no chat and
 *   reads no store.
 * - `POST /api/memory/structured/:characterId/:chatId/rebuild/abandon`, with no body: ends the chat's
 *   rebuild with nothing written live, whatever stopped it, a hold and the memory toggle included,
 *   answered `StructuredMemoryAbandonAnswer`: the chat's task is cancelled and the run and what it staged
 *   go, and the memory revision stays. A chat with no run, which is what a repeat finds, answers
 *   `abandoned: false` and cancels nothing. 404 `chatGone`, and 409 `{ error, reason: "fenced" }` while a
 *   job holds the chat (`chatHeld`).
 *
 * All are authenticated, rate-limited, and epoch-checked (412 `EpochMismatch`); 400 for an id that is
 * not a resource id, 503 (`Retry-After`) when the store is closed. Read-route ids and cursors are
 * checked before the epoch. The app makes every answer `no-store` and refuses them during shutdown.
 * The epoch check and the store reads run in one synchronous step, so a round is one snapshot;
 * separate rounds are tied together only by `revision`.
 * An edit's, a revert's, a page tool's, an import's, an inherit's, a restore's, an adoption's, a decline's,
 * a reset's, a chapter removal's, or an abandon's checks and its write share one such step too, after any
 * body is read, so nothing can take the chat between the fence and the write, and no writer of the source
 * chat comes between its reads. The fence covers a rebuild's run too, also while a stopped one waits.
 */
export function registerStructuredMemoryRoutes(
    app: Hono<AppEnv>,
    arg: {
        store: ResourceStore;
        maintenance: MaintenanceGate;
        kinds: ResourceKindRegistry;
        auth: AuthStore;
        limiter: MiddlewareHandler<AppEnv>;
        packageRoundBytes: number;
        /** The cap of a restore's body, which holds at once what rounds read one at a time. */
        restoreBodyBytes: number;
        /**
         * Whether something that can write this chat's memory holds the chat, which refuses an edit, a
         * revert, a page tool, an import, an inherit, a restore, an adoption, a decline, a reset or a chapter
         * removal: its task, a job, or its rebuild's run.
         */
        fenced: (characterId: string, chatId: string) => boolean;
        /** Whether a job holds the chat: the one thing that refuses abandoning its rebuild. */
        chatHeld: (characterId: string, chatId: string) => boolean;
        /** Ends the chat's queued and running task, so nothing writes a run that is going. */
        cancelTask: (characterId: string, chatId: string) => void;
    },
) {
    const {
        store,
        maintenance,
        kinds,
        auth,
        limiter,
        packageRoundBytes,
        restoreBodyBytes,
        fenced,
        chatHeld,
        cancelTask,
    } = arg;
    const limitBody = limitedBody(MAX_EDIT_BODY_BYTES);
    const limitRevisionsBody = limitedBody(MAX_REVISIONS_BODY_BYTES);
    const limitRestoreBody = limitedBody(restoreBodyBytes);
    const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        await next();
    };

    app.get(`${STRUCTURED_MEMORY_PATH}/default-prompts`, limiter, authenticated, (c) => {
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        return compressedJson(c, defaultPrompts() satisfies StructuredMemoryDefaultPromptsAnswer);
    });

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId`, limiter, authenticated, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            }
            const { adoptionDeclined, ...listed } = contents;
            const recorded = contents.runs.findLast(({ result }) => result === "recorded");
            const health = store.memory.readHealth([{ characterId, chatId }], MEMORY_HEALTH_ROUND_BYTES)[0]!;
            return compressedJson(c, {
                ...listed,
                adoption: {
                    adoptable: chatAdoptionHold(store, characterId, chatId, contents),
                    declined: adoptionDeclined === true,
                    resettable: resettable(characterId, chatId, contents),
                },
                rebuild: store.memory.rebuild.status(characterId, chatId),
                recordedLanguage: (recorded && listedRecord(characterId, chatId, "runs", recorded.id).language) ?? null,
                health,
                unsupportedPages:
                    health === "unavailable" ? [] : store.memory.readUnsupportedPages(characterId, chatId),
                writerBlockingReason: writerBlockingReason(store, kinds, characterId, chatId),
            } satisfies StructuredMemoryContentsAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/records/:kind/:id`, limiter, authenticated, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        const kind = c.req.param("kind");
        const id = c.req.param("id");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId) || !isValidResourceId(id)) {
            return c.json({ error: "characterId, chatId, and id must be ids" }, 400);
        }
        if (!isRecordKind(kind)) {
            return c.json({ error: `kind must be one of ${MEMORY_RECORD_KINDS.join(", ")}` }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const record = store.memory.readRecord(characterId, chatId, kind, id);
            if (!record) {
                const reason = store.chatRevision(characterId, chatId) === null ? "chatGone" : "recordGone";
                return c.json({ error: REFUSAL_TEXT[reason], reason }, 404);
            }
            return compressedJson(c, record satisfies StructuredMemoryRecordAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    /** A record the chat's contents list, read in the same synchronous step as them, so nothing can remove it. */
    const listedRecord = <K extends StructuredMemoryRecordKind>(
        characterId: string,
        chatId: string,
        kind: K,
        id: string,
    ): StructuredMemoryRecordOf[K] => {
        const record = store.memory.readRecord(characterId, chatId, kind, id);
        if (!record) {
            throw new Error(`Memory ${kind} ${JSON.stringify(id)} is listed but has no row`);
        }
        return record.data;
    };

    /**
     * Whether a reset may empty the chat's stored `hypaV3Data`, for the reset route and the contents route
     * alike: the chat has not declined, an event came from adopting it, or from a rebuild over one that did,
     * and it holds real summaries. An event's body is read last, and only for a chat that holds such a value.
     */
    const resettable = (characterId: string, chatId: string, contents: MemoryContents): boolean => {
        if (contents.adoptionDeclined || contents.events.length === 0) {
            return false;
        }
        const data = store.chatMeta(characterId, chatId)?.data.hypaV3Data;
        return (
            hypaV3DataHoldsSummaries(data) &&
            !isSealedHypaV3Data(data) &&
            contents.events.some(({ id }) => {
                const { writerRun, adoptedSummaries } = listedRecord(characterId, chatId, "events", id);
                return writerRun === ADOPTED_WRITER_RUN || adoptedSummaries === true;
            })
        );
    };

    /**
     * Answers one round of a budgeted read: the checks every such route shares, then `answer`, in one
     * synchronous step.
     */
    const answerRound = async (c: Context<AppEnv>, answer: (round: RoundRead) => object) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const cursor = parseCursor(c.req.query("cursor"));
        if (cursor === null) {
            return c.json({ error: "cursor must be a non-negative integer" }, 400);
        }
        const revision = c.req.query("revision");
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const currentRevision = store.memory.readRevision(characterId, chatId);
            if (currentRevision === null) {
                return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            }
            if (revision !== undefined && revision !== currentRevision) {
                return c.json({ error: "The chat's memory changed", revision: currentRevision }, 409);
            }
            const read: RoundRead["read"] = (kind, id) => listedRecord(characterId, chatId, kind, id);
            return compressedJson(c, answer({ characterId, chatId, revision: currentRevision, cursor, read }));
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    };

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/package`, limiter, authenticated, (c) =>
        answerRound(c, ({ characterId, chatId, revision, cursor, read }) => {
            const contents = store.memory.readKinds(characterId, chatId, ["pages", "events"])!;
            const listed = [
                ...contents.pages.map(({ id, bytes }) => ({ kind: "pages", id, bytes }) as const),
                ...contents.events.map(({ id, bytes }) => ({ kind: "events", id, bytes }) as const),
            ];
            const { rows, next } = roundOf(listed, cursor, packageRoundBytes);
            const pages: MemoryPage[] = [];
            const events: MemoryEvent[] = [];
            for (const { kind, id } of rows) {
                if (kind === "pages") {
                    pages.push(read(kind, id));
                } else {
                    events.push(read(kind, id));
                }
            }
            return { revision, pages, events, next } satisfies StructuredMemoryPackageRound;
        }),
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/coverage`, limiter, authenticated, (c) =>
        answerRound(c, ({ characterId, chatId, revision, cursor, read }) => {
            const contents = store.memory.readKinds(characterId, chatId, ["events", "runs"])!;
            const listed = [
                ...contents.events.map(({ id, bytes }) => ({ kind: "events", id, bytes }) as const),
                ...contents.runs
                    .filter(({ result }) => result !== "recorded")
                    .map(({ id, bytes }) => ({ kind: "runs", id, bytes }) as const),
            ];
            const { rows, next } = roundOf(listed, cursor, packageRoundBytes);
            const events: StructuredMemoryCoverageEvent[] = [];
            const runs: StructuredMemoryCoverageRun[] = [];
            for (const { kind, id } of rows) {
                if (kind === "events") {
                    const {
                        title,
                        status,
                        staleReason,
                        suppressed,
                        keptState,
                        rerecord,
                        sources,
                        greeting,
                        greetingKept,
                    } = read(kind, id);
                    events.push({
                        id,
                        title,
                        status,
                        staleReason,
                        suppressed,
                        keptState,
                        rerecord,
                        messageIds: sourceIds(sources),
                        sourceIndex: firstSourceIndex(sources, undefined, greeting),
                        sources: storedMemorySources(sources),
                        ...(storedMemoryGreeting(greeting) ? { greeting: storedMemoryGreeting(greeting)! } : {}),
                        ...(storedMemoryGreeting(greetingKept)
                            ? { greetingKept: storedMemoryGreeting(greetingKept)! }
                            : {}),
                    });
                } else {
                    const { result, reason, receipt, window, greeting } = read(kind, id);
                    runs.push({
                        id,
                        result,
                        reason: reason ?? receipt?.reason,
                        messageIds: sourceIds(window),
                        ...(storedMemoryGreeting(greeting) ? { greeting: true as const } : {}),
                    });
                }
            }
            return { revision, events, runs, next } satisfies StructuredMemoryCoverageRound;
        }),
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/story`, limiter, authenticated, (c) =>
        answerRound(c, ({ characterId, chatId, revision, cursor, read }) => {
            const listed = store.memory.readKinds(characterId, chatId, ["events"])!.events.map(({ id, bytes }) => ({
                id,
                bytes,
            }));
            const { rows, next } = roundOf(listed, cursor, packageRoundBytes);
            const events: StructuredMemoryStoryEvent[] = [];
            for (const row of rows) {
                const { id, summary, storyTime, participants, grade } = read("events", row.id);
                events.push({ id, summary, storyTime, participants, ...(grade === undefined ? {} : { grade }) });
            }
            return { revision, events, next } satisfies StructuredMemoryStoryRound;
        }),
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/find`, limiter, authenticated, (c) => {
        const q = c.req.query("q");
        const page = c.req.query("page");
        if ((q === undefined) === (page === undefined)) {
            return c.json({ error: "Exactly one of q and page is required" }, 400);
        }
        const trimmed = q?.trim();
        if (trimmed !== undefined && (trimmed.length === 0 || trimmed.length > MEMORY_FIND_QUERY_CHARS)) {
            return c.json({ error: `q must have 1 to ${MEMORY_FIND_QUERY_CHARS} characters` }, 400);
        }
        if (page !== undefined && !isValidResourceId(page)) {
            return c.json({ error: "page must be an id" }, 400);
        }
        const query: { q: string } | { page: string } =
            trimmed !== undefined ? { q: lowerFindText(trimmed).text } : { page: page! };
        return answerRound(c, ({ characterId, chatId, revision, cursor, read }) => {
            const contents = store.memory.readKinds(
                characterId,
                chatId,
                "q" in query ? ["pages", "events"] : ["events", "threads"],
            )!;
            const listed = [
                ...contents.pages.map(({ id, bytes }) => ({ kind: "pages", id, bytes }) as const),
                ...contents.events
                    .filter(({ status }) => status !== "retracted")
                    .map(({ id, bytes }) => ({ kind: "events", id, bytes }) as const),
                ...contents.threads.map(({ id, bytes }) => ({ kind: "threads", id, bytes }) as const),
            ];
            // Recording indexes survive prefix deletions; page recency follows the messages still here.
            const positions = "page" in query ? new Map<string, number>() : undefined;
            if (positions) {
                const chat = store.readChatSource(characterId, chatId).data as Chat;
                chat.message.forEach(({ chatId: messageId }, index) => {
                    if (messageId !== undefined) positions.set(messageId, index);
                });
            }
            const round = roundOf(listed, cursor, packageRoundBytes);
            let next = round.next;
            const hits: StructuredMemoryFindHit[] = [];
            for (let index = 0; index < round.rows.length; index += 1) {
                const { kind, id } = round.rows[index];
                const record = read(kind, id);
                hits.push(
                    ...(kind === "threads"
                        ? "page" in query
                            ? findThreadHits(id, record, query.page)
                            : []
                        : kind === "pages" && "q" in query
                          ? findPageHits(id, record, query.q)
                          : findEventHits(id, record, query, positions)),
                );
                if (hits.length >= MEMORY_FIND_HITS_MAX) {
                    const following = cursor + index + 1;
                    next = following < listed.length ? following : null;
                    break;
                }
            }
            return { revision, hits, next } satisfies StructuredMemoryFindRound;
        });
    });

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/runs`, limiter, authenticated, (c) =>
        answerRound(c, ({ characterId, chatId, revision, cursor, read }) => {
            const { rows, next } = store.memory.readKindPage(characterId, chatId, "runs", {
                cursor,
                direction: "desc",
                byteBudget: packageRoundBytes,
                rowCap: MEMORY_RUNS_ROUND_ROWS,
            })!;
            const runs = rows.map(({ id }): StructuredMemoryLogRun => {
                const { input, settingsFingerprint, ...logged } = read("runs", id);
                return logged;
            });
            return {
                revision,
                total: store.memory.countKind(characterId, chatId, "runs")!,
                runs,
                next,
            } satisfies StructuredMemoryRunsRound;
        }),
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/threads`, limiter, authenticated, (c) =>
        answerRound(c, ({ characterId, chatId, revision, cursor, read }) => {
            const { rows, next } = store.memory.readKindPage(characterId, chatId, "threads", {
                cursor,
                direction: "asc",
                byteBudget: packageRoundBytes,
            })!;
            return {
                revision,
                threads: rows.map(({ id }) => read("threads", id)),
                next,
            } satisfies StructuredMemoryThreadsRound;
        }),
    );

    app.post(`${STRUCTURED_MEMORY_PATH}/revisions`, limiter, authenticated, limitRevisionsBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const refs = parseChatRefs(read.body, MEMORY_REVISION_CHATS_MAX);
        if (!refs) {
            return c.json(
                { error: `chats must be at most ${MEMORY_REVISION_CHATS_MAX} { characterId, chatId } ids` },
                400,
            );
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            return compressedJson(c, {
                revisions: store.memory.readProjectionRevisions(refs),
            } satisfies StructuredMemoryRevisionsAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.post(`${STRUCTURED_MEMORY_PATH}/health`, limiter, authenticated, limitRevisionsBody, async (c) => {
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        const refs = parseChatRefs(read.body, MEMORY_HEALTH_CHATS_MAX);
        if (!refs) {
            return c.json(
                { error: `chats must be at most ${MEMORY_HEALTH_CHATS_MAX} { characterId, chatId } ids` },
                400,
            );
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            return compressedJson(c, {
                health: store.memory.readHealth(refs, MEMORY_HEALTH_ROUND_BYTES),
            } satisfies StructuredMemoryHealthAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/projection`, limiter, authenticated, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const projection = store.memory.readProjection(characterId, chatId, packageRoundBytes);
            if (!projection) {
                return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            }
            if (projection === "tooLarge") {
                return c.json({ error: REFUSAL_TEXT.tooLarge, reason: "tooLarge" }, 413);
            }
            return compressedJson(c, {
                revision: projection.revision,
                hypaV3Data: projection.data,
            } satisfies StructuredMemoryProjectionAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/chapters`, limiter, authenticated, (c) => {
        const { characterId, chatId } = c.req.param();
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const listed = store.memory.chapters.list(characterId, chatId, packageRoundBytes);
            if (listed === null) return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            if (listed === "tooLarge") return c.json({ error: REFUSAL_TEXT.chaptersTooLarge, reason: "tooLarge" }, 413);
            return compressedJson(c, listed satisfies StructuredMemoryChaptersAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/chapters/cost`, limiter, authenticated, (c) => {
        const { characterId, chatId } = c.req.param();
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const units = chapterUnits(store, { chaId: characterId, chatId });
            if (units === null) return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            return compressedJson(c, { units: units.length } satisfies StructuredMemoryChapterCostAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.post(
        `${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/chapters/remove`,
        limiter,
        authenticated,
        limitBody,
        async (c) => {
            const { characterId, chatId } = c.req.param();
            if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
                return c.json({ error: "characterId and chatId must be ids" }, 400);
            }
            const read = await readJsonBody(c);
            if (!read.ok) return read.response;
            const ids = isPlainObject(read.body) ? read.body.ids : undefined;
            if (
                !Array.isArray(ids) ||
                ids.length === 0 ||
                ids.length > MAX_CHAPTER_REMOVE_IDS ||
                !ids.every(isValidResourceId)
            ) {
                return c.json({ error: REFUSAL_TEXT.chapterIds }, 400);
            }
            const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
            if (epoch !== store.epoch()) return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
            if (fenced(characterId, chatId)) return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
            try {
                maintenance.assertOpen();
                const removed = store.memory.chapters.remove(characterId, chatId, epoch, ids);
                if (removed === null) return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                return compressedJson(c, { removed } satisfies StructuredMemoryChapterRemoveAnswer);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        },
    );

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/edits`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const { revision } = read.body;
        if (typeof revision !== "string") {
            return c.json({ error: "revision must be a string" }, 400);
        }
        const edit = parseMemoryEdit(read.body.edit);
        if (!edit || !isValidResourceId(editedRecordId(edit))) {
            return c.json({ error: "edit is not a valid memory edit" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        const gone = () => {
            const reason = store.chatRevision(characterId, chatId) === null ? "chatGone" : "recordGone";
            return c.json({ error: REFUSAL_TEXT[reason], reason }, 404);
        };
        const options = { epoch, baseRevision: revision };
        try {
            maintenance.assertOpen();
            if (edit.kind === "thread") {
                const stored = store.memory.readRecord(characterId, chatId, "threads", edit.threadId);
                if (!stored) {
                    return gone();
                }
                const edited = applyThreadEdit(stored.data, edit);
                const written = store.memory.write(characterId, chatId, options, edited ? { threads: [edited] } : {});
                return compressedJson(c, {
                    revision: written,
                    kind: "threads",
                    data: edited ?? stored.data,
                } satisfies StructuredMemoryEditAnswer);
            }
            if (edit.kind === "event") {
                const stored = store.memory.readRecord(characterId, chatId, "events", edit.eventId);
                if (!stored) {
                    return gone();
                }
                let messages: readonly Message[] = [];
                let currentGreeting: MemoryGreetingSource | null = null;
                if (edit.repair !== "retract") {
                    const chat = store.readChatSource(characterId, chatId).data as Chat | null;
                    if (!chat) {
                        return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                    }
                    messages = chat.message;
                    const owner = store.get(kinds.get(RESOURCE_KIND.characters)!, characterId)?.data as
                        character | groupChat | undefined;
                    currentGreeting = writerGreeting(owner, chat)?.source ?? null;
                }
                const edited = applyEventRepair(
                    stored.data,
                    edit,
                    messages,
                    messageSourceHash,
                    currentGreeting !== null,
                    currentGreeting,
                );
                const written = store.memory.write(
                    characterId,
                    chatId,
                    options,
                    edited ? withRetractedEvidence(store, { chaId: characterId, chatId }, { events: [edited] }) : {},
                );
                return compressedJson(c, {
                    revision: written,
                    kind: "events",
                    data: edited ?? stored.data,
                } satisfies StructuredMemoryEditAnswer);
            }
            if (edit.kind === "eventText" || edit.kind === "eventRelease") {
                const stored = store.memory.readRecord(characterId, chatId, "events", edit.eventId);
                if (!stored) {
                    return gone();
                }
                const edited =
                    edit.kind === "eventText" ? applyEventText(stored.data, edit) : applyEventRelease(stored.data);
                const written = store.memory.write(characterId, chatId, options, edited ? { events: [edited] } : {});
                return compressedJson(c, {
                    revision: written,
                    kind: "events",
                    data: edited ?? stored.data,
                } satisfies StructuredMemoryEditAnswer);
            }
            const stored = store.memory.readRecord(characterId, chatId, "pages", edit.pageId);
            if (!stored) {
                return gone();
            }
            if (stored.data.trashedAt !== undefined) {
                return c.json({ error: REFUSAL_TEXT.trashed }, 400);
            }
            const events = edit.kind === "sectionKeep" ? store.memory.readContents(characterId, chatId)!.events : [];
            const edited = applyPageEdit(stored.data, edit, { now: Date.now(), newId: randomUUID }, events);
            const written = store.memory.write(characterId, chatId, options, edited ? { pages: [edited] } : {});
            return compressedJson(c, {
                revision: written,
                kind: "pages",
                data: edited ?? stored.data,
            } satisfies StructuredMemoryEditAnswer);
        } catch (error) {
            if (error instanceof MemoryEditRefusal) {
                if (error.reason === "changed") {
                    return c.json({ error: error.message, reason: "changed" }, 409);
                }
                return error.reason === "sectionGone" ? gone() : c.json({ error: error.message }, 400);
            }
            return storeErrorResponse(c, error);
        }
    });

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/revert`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const { revision, pageId, historyId } = read.body;
        if (typeof revision !== "string") {
            return c.json({ error: "revision must be a string" }, 400);
        }
        if (!isValidResourceId(pageId) || !isValidResourceId(historyId)) {
            return c.json({ error: "pageId and historyId must be ids" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        const gone = () => {
            const reason = store.chatRevision(characterId, chatId) === null ? "chatGone" : "recordGone";
            return c.json({ error: REFUSAL_TEXT[reason], reason }, 404);
        };
        const options = { epoch, baseRevision: revision };
        try {
            maintenance.assertOpen();
            const contents = store.memory.readContents(characterId, chatId);
            const stored = store.memory.readRecord(characterId, chatId, "pages", pageId);
            if (!contents || !stored) {
                return gone();
            }
            if (stored.data.trashedAt !== undefined) {
                return c.json({ error: REFUSAL_TEXT.trashed }, 400);
            }
            const undone = revertChange(stored.data, historyId, { now: Date.now(), newId: randomUUID });
            if (!undone) {
                return compressedJson(c, {
                    revision: store.memory.write(characterId, chatId, options, {}),
                    data: stored.data,
                    reverted: false,
                    laterEvents: 0,
                } satisfies StructuredMemoryRevertAnswer);
            }
            const [flagged = undone.page] = flagUnsupportedSections([undone.page], contents.events);
            return compressedJson(c, {
                revision: store.memory.write(characterId, chatId, options, { pages: [flagged] }),
                data: flagged,
                reverted: true,
                laterEvents: laterEventCount(contents.events, undone.eventId),
            } satisfies StructuredMemoryRevertAnswer);
        } catch (error) {
            if (error instanceof MemoryRevertRefusal) {
                if (error.reason === "superseded") {
                    return c.json({ error: error.message, reason: "superseded" }, 409);
                }
                return error.reason === "gone" ? gone() : c.json({ error: error.message }, 400);
            }
            return storeErrorResponse(c, error);
        }
    });

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/inherit`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const read = await readJsonBody(c);
        if (!read.ok) {
            return read.response;
        }
        if (!isPlainObject(read.body)) {
            return c.json({ error: "The body must be an object" }, 400);
        }
        const { sourceChatId } = read.body;
        if (!isValidResourceId(sourceChatId) || sourceChatId === chatId) {
            return c.json({ error: "sourceChatId must be the id of another chat" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        const gone = () => c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
        try {
            maintenance.assertOpen();
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return gone();
            }
            const { revision } = contents;
            const nothingToBuild = { revision, inherited: false } satisfies StructuredMemoryInheritAnswer;
            if (holdsRows(contents)) {
                return compressedJson(c, nothingToBuild);
            }
            const source = store.memory.readContents(characterId, sourceChatId);
            if (!source) {
                return gone();
            }
            // Empty unless the source declined: a change set naming nothing writes nothing.
            const declined = source.adoptionDeclined ? { adoptionDeclined: source.adoptionDeclined } : {};
            const options = { epoch, baseRevision: revision };
            if ([source.pages, source.events, source.threads].every(({ length }) => length === 0)) {
                return compressedJson(c, {
                    revision: store.memory.write(characterId, chatId, options, declined),
                    inherited: false,
                } satisfies StructuredMemoryInheritAnswer);
            }
            const sourceChat = store.readChatSource(characterId, sourceChatId).data as Chat | null;
            const chat = store.readChatSource(characterId, chatId).data as Chat | null;
            if (!sourceChat || !chat) {
                return gone();
            }
            const changes = inheritedRecords({
                pages: source.pages.map(({ id }) => listedRecord(characterId, sourceChatId, "pages", id)),
                events: source.events.map(({ id }) => listedRecord(characterId, sourceChatId, "events", id)),
                threads: source.threads.map(({ id }) => listedRecord(characterId, sourceChatId, "threads", id)),
                sourceMessages: sourceChat.message,
                messages: chat.message,
                hashOf: messageSourceHash,
            });
            const writtenRevision = store.memory.write(characterId, chatId, options, { ...changes, ...declined });
            try {
                store.memory.chapters.copy(characterId, sourceChatId, chatId, epoch);
            } catch {
                // The records have committed. A chapter failure leaves the inheritance answer intact.
            }
            return compressedJson(c, {
                revision: writtenRevision,
                inherited: [changes.pages, changes.events, changes.threads].some((list) => list?.length),
            } satisfies StructuredMemoryInheritAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.post(
        `${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/restore`,
        limiter,
        authenticated,
        limitRestoreBody,
        async (c) => {
            const characterId = c.req.param("characterId");
            const chatId = c.req.param("chatId");
            if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
                return c.json({ error: "characterId and chatId must be ids" }, 400);
            }
            const read = await readJsonBody(c);
            if (!read.ok) {
                return read.response;
            }
            const records = parseRestoredRecords(read.body);
            if (!records) {
                return c.json({ error: "The body must hold whole pages, events, and threads" }, 400);
            }
            const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
            if (epoch !== store.epoch()) {
                return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
            }
            if (fenced(characterId, chatId)) {
                return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
            }
            try {
                maintenance.assertOpen();
                const contents = store.memory.readContents(characterId, chatId);
                if (!contents) {
                    return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                }
                const { revision } = contents;
                const { pages, events, threads } = records;
                if (holdsRows(contents) || [pages, events, threads].every(({ length }) => length === 0)) {
                    return compressedJson(c, { revision, restored: false } satisfies StructuredMemoryRestoreAnswer);
                }
                const options = { epoch, baseRevision: revision };
                return compressedJson(c, {
                    revision: store.memory.write(characterId, chatId, options, { pages, events, threads }),
                    restored: true,
                } satisfies StructuredMemoryRestoreAnswer);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        },
    );

    app.post(
        `${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/page-tools`,
        limiter,
        authenticated,
        limitBody,
        async (c) => {
            const characterId = c.req.param("characterId");
            const chatId = c.req.param("chatId");
            if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
                return c.json({ error: "characterId and chatId must be ids" }, 400);
            }
            const read = await readJsonBody(c);
            if (!read.ok) {
                return read.response;
            }
            if (!isPlainObject(read.body)) {
                return c.json({ error: "The body must be an object" }, 400);
            }
            const { revision } = read.body;
            if (typeof revision !== "string") {
                return c.json({ error: "revision must be a string" }, 400);
            }
            const tool = parseMemoryPageTool(read.body.tool);
            if (!tool || !pageToolIds(tool).every(isValidResourceId)) {
                return c.json({ error: "tool is not a valid page tool" }, 400);
            }
            const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
            if (epoch !== store.epoch()) {
                return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
            }
            if (fenced(characterId, chatId)) {
                return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
            }
            const gone = () => {
                const reason = store.chatRevision(characterId, chatId) === null ? "chatGone" : "recordGone";
                return c.json({ error: REFUSAL_TEXT[reason], reason }, 404);
            };
            try {
                maintenance.assertOpen();
                const contents = store.memory.readContents(characterId, chatId);
                if (!contents) {
                    return gone();
                }
                if (tool.kind === "create" && chatAdoptionHold(store, characterId, chatId, contents) > 0) {
                    return c.json(
                        { error: "Choose whether to adopt the HypaV3 summaries before creating a note page" },
                        400,
                    );
                }
                const { changes, shown, flag } = applyPageTool(
                    {
                        page: (id) => store.memory.readRecord(characterId, chatId, "pages", id)?.data,
                        pages: () => contents.pages.map(({ id }) => listedRecord(characterId, chatId, "pages", id)),
                        events: () => contents.events.map(({ id }) => listedRecord(characterId, chatId, "events", id)),
                        threads: () =>
                            contents.threads.map(({ id }) => listedRecord(characterId, chatId, "threads", id)),
                    },
                    tool,
                    { now: Date.now(), newId: randomUUID },
                );
                // A page's standing evidence is checked against the events as they are now.
                const flagged = new Map(
                    flagUnsupportedSections(
                        (changes.pages ?? []).filter(({ id }) => flag.includes(id)),
                        contents.events,
                    ).map((page) => [page.id, page]),
                );
                const pages = changes.pages?.map((page) => flagged.get(page.id) ?? page);
                const written = store.memory.write(
                    characterId,
                    chatId,
                    { epoch, baseRevision: revision },
                    { ...changes, ...(pages ? { pages } : {}) },
                );
                return compressedJson(c, {
                    revision: written,
                    data: shown && (flagged.get(shown.id) ?? shown),
                } satisfies StructuredMemoryPageToolAnswer);
            } catch (error) {
                if (error instanceof MemoryPageToolRefusal) {
                    return error.reason === "gone" ? gone() : c.json({ error: error.message }, 400);
                }
                return storeErrorResponse(c, error);
            }
        },
    );

    app.post(
        `${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/import`,
        limiter,
        authenticated,
        limitRestoreBody,
        async (c) => {
            const characterId = c.req.param("characterId");
            const chatId = c.req.param("chatId");
            if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
                return c.json({ error: "characterId and chatId must be ids" }, 400);
            }
            const read = await readJsonBody(c);
            if (!read.ok) {
                return read.response;
            }
            if (!isPlainObject(read.body)) {
                return c.json({ error: "The body must be an object" }, 400);
            }
            const { revision } = read.body;
            if (typeof revision !== "string") {
                return c.json({ error: "revision must be a string" }, 400);
            }
            const files = parseImportFiles(read.body.files);
            if (!files) {
                return c.json({ error: "files must be a list of { path, text }" }, 400);
            }
            const { refusals, ...records } = parseMemoryPackage(files);
            const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
            if (epoch !== store.epoch()) {
                return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
            }
            if (fenced(characterId, chatId)) {
                return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
            }
            try {
                maintenance.assertOpen();
                const contents = store.memory.readContents(characterId, chatId);
                if (!contents) {
                    return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                }
                const { pages, events, threads } = records;
                if (
                    holdsRows(contents) ||
                    chatAdoptionHold(store, characterId, chatId, contents) > 0 ||
                    [pages, events, threads].every(({ length }) => length === 0)
                ) {
                    return compressedJson(c, {
                        revision: contents.revision,
                        imported: false,
                        refusals,
                    } satisfies StructuredMemoryImportAnswer);
                }
                return compressedJson(c, {
                    revision: store.memory.write(characterId, chatId, { epoch, baseRevision: revision }, records),
                    imported: { pages: pages.length, events: events.length, threads: threads.length },
                    refusals,
                } satisfies StructuredMemoryImportAnswer);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        },
    );

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/adopt`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        const gone = () => c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
        try {
            maintenance.assertOpen();
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return gone();
            }
            const { revision } = contents;
            const nothingAdopted = { revision, adopted: 0, stale: 0 } satisfies StructuredMemoryAdoptAnswer;
            if (
                contents.adoptionDeclined ||
                [contents.pages, contents.events, contents.threads].some(({ length }) => length > 0)
            ) {
                return compressedJson(c, nothingAdopted);
            }
            const chat = store.readChatSource(characterId, chatId).data as Chat | null;
            if (!chat) {
                return gone();
            }
            const owner = store.get(kinds.get(RESOURCE_KIND.characters)!, characterId)?.data as
                character | groupChat | undefined;
            const events = adoptedEvents({
                data: chat.hypaV3Data,
                messages: chat.message,
                greeting: writerGreeting(owner, chat)?.source ?? null,
                hashOf: messageSourceHash,
                newId: randomUUID,
            });
            if (events.length === 0) {
                return compressedJson(c, nothingAdopted);
            }
            return compressedJson(c, {
                revision: store.memory.write(characterId, chatId, { epoch, baseRevision: revision }, { events }),
                adopted: events.length,
                stale: events.filter(({ status }) => status === "stale").length,
            } satisfies StructuredMemoryAdoptAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.post(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/decline`, limiter, authenticated, limitBody, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
        if (epoch !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        if (fenced(characterId, chatId)) {
            return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
        }
        try {
            maintenance.assertOpen();
            const contents = store.memory.readContents(characterId, chatId);
            if (!contents) {
                return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            }
            const { revision } = contents;
            if (chatAdoptionHold(store, characterId, chatId, contents) === 0) {
                return compressedJson(c, { revision, declined: false } satisfies StructuredMemoryDeclineAnswer);
            }
            const options = { epoch, baseRevision: revision };
            return compressedJson(c, {
                revision: store.memory.write(characterId, chatId, options, { adoptionDeclined: true }),
                declined: true,
            } satisfies StructuredMemoryDeclineAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.post(
        `${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/reset-summaries`,
        limiter,
        authenticated,
        limitBody,
        async (c) => {
            const characterId = c.req.param("characterId");
            const chatId = c.req.param("chatId");
            if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
                return c.json({ error: "characterId and chatId must be ids" }, 400);
            }
            const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
            if (epoch !== store.epoch()) {
                return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
            }
            if (fenced(characterId, chatId)) {
                return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
            }
            try {
                maintenance.assertOpen();
                const contents = store.memory.readContents(characterId, chatId);
                const chatRevision = store.chatRevision(characterId, chatId);
                if (!contents || chatRevision === null) {
                    return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                }
                if (!resettable(characterId, chatId, contents)) {
                    return compressedJson(c, { chatRevision, reset: false } satisfies StructuredMemoryResetAnswer);
                }
                const { chats } = store.applyChanges(
                    {
                        chats: [
                            {
                                characterId,
                                chatId,
                                baseRevision: chatRevision,
                                ops: [{ op: "meta", unset: ["hypaV3Data"] }],
                            },
                        ],
                    },
                    { epoch },
                );
                return compressedJson(c, {
                    chatRevision: chats[0].revision ?? chatRevision,
                    reset: true,
                } satisfies StructuredMemoryResetAnswer);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        },
    );

    app.get(`${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/cost`, limiter, authenticated, async (c) => {
        const characterId = c.req.param("characterId");
        const chatId = c.req.param("chatId");
        if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
            return c.json({ error: "characterId and chatId must be ids" }, 400);
        }
        const mode = c.req.query("mode");
        const turns = c.req.query("turns");
        const through = c.req.query("through");
        if (!isCostMode(mode) || (turns !== "1" && turns !== "2")) {
            return c.json({ error: "mode must be rebuild, backfill, or record, and turns 1 or 2" }, 400);
        }
        if (through !== undefined && !isValidResourceId(through)) {
            return c.json({ error: "through must be an id" }, 400);
        }
        if (c.req.header(RESOURCE_EPOCH_HEADER) !== store.epoch()) {
            return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
        }
        try {
            const cost = await memoryWorkCost(
                store,
                { chaId: characterId, chatId },
                { mode, turns: turns === "1" ? 1 : 2, ...(through !== undefined ? { through } : {}) },
                kinds.get(RESOURCE_KIND.characters)!,
            );
            if (!cost) {
                return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
            }
            return compressedJson(c, cost satisfies StructuredMemoryCostAnswer);
        } catch (error) {
            return storeErrorResponse(c, error);
        }
    });

    app.post(
        `${STRUCTURED_MEMORY_PATH}/:characterId/:chatId/rebuild/abandon`,
        limiter,
        authenticated,
        limitBody,
        async (c) => {
            const characterId = c.req.param("characterId");
            const chatId = c.req.param("chatId");
            if (!isValidResourceId(characterId) || !isValidResourceId(chatId)) {
                return c.json({ error: "characterId and chatId must be ids" }, 400);
            }
            const epoch = c.req.header(RESOURCE_EPOCH_HEADER);
            if (epoch !== store.epoch()) {
                return c.json({ error: "EpochMismatch", epoch: store.epoch() }, 412);
            }
            if (chatHeld(characterId, chatId)) {
                return c.json({ error: REFUSAL_TEXT.fenced, reason: "fenced" }, 409);
            }
            try {
                maintenance.assertOpen();
                const contents = store.memory.readContents(characterId, chatId);
                if (!contents) {
                    return c.json({ error: REFUSAL_TEXT.chatGone, reason: "chatGone" }, 404);
                }
                const { revision } = contents;
                if (!store.memory.rebuild.status(characterId, chatId)) {
                    return compressedJson(c, { revision, abandoned: false } satisfies StructuredMemoryAbandonAnswer);
                }
                cancelTask(characterId, chatId);
                return compressedJson(c, {
                    revision,
                    abandoned: store.memory.rebuild.abandon(characterId, chatId, epoch),
                } satisfies StructuredMemoryAbandonAnswer);
            } catch (error) {
                return storeErrorResponse(c, error);
            }
        },
    );
}
