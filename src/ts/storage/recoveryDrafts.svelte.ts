import { downloadFile } from "../globalApi.svelte";
import type { DraftEntry } from "./draftJournal";
import { isJournalEligible } from "./journalEligibility";

let drafts = $state.raw<DraftEntry[]>([]);
let epoch = $state("");
const entries = $derived(drafts.map((entry) => ({ ...entry, otherEpoch: entry.epoch !== epoch })));

/** A reactive view of durable drafts; exporting and dismissing the notice never remove them. */
export const recoveryDrafts = {
    get entries() {
        return entries;
    },
    replace(rows: DraftEntry[], currentEpoch: string) {
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
    },
};

export async function exportDrafts() {
    await downloadFile("recovered-changes.json", JSON.stringify({ drafts: recoveryDrafts.entries }, null, 2));
}
