<script lang="ts">
    import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { ArrowLeft, PlusIcon, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
    import { tokenizePreset, type PromptItem } from "src/ts/process/prompt";
    import { templateCheck } from "src/ts/process/templates/templateCheck";

    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { onDestroy, onMount } from "svelte";
    import { defaultAutoSuggestPrompt } from "../../../ts/storage/defaultPrompts";
    import AuxModelSelectors from "./Model/AuxModelSelectors.svelte";

    let sorted = 0;
    let warns: string[] = $state([]);
    let tokens = $state(0);
    let extokens = $state(0);
    let draggedIndex = $state(-1);
    let dragOverIndex = $state(-1);
    let openedItemIndices = $state(new Set<number>());
    /** The selected preset's template for reading: `[]` while it has none (writes go to the preset). */
    function templateItems(): PromptItem[] {
        return activePreset.promptTemplate ?? [];
    }
    executeTokenize(templateItems());
    interface Props {
        onGoBack?: () => void;
        mode?: "independent" | "inline";
        subMenu?: number;
    }

    let { onGoBack = () => {}, mode = "independent", subMenu = $bindable(0) }: Props = $props();

    async function executeTokenize(prest: PromptItem[]) {
        tokens = await tokenizePreset(prest, true);
        extokens = await tokenizePreset(prest, false);
    }

    $effect.pre(() => {
        warns = templateCheck({ promptTemplate: activePreset.promptTemplate });
    });
    $effect.pre(() => {
        executeTokenize(templateItems());
    });

    function getDisplayTemplate() {
        return templateItems().map((item, i) => ({
            item,
            originalIndex: i,
            displayIndex: i,
        }));
    }

    function getReorderedTemplate() {
        if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
            return getDisplayTemplate();
        }

        const items = getDisplayTemplate();
        const [movedItem] = items.splice(draggedIndex, 1);

        const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex;
        items.splice(adjustedDropIndex, 0, movedItem);

        return items.map((item, displayIndex) => ({
            ...item,
            displayIndex,
        }));
    }

    function handlePromptDrop() {
        if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
            return;
        }

        const templates = [...templateItems()];
        const [movedItem] = templates.splice(draggedIndex, 1);

        const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex;
        templates.splice(adjustedDropIndex, 0, movedItem);

        const newOpenedIndices = new Set<number>();
        openedItemIndices.forEach((index) => {
            if (index === draggedIndex) {
                newOpenedIndices.add(adjustedDropIndex);
            } else if (draggedIndex < adjustedDropIndex) {
                if (index > draggedIndex && index <= adjustedDropIndex) {
                    newOpenedIndices.add(index - 1);
                } else {
                    newOpenedIndices.add(index);
                }
            } else {
                if (index >= adjustedDropIndex && index < draggedIndex) {
                    newOpenedIndices.add(index + 1);
                } else {
                    newOpenedIndices.add(index);
                }
            }
        });
        openedItemIndices = newOpenedIndices;

        activePreset.promptTemplate = templates;
        draggedIndex = -1;
        dragOverIndex = -1;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.altKey && e.key === "o") {
            if (openedItemIndices.size === templateItems().length) {
                openedItemIndices = new Set<number>();
            } else {
                openedItemIndices = new Set(templateItems().map((_, i) => i));
            }
        }
    };

    onMount(() => {
        document.addEventListener("keydown", handleKeyDown);
    });

    onDestroy(() => {
        document.removeEventListener("keydown", handleKeyDown);
    });
</script>

