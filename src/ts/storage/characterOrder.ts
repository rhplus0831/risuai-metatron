import type { Database } from "../../../shared/database.ts";
import { DBState } from "../stores.svelte";

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
    const original = JSON.stringify(DBState.db.characterOrder ?? []);
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

    for (let i = 0; i < DBState.db.characters.length; i++) {
        const char = DBState.db.characters[i];
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
    if (DBState.db.characterOrder === undefined || JSON.stringify(order) !== original) {
        DBState.db.characterOrder = order;
    }
}
