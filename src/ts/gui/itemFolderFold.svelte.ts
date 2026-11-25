import type { ItemFolderKind } from "../storage/collectionStore.svelte";

/**
 * Which module or persona folders are folded on this device: one `localStorage` list of folder ids per folder kind.
 * A folder is open by default. Folding writes nothing to the server, so it never conflicts and another device keeps
 * its own state. A write that `localStorage` refuses keeps the list in memory for this tab; a write re-renders the
 * mounted lists of this tab.
 */

const STORAGE_KEYS: Record<ItemFolderKind, string> = {
    moduleFolders: "risu-module-folders-folded",
    personaFolders: "risu-persona-folders-folded",
};
const unsaved: Partial<Record<ItemFolderKind, string[]>> = {};
let foldRevision = $state(0);

function foldedIds(kind: ItemFolderKind): string[] {
    const kept = unsaved[kind];
    if (kept) return kept;
    try {
        const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS[kind]) ?? "[]");
        return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

/** Whether the folder with `folderId` is folded on this device (open by default). */
export function isFolderFolded(kind: ItemFolderKind, folderId: string): boolean {
    // Storage itself is not reactive; a write also invalidates mounted lists in this tab.
    void foldRevision;
    return foldedIds(kind).includes(folderId);
}

/**
 * Folds or unfolds the folder with `folderId`. `existingIds` are the ids of the folders that exist now: the stored
 * list keeps only those, so ids of deleted folders are dropped on the write.
 */
export function setFolderFolded(
    kind: ItemFolderKind,
    folderId: string,
    folded: boolean,
    existingIds: readonly string[],
): void {
    const existing = new Set(existingIds);
    const ids = new Set(foldedIds(kind).filter((id) => existing.has(id)));
    if (folded && existing.has(folderId)) {
        ids.add(folderId);
    } else {
        ids.delete(folderId);
    }
    const next = [...ids];
    try {
        localStorage.setItem(STORAGE_KEYS[kind], JSON.stringify(next));
        delete unsaved[kind];
    } catch {
        unsaved[kind] = next;
    }
    foldRevision++;
}
