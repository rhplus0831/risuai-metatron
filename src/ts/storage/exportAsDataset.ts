import { downloadFile } from "../globalApi.svelte";
import { alertError, alertNormal } from "../alert";
import { language } from "src/lang";
import { characterList } from "./characterStore.svelte";
import { readChatsDetached } from "./chatEdits";

/**
 * Downloads `dataset.json` as one entry per chat of each non-group character, pairing saved
 * messages with metadata captured before the read. `src/ts/storage/chatEdits.ts` supplies detached
 * server chats after flushing queued writes; a read failure is shown through `src/ts/alert.ts`
 * and aborts the export. A successful download is followed by a success alert.
 */

/**
 * Exports every chat of every character (not groups) as a dataset: the characters as they are when
 * the export starts, their chats as saved, read from the server (`readChatsDetached`, which saves
 * what is queued first and refuses when a conflict discarded a local change).
 */
export async function exportAsDataset() {
    const characters = characterList()
        .filter((char) => char && char.type !== "group")
        .map((char) => ({
            chaId: char.chaId,
            name: char.name,
            description: char.type === "group" ? undefined : char.desc,
            lorebook: JSON.parse(JSON.stringify(char.globalLore ?? [])),
        }));
    let chats: Awaited<ReturnType<typeof readChatsDetached>>;
    try {
        chats = await readChatsDetached(characters.map((char) => char.chaId));
    } catch (error) {
        alertError(error);
        return;
    }

    let dataset = [];
    for (const char of characters) {
        for (const chat of chats.get(char.chaId) ?? []) {
            dataset.push({
                name: char.name,
                description: char.description,
                chats: chat.message,
                lorebook: char.lorebook,
            });
        }
    }

    await downloadFile("dataset.json", Buffer.from(JSON.stringify(dataset, null, 4), "utf-8"));

    alertNormal(language.successExport);
}
