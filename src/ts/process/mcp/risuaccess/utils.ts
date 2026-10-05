import { type AnyClientCharacter, selectedCharacter, characterList } from "../../../storage/characterStore.svelte";
import type { DeepReadonly } from "../../../../../shared/readonly.ts";

/**
 * The record of the character a tool names (by `chaId`, else by name; the selected one for an
 * empty id), typed read-only: the write tools change it only through `updateCharacter`. Its chats
 * are the chat module's (the host's `currentMessages` loads them).
 */
export function getCharacter(id: string): DeepReadonly<AnyClientCharacter> | undefined {
    return id ? characterList().find((c) => c.chaId === id || c.name === id) : selectedCharacter();
}