{#if mode === "independent"}
    <h2 class="mb-2 text-2xl font-bold mt-2 items-center flex">
        <button class="mr-2 text-textcolor2 hover:text-textcolor" onclick={onGoBack}>
            <ArrowLeft />
        </button>
        {language.promptTemplate}
    </h2>

    <div class="flex w-full rounded-md border border-selected">
        <button
            onclick={() => {
                subMenu = 0;
            }}
            class="p-2 flex-1"
            class:bg-selected={subMenu === 0}
        >
            <span>{language.template}</span>
        </button>
        <button
            onclick={() => {
                subMenu = 1;
            }}
            class="p-2 flex-1"
            class:bg-selected={subMenu === 1}
        >
            <span>{language.settings}</span>
        </button>
    </div>
{/if}
{#if warns.length > 0 && subMenu === 0}
    <div class="text-red-500 flex flex-col items-start p-2 rounded-md border-red-500 border mt-4">
        <h2 class="text-xl font-bold">Warning</h2>
        <div class="border-b border-b-red-500 mt-1 mb-2 w-full"></div>
        {#each warns as warn}
            <span class="ml-4">{warn}</span>
        {/each}
    </div>
{/if}

{#if subMenu === 0}
    <div class="contain w-full max-w-full mt-4 flex flex-col p-3 rounded-md">
        {#if templateItems().length === 0}
            <div class="text-textcolor2">No Format</div>
        {/if}
        {#key sorted}
            {#each getReorderedTemplate() as { item: prompt, originalIndex, displayIndex }}
                <PromptDataItem
                    bind:promptItem={activePreset.promptTemplate[originalIndex]}
                    isDragging={draggedIndex === originalIndex}
                    isOpened={openedItemIndices.has(originalIndex)}
                    bind:draggedIndex
                    bind:dragOverIndex
                    bind:openedItemIndices
                    currentIndex={originalIndex}
                    {displayIndex}
                    onDrop={handlePromptDrop}
                    onRemove={() => {
                        let templates = activePreset.promptTemplate;
                        templates.splice(originalIndex, 1);
                        activePreset.promptTemplate = templates;

                        const newOpenedIndices = new Set<number>();
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                return;
                            } else if (index > originalIndex) {
                                newOpenedIndices.add(index - 1);
                            } else {
                                newOpenedIndices.add(index);
                            }
                        });
                        openedItemIndices = newOpenedIndices;

                        draggedIndex = -1;
                        dragOverIndex = -1;
                    }}
                    moveDown={() => {
                        if (originalIndex === activePreset.promptTemplate.length - 1) {
                            return;
                        }
                        let templates = activePreset.promptTemplate;
                        let temp = templates[originalIndex];
                        templates[originalIndex] = templates[originalIndex + 1];
                        templates[originalIndex + 1] = temp;
                        activePreset.promptTemplate = templates;

                        const newOpenedIndices = new Set<number>();
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                newOpenedIndices.add(originalIndex + 1);
                            } else if (index === originalIndex + 1) {
                                newOpenedIndices.add(originalIndex);
                            } else {
                                newOpenedIndices.add(index);
                            }
                        });
                        openedItemIndices = newOpenedIndices;
                    }}
                    moveUp={() => {
                        if (originalIndex === 0) {
                            return;
                        }
                        let templates = activePreset.promptTemplate;
                        let temp = templates[originalIndex];
                        templates[originalIndex] = templates[originalIndex - 1];
                        templates[originalIndex - 1] = temp;
                        activePreset.promptTemplate = templates;

                        const newOpenedIndices = new Set<number>();
                        openedItemIndices.forEach((index) => {
                            if (index === originalIndex) {
                                newOpenedIndices.add(originalIndex - 1);
                            } else if (index === originalIndex - 1) {
                                newOpenedIndices.add(originalIndex);
                            } else {
                                newOpenedIndices.add(index);
                            }
                        });
                        openedItemIndices = newOpenedIndices;
                    }}
                />
            {/each}
        {/key}
    </div>

    <button
        class="font-medium cursor-pointer hover:text-green-500"
        onclick={() => {
            let value = activePreset.promptTemplate ?? [];
            value.push({
                type: "plain",
                text: "",
                role: "system",
                type2: "normal",
            });
            activePreset.promptTemplate = value;
        }}><PlusIcon /></button
    >

    <span class="text-textcolor2 text-sm mt-2">{tokens} {language.fixedTokens}</span>
    <span class="text-textcolor2 mb-6 text-sm mt-2">{extokens} {language.exactTokens}</span>
{:else}
    <span class="text-textcolor mt-4">{language.postEndInnerFormat}</span>
    <TextInput bind:value={activePreset.promptSettings.postEndInnerFormat} />

    <Check
        bind:check={activePreset.promptSettings.sendChatAsSystem}
        name={language.sendChatAsSystem}
        className="mt-4"
    />
    <Check bind:check={activePreset.promptSettings.sendName} name={language.formatGroupInSingle} className="mt-4" />
    <Check
        bind:check={activePreset.promptSettings.trimStartNewChat}
        name={language.trimStartNewChat}
        className="mt-4"
    />
    <Check bind:check={activePreset.promptSettings.utilOverride} name={language.utilOverride} className="mt-4" />
    <Check bind:check={activePreset.jsonSchemaEnabled} name={language.enableJsonSchema} className="mt-4" />
    <Check bind:check={activePreset.outputImageModal} name={language.outputImageModal} className="mt-4" />

    <Check bind:check={activePreset.strictJsonSchema} name={language.strictJsonSchema} className="mt-4" />

    {#if settings.ui.showUnrecommended}
        <Check
            bind:check={activePreset.promptSettings.customChainOfThought}
            name={language.customChainOfThought}
            className="mt-4"
        >
            <Help unrecommended key="customChainOfThought" />
        </Check>
    {/if}
    <span class="text-textcolor mt-4">{language.maxThoughtTagDepth}</span>
    <NumberInput bind:value={activePreset.promptSettings.maxThoughtTagDepth} />
    <span class="text-textcolor mt-4">{language.groupOtherBotRole} <Help key="groupOtherBotRole" /></span>
    <SelectInput bind:value={activePreset.groupOtherBotRole}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="system">System</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    <span class="text-textcolor mt-4"
        >{language.customPromptTemplateToggle} <Help key="customPromptTemplateToggle" /></span
    >
    <TextAreaInput bind:value={activePreset.customPromptTemplateToggle} />
    <span class="text-textcolor mt-4">{language.defaultVariables} <Help key="defaultVariables" /></span>
    <TextAreaInput bind:value={activePreset.templateDefaultVariables} />
    <span class="text-textcolor mt-4">{language.predictedOutput}</span>
    <TextAreaInput bind:value={settings.providers.OAIPrediction} />
    <span class="text-textcolor mt-4">{language.autoSuggest} <Help key="autoSuggest" /></span>
    <TextAreaInput bind:value={activePreset.autoSuggestPrompt} placeholder={defaultAutoSuggestPrompt} />
    <span class="text-textcolor mt-4">{language.groupInnerFormat} <Help key="groupInnerFormat" /></span>
    <TextAreaInput
        placeholder={`<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`}
        bind:value={activePreset.groupTemplate}
    />
    <span class="text-textcolor mt-4">{language.systemContentReplacement} <Help key="systemContentReplacement" /></span>
    <TextAreaInput bind:value={activePreset.systemContentReplacement} />
    <span class="text-textcolor mt-4">{language.systemRoleReplacement} <Help key="systemRoleReplacement" /></span>
    <SelectInput bind:value={activePreset.systemRoleReplacement}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    {#if activePreset.jsonSchemaEnabled}
        <span class="text-textcolor mt-4">{language.jsonSchema} <Help key="jsonSchema" /></span>
        <TextAreaInput bind:value={activePreset.jsonSchema} />
        <span class="text-textcolor mt-4">{language.extractJson} <Help key="extractJson" /></span>
        <TextInput bind:value={activePreset.extractJson} />
    {/if}

    {#if !settings.ui.auxModelUnderModelSettings}
        <AuxModelSelectors />
    {/if}

    {#snippet fallbackModelList(arg: "model" | "memory" | "translate" | "emotion" | "otherAx")}
        {#each settings.providers.fallbackModels[arg] as model, i}
            <span class="text-textcolor mt-4">
                {language.model}
                {i + 1}
            </span>
            <ModelList bind:value={settings.providers.fallbackModels[arg][i]} blankable />
        {/each}
        <div class="flex gap-2">
            <button
                class="bg-selected text-textcolor p-2 rounded-md"
                onclick={() => {
                    let value = settings.providers.fallbackModels[arg] ?? [];
                    value.push("");
                    settings.providers.fallbackModels[arg] = value;
                }}><PlusIcon /></button
            >
            <button
                class="bg-red-500 text-white p-2 rounded-md"
                onclick={() => {
                    let value = settings.providers.fallbackModels[arg] ?? [];
                    value.pop();
                    settings.providers.fallbackModels[arg] = value;
                }}><TrashIcon /></button
            >
        </div>
    {/snippet}

    <Accordion name={language.fallbackModel} styled>
        <Check
            bind:check={settings.providers.fallbackWhenBlankResponse}
            name={language.fallbackWhenBlankResponse}
            className="mt-4"
        />
        <Check
            bind:check={settings.providers.doNotChangeFallbackModels}
            name={language.doNotChangeFallbackModels}
            className="mt-4"
        />

        <Accordion name={language.model} styled>
            {@render fallbackModelList("model")}
        </Accordion>
        <Accordion name={"Memory"} styled>
            {@render fallbackModelList("memory")}
        </Accordion>
        <Accordion name={"Translations"} styled>
            {@render fallbackModelList("translate")}
        </Accordion>
        <Accordion name={"Emotion"} styled>
            {@render fallbackModelList("emotion")}
        </Accordion>
        <Accordion name={"OtherAx"} styled>
            {@render fallbackModelList("otherAx")}
        </Accordion>
    </Accordion>
{/if}
