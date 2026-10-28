import { downloadFile } from "../globalApi.svelte";
import { language } from "src/lang";
import { alertConfirm, alertError } from "../alert";
import { JOURNAL_ENTRY_TTL_MS, pageDraftJournal, type DraftEntry } from "./draftJournal";
import { isJournalEligible } from "./journalEligibility";
import { getResourceEpoch } from "./resourceClient";

let drafts = $state.raw<DraftEntry[]>([]);
let epoch = $state("");
let now = $state(Date.now());
let isOpen = $state(false);
let refreshing = $state(false);
let timer: ReturnType<typeof setInterval> | undefined;
let refreshVersion = 0;
const entries = $derived(
    drafts
        .filter((entry) => entry.createdAt + JOURNAL_ENTRY_TTL_MS > now)
        .map((entry) => ({ ...entry, otherEpoch: entry.epoch !== epoch })),
);

function expire() {
    now = Date.now();
    drafts = drafts.filter((entry) => entry.createdAt + JOURNAL_ENTRY_TTL_MS > now);
    if (drafts.length > 0 && timer === undefined) timer = setInterval(expire, 60_000);
    if (drafts.length === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
    }
}

/** A reactive view of durable drafts; exporting and dismissing the notice never remove them. */
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
        if (!journal.enabled) return;
        const version = ++refreshVersion;
        refreshing = true;
        try {
            const rows = await journal.listDrafts();
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
    /** Called after confirmation for Discard, or after Apply has saved successfully. */
    async remove(id: string) {
        await pageDraftJournal().removeDraft(id);
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
