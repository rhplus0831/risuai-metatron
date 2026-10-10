import type { ChatBindingField } from "../../../shared/chatBinding.ts";
import { chatBindingPatch, chatBindingTargetExists } from "./chatBinding.svelte";
import { chatEntry, currentChatRef, type ChatRef } from "./chatStore.svelte";
import { selectModelPreset, selectPersona, selectPreset } from "./selection.svelte";

/*
 * The pickers' action (`docs/plan/chat-binding.md`, decision 8 and slice 5): a pick changes the binding
 * of the chat the screen shows, and the tab's selection only at home. Its own module so that
 * `chatBinding.svelte.ts`, which the parser and the request code read, does not import the selection.
 */

/**
 * Picks record `id` for `field` where the screen shows it (decision 8): `target` names the chat (a
 * picker opened for that chat, or a chat captured before an await), `null` the tab's selection, and
 * `undefined` the open chat now (`currentChatRef()`, else the tab's selection at home). A chat's pick
 * binds that field only: the tab's selection and `bindingReview` are left as they are. Returns false
 * (nothing changes) when the record does not exist or the chat is not a member any more.
 */
export function pickBinding(field: ChatBindingField, id: string, target?: ChatRef | null): boolean {
    if (!chatBindingTargetExists(field, id)) {
        return false;
    }
    const ref = target === undefined ? currentChatRef() : target;
    if (ref) {
        if (!chatEntry(ref)) {
            return false;
        }
        chatBindingPatch(ref, { [field]: id });
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
