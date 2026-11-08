import { characterList, selectedCharacter } from "../storage/characterStore.svelte";
import { appendMessage, ensureChatLoaded, selectedChatId } from "../storage/chatStore.svelte";
import { findCharacterbyId } from "../util";
import { alertConfirm, alertError, alertSelectChar } from "../alert";
import { language } from "src/lang";

/**
 * Edits a group's parallel member, talk-weight, and active arrays together. Adding captures the
 * group id before dialogs and resolves that same group again afterwards; an optional greeting is
 * appended through `src/ts/storage/chatStore.svelte.ts` before membership is added. Speaker
 * selection during generation belongs to the server, not these membership helpers.
 */

/**
 * Adds a picked character to the selected group, refused (`alreadyCharInGroup`) when it is a member
 * already. With the confirm, its first message is appended to the group's selected chat before it
 * joins. The member arrays `characters`, `characterTalks`, and `characterActive` are parallel and grow
 * together, written in place on the group.
 */
export async function addGroupChar() {
    const chaId = selectedCharacter()?.chaId;
    // The group is found again after each dialog: the selection can change and the group can be deleted meanwhile.
    const groupOf = () => {
        const found = characterList().find((entry) => entry?.chaId === chaId);
        return found?.type === "group" ? found : undefined;
    };
    if (groupOf()) {
        const res = await alertSelectChar();
        let group = groupOf();
        if (res && group) {
            if (group.characters.includes(res)) {
                alertError(language.errors.alreadyCharInGroup);
            } else {
                const loadFirstMessage = await alertConfirm(language.askLoadFirstMsg);
                // The captured group's selected chat (not whatever character is selected now), loaded.
                const firstChatId = group ? selectedChatId(group.chaId) : null;
                const firstChat =
                    loadFirstMessage && group && firstChatId !== null
                        ? await ensureChatLoaded({ chaId: group.chaId, chatId: firstChatId })
                        : undefined;
                group = groupOf();
                if (!group) {
                    return;
                }
                if (loadFirstMessage) {
                    const chatId = firstChat ? firstChatId : null;
                    if (chatId !== null) {
                        appendMessage(
                            { chaId: group.chaId, chatId },
                            { role: "char", data: findCharacterbyId(res).firstMessage, saying: res },
                        );
                    }
                }

                group.characters.push(res);
                group.characterTalks.push((1 / 6) * 4);
                group.characterActive.push(true);
            }
        }
    }
}

/** Removes member `index` from the selected group's three parallel member arrays together; nothing for a character. */
export function rmCharFromGroup(index: number) {
    const group = selectedCharacter();
    if (group?.type === "group") {
        group.characters.splice(index, 1);
        group.characterTalks.splice(index, 1);
        group.characterActive.splice(index, 1);
    }
}
