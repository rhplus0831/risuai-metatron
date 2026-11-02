import { createHash } from "node:crypto";
import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { Message } from "../../../../../shared/database.ts";
import {
    type MemoryEvent,
    type MemoryHistoryChangeKind,
    type MemoryHistorySnapshot,
    type MemoryPage,
    type MemoryPageCandidate,
    type MemoryPageHistoryEntry,
    type MemoryPageType,
    type MemoryReceipt,
    type MemorySceneDraft,
    type MemorySection,
    type MemorySource,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    type StructuredMemoryHighlightKind,
    type StructuredMemoryHighlightMode,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import type { EditStamp } from "./edits.ts";

/**
 * What the writer does to a chat's pages, without any I/O: the pages its prompt lists, what becomes of a
 * model's page candidates, and the changes one commit gathers. What the patch call may do to a section
 * is in `patches.ts`.
 *
 * - Names: a name key is a name trimmed and lower-cased. A title and an alias match by whole key against
 *   a create, and as a substring of a window's messages for the cast.
 * - Seeds: lore entries and group members tie names together, but only code reads them and they never
 *   stand in for a model's confidence. A lore entry matches on its name alone: an entry named "Rivals"
 *   and keyed `Alice,Bob` says nothing about Alice and Bob being one subject.
 * - Aliases on an existing page are the user's: a create that matches a page adds none to it.
 * - The scene page is code's: no candidate reaches it, and only `rewriteScene` writes it. Its sections
 *   are independent facts, so a lock skips one section and not the rest.
 * - A writer may replace a `userCorrected` section, because the lock is the only hard guarantee. A change
 *   that really replaces the text clears the mark, the words being no longer a person's, and is always
 *   highlighted. An identical upsert and a disputed join, which keeps those words, leave the mark.
 * - Highlighting comes from a change's kind and the rule the commit stamps, never from a model's word. It
 *   is a writer's: a person's `edit` and `revert` entries are never highlighted, and neither is an entry
 *   that leaves the text as it was, which gives a person nothing to look at or undo.
 * - A history entry's `before` keeps the section's marks with its content, so a revert gives it back as
 *   it stood. A revert undoes a writer's change newest first and never runs over a later one
 *   (`revertChange`), and what it took back stays on the page's history for the writer's next input.
 */

export type Warning = MemoryReceipt["warnings"][number];

export type ReceiptSection = MemoryReceipt["pages"][number]["sections"][number];

/** Names lore or a group ties to one subject. */
export type AliasSeed = {
    /** The name keys that find the seed. */
    names: string[];
    /** What a page created under one of `names` takes as aliases. */
    aliases: string[];
};

/** A page as the analysis prompt lists it. */
export type CastRow = Pick<MemoryPage, "id" | "type" | "title" | "aliases"> & {
    lastState: string;
    sections: { heading: string; summary: string }[];
};

/** What becomes of a recording's candidates against the records as they stand now. */
export type PagePlan = {
    /** The pages the candidates accepted, each once, in candidate order, with the candidate that named it first. */
    targets: { page: MemoryPage; candidate: MemoryPageCandidate }[];
    /** The pages this recording makes, none with sections or history yet. */
    created: MemoryPage[];
    refused: MemoryReceipt["refused"];
    /** A page id by the name key of a create or a new page, for references that name it by title. */
    names: ReadonlyMap<string, string>;
    /** The character page of the group member who spoke the window. */
    speakerId?: string;
};

/** How a commit highlights the changes it writes. */
export type HighlightRule = {
    mode: StructuredMemoryHighlightMode;
    /** What the `important` mode lists. */
    kinds: readonly StructuredMemoryHighlightKind[];
    /** The grade from which a listed `change` counts. */
    changeGrade: number;
};

/** What one commit stamps on everything it changes. */
export type PageStamp = {
    eventId: string;
    sources: readonly MemorySource[];
    /** `Date.now()` of the commit. */
    at: number;
    newId(): string;
    /** Without one, only a change that replaces a person's correction is highlighted. */
    highlight?: HighlightRule;
    /** The grade of the event the commit writes. */
    grade?: number;
};

/** What one commit does to one page. */
type PageChange = { page: MemoryPage; created: boolean; sections: ReceiptSection[] };

/** All of a commit's page changes by page id, because the store refuses an id written twice in a change set. */
export type PageChanges = Map<string, PageChange>;

/** Why a revert does not fit the page: the entry is gone, it is no writer's change, or a later one stands on it. */
export class MemoryRevertRefusal extends Error {
    readonly reason: "gone" | "invalid" | "superseded";

    constructor(reason: MemoryRevertRefusal["reason"], message: string) {
        super(message);
        this.reason = reason;
    }
}

/** A `revert` entry, which always names its section. */
type RevertEntry = MemoryPageHistoryEntry & { heading: string };

/** The scene page's fixed sections, each also a field of `MemorySceneDraft`. */
export const SCENE_SECTIONS = ["place", "time", "state"] as const;

/** The most a prompt lists of what a person took back: per page on a patch row, and in all for the scene. */
export const PROMPT_TAKEN_BACK = 3;

/** The marks a history entry keeps with a section's content. */
const SNAPSHOT_MARKS = ["userCorrected", "disputed", "unsupported", "pinned", "suppressed"] as const;

const SCENE_TITLE = "Scene";

/** A stored field as text: stored lore and characters hold anything, and what is no string counts as absent. */
export const storedText = (value: unknown) => (typeof value === "string" ? value : "");

/** A name as it is compared. */
export function nameKey(name: string): string {
    return name.trim().toLowerCase();
}

/** The name keys of `page`. */
function pageNames({ title, aliases }: Pick<MemoryPage, "title" | "aliases">): string[] {
    return [title, ...aliases].map(nameKey).filter((key) => key !== "");
}

/** Whether `page` goes by one of `names`. */
function namedBy(page: MemoryPage, names: ReadonlySet<string>): boolean {
    return pageNames(page).some((key) => names.has(key));
}

/**
 * The alias seeds of a chat's lore and a group's members, both stored data of any shape: an entry that is
 * no object, as a legacy array-shaped one is, gives no seed. A lore entry gives its name to match and its
 * comma-split keys as aliases; a regex or folder entry gives nothing, its keys being no names. A member's
 * `name` and `nickname` are one seed each way.
 */
export function aliasSeeds(lore: readonly unknown[], members: readonly unknown[]): AliasSeed[] {
    const seeds: AliasSeed[] = [];
    for (const { comment, key, useRegex, mode } of lore.filter(isPlainObject)) {
        const name = nameKey(storedText(comment));
        if (name !== "" && !useRegex && mode !== "folder") {
            seeds.push({ names: [name], aliases: storedText(key).split(",") });
        }
    }
    for (const { name, nickname } of members.filter(isPlainObject)) {
        const names = [storedText(name), storedText(nickname)].filter((text) => nameKey(text) !== "");
        if (names.length === 2) {
            seeds.push({ names: names.map(nameKey), aliases: names });
        }
    }
    return seeds;
}

/** `key` and every name a seed ties to it. */
function tiedNames(key: string, seeds: readonly AliasSeed[]): Set<string> {
    return new Set([key, ...seeds.flatMap(({ names }) => (names.includes(key) ? names : []))]);
}

/** A page's newest word on its subject: a character's `currentState`, else the section changed last. */
function lastState({ sections }: MemoryPage): string {
    const section =
        sections.find(({ heading }) => heading === "currentState") ??
        sections.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
    return section?.body ?? "";
}

function castRow(page: MemoryPage): CastRow {
    const { id, type, title, aliases, sections } = page;
    return {
        id,
        type,
        title: clampText(title, LIMITS.labelChars),
        aliases: aliases.slice(0, LIMITS.aliasesPerPage).map((alias) => clampText(alias, LIMITS.labelChars)),
        lastState: clampText(lastState(page), LIMITS.promptPageStateChars),
        sections: sections.slice(0, LIMITS.sectionsPerPage).map(({ heading, body }) => ({
            heading: clampText(heading, LIMITS.labelChars),
            summary: clampText(body, LIMITS.promptSectionSummaryChars),
        })),
    };
}

/**
 * The pages a recording's prompt lists, at most `promptPages`, in this order: `always` pages, the scene's
 * participants, then pages whose title or alias appears in `messages`, so the cost of a recording does
 * not grow with the cast. The scene page itself is left out: it has its own slot.
 */
export function castSlice(pages: readonly MemoryPage[], messages: readonly Pick<Message, "data">[]): CastRow[] {
    const scene = pages.find(({ type }) => type === "scene");
    const listed = pages.filter((page) => page !== scene);
    const texts = messages.map(({ data }) => data.toLowerCase());
    const present = new Set(scene?.participants ?? []);
    const picked = new Set([
        ...listed.filter(({ contextMode }) => contextMode === "always"),
        ...listed.filter(({ id }) => present.has(id)),
        ...listed.filter((page) => pageNames(page).some((key) => texts.some((text) => text.includes(key)))),
    ]);
    return [...picked].slice(0, LIMITS.promptPages).map(castRow);
}

/** A page with nothing on it. `aliases` lose blanks, repeats, and the title itself, and stop at the cap. */
function newPage(id: string, type: MemoryPageType, title: string, aliases: readonly string[]): MemoryPage {
    const kept = new Map<string, string>();
    for (const alias of aliases) {
        const name = clampText(alias.trim(), LIMITS.labelChars);
        const key = nameKey(name);
        if (key !== "" && key !== nameKey(title) && !kept.has(key)) {
            kept.set(key, name);
        }
    }
    return {
        id,
        type,
        title,
        aliases: [...kept.values()].slice(0, LIMITS.aliasesPerPage),
        contextMode: "auto",
        sections: [],
        links: [],
        retrieval: { keywords: [] },
        history: [],
    };
}

/** The chat's one scene page before anything is written to it. */
export function newScenePage(id: string): MemoryPage {
    return { ...newPage(id, "scene", SCENE_TITLE, []), contextMode: "always", participants: [] };
}

/**
 * What becomes of `candidates` against `pages`, the chat's whole pages as they stand now. A commit runs
 * this again on every attempt, and `newPageId` keeps a new page's id across them.
 *
 * - A `targetId` that exists is a target at any confidence, since only a new page needs one. A missing
 *   one is refused `unknownPage`.
 * - The scene page, and a create of that type, are refused `sceneOwned`.
 * - A create is matched first, by name key over the titles and aliases of existing pages of its type,
 *   with the names seeds tie to it. A match makes it a target of that page at any confidence, and two
 *   creates of one name are one page.
 * - A create below `createConfidence` with no match is refused `lowConfidence`, which is how the receipt
 *   lists an unresolved mention. A weaker mention of a page another candidate makes is no such thing:
 *   the creates above the threshold go first.
 * - `speaker` gets a character page: an existing one by name, else one code makes. That name is exact,
 *   so no threshold applies, and alone it makes no target.
 * - `repeated`: a repeat makes nothing, so every candidate is refused `repeatedEvent`, though a name that
 *   finds an existing page still reads as that page.
 */
export function planPages(arg: {
    pages: readonly MemoryPage[];
    candidates: readonly MemoryPageCandidate[];
    seeds: readonly AliasSeed[];
    /** The group member who spoke the window. */
    speaker?: { name: string; nickname?: string };
    repeated: boolean;
    newPageId(key: string): string;
}): PagePlan {
    const { pages, candidates, seeds, speaker, newPageId } = arg;
    const created: MemoryPage[] = [];
    const names = new Map<string, string>();
    const find = (type: MemoryPageType, title: string) => {
        const tied = tiedNames(nameKey(title), seeds);
        return (
            pages.find((page) => page.type === type && namedBy(page, tied)) ??
            created.find((page) => tied.has(nameKey(page.title)) || (page.type === type && namedBy(page, tied)))
        );
    };
    if (arg.repeated) {
        for (const { create } of candidates) {
            const page = create && find(create.type, create.title);
            if (page) {
                names.set(nameKey(create.title), page.id);
            }
        }
        const refused = candidates.map((candidate) => ({ candidate, refusal: "repeatedEvent" }));
        return { targets: [], created, refused, names };
    }
    const make = (type: MemoryPageType, title: string, aliases: readonly string[]) => {
        const key = nameKey(title);
        const seeded = seeds.flatMap((seed) => (seed.names.includes(key) ? seed.aliases : []));
        const page = newPage(newPageId(key), type, title, [...aliases, ...seeded]);
        created.push(page);
        names.set(key, page.id);
        return page;
    };

    let speakerId: string | undefined;
    if (speaker) {
        const name = clampText(speaker.name.trim(), LIMITS.labelChars);
        const aliases = speaker.nickname ? [speaker.nickname] : [];
        speakerId = (find("character", name) ?? make("character", name, aliases)).id;
    }
    for (const { create, confidence } of candidates) {
        if (
            create &&
            create.type !== "scene" &&
            confidence >= LIMITS.createConfidence &&
            !find(create.type, create.title)
        ) {
            make(create.type, create.title, create.aliases);
        }
    }

    const targets = new Map<string, PagePlan["targets"][number]>();
    const refused: MemoryReceipt["refused"] = [];
    for (const candidate of candidates) {
        const { create, targetId } = candidate;
        const page = create ? find(create.type, create.title) : pages.find(({ id }) => id === targetId);
        if (create?.type === "scene" || page?.type === "scene") {
            refused.push({ candidate, refusal: "sceneOwned" });
        } else if (!page) {
            refused.push({ candidate, refusal: create ? "lowConfidence" : "unknownPage" });
        } else {
            if (!targets.has(page.id)) {
                targets.set(page.id, { page, candidate });
            }
            if (create) {
                names.set(nameKey(create.title), page.id);
            }
        }
    }
    return {
        targets: [...targets.values()],
        created,
        refused,
        names,
        ...(speakerId !== undefined ? { speakerId } : {}),
    };
}

/**
 * `plan` without its targets among `frozen`, each named by a warning. Creates stand, and a name that finds a
 * frozen page still reads as that page, so references keep working.
 */
export function withoutFrozenTargets(
    plan: PagePlan,
    frozen: ReadonlySet<string>,
): { plan: PagePlan; warnings: Warning[] } {
    const dropped = plan.targets.filter(({ page }) => frozen.has(page.id));
    return {
        plan: { ...plan, targets: plan.targets.filter(({ page }) => !frozen.has(page.id)) },
        warnings: dropped.map(({ page }) => ({ kind: "frozenPage", pageId: page.id, detail: page.title })),
    };
}

/** The member who spoke every reply of `messages`, when exactly one did. */
export function windowSpeaker(messages: readonly Pick<Message, "role" | "saying">[]): string | undefined {
    const speakers = new Set(messages.flatMap(({ role, saying }) => (role === "char" && saying ? [saying] : [])));
    return speakers.size === 1 ? [...speakers][0] : undefined;
}

/** The text embedded for a section: retrieval must embed exactly this, or the vector warmed here goes unused. */
export function sectionVectorText(
    { title }: Pick<MemoryPage, "title">,
    { heading, body }: Pick<MemorySection, "heading" | "body">,
): string {
    return `${title}: ${heading}\n${body}`.trim();
}

/** The hash a receipt keeps of a section's body. */
function bodyHash(body: string): string {
    return createHash("sha256").update(body, "utf8").digest("hex");
}

/** A warning about one section of `page`; the receipt's reader keeps only `kind` and `detail`. */
export function sectionWarning(kind: string, page: Pick<MemoryPage, "id" | "title">, heading: string): Warning {
    return { kind, pageId: page.id, heading, detail: `${page.title}: ${heading}` };
}

/** `before` and `added`, each key once at its newest place, keeping the newest `sectionEvidence`. */
function newestEvidence<T>(before: readonly T[], added: readonly T[], key: (item: T) => string): T[] {
    const kept = new Map<string, T>();
    for (const item of [...before, ...added]) {
        kept.delete(key(item));
        kept.set(key(item), item);
    }
    return [...kept.values()].slice(-LIMITS.sectionEvidence);
}

/** What a history entry keeps of `section`. */
function sectionSnapshot(section: MemorySection): MemoryHistorySnapshot {
    const { body, provenance, sources } = section;
    const marks = SNAPSHOT_MARKS.filter((mark) => section[mark]).map((mark) => [mark, true]);
    return { body, provenance, sources, ...Object.fromEntries(marks) };
}

/**
 * Whether `stamp`'s rule highlights a change of `kind` on `page`. Under `important` a listed kind is, and
 * a `change` only from the rule's grade, the higher of the event's and the page's, an absent one counting
 * as none.
 */
function ruleHighlights({ highlight, grade }: PageStamp, kind: MemoryHistoryChangeKind, page: MemoryPage): boolean {
    if (highlight?.mode !== "important") {
        return highlight?.mode === "all";
    }
    const kinds: readonly string[] = highlight.kinds;
    return (
        kinds.includes(kind) && (kind !== "change" || Math.max(grade ?? -1, page.grade ?? -1) >= highlight.changeGrade)
    );
}

/** A writer's history entry. */
function historyEntry(
    stamp: PageStamp,
    edit: { heading: string | null; before: MemoryHistorySnapshot | null; kind: MemoryHistoryChangeKind },
    highlighted: boolean,
): MemoryPageHistoryEntry {
    const { heading, before, kind } = edit;
    return { id: stamp.newId(), heading, before, kind, highlighted, eventId: stamp.eventId, at: stamp.at };
}

/** Records `page` as what the commit leaves of it, adding the receipt's lines for it. */
function putPage(changes: PageChanges, page: MemoryPage, sections: readonly ReceiptSection[] = []) {
    const change = changes.get(page.id);
    changes.set(page.id, {
        page,
        created: change?.created ?? false,
        sections: [...(change?.sections ?? []), ...sections],
    });
}

/** Records `page` as new, with its one `create` entry, and answers it as written. */
export function addPage(changes: PageChanges, page: MemoryPage, stamp: PageStamp): MemoryPage {
    const edit = { heading: null, before: null, kind: "create" } as const;
    const added = { ...page, history: [historyEntry(stamp, edit, ruleHighlights(stamp, "create", page))] };
    changes.set(page.id, { page: added, created: true, sections: [] });
    return added;
}

/**
 * Sets `heading` of `page`, which must be the commit's latest version of it, to `body`, or removes it on
 * null. The section gains the event and the window as evidence and loses `unsupported`, and `disputed`
 * unless the edit sets it; `locked`, `pinned`, and `suppressed` stay. `userCorrected` goes when another
 * text or a delete replaces a person's words, which highlights the entry whatever the rule says, and
 * stays on an identical upsert and on a disputed join, whose text keeps them. An identical upsert is
 * never highlighted, though it keeps its entry and its receipt row. The history keeps what was replaced,
 * marks included, with one entry, bounded by `pageHistoryEntries`.
 */
export function changeSection(
    changes: PageChanges,
    page: MemoryPage,
    edit: { heading: string; body: string | null; kind: MemoryHistoryChangeKind; disputed?: boolean },
    stamp: PageStamp,
): void {
    const { heading, body, kind, disputed } = edit;
    const before = page.sections.find((section) => section.heading === heading);
    const sameText = body === before?.body;
    const replacesCorrection = !!before?.userCorrected && !disputed && !sameText;
    const entry = historyEntry(
        stamp,
        { heading, before: before ? sectionSnapshot(before) : null, kind },
        replacesCorrection || (!sameText && ruleHighlights(stamp, kind, page)),
    );
    let sections = page.sections.filter((section) => section !== before);
    if (body !== null) {
        const written: MemorySection = {
            locked: false,
            ...before,
            heading,
            body,
            provenance: newestEvidence(before?.provenance ?? [], [stamp.eventId], (id) => id),
            sources: newestEvidence(before?.sources ?? [], stamp.sources, ({ messageId }) => messageId),
            updatedAt: stamp.at,
        };
        delete written.unsupported;
        delete written.disputed;
        if (disputed) {
            written.disputed = true;
        }
        if (replacesCorrection) {
            delete written.userCorrected;
        }
        sections = before
            ? page.sections.map((section) => (section === before ? written : section))
            : [...sections, written];
    }
    const history = [...page.history, entry].slice(-LIMITS.pageHistoryEntries);
    putPage(changes, { ...page, sections, history }, [
        {
            heading,
            ...(before ? { beforeHash: bodyHash(before.body) } : {}),
            ...(body !== null ? { afterHash: bodyHash(body) } : {}),
            historyId: entry.id,
            ...(entry.highlighted ? { highlighted: kind } : {}),
        },
    ]);
}

/**
 * Gives each shift's `from` page a link to its `to` page, which nothing else fills. No section changes,
 * and a page at `pageRefsPerItem` links takes no more.
 */
export function addLinks(
    changes: PageChanges,
    pages: ReadonlyMap<string, MemoryPage>,
    shifts: readonly { from: string; to: string }[],
): void {
    for (const { from, to } of shifts) {
        const page = changes.get(from)?.page ?? pages.get(from);
        if (page && from !== to && !page.links.includes(to) && page.links.length < LIMITS.pageRefsPerItem) {
            putPage(changes, { ...page, links: [...page.links, to] });
        }
    }
}

/** `page`'s `revert` entries, newest first. Each `before` is what it took back, null for a deletion it undid. */
export function revertEntries({ history }: Pick<MemoryPage, "history">): RevertEntry[] {
    return history
        .filter((entry): entry is RevertEntry => entry.kind === "revert" && entry.heading !== null)
        .toReversed();
}

/**
 * What a person took back of `heading` and nothing wrote over since: what the `revert` entries at the end
 * of its history hold. A different rewrite frees those texts, because the story may return to a place.
 */
function standingReverts({ history }: MemoryPage, heading: string): Set<string> {
    const texts = new Set<string>();
    for (const { kind, before } of history.filter((entry) => entry.heading === heading).toReversed()) {
        if (kind !== "revert") {
            break;
        }
        if (before) {
            texts.add(before.body);
        }
    }
    return texts;
}

/**
 * Rewrites the scene from `draft`: each fixed section as a `change` with the old text in the history, so
 * the bounded history keeps old scenes, or a `create` the first time. A blank field, or one that says the
 * same, changes nothing. A locked section is skipped with a warning and the others go on, and so is a
 * field that says again what a person took back (`standingReverts`). A blank list of participants keeps
 * the attendance, which has no history entry: each event's participants record it. `scene` must be the
 * commit's latest version of the page.
 */
export function rewriteScene(
    changes: PageChanges,
    scene: MemoryPage,
    draft: MemorySceneDraft,
    stamp: PageStamp,
): Warning[] {
    const warnings: Warning[] = [];
    let page = scene;
    for (const heading of SCENE_SECTIONS) {
        const body = draft[heading];
        const section = page.sections.find((entry) => entry.heading === heading);
        if (body.trim() === "" || body === section?.body) {
            continue;
        }
        if (section?.locked) {
            warnings.push(sectionWarning("lockedSection", page, heading));
            continue;
        }
        if (standingReverts(page, heading).has(body)) {
            warnings.push(sectionWarning("revertedScene", page, heading));
            continue;
        }
        changeSection(changes, page, { heading, body, kind: section ? "change" : "create" }, stamp);
        page = changes.get(page.id)!.page;
    }
    const present = page.participants ?? [];
    const { participants } = draft;
    if (
        participants.length > 0 &&
        (participants.length !== present.length || participants.some((id, index) => id !== present[index]))
    ) {
        putPage(changes, { ...page, participants });
    }
    return warnings;
}

/** The pages `changes` lists as a receipt lists them. */
export function receiptPages(changes: PageChanges): MemoryReceipt["pages"] {
    return [...changes.values()].map(({ page, created, sections }) => ({
        pageId: page.id,
        title: clampText(page.title, LIMITS.labelChars),
        created,
        sections,
    }));
}

/** The text of every section `changes` wrote and left standing; the scene's take no vectors. */
export function changedSectionTexts(changes: PageChanges): string[] {
    return [...changes.values()].flatMap(({ page, sections }) => {
        const headings = new Set(sections.map(({ heading }) => heading));
        return page.type === "scene"
            ? []
            : page.sections
                  .filter(({ heading }) => headings.has(heading))
                  .map((section) => sectionVectorText(page, section));
    });
}

/**
 * The entries of `entries`, one heading's history, that undoing `target` takes together, oldest first, or
 * null for a `compact` whose patch left the bounded history. A `compact` is a shorter text of the entry
 * just before it, so the two are one change. Only that place and their event tie them: a repeated turn
 * reuses its event's id while its scene rewrite still writes, and those are changes of their own.
 */
function revertGroup(
    entries: readonly MemoryPageHistoryEntry[],
    target: MemoryPageHistoryEntry,
): MemoryPageHistoryEntry[] | null {
    const index = entries.indexOf(target);
    if (target.kind === "compact") {
        const patch: MemoryPageHistoryEntry | undefined = entries[index - 1];
        return patch && patch.kind !== "compact" && patch.eventId === target.eventId ? [patch, target] : null;
    }
    const next: MemoryPageHistoryEntry | undefined = entries[index + 1];
    return next?.kind === "compact" && next.eventId === target.eventId ? [target, next] : [target];
}

/**
 * `heading`'s section as `before` left it, at `at`: its text, its evidence, and the marks that speak of
 * that text, as `before` holds them. `live` keeps its lock, its pin, and its suppression, which a person
 * set on the section whatever it says, and a section that comes back has only what `before` kept of them.
 */
function revertedSection(
    heading: string,
    before: MemoryHistorySnapshot,
    live: MemorySection | undefined,
    at: number,
): MemorySection {
    const { body, provenance, sources, userCorrected, disputed, unsupported } = before;
    const { pinned, suppressed } = live ?? before;
    return {
        heading,
        locked: live?.locked ?? false,
        body,
        provenance,
        sources,
        updatedAt: at,
        ...(pinned ? { pinned } : {}),
        ...(suppressed ? { suppressed } : {}),
        ...(userCorrected ? { userCorrected } : {}),
        ...(disputed ? { disputed } : {}),
        ...(unsupported ? { unsupported } : {}),
    };
}

/**
 * Undoes the writer's change `historyId` names in `page`, the page as stored: the page to store and the
 * event that made the change, or null for one a person already undid. A `MemoryRevertRefusal` says why it
 * cannot be undone: only a writer's change of a section can.
 *
 * - A change and its compaction are one change, and naming either undoes both (`revertGroup`).
 * - Undoing goes newest first: a later entry of the heading that still stands refuses it `superseded`, so
 *   a later patch or a person's edit is never silently overwritten.
 * - A locked section can be reverted: the lock binds the writer, not the person.
 * - The section takes the first `before` of the group (`revertedSection`), or goes when that is null. One
 *   that comes back goes last, within `sectionsPerPage`.
 * - The group's entries are marked `revertedBy`, and one `revert` entry, bounded by `pageHistoryEntries`,
 *   keeps the section as it stood, which is what the writer's next input reads.
 */
export function revertChange(
    page: MemoryPage,
    historyId: string,
    { now, newId }: EditStamp,
): { page: MemoryPage; eventId: string } | null {
    const target = page.history.find(({ id }) => id === historyId);
    if (!target) {
        throw new MemoryRevertRefusal("gone", "The page's history no longer holds this change");
    }
    const { heading, eventId, kind } = target;
    if (heading === null || eventId === undefined || kind === "edit" || kind === "revert") {
        throw new MemoryRevertRefusal("invalid", "Only a writer's change of a section can be reverted");
    }
    if (target.revertedBy) {
        return null;
    }
    const entries = page.history.filter((entry) => entry.heading === heading);
    const group = revertGroup(entries, target);
    if (!group) {
        throw new MemoryRevertRefusal("superseded", "The change this one shortened is no longer in the history");
    }
    const later = entries.slice(entries.indexOf(group.at(-1)!) + 1);
    if (later.some((entry) => !entry.revertedBy && entry.kind !== "revert")) {
        throw new MemoryRevertRefusal("superseded", "A later change of this section stands on this one");
    }
    const live = page.sections.find((section) => section.heading === heading);
    const { before } = group[0];
    if (before && !live && page.sections.length >= LIMITS.sectionsPerPage) {
        throw new MemoryRevertRefusal("invalid", "The page has no room for this section");
    }
    const restored = before && revertedSection(heading, before, live, now);
    const sections = restored
        ? live
            ? page.sections.map((section) => (section === live ? restored : section))
            : [...page.sections, restored]
        : page.sections.filter((section) => section !== live);
    const entry: MemoryPageHistoryEntry = {
        id: newId(),
        heading,
        before: live ? sectionSnapshot(live) : null,
        kind: "revert",
        highlighted: false,
        at: now,
    };
    const history = page.history.map((stored) =>
        group.includes(stored) ? { ...stored, revertedBy: "user" as const } : stored,
    );
    return {
        page: { ...page, sections, history: [...history, entry].slice(-LIMITS.pageHistoryEntries) },
        eventId,
    };
}

/** How many of `events`, in insertion order, stand after the one `eventId` names; 0 when it names none. */
export function laterEventCount(events: readonly Pick<MemoryEvent, "id" | "status">[], eventId: string): number {
    const index = events.findIndex(({ id }) => id === eventId);
    return index === -1 ? 0 : events.slice(index + 1).filter(({ status }) => status !== "retracted").length;
}
