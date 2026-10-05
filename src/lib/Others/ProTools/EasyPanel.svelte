<script lang="ts">
    import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import ClaudeThinkingSeparateParams from "src/lib/Setting/Pages/ClaudeThinkingSeparateParams.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { easyPanelStore } from "src/ts/stores.svelte";
    import Help from "../Help.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import AllSeperateParameters from "../AllSeperateParameters.svelte";
    import { onMount } from "svelte";
    import { XIcon } from "@lucide/svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import CustomModelsSettings from "src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte";

    let selectedOption = $state("models");
    let selectedParameterOption = $state("memory");
    let parameterModelSelection = $state("");

    let hasEPRequirements = $derived.by(() => {
        return (
            activePreset.seperateParametersEnabled &&
            settings.providers.doNotChangeSeperateModels &&
            settings.providers.seperateModels &&
            settings.ui.epEnabled &&
            settings.providers.disableSeperateParameterChangeOnPresetChange
        );
    });

    const onClose = () => {
        easyPanelStore.open = false;
    };
</script>

<div class="fixed z-50 w-dvw h-dvh top-0 left-0 pointer-events-none flex justify-stretch items-stretch">
    <div
        class="m-4 p-4 bg-bgcolor/80 backdrop-blur-sm rounded-lg shadow-lg pointer-events-auto flex-1 flex flex-col overflow-y-auto"
    >
        <h2 class="text-lg font-bold mb-2 flex items-center">
            {language.easyPanel}
            <div class="ml-2 bg-blue-800 p-1 rounded text-sm">Beta</div>
            <button
                class="ml-auto p-1 rounded hover:bg-selected"
                onclick={() => {
                    onClose();
                }}
            >
                <XIcon size={28} class="ml-auto hover:bg-selected rounded"></XIcon>
            </button>
        </h2>
        <SegmentedControl
            options={[
                { label: language.model, value: "models" },
                { label: language.parameters, value: "parameters" },
                { label: language.customModels, value: "customModels" },
                { label: language.settings, value: "settings" },
            ]}
            bind:value={selectedOption}
            size="md"
        />

        {#if !hasEPRequirements}
            <div class="mt-4 p-4 bg-yellow-100 text-yellow-800 rounded">
                {language.epRequirementsNotMet}
            </div>

            <Button
                className="mt-4"
                onclick={() => {
                    activePreset.seperateParametersEnabled = true;
                    settings.providers.doNotChangeSeperateModels = true;
                    settings.providers.seperateModels = {
                        memory: "",
                        translate: "",
                        emotion: "",
                        otherAx: "",
                    };
                    settings.ui.epEnabled = true;
                    settings.providers.disableSeperateParameterChangeOnPresetChange = true;
                }}
            >
                {language.run}
            </Button>
        {:else if selectedOption === "models"}
            <div class="w-full grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 justify-center items-center">
                <div class="col-span-1">
                    <span class="text-textcolor">{language.mainModel}</span>
                    <ModelList bind:value={activePreset.aiModel} blankable excludesPrefix="plugin" />
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.submodel}</span>
                    <ModelList bind:value={activePreset.subModel} blankable excludesPrefix="plugin" />
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.longTermMemory}</span>
                    <ModelList
                        bind:value={settings.providers.seperateModels.memory}
                        blankable
                        excludesPrefix="plugin"
                    />
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.translator}</span>
                    <ModelList
                        bind:value={settings.providers.seperateModels.translate}
                        blankable
                        excludesPrefix="plugin"
                    />
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.emotionImage}</span>
                    <ModelList
                        bind:value={settings.providers.seperateModels.emotion}
                        blankable
                        excludesPrefix="plugin"
                    />
                </div>

                <div class="col-span-1">
                    <span class="text-textcolor">{language.others}</span>
                    <ModelList
                        bind:value={settings.providers.seperateModels.otherAx}
                        blankable
                        excludesPrefix="plugin"
                    />
                </div>
            </div>
        {/if}
        {#if selectedOption === "parameters"}
            {#if settings.providers.seperateParametersByModel}
                <ModelList
                    bind:value={parameterModelSelection}
                    blankable
                    excludesPrefix="plugin"
                    onChange={(v) => {
                        settings.providers.seperateParameters.overrides ??= {};
                        settings.providers.seperateParameters.overrides[v] ??= {};
                    }}
                />

                {#if parameterModelSelection !== ""}
                    <AllSeperateParameters
                        bind:value={settings.providers.seperateParameters.overrides[parameterModelSelection]}
                        withImportExport
                        paramKey={parameterModelSelection}
                    />
                {/if}
            {:else}
                <SegmentedControl
                    options={[
                        { label: language.longTermMemory, value: "memory" },
                        { label: language.translator, value: "translate" },
                        { label: language.emotionImage, value: "emotion" },
                        { label: language.others, value: "otherAx" },
                    ]}
                    bind:value={selectedParameterOption}
                    size="md"
                />
                <div class="w-full mt-4 flex flex-col">
                    {#if selectedParameterOption === "memory"}
                        <AllSeperateParameters
                            bind:value={settings.providers.seperateParameters.memory}
                            withImportExport
                            paramKey="memory"
                        />
                    {:else if selectedParameterOption === "translate"}
                        <AllSeperateParameters
                            bind:value={settings.providers.seperateParameters.translate}
                            withImportExport
                            paramKey="translate"
                        />
                    {:else if selectedParameterOption === "emotion"}
                        <AllSeperateParameters
                            bind:value={settings.providers.seperateParameters.emotion}
                            withImportExport
                            paramKey="emotion"
                        />
                    {:else if selectedParameterOption === "otherAx"}
                        <AllSeperateParameters
                            bind:value={settings.providers.seperateParameters.otherAx}
                            withImportExport
                            paramKey="otherAx"
                        />
                    {/if}
                </div>
            {/if}
        {:else if selectedOption === "customModels"}
            <CustomModelsSettings noAccordion />
        {:else if selectedOption === "settings"}
            <CheckInput
                name={language.seperateParametersByModel}
                bind:check={settings.providers.seperateParametersByModel}
            />
        {/if}
    </div>
</div>
