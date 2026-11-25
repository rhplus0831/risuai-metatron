import { downloadFile } from "../globalApi.svelte";
import { language } from "src/lang";
import { alertConfirm, alertError } from "../alert";
import { heldMessageById } from "./chatStore.svelte";
import { JOURNAL_ENTRY_TTL_MS, pageDraftJournal, type ComposerRecovery, type DraftEntry } from "./draftJournal";
import { isJournalEligible } from "./journalEligibility";
import type { RecoveryApplyAttempt } from "./journalRecovery";
import { getResourceEpoch } from "./resourceClient";

/**
 * Reactive view of src/ts/storage/draftJournal.ts listDrafts; the journal remains durable authority.
 * Record drafts are filtered through src/ts/storage/journalEligibility.ts, and entries omit expired
 * rows and tag other epochs. While drafts remain, a 60 s timer removes expired rows from the view,
 * notice and Settings without reloading. A displaced send is retired when its user message appears
 * in the loaded target chat.
 */

let drafts = $state.raw<DraftEntry[]>([]);
let epoch = $state("");
let now = $state(Date.now());
let isOpen = $state(false);
let refreshing = $state(false);
/** Drafts applied and saved whose delete failed; Apply stays off for them while the page lives. */
let applied = $state.raw(new Set<string>());
/** Save receipts belong to this page; export always reads the original journal entry. */
export const recoveryApplyAttempts = new Map<string, RecoveryApplyAttempt>();
export function forgetRecoveryAttempt(id: string) {
    recoveryApplyAttempts.get(id)?.content?.release();
    recoveryApplyAttempts.delete(id);
}
let timer: ReturnType<typeof setInterval> | undefined;
let refreshVersion = 0;

export function composerDraftLanded(entry: ComposerRecovery): boolean {
    const [chaId, chatId] = entry.chatKey.split("\u0000");
    return heldMessageById({ chaId, chatId }, entry.value.userMessageId)?.role === "user";
}

const landed = $derived(new Set(drafts.filter((entry) => entry.scope === "composer" && composerDraftLanded(entry))));
const entries = $derived(
    drafts
        .filter((entry) => entry.createdAt + JOURNAL_ENTRY_TTL_MS > now && !landed.has(entry))
        .map((entry) => ({ ...entry, otherEpoch: entry.scope !== "composer" && entry.epoch !== epoch })),
);

$effect.root(() => {
    $effect(() => {
        if (!landed.size) return;
        for (const entry of landed) void pageDraftJournal().removeDraft(entry.id);
        drafts = drafts.filter((entry) => !landed.has(entry));
    });
});

function expire() {
    now = Date.now();
    for (const [id, attempt] of recoveryApplyAttempts) {
        if (attempt.expiresAt <= now) forgetRecoveryAttempt(id);
    }
    drafts = drafts.filter((entry) => entry.createdAt + JOURNAL_ENTRY_TTL_MS > now);
    const needsExpiry = drafts.length > 0 || recoveryApplyAttempts.size > 0;
    if (needsExpiry && timer === undefined) timer = setInterval(expire, 60_000);
    if (!needsExpiry && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
    }
}

/**
 * A reactive view of durable drafts; exporting and dismissing the notice never remove them.
 * Discard requires confirmation before removing durable intent.
 */
export const recoveryDrafts = {
    get entries() {
        return entries;
    },
    get now() {
        return now;
    },
    get isOpen() {
        return isOpen;
    },
    get refreshing() {
        return refreshing;
    },
    replace(rows: DraftEntry[], currentEpoch: string) {
        refreshVersion += 1;
        epoch = currentEpoch;
        drafts = rows.filter(
            (entry) =>
                entry.scope !== "record" ||
                Object.values(entry.layers).every((layer) =>
                    isJournalEligible({
                        scope: "record",
                        kind: entry.target.split("\u0000")[0],
                        text: layer.value.text,
                    }),
                ),
        );
        expire();
    },
    async refresh() {
        const journal = pageDraftJournal();
        const version = ++refreshVersion;
        refreshing = true;
        try {
            const rows = await journal.listDrafts();
            // An unavailable journal can still offer displaced sends from this page.
            if (!journal.enabled) rows.push(...drafts.filter((entry) => entry.scope !== "composer"));
            if (version === refreshVersion) recoveryDrafts.replace(rows, getResourceEpoch());
        } finally {
            refreshing = false;
        }
    },
    async open() {
        isOpen = true;
        expire();
        try {
            await recoveryDrafts.refresh();
        } catch (error) {
            alertError(`${language.recoveryDrafts.refreshFailed}\n${String(error)}`);
        }
    },
    close() {
        isOpen = false;
    },
    isApplied(id: string) {
        return applied.has(id);
    },
    markApplied(id: string) {
        applied = new Set(applied).add(id);
    },
    /**
     * Called after confirmation for Discard, or after Apply has saved successfully. A failed delete keeps
     * the row, which would otherwise come back at the next boot, and throws.
     */
    async remove(id: string) {
        if (!(await pageDraftJournal().removeDraft(id))) throw new Error(language.recoveryDrafts.removeFailed);
        forgetRecoveryAttempt(id);
        refreshVersion += 1;
        drafts = drafts.filter((entry) => entry.id !== id);
        expire();
    },
    async discard(entry: DraftEntry, name: string) {
        if (await alertConfirm(language.recoveryDrafts.discardConfirm(name))) await recoveryDrafts.remove(entry.id);
    },
    async export(entry: DraftEntry) {
        const date = new Date(entry.createdAt).toISOString().replaceAll(":", "-");
        await downloadFile(`recovered-change-${date}.json`, JSON.stringify({ drafts: [entry] }, null, 2));
    },
};

export async function exportDrafts() {
    await downloadFile("recovered-changes.json", JSON.stringify({ drafts: recoveryDrafts.entries }, null, 2));
}
