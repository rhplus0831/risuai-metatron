import type { ChatBindingField } from "../../../shared/chatBinding.ts";
import { chatBindingPatch, chatBindingTargetExists } from "./chatBinding.svelte";
import { chatEntry, type ChatRef } from "./chatStore.svelte";
import { selectModelPreset, selectPersona, selectPreset } from "./selection.svelte";

/*
 * The pickers' action: a pick changes an explicitly named chat's binding or the tab's selection.
 * Its own module so that
 * `chatBinding.svelte.ts`, which the parser and the request code read, does not import the selection.
 */

/**
 * Picks record `id` for `field`: `target` names the chat (a picker opened for that chat, or a chat
 * captured before an await), or `null` for the tab's selection, also with a chat open. The target is
 * required, so a picker cannot bind the open chat by leaving it out. A chat's pick
 * binds that field only: the tab's selection and `bindingReview` are left as they are. Returns false
 * (nothing changes) when the record does not exist or the chat is not a member any more.
 */
export function pickBinding(field: ChatBindingField, id: string, target: ChatRef | null): boolean {
    if (!chatBindingTargetExists(field, id)) {
        return false;
    }
    if (target) {
        if (!chatEntry(target)) {
            return false;
        }
        chatBindingPatch(target, { [field]: id });
        return true;
    }
    switch (field) {
        case "modelPresetId":
            selectModelPreset(id);
            break;
        case "promptPresetId":
            selectPreset(id);
            break;
        case "personaId":
            selectPersona(id);
            break;
    }
    return true;
}
