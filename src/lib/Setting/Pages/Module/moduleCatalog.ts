import { groupByFolder, type ItemFolder } from "../../../../../shared/itemFolders.ts";
import { matchesAny, type PreparedQuery } from "src/ts/util/koreanSearch";

/**
 * The row order the module catalog (`ModuleSettings.svelte`) and the chat's module menu (`ModuleChatMenu.svelte`)
 * share, the module folder choices of the catalog's move dialog, and the folder rows' "switch all" rules. Pure: the
 * components pass the settings lists in and write the results back.
 */

/** What a catalog row needs of a module: its id and its (possibly missing) name. */
export type CatalogModule = { readonly id: string; readonly name?: string };

/** The name order of both lists: case-folded `localeCompare`, a missing name as an empty string. */
export function compareByName(a: { readonly name?: string }, b: { readonly name?: string }): number {
    return (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase());
}

/** A folder of the catalog: its modules as listed (search matches only while searching) and every member's id. */
export type CatalogFolder<T extends CatalogModule> = {
    folder: ItemFolder;
    /** The modules shown under the folder, by name. */
    modules: T[];
    /**
     * The ids of every module the read rules place in this folder, whatever the search: what the folder's count and
     * "switch all" buttons act on. A member id that names no module is not here.
     */
    memberIds: string[];
};

export type ModuleCatalog<T extends CatalogModule> = {
    /** The folders by name; while searching only those with a match. */
    folders: CatalogFolder<T>[];
    /** The modules no folder holds, by name; while searching only the matches. */
    root: T[];
    /** A query is set: every listed folder shows open whatever its fold state. */
    searching: boolean;
};

/**
 * The folders by name, each with its modules by name, then the root modules by name. Membership is resolved with the
 * folders in their stored order (`groupByFolder`) before the folder rows are sorted, so a module several folders
 * list belongs to the first of them. With a query only the modules whose name matches are listed and a folder with
 * no match is left out; without one an empty folder is listed too.
 */
export function moduleCatalog<T extends CatalogModule>(
    modules: readonly T[],
    folders: readonly ItemFolder[],
    query: PreparedQuery | null,
): ModuleCatalog<T> {
    const groups = groupByFolder(modules, folders);
    const shown = (items: readonly T[]) =>
        items.filter((module) => !query || matchesAny([module.name], query)).sort(compareByName);
    const catalogFolders = groups.folders
        .map(({ folder, items }) => ({
            folder,
            modules: shown(items),
            memberIds: [...new Set(items.map((module) => module.id))],
        }))
        .filter((entry) => !query || entry.modules.length > 0)
        .sort((a, b) => compareByName(a.folder, b.folder));
    return { folders: catalogFolders, root: shown(groups.root), searching: query !== null };
}

/** One rendered row of a catalog: a folder row, or a module row under a folder (`folderId`) or at the root. */
export type CatalogRow<T extends CatalogModule> =
    ({ type: "folder"; open: boolean } & CatalogFolder<T>) | { type: "module"; module: T; folderId: string | null };

/**
 * The catalog flattened into rows: each folder row, then its module rows unless it is folded and no query is set,
 * then the root module rows.
 */
export function catalogRows<T extends CatalogModule>(
    catalog: ModuleCatalog<T>,
    isFolded: (folderId: string) => boolean,
): CatalogRow<T>[] {
    const rows: CatalogRow<T>[] = [];
    for (const entry of catalog.folders) {
        const open = catalog.searching || !isFolded(entry.folder.id);
        rows.push({ type: "folder", open, ...entry });
        if (open) {
            for (const module of entry.modules) {
                rows.push({ type: "module", module, folderId: entry.folder.id });
            }
        }
    }
    for (const module of catalog.root) {
        rows.push({ type: "module", module, folderId: null });
    }
    return rows;
}

/** A folder's name as shown: a blank one is `unnamedLabel`. Stored names are not changed. */
export function folderDisplayName(name: string, unnamedLabel: string): string {
    return name.trim() === "" ? unnamedLabel : name;
}

