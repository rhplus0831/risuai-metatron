import { get } from "svelte/store";
import { chatCheckpointsDialog } from "src/ts/checkpoints/chatCheckpoints.svelte";
import {
    chatBindingDialog,
    loreBudgetStopDialog,
    openModelPresetList,
    openPersonaList,
    openPresetList,
} from "src/ts/stores.svelte";

export type BindingLayer =
    "loreBudgetStopDialog" | "personaList" | "modelPresetList" | "presetList" | "checkpointsDialog" | "bindingDialog";

/**
 * The topmost open chat dialog or picker list, following their mount order in `App.svelte`: the last
 * mounted (the lore budget stop dialog) paints on top and is named first.
 */
export function topBindingLayer(): BindingLayer | null {
    if (get(loreBudgetStopDialog)) {
        return "loreBudgetStopDialog";
    }
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
