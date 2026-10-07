import { characterList, selectedCharacter } from "../storage/characterStore.svelte";
import { appendMessage, ensureChatLoaded, selectedChatId } from "../storage/chatStore.svelte";
import shuffle from "lodash/shuffle";
import { findCharacterbyId } from "../util";
import { alertConfirm, alertError, alertSelectChar } from "../alert";
import { language } from "src/lang";

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

export function rmCharFromGroup(index: number) {
    const group = selectedCharacter();
    if (group?.type === "group") {
        group.characters.splice(index, 1);
        group.characterTalks.splice(index, 1);
        group.characterActive.splice(index, 1);
    }
}

export type GroupOrder = {
    id: string;
    talkness: number;
    index: number;
};

export function groupOrder(chars: GroupOrder[], input: string): GroupOrder[] {
    let order: GroupOrder[] = [];
    let ids: string[] = [];
    if (input) {
        const words = getWords(input);

        for (const word of words) {
            for (let char of chars) {
                const charNameChunks = getWords(findCharacterbyId(char.id).name);

                if (charNameChunks.includes(word)) {
                    order.push(char);
                    ids.push(char.id);
                    break;
                }
            }
        }
    }

    const shuffled = shuffle(chars);
    for (const char of shuffled) {
        if (ids.includes(char.id)) {
            continue;
        }

        const chance = char.talkness ?? 0.5;

        if (chance >= Math.random()) {
            order.push(char);
            ids.push(char.id);
        }
    }

    while (order.length === 0) {
        order.push(chars[Math.floor(Math.random() * chars.length)]);
    }

    return order;
}

function getWords(data: string) {
    const matches = data.split(/\n| /g);
    let words: string[] = [];
    if (!matches) {
        return [data];
    }
    for (const match of matches) {
        words.push(match.toLocaleLowerCase());
    }
    return words;
}
