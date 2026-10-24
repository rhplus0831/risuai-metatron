import { get } from "svelte/store";
import { chatCheckpointsDialog } from "src/ts/checkpoints/chatCheckpoints.svelte";
import { chatBindingDialog, openModelPresetList, openPersonaList, openPresetList } from "src/ts/stores.svelte";

export type BindingLayer = "personaList" | "modelPresetList" | "presetList" | "checkpointsDialog" | "bindingDialog";

/** The topmost open chat dialog or picker list, following their mount order in `App.svelte`. */
export function topBindingLayer(): BindingLayer | null {
    if (get(openPersonaList)) {
        return "personaList";
    }
    if (get(openModelPresetList)) {
        return "modelPresetList";
    }
    if (get(openPresetList)) {
        return "presetList";
    }
    if (get(chatCheckpointsDialog)) {
        return "checkpointsDialog";
    }
    if (get(chatBindingDialog)) {
        return "bindingDialog";
    }
    return null;
}
