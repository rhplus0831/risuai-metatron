import { selectedCharacter, characterList } from "../storage/characterStore.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { getChatVar, getChatVarOf, setChatVar, setChatVarOf } from "../parser/chatVar.svelte";
import { type Message, type loreBook } from "../storage/database.svelte";
import { tokenize } from "../tokenizer";
import { risuChatParser } from "../parser/parser.svelte";
import { findCharacterbyId, getUserName, pickHashRand, selectSingleFile } from "../util";
import { alertError, alertNormal } from "../alert";
import { language } from "../../lang";
import { downloadFile } from "../globalApi.svelte";
import { getModuleLorebooks } from "./modules";
import { activateLore } from "../../../shared/lore/activation.ts";
import { v4 } from "uuid";
import {
    type ChatRef,
    chatOwnerToken,
    currentChatRef,
    ensureChatLoaded,
    findChat,
    pinChat,
    selectedChat,
    setChatMeta,
} from "../storage/chatStore.svelte";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { findCharacter, updateCharacter } from "../storage/characterStore.svelte";
import { upgradeLorebook } from "../../../shared/modules.ts";

/** Appends entries to the selected chat's local lore (through the chat module). */
function appendLocalLore(entries: loreBook[]) {
    const ref = currentChatRef();
    const chat = ref ? findChat(ref) : undefined;
    if (ref && chat) {
        setChatMeta(ref, { localLore: [...$state.snapshot(chat.localLore ?? []), ...entries] });
    }
}

export function addLorebook(type: number) {
    const char = selectedCharacter();
    if (type === 0) {
        char.globalLore.push({
            key: "",
            comment: `New Lore ${char.globalLore.length + 1}`,
            content: "",
            mode: "normal",
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false,
        });
    } else {
        appendLocalLore([
            {
                key: "",
                comment: `New Lore ${(selectedChat()?.localLore?.length ?? 0) + 1}`,
                content: "",
                mode: "normal",
                insertorder: 100,
                alwaysActive: false,
                secondkey: "",
                selective: false,
            },
        ]);
    }
}

export function addLorebookFolder(type: number) {
    const char = selectedCharacter();
    const id = v4();
    if (type === 0) {
        char.globalLore.push({
            key: "\uf000folder:" + id,
            comment: `New Folder`,
            content: "",
            mode: "folder",
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false,
        });
    } else {
        appendLocalLore([
            {
                key: "\uf000folder:" + id,
                comment: `New Folder`,
                content: "",
                mode: "folder",
                insertorder: 100,
                alwaysActive: false,
                secondkey: "",
                selective: false,
            },
        ]);
    }
}

/**
 * The active lore of `chatRef`'s chat (default: the selected character's selected chat): the
 * shared activation (`shared/lore/activation.ts`) with the client's state.
 */
export async function loadLoreBookV3Prompt(chatRef?: ChatRef | null) {
    const ref = chatRef ?? currentChatRef();
    // The chat stays loaded for the whole activation (its variables are read and written as it goes).
    const release = ref ? pinChat(ref) : null;
    try {
        return await activatePinnedLore(ref);
    } finally {
        release?.();
    }
}

async function activatePinnedLore(ref: ChatRef | null) {
    const char = ref ? characterList().find((entry) => entry?.chaId === ref.chaId) : selectedCharacter();
    const lorechat = ref ? findChat(ref) : selectedChat();
    if (!lorechat) {
        // A chat that is not loaded (the selected one while it loads) has no lore to activate yet.
        throw new Error("The chat is not loaded");
    }
    // The chat's owner now: if its character's chats are replaced during the activation (even under
    // the same ids), its variables are not read or written there and the result is dropped.
    const owner = ref ? chatOwnerToken(ref.chaId) : null;
    const same = () => {
        if (ref && chatOwnerToken(ref.chaId) !== owner) {
            throw new Error("The chat changed during the lore activation");
        }
    };
    const result = await activateLore(
        {
            character: char,
            chat: lorechat,
            moduleLorebooks: getModuleLorebooks(ref),
            loreBookDepth: settings.memoryTranslateMedia.loreBookDepth,
            loreBookToken: settings.providers.loreBookToken,
            userName: getUserName(ref),
        },
        {
            clone: safeStructuredClone,
            findCharacterName: (id) => findCharacterbyId(id)?.name,
            getChatVar: (key) => {
                same();
                return getChatVarOf(ref, key);
            },
            setChatVar: (key, value) => {
                same();
                return setChatVarOf(ref, key, value);
            },
            pickHashRand,
            parseCBS: (text) => {
                same();
                return risuChatParser(text, { chara: char, chatRef: ref });
            },
            tokenize,
            testRegex: (pattern, flags, text) => new RegExp(pattern, flags).test(text),
        },
    );
    same();
    return result;
}

