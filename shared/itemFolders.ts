import { isRecordId, newId, normalizeIdList } from "./ids.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * The one-level folders of the module list and the persona list (the `moduleFolders` and
 * `personaFolders` collections). A folder only names its members: the item list decides what is
 * listed and in what order, and the folders are read over it by three rules. An item no folder
 * names is at the root; an item several folders name belongs to the first of them in list order;
 * an id that names no item is ignored and left as stored. No pass repairs a folder list, so every
 * reader goes through `folderOfItem` or `groupByFolder`.
 */

/** A named folder; `data` holds the member ids (module ids or persona ids), and its order means nothing. */
export type ItemFolder = {
    id: string;
    name: string;
    data: string[];
};

/**
 * Normalizes plain data without mutating it, applied by the server to both folder collections:
 * anything that is not a list becomes `[]`, entries that are not objects are dropped (the server
 * rejects them first), and each entry keeps only `id`, `name`, and `data`, in that key order. An
 * invalid id, or one an earlier entry has, gets a fresh one; a `name` that is not a string becomes
 * `""`; `data` becomes its non-blank strings, each once, in first-occurrence order
 * (`normalizeIdList`). An id two folders list stays in both (the read rules decide). Normalizing
 * the output again preserves its JSON.
 */
export function normalizeItemFolders(input: unknown): ItemFolder[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const seen = new Set<string>();
    const folders: ItemFolder[] = [];
    for (const entry of input) {
        if (!isPlainObject(entry)) {
            continue;
        }
        const id = isRecordId(entry.id) && !seen.has(entry.id) ? entry.id : newId();
        seen.add(id);
        folders.push({
            id,
            name: typeof entry.name === "string" ? entry.name : "",
            data: normalizeIdList(entry.data),
        });
    }
    return folders;
}

/** A new folder in canonical form: a fresh id, the given name, and no members. */
export function createItemFolder(name: string): ItemFolder {
    return { id: newId(), name, data: [] };
}

/** The folder `itemId` belongs to: the first one in list order that lists it, or null (the root). */
export function folderOfItem(folders: readonly ItemFolder[], itemId: string): ItemFolder | null {
    return folders.find((folder) => folder.data.includes(itemId)) ?? null;
}

/** `groupByFolder`'s result: every folder with its items, and the items no folder names. */
export type FolderGroups<T> = {
    folders: { folder: ItemFolder; items: T[] }[];
    root: T[];
};

/**
 * Sorts `items` into `folders` by the read rules: every folder appears, in list order, with the
 * items that belong to it (an empty folder with none), and `root` holds the rest. Each item appears
 * once, in the order `items` came in; a member id that names no item adds nothing.
 */
export function groupByFolder<T extends { readonly id: string }>(
    items: readonly T[],
    folders: readonly ItemFolder[],
): FolderGroups<T> {
    const groups = folders.map((folder) => ({ folder, items: [] as T[] }));
    const groupOf = new Map<string, T[]>();
    for (const group of groups) {
        for (const id of group.folder.data) {
            if (!groupOf.has(id)) {
                groupOf.set(id, group.items);
            }
        }
    }
    const root: T[] = [];
    for (const item of items) {
        (groupOf.get(item.id) ?? root).push(item);
    }
    return { folders: groups, root };
}

/**
 * A new list where `itemId` is in no folder but the one with `folderId`: it is removed from every
 * other folder and added to the target when the target lacks it. `null`, or an id no folder has,
 * leaves the item at the root. The input is not changed; a folder the move does not touch is the
 * same object in the result, and a changed one is a new canonical object.
 */
export function withItemInFolder(
    folders: readonly ItemFolder[],
    itemId: string,
    folderId: string | null,
): ItemFolder[] {
    const target = folderId === null ? undefined : folders.find((folder) => folder.id === folderId);
    return folders.map((folder) => {
        const listed = folder.data.includes(itemId);
        if (listed === (folder === target)) {
            return folder;
        }
        return {
            id: folder.id,
            name: folder.name,
            data: listed ? folder.data.filter((id) => id !== itemId) : [...folder.data, itemId],
        };
    });
}

/** A new list where no folder lists `itemId` (`withItemInFolder` with no target): what a deleted item leaves. */
export function withoutItem(folders: readonly ItemFolder[], itemId: string): ItemFolder[] {
    return withItemInFolder(folders, itemId, null);
}

/**
 * Whether `next`, a list `withItemInFolder` or `withoutItem` made from `folders`, differs from it:
 * those keep the length and reuse every untouched folder, so one replaced object means a change.
 */
export function itemFoldersChanged(folders: readonly ItemFolder[], next: readonly ItemFolder[]): boolean {
    return next.length !== folders.length || next.some((folder, index) => folder !== folders[index]);
}
