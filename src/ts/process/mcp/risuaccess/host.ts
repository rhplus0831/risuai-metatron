import { language } from "src/lang";
import { alertConfirm } from "src/ts/alert";
import { findCharacter, updateCharacter } from "src/ts/storage/characterStore.svelte";
import { findModule, setModuleEnabled, updateModule } from "src/ts/storage/collectionStore.svelte";
import { MutationValidationError } from "src/ts/storage/mutationValidation";
import { DBState } from "src/ts/stores.svelte";
import type { RisuAccessHost, RisuAccessWrite } from "../../../../../shared/mcp/risuaccess/host.ts";
import { getCharacter } from "./utils";

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
 */
export const tabRisuAccessHost: RisuAccessHost = {
    getCharacter,
    findCharacter,
    characters: () => DBState.db.characters,
    currentMessages: async (char) => char.chats[char.chatPage].message,
    updateCharacter: (chaId, patch) => written(() => updateCharacter(chaId, patch)),
    modules: () => DBState.db.modules,
    enabledModules: () => DBState.db.enabledModules || [],
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