export async function importLoreBook(mode: "global" | "local" | "sglobal") {
    const chaId = selectedCharacter()?.chaId;
    // The chat (for local lore) is captured before the file dialog, so a chat switch cannot redirect
    // it, with its owner (a replacement of its character's chats meanwhile gets nothing).
    const chatTarget = mode === "local" ? currentChatRef() : null;
    const chatOwner = chatTarget ? chatOwnerToken(chatTarget.chaId) : null;
    const lore: loreBook[] = [];
    const lorebook = (await selectSingleFile(["json", "lorebook"])).data;
    if (!lorebook) {
        return;
    }

    try {
        const importedlore = JSON.parse(Buffer.from(lorebook).toString("utf-8"));
        if (importedlore.type === "risu" && importedlore.data) {
            const datas: loreBook[] = importedlore.data;
            for (const data of datas) {
                lore.push(data);
            }
        } else if (importedlore.entries) {
            const entries: { [key: string]: CCLorebook } = importedlore.entries;
            lore.push(...convertExternalLorebook(entries));
        }
        if (mode === "global") {
            // The character selected when the import started, by id; a character removed meanwhile gets nothing.
            const character = chaId === undefined ? undefined : findCharacter(chaId);
            if (character) {
                // Old entries in the file are converted as they enter (a refusal imports nothing); the
                // character's own entries keep their content.
                updateCharacter(chaId, { globalLore: [...(character.globalLore ?? []), ...upgradeLorebook(lore)] });
            }
        } else if (chatTarget) {
            // Loaded again: the dialog may have outlasted the chat's stay in memory.
            const chat = await ensureChatLoaded(chatTarget);
            if (chat && chatOwnerToken(chatTarget.chaId) === chatOwner) {
                setChatMeta(chatTarget, { localLore: [...$state.snapshot(chat.localLore ?? []), ...lore] });
            }
        }
    } catch (error) {
        alertError(error);
    }
}

export interface CCLorebook {
    key: string[];
    comment: string;
    content: string;
    order: number;
    constant: boolean;
    name: string;
    keywords: string[];
    priority: number;
    entry: string;
    secondary_keys: string[];
    selective: boolean;
    forceActivation: boolean;
    keys: string[];
    displayName: string;
    text: string;
    contextConfig?: {
        budgetPriority: number;
        prefix: string;
        suffix: string;
    };
}

export function convertExternalLorebook(entries: { [key: string]: CCLorebook }) {
    let lore: loreBook[] = [];
    for (const key in entries) {
        const currentLore = entries[key];
        lore.push({
            key: currentLore.key
                ? currentLore.key.join(", ")
                : currentLore.keys
                  ? currentLore.keys.join(", ")
                  : currentLore.keywords
                    ? currentLore.keywords.join(", ")
                    : "",
            insertorder: currentLore.order ?? currentLore.priority ?? currentLore?.contextConfig?.budgetPriority ?? 0,
            comment: currentLore.comment || currentLore.name || currentLore.displayName || "",
            content: currentLore.content || currentLore.entry || currentLore.text || "",
            mode: "normal",
            alwaysActive: currentLore.constant ?? currentLore.forceActivation ?? false,
            secondkey: currentLore.secondary_keys ? currentLore.secondary_keys.join(", ") : "",
            selective: currentLore.selective ?? false,
        });
    }
    return lore;
}

export async function exportLoreBook(mode: "global" | "local" | "sglobal") {
    try {
        const char = selectedCharacter();
        const chat = mode === "sglobal" ? undefined : selectedChat();
        const lore = mode === "global" ? char.globalLore : chat.localLore;
        const stringl = Buffer.from(
            JSON.stringify({
                type: "risu",
                ver: 1,
                data: lore,
            }),
            "utf-8",
        );

        await downloadFile(`lorebook_export.json`, stringl);

        alertNormal(language.successExport);
    } catch (error) {
        alertError(error);
    }
}
