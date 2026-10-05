import { selectedCharacter, characterList } from "../../../storage/characterStore.svelte";
import type { DeepReadonly } from "../../../../../shared/readonly.ts";
import { type character, type groupChat } from "src/ts/storage/database.svelte";

/**
 * The mirror record of the character a tool names (by `chaId`, else by name; the selected one for an
 * empty id), typed read-only: the write tools change it only through `updateCharacter`.
 */
export function getCharacter(id: string): DeepReadonly<character | groupChat> | undefined {
    return id ? characterList().find((c) => c.chaId === id || c.name === id) : selectedCharacter();
}
