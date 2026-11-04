import type { ChatLoreOverride } from "../../../shared/database.ts";
import { setChatMeta } from "./chatStore.svelte";
import { createChatFieldDraft } from "./chatFieldDraft.svelte";

/**
 * Frozen character lore copies edited independently from the chat's local lorebook. Syncing never adds
 * the optional field; an override orphan move updates both fields through one `setChatMeta`.
 */
const field = createChatFieldDraft<ChatLoreOverride>(
    (chat) => chat.loreOverrides ?? [],
    (ref, loreOverrides) => setChatMeta(ref, { loreOverrides }),
);
export const loreOverridesDraft = field.draft;
export const useLoreOverridesDraft = field.useDraft;
