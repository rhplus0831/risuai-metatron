<script lang="ts">
    import { activeModelPreset } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import { language } from "src/lang";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import CredentialSelect from "src/lib/UI/GUI/CredentialSelect.svelte";
</script>

<div class="flex items-center mt-4">
    <Check bind:check={activeModelPreset.seperateModelsForAxModels} name={language.seperateModelsForAxModels}></Check>
</div>
{#if activeModelPreset.seperateModelsForAxModels}
    <Accordion name={language.axModelsDef} styled>
        <span class="text-textcolor mt-4"> Memory </span>
        <ModelList bind:value={activeModelPreset.seperateModels.memory} blankable />
        {#if activeModelPreset.seperateModels.memory}
            <CredentialSelect modelId={activeModelPreset.seperateModels.memory} compact />
        {/if}

        <span class="text-textcolor mt-4"> Translations </span>
        <ModelList bind:value={activeModelPreset.seperateModels.translate} blankable />
        {#if activeModelPreset.seperateModels.translate}
            <CredentialSelect modelId={activeModelPreset.seperateModels.translate} compact />
        {/if}

        <span class="text-textcolor mt-4"> Emotion </span>

        <ModelList bind:value={activeModelPreset.seperateModels.emotion} blankable />
        {#if activeModelPreset.seperateModels.emotion}
            <CredentialSelect modelId={activeModelPreset.seperateModels.emotion} compact />
        {/if}

        <span class="text-textcolor mt-4"> OtherAx </span>

        <ModelList bind:value={activeModelPreset.seperateModels.otherAx} blankable />
        {#if activeModelPreset.seperateModels.otherAx}
            <CredentialSelect modelId={activeModelPreset.seperateModels.otherAx} compact />
        {/if}
    </Accordion>
{/if}
