import {
    type MemoryPage,
    type MemoryReceipt,
    type MemorySection,
    memorySectionOverBudget,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import { answerJson } from "./analysis.ts";
import {
    changeSection,
    type PageChanges,
    type PageStamp,
    type ReceiptSection,
    sectionWarning,
    type Warning,
} from "./pages.ts";

/**
 * The compaction call's rules, without any I/O: which sections get one, what is kept of its answer, and
 * what that makes of the pages as they stand at the commit. Only page sections are compacted, never an
 * event.
 *
 * - A section gets a call when a commit really changed it and left it past its page type's budget. One
 *   past its budget that the commit did not change gets none, so a section that cannot shrink is not
 *   asked again every window. The scene page is rewritten whole, so nothing compacts it.
 * - A compaction never overrides a person. A locked section gets no call, and neither does a
 *   `userCorrected` or `disputed` one, which is listed `compactionSkipped`: a person's words are not the
 *   model's to shrink, and a rewrite could silently settle a dispute that waits for review.
 * - Nothing is cut to fit, because a clamped answer would manufacture a smaller result. An answer with no
 *   text is `compactionFailed` and one not strictly shorter than the section is `compactionNotSmaller`,
 *   though one that is shorter need not reach the budget.
 * - The commit may run again on fresh records, so a compaction applies only on an attempt that itself
 *   really changed the section, left it with exactly the body the call saw, and left it free of the
 *   marks above. Any other is dropped `compactionStale`. That attempt's patch already gave the section
 *   this event and window, under the same stamp, so `changeSection` adds no evidence it did not gain.
 */

/** A section that gets a compaction call, with the body the call sees. */
export type CompactionTarget = {
    page: Pick<MemoryPage, "id" | "type" | "title">;
    heading: string;
    body: string;
};

/** A section's shorter body; `from` is the body the call saw. */
export type Compaction = { pageId: string; heading: string; from: string; body: string };

/** The compaction an answer gives, or the warning that lists why it gives none. */
export type ReadCompaction = { ok: true; compaction: Compaction } | { ok: false; warning: Warning };

/** Whether a receipt row's commit really changed its section: an identical upsert and a delete did not. */
const reallyChanged = ({ beforeHash, afterHash }: ReceiptSection) =>
    afterHash !== undefined && afterHash !== beforeHash;

/** Whether the model may rewrite `section`. */
const mayCompact = ({ locked, userCorrected, disputed }: MemorySection) => !locked && !userCorrected && !disputed;

/**
 * The sections that need a call, in the order of `receipts`, from the pages and receipt rows a
 * `commitPages` answered, and a warning for each one a person's mark keeps from it. A locked section is
 * left out with no warning: a patch refuses it, so one here would not be this commit's doing.
 */
export function compactionTargets(
    pages: readonly MemoryPage[],
    receipts: MemoryReceipt["pages"],
): { targets: CompactionTarget[]; warnings: Warning[] } {
    const targets: CompactionTarget[] = [];
    const warnings: Warning[] = [];
    for (const { pageId, sections } of receipts) {
        const page = pages.find(({ id }) => id === pageId);
        if (!page || page.type === "scene") {
            continue;
        }
        const { id, type, title } = page;
        for (const heading of new Set(sections.filter(reallyChanged).map((row) => row.heading))) {
            const section = page.sections.find((entry) => entry.heading === heading);
            if (!section || section.locked || !memorySectionOverBudget(type, section.body)) {
                continue;
            }
            if (mayCompact(section)) {
                targets.push({ page: { id, type, title }, heading, body: section.body });
            } else {
                warnings.push(sectionWarning("compactionSkipped", page, heading));
            }
        }
    }
    return { targets, warnings };
}

/** What a compaction call's answer for `target` comes to (`answerJson`); the body is never cut. */
export function readCompaction(target: CompactionTarget, text: string): ReadCompaction {
    const { page, heading, body: from } = target;
    const parsed = answerJson(text);
    const body = isPlainObject(parsed) ? parsed.body : undefined;
    if (typeof body !== "string" || body.trim() === "") {
        return { ok: false, warning: sectionWarning("compactionFailed", page, heading) };
    }
    if (body.length >= from.length) {
        return { ok: false, warning: sectionWarning("compactionNotSmaller", page, heading) };
    }
    return { ok: true, compaction: { pageId: page.id, heading, from, body } };
}

/**
 * Applies `compactions` over `changes`, which must hold this attempt's patches, as `compact` changes, and
 * answers what it lists: `compacted` for one applied, with the change of length, and `compactionStale`
 * for one this attempt no longer allows.
 */
export function applyCompactions(arg: {
    changes: PageChanges;
    pages: ReadonlyMap<string, MemoryPage>;
    compactions: readonly Compaction[];
    stamp: PageStamp;
}): Warning[] {
    const { changes, pages, stamp } = arg;
    const warnings: Warning[] = [];
    for (const { pageId, heading, from, body } of arg.compactions) {
        const change = changes.get(pageId);
        const section = change?.page.sections.find((entry) => entry.heading === heading);
        // The row says this attempt changed the section; the page being in `changes` does not.
        const changed = change?.sections.some((row) => row.heading === heading && reallyChanged(row));
        if (!change || !section || !changed || section.body !== from || !mayCompact(section)) {
            const page = change?.page ?? pages.get(pageId) ?? { id: pageId, title: pageId };
            warnings.push(sectionWarning("compactionStale", page, heading));
            continue;
        }
        changeSection(changes, change.page, { heading, body, kind: "compact" }, stamp);
        const detail = `${change.page.title}: ${heading} (${from.length} → ${body.length})`;
        warnings.push({ ...sectionWarning("compacted", change.page, heading), detail });
    }
    return warnings;
}
