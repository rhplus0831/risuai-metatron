import { settings } from "../storage/settingsViews.svelte";
import { get } from "svelte/store";
import { getChatVar, getChatVarOf, setChatVar, setChatVarOf } from "../parser/chatVar.svelte";
import { selectedCharID } from "../stores.svelte";
import { type Message, type loreBook } from "../storage/database.svelte";
import { DBState } from "../stores.svelte";
import { tokenize } from "../tokenizer";
import { risuChatParser } from "../parser/parser.svelte";
import { findCharacterbyId, getUserName, pickHashRand, selectSingleFile } from "../util";
import { alertError, alertNormal } from "../alert";
import { language } from "../../lang";
import { downloadFile } from "../globalApi.svelte";
import { getModuleLorebooks } from "./modules";
import { activateLore } from "../../../shared/lore/activation.ts";
import { v4 } from "uuid";
import { type ChatRef, currentChatRef, findChat, setChatMeta } from "../storage/chatStore.svelte";
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
    const selectedID = get(selectedCharID);
    if (type === 0) {
        DBState.db.characters[selectedID].globalLore.push({
            key: "",
            comment: `New Lore ${DBState.db.characters[selectedID].globalLore.length + 1}`,
            content: "",
            mode: "normal",
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false,
        });
    } else {
        const page = DBState.db.characters[selectedID].chatPage;
        appendLocalLore([
            {
                key: "",
                comment: `New Lore ${DBState.db.characters[selectedID].chats[page].localLore.length + 1}`,
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
    const selectedID = get(selectedCharID);
    const id = v4();
    if (type === 0) {
        DBState.db.characters[selectedID].globalLore.push({
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
    const char = ref
        ? DBState.db.characters.find((entry) => entry?.chaId === ref.chaId)
        : DBState.db.characters[get(selectedCharID)];
    const lorechat = ref ? findChat(ref) : char.chats[char.chatPage];
    return await activateLore(
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
            getChatVar: (key) => getChatVarOf(ref, key),
            setChatVar: (key, value) => setChatVarOf(ref, key, value),
            pickHashRand,
            parseCBS: (text) => risuChatParser(text, { chara: char, chatRef: ref }),
            tokenize,
            testRegex: (pattern, flags, text) => new RegExp(pattern, flags).test(text),
        },
    );
}

export async function importLoreBook(mode: "global" | "local" | "sglobal") {
    const selectedID = get(selectedCharID);
    const chaId = DBState.db.characters[selectedID]?.chaId;
    // The chat (for local lore) is captured before the file dialog, so a chat switch cannot redirect it.
    const chatTarget = mode === "local" ? currentChatRef() : null;
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
            const chat = findChat(chatTarget);
            if (chat) {
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
        const selectedID = get(selectedCharID);
        const page = mode === "sglobal" ? -1 : DBState.db.characters[selectedID].chatPage;
        const lore =
            mode === "global"
                ? DBState.db.characters[selectedID].globalLore
                : DBState.db.characters[selectedID].chats[page].localLore;
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
