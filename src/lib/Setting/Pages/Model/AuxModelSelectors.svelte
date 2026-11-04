<script lang="ts">
    import { activeModelPreset } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import { language } from "src/lang";
    import ProfileSlotSelect from "./ProfileSlotSelect.svelte";
    import type { AuxModelMode } from "../../../../../shared/database.ts";

    /**
     * Edits the model preset's persisted `seperateModelsForAxModels` toggle and
     * `auxSlots.{memory,translate,emotion,otherAx}` via
     * `src/lib/Setting/Pages/Model/ProfileSlotSelect.svelte`: picks profiles, marks deleted
     * ones missing, shows bare plugin model ids as "no profile". Preserve the toggle's spelling.
     * `shared/llm/modelSlots.ts` `resolveSlotProfile`: without a request's explicit profile id
     * or static-model override, disabled or unset aux slots and `submodel` use sub. A dangling profile
     * in the selected slot refuses. Turning the toggle off ignores aux slots. `submodel` is not auxiliary.
     */

    const modes: readonly AuxModelMode[] = ["memory", "translate", "emotion", "otherAx"];
</script>

<div class="flex items-center mt-4">
    <Check bind:check={activeModelPreset.seperateModelsForAxModels} name={language.seperateModelsForAxModels} />
</div>
{#if activeModelPreset.seperateModelsForAxModels && activeModelPreset.id}
    <Accordion name={language.axModelsDef} styled>
        {#each modes as mode}
            <ProfileSlotSelect presetId={activeModelPreset.id} {mode} label={language.modelProfiles.auxModes[mode]} />
        {/each}
    </Accordion>
{/if}
