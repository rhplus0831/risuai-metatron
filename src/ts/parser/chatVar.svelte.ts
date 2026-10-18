import { characterList, selectedCharacter } from "../storage/characterStore.svelte";
import { settings, activePreset, readPresetFieldOf, type PresetScope } from "../storage/settingsViews.svelte";
import { chatDisplayIds } from "../storage/chatBinding.svelte";
import { parseKeyValue } from "../util";
import { type ChatRef, currentChatRef, findChat, mergeChatMeta, selectedChat } from "../storage/chatStore.svelte";
import { getModuleToggles } from "../process/modules";
import { resolveGlobalChatVar, toggleDefinitionsText } from "../../../shared/prompt/toggles.ts";

/**
 * A chat variable of the selected chat, else its default: the character's, then the prompt preset's
 * (`scope`'s, a parse for a captured context; else the settings view's).
 */
export function getChatVar(key: string, scope?: PresetScope): string {
    const char = selectedCharacter();
    if (!char) {
        return "null";
    }
    const state = selectedChat()?.scriptstate?.["$" + key];
    if (state === undefined || state === null) {
        const presetDefaults = scope
            ? (readPresetFieldOf(scope, "templateDefaultVariables") as string | undefined)
            : activePreset.templateDefaultVariables;
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(presetDefaults ?? ""));
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

/**
 * Sets a chat variable of the selected chat: one `scriptstate` entry merged through the chat module
 * (`mergeChatMeta`), so variables another writer set meanwhile are kept.
 */
export function setChatVar(key: string, value: string): boolean {
    const chat = selectedChat();
    const ref = currentChatRef();
    const stateKey = "$" + key;
    if (!chat || !ref || chat.scriptstate?.[stateKey] === value) {
        return false;
    }
    mergeChatMeta(ref, "scriptstate", { [stateKey]: value });
    return true;
}

/**
 * `getChatVar` for a given chat (a caller that captured its chat before an await). The preset's
 * defaults are `scope`'s (a parse for a captured context, a `presetChain` pick included), else the
 * chat's display preset.
 */
export function getChatVarOf(ref: ChatRef | null, key: string, scope?: PresetScope): string {
    const char = ref ? characterList().find((entry) => entry?.chaId === ref.chaId) : undefined;
    if (!char) {
        return "null";
    }
    const state = findChat(ref)?.scriptstate?.["$" + key];
    if (state === undefined || state === null) {
        // The scope's preset, else the chat's display preset (`docs/plan/chat-binding.md`), never
        // the selected chat's.
        const presetDefaults = readPresetFieldOf(scope ?? chatDisplayIds(ref), "templateDefaultVariables") as
            string | undefined;
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(presetDefaults ?? ""));
        return defaultVariables.find((f) => f[0] === key)?.[1] ?? "null";
    }
    return state.toString();
}

/** `setChatVar` for a given chat (nothing when it is gone): one `scriptstate` entry merged. */
export function setChatVarOf(ref: ChatRef | null, key: string, value: string): boolean {
    const chat = ref ? findChat(ref) : undefined;
    const stateKey = "$" + key;
    if (!ref || !chat || chat.scriptstate?.[stateKey] === value) {
        return false;
    }
    mergeChatMeta(ref, "scriptstate", { [stateKey]: value });
    return true;
}

/** The preset, enabled modules, and owner definitions, read only when a toggle needs them. */
export function globalToggleDefinitions(ref?: ChatRef | null, scope?: PresetScope): string {
    const char = ref ? characterList().find((entry) => entry?.chaId === ref.chaId) : selectedCharacter();
    const presetText =
        scope || ref
            ? readPresetFieldOf(scope ?? chatDisplayIds(ref!), "customPromptTemplateToggle")
            : activePreset.customPromptTemplateToggle;
    return toggleDefinitionsText(
        presetText,
        getModuleToggles(ref, scope),
        char?.type !== "group" ? char?.customModuleToggle : "",
    );
}

/** `getGlobalChatVar` for a given chat; toggle defaults use its display preset or captured scope. */
export function getGlobalChatVarOf(ref: ChatRef | null, key: string, scope?: PresetScope): string {
    return resolveGlobalChatVar(
        key,
        ref ? findChat(ref)?.GLGlobalVariables : undefined,
        settings.globalChatVariables,
        () => globalToggleDefinitions(ref, scope),
    );
}

export function getGlobalChatVar(key: string, scope?: PresetScope): string {
    return resolveGlobalChatVar(key, selectedChat()?.GLGlobalVariables, settings.globalChatVariables, () =>
        globalToggleDefinitions(undefined, scope),
    );
}
