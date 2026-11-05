import { truncateCheckpointText as clampText } from "../../../../../shared/chatCheckpoints.ts";
import {
    CHARACTER_SECTION_SLOTS,
    MEMORY_PATCH_CONFLICTS,
    MEMORY_PATCH_OPS,
    type MemoryHistoryChangeKind,
    type MemoryPage,
    type MemoryPageType,
    type MemoryPatch,
    type MemoryReceipt,
    type MemorySection,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import { type Admission, answerJson, readConfidence, readList } from "./analysis.ts";
import { applyCompactions, type Compaction } from "./compact.ts";
import {
    addLinks,
    addPage,
    changedSectionTexts,
    changeSection,
    newScenePage,
    type PageChanges,
    type PagePlan,
    type PageStamp,
    PROMPT_TAKEN_BACK,
    receiptPages,
    revertEntries,
    rewriteScene,
    sectionWarning,
    type Warning,
} from "./pages.ts";

/**
 * The patch call's rules, without any I/O: what it shows of its pages, what is kept of its answer, and
 * what that makes of the pages as they stand at the commit.
 *
 * - A refusal other than `sectionTooLong` cancels the page's group, so a fact moved between two sections
 *   cannot lose one half of the move. Its warning names the cause and valid patches read `pageRefused`.
 *   An oversized section refuses only its patch, so the page's other sections can keep updating.
 *   Other pages still apply and the event commits: one page's refusal is no failure of the run.
 * - What the call showed is compared with the fresh page, by existence as well as by body, for every
 *   heading a patch names: a section deleted during the call cannot come back as new, and one added
 *   during it was never seen.
 * - An upsert of an existing section is a `change`. A `contradiction` keeps that kind, and below
 *   `contradictionConfidence`, where a missing confidence counts as 0, both values stay, marked disputed.
 *   Nothing is cut to fit: a body past `sectionBodyChars`, as answered or once joined, is refused.
 * - The model never sets what code owns: evidence, flags, locks, and history are `changeSection`'s.
 * - A patch may replace a `userCorrected` section: only a lock refuses it. The call shows the mark and its
 *   rules ask for a contradiction, and what such a patch does to the mark is `changeSection`'s.
 * - What a person took back reaches the call, so a reverted change is not proposed again. Its room comes
 *   first out of `promptPatchChars`, so a page full of bodies cannot push it out and the prompt stays
 *   within that bound. Code does not compare a patch with it: a change can come true later.
 */

/** One section row of the patch call's list. */
type PatchRowSection =
    { heading: string; body: string; locked?: true; userCorrected?: true } | { heading: string; empty: true };

/** What a person took back of a page: a section's text, or `deleted` for a deletion they undid. */
type PatchRowTakenBack = { heading: string; text: string } | { heading: string; deleted: true };

/** A page as the patch call lists it. */
export type PatchRow = {
    id: string;
    type: MemoryPageType;
    title: string;
    sections: PatchRowSection[];
    /** The sections past the call's budget, by heading. */
    notShown: string[];
    /** The newest of what a person took back of the page, when there is any. */
    takenBack?: PatchRowTakenBack[];
};

/** What a patch call shows of its targets. */
export type ShownPages = {
    rows: PatchRow[];
    /** By page id then heading, the body the call showed; null for a section it lists by heading alone. */
    seen: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
    /** Targets with sections, none of which fit. */
    refused: MemoryReceipt["refused"];
};

/** The patches and what bounding them cut, or why the answer cannot be used. */
export type ParsedPatches = { ok: true; patches: MemoryPatch[]; warnings: Warning[] } | { ok: false; error: string };

/** A patch's effect once it is admitted: a null `body` removes the section. */
type SectionEdit = { heading: string; body: string | null; kind: MemoryHistoryChangeKind; disputed?: boolean };

/**
 * The patch call's list. What a person took back comes first out of `promptPatchChars`, at most
 * `PROMPT_TAKEN_BACK` rows a page, newest first. Sections then show whole or not at all, in target order,
 * while the rest lasts, and one past that is listed by heading under `notShown`. A target with sections,
 * none of which fit, is refused `overBudget`, and a page with none needs no room. A character page marks
 * each slot it has no section for.
 */
export function showTargets(targets: PagePlan["targets"]): ShownPages {
    const rows: PatchRow[] = [];
    const seen = new Map<string, Map<string, string | null>>();
    const refused: MemoryReceipt["refused"] = [];
    let room = LIMITS.promptPatchChars;
    const takenBack = new Map<string, PatchRowTakenBack[]>();
    for (const { page } of targets) {
        const listed = revertEntries(page).slice(0, PROMPT_TAKEN_BACK);
        takenBack.set(
            page.id,
            listed.flatMap(({ heading, before }): PatchRowTakenBack[] => {
                const shown = clampText(heading, LIMITS.labelChars);
                const text = before && clampText(before.body, LIMITS.promptSectionSummaryChars);
                const charge = shown.length + (text?.length ?? 0);
                if (charge > room) {
                    return [];
                }
                room -= charge;
                return [text === null ? { heading: shown, deleted: true } : { heading: shown, text }];
            }),
        );
    }
    for (const { page, candidate } of targets) {
        const headings = new Map<string, string | null>();
        const sections: PatchRowSection[] = [];
        const notShown: string[] = [];
        for (const { heading, body, locked, userCorrected } of page.sections) {
            if (body.length <= room) {
                room -= body.length;
                headings.set(heading, body);
                sections.push({
                    heading,
                    body,
                    ...(locked ? { locked } : {}),
                    ...(userCorrected ? { userCorrected } : {}),
                });
            } else {
                headings.set(heading, null);
                notShown.push(heading);
            }
        }
        if (page.sections.length > 0 && sections.length === 0) {
            refused.push({ candidate, refusal: "overBudget" });
            continue;
        }
        const slots: readonly string[] = page.type === "character" ? CHARACTER_SECTION_SLOTS : [];
        for (const heading of slots.filter((slot) => !headings.has(slot))) {
            sections.push({ heading, empty: true });
        }
        const { id, type, title } = page;
        const taken = takenBack.get(id) ?? [];
        rows.push({ id, type, title, sections, notShown, ...(taken.length > 0 ? { takenBack: taken } : {}) });
        seen.set(id, headings);
    }
    return { rows, seen, refused };
}

/** A patch needs a page, a heading with text, and a known `op`; a `body` may be missing, and is then blank. */
function readPatch(value: unknown): MemoryPatch | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const { pageId, heading, body, was } = value;
    const op = MEMORY_PATCH_OPS.find((entry) => entry === value.op);
    if (typeof pageId !== "string" || typeof heading !== "string" || heading.trim() === "" || !op) {
        return undefined;
    }
    const conflict = MEMORY_PATCH_CONFLICTS.find((entry) => entry === value.conflict);
    const confidence = readConfidence(value.confidence);
    return {
        pageId: clampText(pageId, LIMITS.idChars),
        heading: clampText(heading.trim(), LIMITS.labelChars),
        op,
        // A run keeps this, so it is bounded, but a body too long must still read as too long
        // (`resolveGroup`), even where the cut would split a surrogate pair and lose a unit.
        ...(typeof body === "string" ? { body: clampText(body, LIMITS.sectionBodyChars + 2) } : {}),
        ...(conflict ? { conflict } : {}),
        ...(typeof was === "string" ? { was: clampText(was, LIMITS.factChars) } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
    };
}

/**
 * A patch call's answer as bounded patches (`answerJson`). An answer that is not JSON, or has no
 * `patches` list, cannot be used, and the error says which; a malformed element is left out and counted,
 * and one past `patchesPerCall` is not read. `upsert` supplies the whole new section body; `delete`
 * removes it. Neither operation is a text diff.
 */
export function parsePatches(text: string): ParsedPatches {
    const json = answerJson(text);
    if (!json.ok) {
        return { ok: false, error: `The model's answer is not valid JSON: ${json.error}` };
    }
    const parsed = json.value;
    if (!isPlainObject(parsed) || !Array.isArray(parsed.patches)) {
        return { ok: false, error: 'The model\'s answer has no valid "patches" list' };
    }
    const warnings: Warning[] = [];
    return {
        ok: true,
        patches: readList("patches", parsed.patches, LIMITS.patchesPerCall, readPatch, warnings),
        warnings,
    };
}

/** What an upsert makes of `section`, or `sectionTooLong` when a joined body would not fit. */
function upsertOver(section: MemorySection, patch: MemoryPatch, body: string): SectionEdit | string {
    const { heading, conflict, confidence } = patch;
    const disputed = conflict === "contradiction" && (confidence ?? 0) < LIMITS.contradictionConfidence;
    const was = patch.was?.trim() ?? "";
    const wasLine = `(was: ${was})`;
    const joined = disputed
        ? `${section.body}\n[disputed] ${body}`
        : was === "" || body.includes(wasLine)
          ? body
          : `${body}\n${wasLine}`;
    if (joined.length > LIMITS.sectionBodyChars) {
        return "sectionTooLong";
    }
    const kind = conflict === "contradiction" ? "contradiction" : "change";
    return { heading, body: joined, kind, ...(disputed ? { disputed } : {}) };
}

/** Each of `group`, one page's patches in order, as an edit of `page`, or as the code that refuses it. */
function resolveGroup(
    page: MemoryPage,
    group: readonly MemoryPatch[],
    shown: ReadonlyMap<string, string | null>,
): (SectionEdit | string)[] {
    const slots: readonly string[] = CHARACTER_SECTION_SLOTS;
    const handled = new Set<string>();
    // Deletes make room for additions in any order; oversized additions consume no room.
    let sections = page.sections.length - group.filter(({ op }) => op === "delete").length;
    return group.map((patch) => {
        const { heading, op } = patch;
        const section = page.sections.find((entry) => entry.heading === heading);
        if (section?.locked) {
            return "lockedSection";
        }
        if (section ? shown.get(heading) !== section.body : shown.has(heading) || op === "delete") {
            return "unseenSection";
        }
        if (handled.has(heading)) {
            return "duplicateHeading";
        }
        handled.add(heading);
        if (op === "delete") {
            return { heading, body: null, kind: "delete" };
        }
        if (!section && page.type === "character" && !slots.includes(heading)) {
            return "notASlot";
        }
        if (!section && sections + 1 > LIMITS.sectionsPerPage) {
            return "tooManySections";
        }
        const body = patch.body ?? "";
        if (body.trim() === "") {
            return "emptyBody";
        }
        if (body.length > LIMITS.sectionBodyChars) {
            return "sectionTooLong";
        }
        if (!section) sections++;
        return section ? upsertOver(section, patch, body) : { heading, body, kind: "create" };
    });
}

/** Whether `edits` leave a page that had sections with no section that has text. */
function emptiesPage(page: MemoryPage, edits: readonly SectionEdit[]): boolean {
    const removed = new Set(edits.flatMap(({ heading, body }) => (body === null ? [heading] : [])));
    return (
        page.sections.length > 0 &&
        edits.every(({ body }) => body === null) &&
        page.sections.every(({ heading, body }) => removed.has(heading) || body.trim() === "")
    );
}

/**
 * Applies `patches` over `changes` and `pages`, a page's patches together, and answers what it lists.
 * `seen` is what the call showed: a page it does not hold, or one that is gone, is refused `unseenPage`.
 * Every refused patch is listed with its code as `kind` and `<page title>: <heading>` as `detail`:
 *
 * - `lockedSection`: touches a locked section.
 * - `unseenSection`: an existing body was not shown or changed since, a section was added or deleted
 *   since it was shown, or a delete names no section.
 * - `duplicateHeading`: the group names the same heading twice.
 * - `notASlot`: adds to a character outside `CHARACTER_SECTION_SLOTS`.
 * - `tooManySections`: additions exceed `sectionsPerPage`, after this group's deletes make room.
 * - `emptyBody`: an upsert is blank.
 * - `sectionTooLong`: the answered or joined body exceeds `sectionBodyChars`; nothing is cut to fit.
 *
 * `sectionTooLong` refuses only its patch. Every other refusal cancels its page's whole group; otherwise
 * valid patches read `pageRefused`. If the remaining edits would empty a page that had sections, those
 * edits read `emptiesPage`. Other pages and the event still commit.
 * An upsert of existing text is `change`, or `contradiction` for that conflict. At or above
 * `contradictionConfidence` it replaces; below it, missing confidence counting as zero, it joins
 * `<old>\n[disputed] <new>`, sets `disputed` and warns. A replacing upsert appends `(was: ...)` for
 * nonblank `was` unless that exact line is already present. Neither conflict waits for approval.
 */
export function applyPatches(arg: {
    changes: PageChanges;
    pages: ReadonlyMap<string, MemoryPage>;
    patches: readonly MemoryPatch[];
    seen: ShownPages["seen"];
    stamp: PageStamp;
}): Warning[] {
    const { changes, pages, seen, stamp } = arg;
    const groups = new Map<string, MemoryPatch[]>();
    for (const patch of arg.patches) {
        groups.set(patch.pageId, [...(groups.get(patch.pageId) ?? []), patch]);
    }
    const warnings: Warning[] = [];
    for (const [pageId, group] of groups) {
        const page = changes.get(pageId)?.page ?? pages.get(pageId);
        const shown = seen.get(pageId);
        if (!page || !shown) {
            const named = page ?? { id: pageId, title: pageId };
            warnings.push(...group.map(({ heading }) => sectionWarning("unseenPage", named, heading)));
            continue;
        }
        const outcomes = resolveGroup(page, group, shown);
        const edits = outcomes.filter((outcome) => typeof outcome !== "string");
        if (outcomes.some((outcome) => typeof outcome === "string" && outcome !== "sectionTooLong")) {
            warnings.push(
                ...group.map(({ heading }, index) => {
                    const outcome = outcomes[index];
                    return sectionWarning(typeof outcome === "string" ? outcome : "pageRefused", page, heading);
                }),
            );
        } else {
            outcomes.forEach((outcome, index) => {
                if (typeof outcome === "string") {
                    warnings.push(sectionWarning(outcome, page, group[index].heading));
                }
            });
            if (emptiesPage(page, edits)) {
                warnings.push(...edits.map(({ heading }) => sectionWarning("emptiesPage", page, heading)));
                continue;
            }
            for (const edit of edits) {
                changeSection(changes, changes.get(pageId)?.page ?? page, edit, stamp);
                if (edit.disputed) {
                    warnings.push(sectionWarning("disputed", page, edit.heading));
                }
            }
        }
    }
    return warnings;
}

/**
 * Everything one commit does to pages, from `pages`, the chat's whole pages as they stand now: the pages
 * `plan` makes, the scene page when the chat has none, so a chat with records has one, the patches, the
 * compactions of what those changed, the links of a new event's relationship shifts, and the scene. A
 * repeat stops the links and the patches, which it lists as unseen, and so the compactions, which it
 * lists as stale, but not the scene.
 */
export function commitPages(arg: {
    pages: readonly MemoryPage[];
    plan: PagePlan;
    admission: Pick<Admission, "event" | "repeated" | "scene">;
    patches: readonly MemoryPatch[];
    seen: ShownPages["seen"];
    /** The shorter bodies the run's compaction calls gave. */
    compactions: readonly Compaction[];
    /** The id of a scene page made now, the same on every attempt of a run. */
    sceneId: string;
    stamp: PageStamp;
}): { pages: MemoryPage[]; receipts: MemoryReceipt["pages"]; warnings: Warning[]; vectorTexts: string[] } {
    const { plan, admission, patches, compactions, stamp } = arg;
    const pages = new Map(arg.pages.map((page) => [page.id, page]));
    const changes: PageChanges = new Map();
    for (const page of plan.created) {
        addPage(changes, page, stamp);
    }
    const scene = arg.pages.find(({ type }) => type === "scene") ?? addPage(changes, newScenePage(arg.sceneId), stamp);
    const seen = admission.repeated ? new Map() : arg.seen;
    const warnings = applyPatches({ changes, pages, patches, seen, stamp });
    warnings.push(...applyCompactions({ changes, pages, compactions, stamp }));
    if (!admission.repeated) {
        addLinks(changes, pages, admission.event.relationshipShifts);
    }
    if (admission.scene) {
        warnings.push(...rewriteScene(changes, changes.get(scene.id)?.page ?? scene, admission.scene, stamp));
    }
    return {
        pages: [...changes.values()].map(({ page }) => page),
        receipts: receiptPages(changes),
        warnings,
        vectorTexts: changedSectionTexts(changes),
    };
}