/** One choice of the move dialog: a folder id, or `null` for "No folder". */
export type FolderChoice = { id: string | null; label: string };

// `alertSelect` joins its options with `||`; a fullwidth bar keeps a label in one piece.
function selectSafe(label: string): string {
    return label.replaceAll("|", "｜");
}

/**
 * The move dialog's choices: the folder ids by name, then `null` for "No folder", each with one label. A blank name
 * shows as `unnamedLabel`, and every ASCII `|` of a label shows as `｜` (U+FF5C) so `alertSelect`'s `||` encoding
 * cannot split it.
 */
export function folderChoices(
    folders: readonly ItemFolder[],
    unnamedLabel: string,
    noFolderLabel: string,
): FolderChoice[] {
    return [
        ...[...folders]
            .sort(compareByName)
            .map((folder) => ({ id: folder.id, label: selectSafe(folderDisplayName(folder.name, unnamedLabel)) })),
        { id: null, label: selectSafe(noFolderLabel) },
    ];
}

/**
 * The choice an `alertSelect` answer picks from the captured `choices`, or `null` (no action) when the answer is not
 * a non-negative integer index within the list: cancel and Escape answer `""`.
 */
export function choiceForAnswer(choices: readonly FolderChoice[], answer: string): FolderChoice | null {
    if (!/^\d+$/.test(answer)) {
        return null;
    }
    return choices[Number(answer)] ?? null;
}

/** Whether the folder has members and every one is globally enabled (its globe shows blue). */
export function allMembersEnabled(memberIds: readonly string[], enabledModules: readonly string[]): boolean {
    return memberIds.length > 0 && memberIds.every((id) => enabledModules.includes(id));
}

/**
 * The folder's global switch: when every member is in `enabledModules`, the list without them; otherwise the list
 * with the missing members appended. A new list, for one assignment of `enabledModules`.
 */
export function switchAllGlobally(memberIds: readonly string[], enabledModules: readonly string[]): string[] {
    if (memberIds.every((id) => enabledModules.includes(id))) {
        const members = new Set(memberIds);
        return enabledModules.filter((id) => !members.has(id));
    }
    return [...enabledModules, ...memberIds.filter((id) => !enabledModules.includes(id))];
}

/** The members the chat switch acts on: those not globally enabled (the menu disables their own toggles). */
export function chatSwitchTargets(memberIds: readonly string[], enabledModules: readonly string[]): string[] {
    return memberIds.filter((id) => !enabledModules.includes(id));
}

/** Whether the folder has chat switch targets and every one is in the chat's `modules` (its check shows blue). */
export function allTargetsInChat(
    memberIds: readonly string[],
    enabledModules: readonly string[],
    chatModules: readonly string[],
): boolean {
    const targets = chatSwitchTargets(memberIds, enabledModules);
    return targets.length > 0 && targets.every((id) => chatModules.includes(id));
}

/**
 * The folder's chat switch: when every target is in the chat's `modules`, the list without them; otherwise the list
 * with the missing targets appended. A new list, for one `setCurrentChatMeta({ modules })`.
 */
export function switchAllForChat(
    memberIds: readonly string[],
    enabledModules: readonly string[],
    chatModules: readonly string[],
): string[] {
    const targets = chatSwitchTargets(memberIds, enabledModules);
    if (targets.every((id) => chatModules.includes(id))) {
        const removed = new Set(targets);
        return chatModules.filter((id) => !removed.has(id));
    }
    return [...chatModules, ...targets.filter((id) => !chatModules.includes(id))];
}

/** The chat menu's "on / total" of a folder: on is globally enabled or in the chat's `modules`. */
export function chatOnCount(
    memberIds: readonly string[],
    enabledModules: readonly string[],
    chatModules: readonly string[],
): { on: number; total: number } {
    const on = memberIds.filter((id) => enabledModules.includes(id) || chatModules.includes(id)).length;
    return { on, total: memberIds.length };
}
