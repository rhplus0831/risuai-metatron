import { createHash } from "node:crypto";
import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import type { Message } from "../../../../../shared/database.ts";
import {
    type MemoryHistoryChangeKind,
    type MemoryPage,
    type MemoryPageCandidate,
    type MemoryPageHistoryEntry,
    type MemoryPageType,
    type MemoryReceipt,
    type MemorySceneDraft,
    type MemorySection,
    type MemorySectionContent,
    type MemorySource,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";

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

/** What one commit stamps on everything it changes. */
export type PageStamp = {
    eventId: string;
    sources: readonly MemorySource[];
    /** `Date.now()` of the commit. */
    at: number;
    newId(): string;
};

/** What one commit does to one page. */
type PageChange = { page: MemoryPage; created: boolean; sections: ReceiptSection[] };

/** All of a commit's page changes by page id, because the store refuses an id written twice in a change set. */
export type PageChanges = Map<string, PageChange>;

/** The scene page's fixed sections, each also a field of `MemorySceneDraft`. */
export const SCENE_SECTIONS = ["place", "time", "state"] as const;

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

function historyEntry(
    stamp: PageStamp,
    heading: string | null,
    before: MemorySectionContent | null,
    kind: MemoryHistoryChangeKind,
): MemoryPageHistoryEntry {
    return { id: stamp.newId(), heading, before, kind, highlighted: false, eventId: stamp.eventId, at: stamp.at };
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
    const added = { ...page, history: [historyEntry(stamp, null, null, "create")] };
    changes.set(page.id, { page: added, created: true, sections: [] });
    return added;
}

/**
 * Sets `heading` of `page`, which must be the commit's latest version of it, to `body`, or removes it on
 * null. The section gains the event and the window as evidence and loses `unsupported`, and `disputed`
 * unless the edit sets it; trust flags and `locked` stay. The history keeps what was replaced with one
 * entry, bounded by `pageHistoryEntries`.
 */
export function changeSection(
    changes: PageChanges,
    page: MemoryPage,
    edit: { heading: string; body: string | null; kind: MemoryHistoryChangeKind; disputed?: boolean },
    stamp: PageStamp,
): void {
    const { heading, body, kind, disputed } = edit;
    const before = page.sections.find((section) => section.heading === heading);
    const entry = historyEntry(
        stamp,
        heading,
        before ? { body: before.body, provenance: before.provenance, sources: before.sources } : null,
        kind,
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

/**
 * Rewrites the scene from `draft`: each fixed section as a `change` with the old text in the history, so
 * the bounded history keeps old scenes, or a `create` the first time. A blank field, or one that says the
 * same, changes nothing. A locked section is skipped with a warning and the others go on. A blank list of
 * participants keeps the attendance, which has no history entry: each event's participants record it.
 * `scene` must be the commit's latest version of the page.
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
    return [...changes.values()].map(({ page, created, sections }) => ({ pageId: page.id, created, sections }));
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
