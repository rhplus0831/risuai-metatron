import { settings } from "../../../storage/settingsViews.svelte";
import { language } from "src/lang";
import { alertConfirm } from "src/ts/alert";
import { findCharacter, updateCharacter, characterList } from "src/ts/storage/characterStore.svelte";
import { findModule, setModuleEnabled, updateModule } from "src/ts/storage/collectionStore.svelte";
import { MutationValidationError } from "src/ts/storage/mutationValidation";
import type { RisuAccessHost, RisuAccessWrite } from "../../../../../shared/mcp/risuaccess/host.ts";
import { getCharacter } from "./utils";
import { type ChatRef, ensureChatLoaded, selectedChatId } from "src/ts/storage/chatStore.svelte";

/** A mutation's outcome as the shared handlers take it: a refused value is an answer, not a throw. */
function written(write: () => boolean): RisuAccessWrite {
    try {
        return write() ? { ok: true } : { ok: false, notFound: true };
    } catch (error) {
        if (error instanceof MutationValidationError) {
            return { ok: false, error: error.message };
        }
        throw error;
    }
}

/**
 * The RisuAccess tools' host in the tab (`shared/mcp/risuaccess/host.ts`): the mirror records, the
 * mutation modules, and the consent prompt. The handlers themselves are shared with the server.
 *
 * `chatRef` is the chat a request's tool call is for (`callMCPTool`): an empty character id names its
 * character, and that character's history is that chat, as a server job's scope does
 * (`server/src/mcp/internal.ts`). Another character's history is its selected chat in this tab.
 * `null` is a request without a chat: an empty id names no character. `undefined` (a call without a
 * request, the Playground) keeps the selection.
 */
export function tabRisuAccessHostFor(chatRef: ChatRef | null | undefined): RisuAccessHost {
    return {
        getCharacter: (id) => {
            if (id || chatRef === undefined) {
                return getCharacter(id);
            }
            return chatRef ? findCharacter(chatRef.chaId) : undefined;
        },
        findCharacter,
        characters: () => characterList(),
        // The request's chat for its character, else the character's selected chat in this tab, loaded first.
        currentMessages: async (char) => {
            const chatId = chatRef && char.chaId === chatRef.chaId ? chatRef.chatId : selectedChatId(char.chaId);
            return chatId === null ? [] : ((await ensureChatLoaded({ chaId: char.chaId, chatId }))?.message ?? []);
        },
        updateCharacter: (chaId, patch) => written(() => updateCharacter(chaId, patch)),
        modules: () => settings.modules,
        enabledModules: () => settings.enabledModules || [],
        findModule,
        updateModule: (id, patch, enabled) => {
            const result = written(() => updateModule(id, patch));
            if (result.ok && enabled !== undefined) {
                setModuleEnabled(id, enabled);
            }
            return result;
        },
        confirm: (tool, action) =>
            alertConfirm(language.mcpAccessPrompt.replace("{{tool}}", tool).replace("{{action}}", action)),
    };
}

/** The host for a call without a request: the selected character and chat. */
export const tabRisuAccessHost: RisuAccessHost = tabRisuAccessHostFor(undefined);
