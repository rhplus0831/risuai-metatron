/** Group records stay in storage and sync, but the tab cannot open them. */
export function isArchivedGroup(character: { type?: unknown } | null | undefined): boolean {
    return character?.type === "group";
}
