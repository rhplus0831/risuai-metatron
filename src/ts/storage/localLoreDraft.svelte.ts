import type { loreBook } from "./database.svelte";
import { setChatMeta } from "./chatStore.svelte";
import { createChatFieldDraft } from "./chatFieldDraft.svelte";

const field = createChatFieldDraft<loreBook>(
    (chat) => chat.localLore ?? [],
    (ref, localLore) => setChatMeta(ref, { localLore }),
);
/** The selected chat's editable local lorebook; see createChatFieldDraft for synchronization and send fencing. */
export const localLoreDraft = field.draft;
export const useLocalLoreDraft = field.useDraft;
