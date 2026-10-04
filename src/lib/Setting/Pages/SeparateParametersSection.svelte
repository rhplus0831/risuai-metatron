<script lang="ts">
    import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import AllSeperateParameters from "src/lib/Others/AllSeperateParameters.svelte";

    const paramLabels: Record<string, string> = {
        memory: "longTermMemory",
        emotion: "emotionImage",
        translate: "translator",
        otherAx: "others",
    };
</script>

<Accordion name={language.seperateParameters} styled>
    <CheckInput bind:check={activePreset.seperateParametersEnabled} name={language.seperateParametersEnabled} />
    {#if activePreset.seperateParametersEnabled}
        {#each Object.keys(settings.providers.seperateParameters) as param}
            <Accordion name={language[paramLabels[param]] ?? param} styled>
                <AllSeperateParameters bind:value={settings.providers.seperateParameters[param]} paramKey={param} />
            </Accordion>
        {/each}
    {/if}
</Accordion>
