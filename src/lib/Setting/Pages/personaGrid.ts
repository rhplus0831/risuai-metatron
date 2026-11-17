/**
 * The reorder rule of the persona settings grid (`PersonaSettings.svelte`). The grid shows one view at a time (the
 * personas in no folder, or one folder's personas), so a drag reorders only the shown personas: they take, in their
 * new order, the list positions they held, and every persona not shown keeps its position. Pure: the page passes the
 * list in and assigns the result once.
 */

/**
 * The list with the shown personas reordered: the personas `shownIdsInNewOrder` names take, in that order, the list
 * positions those personas held, and every other entry keeps its position. A shown id that names no persona is
 * ignored, and so is a later repeat of an id. When the list holds an id more than once, only its first entry counts
 * as shown and the later ones keep their positions. The result is a new list of the same length with every entry of
 * `list` once; an empty shown list, or one naming no persona, returns a copy of `list`. The input is not changed.
 */
export function reorderShown<T extends { id: string }>(list: readonly T[], shownIdsInNewOrder: readonly string[]): T[] {
    const firstById = new Map<string, T>();
    for (const item of list) {
        if (!firstById.has(item.id)) {
            firstById.set(item.id, item);
        }
    }
    const shown = new Set<string>();
    const order: T[] = [];
    for (const id of shownIdsInNewOrder) {
        const item = firstById.get(id);
        if (item === undefined || shown.has(id)) {
            continue;
        }
        shown.add(id);
        order.push(item);
    }
    let next = 0;
    return list.map((item) => (shown.has(item.id) && firstById.get(item.id) === item ? order[next++] : item));
}
