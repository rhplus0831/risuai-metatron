<script lang="ts">
    import { CpuIcon, PackageIcon, Sailboat, ScrollTextIcon } from "@lucide/svelte";
    import { QuickSettings } from "src/ts/stores.svelte";
    import ModelSettings from "../Setting/Pages/ModelSettings.svelte";
    import PromptPresetSettings from "../Setting/Pages/PromptPresetSettings.svelte";
    import OtherBotSettings from "../Setting/Pages/OtherBotSettings.svelte";
    import ModuleSettings from "../Setting/Pages/Module/ModuleSettings.svelte";
</script>

<div class="flex mb-2 gap-2">
    <button
        class={QuickSettings.index === 0 ? "text-textcolor " : "text-textcolor2"}
        onclick={() => {
            QuickSettings.index = 0;
        }}
    >
        <CpuIcon />
    </button>
    <button
        class={QuickSettings.index === 3 ? "text-textcolor " : "text-textcolor2"}
        onclick={() => {
            QuickSettings.index = 3;
        }}
    >
        <ScrollTextIcon />
    </button>
    <button
        class={QuickSettings.index === 1 ? "text-textcolor " : "text-textcolor2"}
        onclick={() => {
            QuickSettings.index = 1;
        }}
    >
        <Sailboat />
    </button>
    <button
        class={QuickSettings.index === 2 ? "text-textcolor " : "text-textcolor2"}
        onclick={() => {
            QuickSettings.index = 2;
        }}
    >
        <PackageIcon />
    </button>
</div>

<div class="py-6 px-4 flex flex-col text-textcolor overflow-y-auto relative rs-setting-cont-5">
    {#if QuickSettings.index === 0}
        <ModelSettings quick />
    {:else if QuickSettings.index === 3}
        <PromptPresetSettings />
    {:else if QuickSettings.index === 1}
        <OtherBotSettings />
    {:else if QuickSettings.index === 2}
        <ModuleSettings />
    {/if}
</div>
