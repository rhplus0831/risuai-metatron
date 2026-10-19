import type { Database } from "../../../shared/database.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { characterList } from "./characterStore.svelte";
import { readRefs } from "./resourceClient";
import { settings } from "./settingsViews.svelte";

/**
 * Checks and updates the character order in the database (the `characterOrder` mutation: every
 * character add, remove, restore, and import ends here). Characters missing from the order are
 * appended, and entries naming no live character are removed. A folder is dropped when it is empty
 * before its members are filtered, so a folder emptied by the filtering goes on the next call; a
 * folder without a member list counts as empty (it used to throw).
 * `globalApi.svelte.ts` re-exports it for its existing callers and the plugin API.
 */
export function checkCharOrder() {
    // Repaired on a plain copy and installed once (one queued write of the `characterOrder` record).
    const original = JSON.stringify(settings.characterOrder ?? []);
    const order = JSON.parse(original) as Database["characterOrder"];
    const ordered = new Set<string>();
    for (let i = 0; i < order.length; i++) {
        const folder = order[i];
        if (typeof folder !== "string" && folder) {
            // A malformed folder (no member list) counts as empty, so it is dropped below.
            if (!Array.isArray(folder.data)) {
                folder.data = [];
            }
            for (const f of folder.data) {
                ordered.add(f);
            }
        }
        if (typeof folder === "string") {
            ordered.add(folder);
        }
    }

    const charIdSet = new Set<string>();

    const characters = characterList();
    for (let i = 0; i < characters.length; i++) {
        const char = characters[i];
        const charId = char.chaId;
        if (!char.trashTime) {
            charIdSet.add(charId);
        }
        if (!ordered.has(charId)) {
            if (charId !== "§playground" && !char.trashTime) {
                order.push(charId);
            }
        }
    }

    for (let i = 0; i < order.length; i++) {
        const data = order[i];
        if (typeof data !== "string") {
            if (!data) {
                order.splice(i, 1);
                i--;
                continue;
            }
            if (data.data.length === 0) {
                order.splice(i, 1);
                i--;
                continue;
            }
            for (let i2 = 0; i2 < data.data.length; i2++) {
                const data2 = data.data[i2];
                if (!charIdSet.has(data2)) {
                    data.data.splice(i2, 1);
                    i2--;
                }
            }
        } else {
            if (!charIdSet.has(data)) {
                order.splice(i, 1);
                i--;
            }
        }
    }
    if (settings.characterOrder === undefined || JSON.stringify(order) !== original) {
        settings.characterOrder = order;
    }
}

/** Most character refs one read of the remote repair names (the server takes 5,000 entries per read). */
const REPAIR_READ_CHUNK = 1000;

/**
 * Whether a remote repair is queued or running, and the count of remote orders announced so far (an
 * attempt whose count moved during its reads is stale).
 */
const remoteRepair = { running: false, seq: 0 };

/**
 * Repairs the order after the save adapter brought another writer's `characterOrder` into the mirror
 * (a conflict reload, a live update's patch or whole record: `onRemoteRecordApplied`, registered at
 * boot): a character created here that the server's order lacks (another tab wrote the order while
 * this tab's create and order write were refused together) is appended at the root, as
 * `checkCharOrder` would. The repair only adds: it never removes or moves an entry, so an entry
 * naming a character this tab has not read yet (a capped read applies the order first) keeps its
 * folder. This tab's copy of a character may be older than the order (another tab's trash or delete
 * not applied here yet, a create whose answer was lost), so every candidate (a live character the
 * order lists nowhere) is read from the server, in chunks, and appended only when the server holds a
 * copy that is not trashed, or none while this tab holds no saved revision of it (`heldRevision`,
 * taken before the read: its own unsaved create). A read is dropped when another remote order arrived
 * or the order changed here during it, and the repair starts over from the newest order until an
 * attempt ends with the order unchanged; nothing is appended from a dropped read. A failed read ends
 * the repair (logged) unless a newer order arrived meanwhile: the next remote order, or the next
 * `checkCharOrder`, repairs again. It starts in a microtask, after the synchronous apply step that
 * announced the order, reads only when there is a candidate, and writes once, only when it appends,
 * so the write it queues comes back with nothing to append.
 */
export function queueRemoteCharOrderRepair(heldRevision: (chaId: string) => string | null) {
    remoteRepair.seq += 1;
    if (remoteRepair.running) {
        return;
    }
    remoteRepair.running = true;
    queueMicrotask(async () => {
        try {
            for (;;) {
                const seq = remoteRepair.seq;
                let outcome: "done" | "stale" | "failed";
                try {
                    outcome = await appendMissingCharacters(seq, heldRevision);
                } catch (error) {
                    console.error("[Save]", error);
                    outcome = "failed";
                }
                if (outcome !== "stale" && remoteRepair.seq === seq) {
                    return;
                }
            }
        } finally {
            remoteRepair.running = false;
        }
    });
}

/** The live characters this tab holds that the order lists nowhere (`checkCharOrder`'s appends). */
function unorderedCharacters(): string[] {
    const order = settings.characterOrder;
    const ordered = new Set<string>();
    for (const entry of Array.isArray(order) ? order : []) {
        if (typeof entry === "string") {
            ordered.add(entry);
        } else if (entry && Array.isArray(entry.data)) {
            for (const id of entry.data) {
                ordered.add(id);
            }
        }
    }
    return characterList()
        .filter((char) => char.chaId !== "§playground" && !char.trashTime && !ordered.has(char.chaId))
        .map((char) => char.chaId);
}

/** One attempt of the remote repair (`queueRemoteCharOrderRepair`); "stale" when its reads were dropped. */
async function appendMissingCharacters(
    seq: number,
    heldRevision: (chaId: string) => string | null,
): Promise<"done" | "stale"> {
    const before = JSON.stringify(settings.characterOrder ?? []);
    const candidates = unorderedCharacters();
    const appendable = new Set<string>();
    for (let start = 0; start < candidates.length; start += REPAIR_READ_CHUNK) {
        const chunk = candidates.slice(start, start + REPAIR_READ_CHUNK);
        const unsaved = new Set(chunk.filter((id) => heldRevision(id) === null));
        const read = await readRefs(chunk.map((id) => ({ kind: RESOURCE_KIND.characters, id })));
        if (remoteRepair.seq !== seq || JSON.stringify(settings.characterOrder ?? []) !== before) {
            return "stale";
        }
        for (const item of read.items) {
            const live =
                item.revision === null
                    ? unsaved.has(item.id)
                    : !(item.data as { trashTime?: unknown } | null)?.trashTime;
            if (live) {
                appendable.add(item.id);
            }
        }
    }
    // The characters may have changed during the reads: only those still unordered are appended.
    const missing = unorderedCharacters().filter((id) => appendable.has(id));
    if (missing.length > 0) {
        settings.characterOrder = [
            ...(JSON.parse(JSON.stringify(settings.characterOrder ?? [])) as Database["characterOrder"]),
            ...missing,
        ];
    }
    return "done";
}
