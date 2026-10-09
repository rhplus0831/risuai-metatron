<script lang="ts">
    import { activeModelPreset } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import { language } from "src/lang";
    import ProfileSlotSelect from "./ProfileSlotSelect.svelte";
    import type { AuxModelMode } from "../../../../../shared/database.ts";

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
