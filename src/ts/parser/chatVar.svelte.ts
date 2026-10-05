import { settings, activePreset } from "../storage/settingsViews.svelte";
import { get } from "svelte/store";
import { DBState, selectedCharID } from "../stores.svelte";
import { parseKeyValue } from "../util";
import { getCurrentChat } from "../storage/database.svelte";
import { setCurrentChatMeta } from "../storage/chatEdits";
import { type ChatRef, findChat, setChatMeta } from "../storage/chatStore.svelte";

export function getChatVar(key: string): string {
    const selectedChar = get(selectedCharID);
    const char = DBState.db.characters[selectedChar];
    if (!char) {
        return "null";
    }
    const chat = char.chats[char.chatPage];
    const state = chat?.scriptstate?.["$" + key];
    if (state === undefined || state === null) {
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(
            parseKeyValue(activePreset.templateDefaultVariables),
        );
        const findResult = defaultVariables.find((f) => {
            return f[0] === key;
        });
        if (findResult) {
            return findResult[1];
        }
        return "null";
    }
    return state.toString();
}

/** Sets a chat variable of the selected chat (a `scriptstate` write through the chat module). */
export function setChatVar(key: string, value: string): boolean {
    const chat = getCurrentChat();
    const stateKey = "$" + key;
    if (!chat || chat.scriptstate?.[stateKey] === value) {
        return false;
    }
    setCurrentChatMeta({ scriptstate: { ...$state.snapshot(chat.scriptstate ?? {}), [stateKey]: value } });
    return true;
}

/** `getChatVar` for a given chat (a caller that captured its chat before an await). */
export function getChatVarOf(ref: ChatRef | null, key: string): string {
    const char = ref ? DBState.db.characters.find((entry) => entry?.chaId === ref.chaId) : undefined;
    if (!char) {
        return "null";
    }
    const state = findChat(ref)?.scriptstate?.["$" + key];
    if (state === undefined || state === null) {
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(
            parseKeyValue(activePreset.templateDefaultVariables),
        );
        return defaultVariables.find((f) => f[0] === key)?.[1] ?? "null";
    }
    return state.toString();
}

/** `setChatVar` for a given chat (nothing when it is gone). */
export function setChatVarOf(ref: ChatRef | null, key: string, value: string): boolean {
    const chat = ref ? findChat(ref) : undefined;
    const stateKey = "$" + key;
    if (!ref || !chat || chat.scriptstate?.[stateKey] === value) {
        return false;
    }
    setChatMeta(ref, { scriptstate: { ...$state.snapshot(chat.scriptstate ?? {}), [stateKey]: value } });
    return true;
}

export function getGLChatVar(key: string): string {
    console.log("getGLChatVar", key);
    const chat = getCurrentChat();
    return chat?.GLGlobalVariables?.[key];
}

export function setGLChatVar(key: string, value: string) {
    console.log("setGLChatVar", key, value);
    const chat = getCurrentChat();
    if (chat) {
        setCurrentChatMeta({ GLGlobalVariables: { ...$state.snapshot(chat.GLGlobalVariables ?? {}), [key]: value } });
    }
}

/** Removes a per-chat global variable of the selected chat. */
function deleteGLChatVar(key: string) {
    const chat = getCurrentChat();
    if (chat?.GLGlobalVariables && Object.hasOwn(chat.GLGlobalVariables, key)) {
        const next = { ...$state.snapshot(chat.GLGlobalVariables) };
        delete next[key];
        setCurrentChatMeta({ GLGlobalVariables: next });
    }
}

/** `getGlobalChatVar` for a given chat (its per-chat overrides; nothing local when it is gone). */
export function getGlobalChatVarOf(ref: ChatRef | null, key: string): string {
    const vt = ref ? findChat(ref)?.GLGlobalVariables?.[key] : undefined;
    if (vt !== "null" && vt) {
        return vt;
    }
    return settings.globalChatVariables[key] ?? "null";
}

export function getGlobalChatVar(key: string): string {
    const vt = getGLChatVar(key);
    if (vt !== "null" && vt) {
        return vt;
    }
    return settings.globalChatVariables[key] ?? "null";
}

export function setGlobalChatVar(key: string, value: string) {
    if (getCurrentChat()?.useLocallySetGlobalVariables) {
        setGLChatVar(key, value);
        return;
    } else if (getGLChatVar(key) !== undefined) {
        deleteGLChatVar(key);
    }
    settings.globalChatVariables[key] = value;
}

export function isLocallyHandledGlobalChatVar(key: string): boolean {
    return !!getGLChatVar(key);
}

export function removeLocallyHandledGlobalChatVar(key: string): boolean {
    if (getGLChatVar(key) !== undefined) {
        deleteGLChatVar(key);
        return true;
    }
    return false;
}
