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
    DBState.db.characterOrder = DBState.db.characterOrder ?? [];
    const ordered = new Set<string>();
    for (let i = 0; i < DBState.db.characterOrder.length; i++) {
        const folder = DBState.db.characterOrder[i];
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
                DBState.db.characterOrder.push(charId);
            }
        }
    }

    for (let i = 0; i < DBState.db.characterOrder.length; i++) {
        const data = DBState.db.characterOrder[i];
        if (typeof data !== "string") {
            if (!data) {
                DBState.db.characterOrder.splice(i, 1);
                i--;
                continue;
            }
            if (data.data.length === 0) {
                DBState.db.characterOrder.splice(i, 1);
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
            DBState.db.characterOrder[i] = data;
        } else {
            if (!charIdSet.has(data)) {
                DBState.db.characterOrder.splice(i, 1);
                i--;
            }
        }
    }
}
