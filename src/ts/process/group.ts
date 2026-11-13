import { characterList, selectedCharacter } from "../storage/characterStore.svelte";
import {
    appendMessage,
    chatOwnerToken,
    ensureChatLoaded,
    findChat,
    pinChat,
    selectedChatId,
} from "../storage/chatStore.svelte";
import { findCharacterbyId } from "../util";
import { alertConfirm, alertError, alertSelectChar } from "../alert";
import { language } from "src/lang";

/**
 * Edits a group's parallel member, talk-weight, and active arrays together. Adding captures the
 * group and chat ids before dialogs and resolves that same group again afterwards; an optional greeting is
 * appended through `src/ts/storage/chatStore.svelte.ts` before membership is added. Speaker
 * selection during generation belongs to the server, not these membership helpers.
 */

/**
 * Adds a picked character to the selected group, refused (`alreadyCharInGroup`) when it is a member
 * already. With the confirm, its first message is appended to the group's captured chat before it
 * joins. The member arrays `characters`, `characterTalks`, and `characterActive` are parallel and grow
 * together, written in place on the group.
 */
export async function addGroupChar() {
    const chaId = selectedCharacter()?.chaId;
    const firstChatId = chaId ? selectedChatId(chaId) : null;
    const ref = chaId && firstChatId !== null ? { chaId, chatId: firstChatId } : null;
    const owner = chaId ? chatOwnerToken(chaId) : undefined;
    // The group is found again after each dialog: the selection can change and the group can be deleted meanwhile.
    const groupOf = () => {
        const found = characterList().find((entry) => entry?.chaId === chaId);
        return found?.type === "group" && chatOwnerToken(found.chaId) === owner ? found : undefined;
    };
    if (groupOf()) {
        const res = await alertSelectChar();
        let group = groupOf();
        if (res && group) {
            if (group.characters.includes(res)) {
                alertError(language.errors.alreadyCharInGroup);
            } else {
                const loadFirstMessage = await alertConfirm(language.askLoadFirstMsg);
                const release = loadFirstMessage && ref ? pinChat(ref) : undefined;
                try {
                    const firstChat = loadFirstMessage && ref ? await ensureChatLoaded(ref) : undefined;
                    group = groupOf();
                    if (!group) {
                        return;
                    }
                    if (loadFirstMessage) {
                        // A missing captured destination cancels the action instead of using a later selection.
                        if (!ref || !firstChat || !findChat(ref)) {
                            return;
                        }
                        appendMessage(ref, {
                            role: "char",
                            data: findCharacterbyId(res).firstMessage,
                            saying: res,
                        });
                    }

                    group.characters.push(res);
                    group.characterTalks.push((1 / 6) * 4);
                    group.characterActive.push(true);
                } finally {
                    release?.();
                }
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
