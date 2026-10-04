<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import { language } from "src/lang";
    import ModelList from "src/lib/UI/ModelList.svelte";
</script>

<div class="flex items-center mt-4">
    <Check bind:check={settings.providers.seperateModelsForAxModels} name={language.seperateModelsForAxModels}></Check>
</div>
{#if settings.providers.seperateModelsForAxModels}
    <Check bind:check={settings.providers.doNotChangeSeperateModels} name={language.doNotChangeSeperateModels}></Check>
    <Accordion name={language.axModelsDef} styled>
        <span class="text-textcolor mt-4"> Memory </span>
        <ModelList bind:value={settings.providers.seperateModels.memory} blankable />

        <span class="text-textcolor mt-4"> Translations </span>
        <ModelList bind:value={settings.providers.seperateModels.translate} blankable />

        <span class="text-textcolor mt-4"> Emotion </span>

        <ModelList bind:value={settings.providers.seperateModels.emotion} blankable />

        <span class="text-textcolor mt-4"> OtherAx </span>

        <ModelList bind:value={settings.providers.seperateModels.otherAx} blankable />
    </Accordion>
{/if}
