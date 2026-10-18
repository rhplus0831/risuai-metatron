/**
 * The folder a chat is listed under: the first of `folders` whose id is the chat's `folderId`, or
 * null for a chat without one or whose folder does not exist. A dangling id (a folder deleted while
 * another tab moved a chat into it, or a folder write refused while the chat's `folderId` saved) is
 * read as unfiled, so the chat lists at the root instead of nowhere; the id itself is left as stored.
 */
export function chatFolderOf<F extends { id: string }>(
    chat: { folderId?: string | null },
    folders: readonly F[] | null | undefined,
): F | null {
    if (chat.folderId == null) {
        return null;
    }
    return folders?.find((folder) => folder.id === chat.folderId) ?? null;
}
