<script lang="ts">
    import { settings, editedPreset } from "src/ts/storage/settingsViews.svelte";
    import { ArrowLeft, PlusIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
    import { tokenizePreset, type PromptItem } from "src/ts/process/prompt";
    import { createTokenCountField } from "src/ts/tokenCountField";
    import { tokenScopeKey } from "src/ts/tokenizer";
    import { templateCheck } from "src/ts/process/templates/templateCheck";

    import Alert from "src/lib/UI/GUI/Alert.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import OocToggleEditor from "../OocToggleEditor.svelte";
    import { oocToggleMap } from "src/ts/ooc/oocToggleSettings.svelte";
    import { onDestroy, onMount } from "svelte";
    import { defaultAutoSuggestPrompt } from "../../../ts/storage/defaultPrompts";

    let sorted = 0;
    let warns: string[] = $state([]);
    let tokens = $state(0);
    let extokens = $state(0);
    let draggedIndex = $state(-1);
    let dragOverIndex = $state(-1);
    let openedItemIndices = $state(new Set<number>());
    /** The selected preset's template for reading: `[]` while it has none (writes go to the preset). */
    function templateItems(): PromptItem[] {
        return editedPreset.promptTemplate ?? [];
    }
    interface Props {
        onGoBack?: () => void;
        mode?: "independent" | "inline";
        subMenu?: number;
    }

    let { onGoBack = () => {}, mode = "independent", subMenu = $bindable(0) }: Props = $props();

    type PromptTokenCountInput = { items: PromptItem[]; scope: string } | { error: unknown };

    const consistentTokens = createTokenCountField<PromptTokenCountInput>({
        count: async (input) => {
            if ("error" in input) throw input.error;
            return tokenizePreset(input.items, true);
        },
        apply: (count) => (tokens = count),
        same: (a, b) => !("error" in a) && !("error" in b) && JSON.stringify(a) === JSON.stringify(b),
    });
    const expandedTokens = createTokenCountField<PromptTokenCountInput>({
        count: async (input) => {
            if ("error" in input) throw input.error;
            return tokenizePreset(input.items, false);
        },
        apply: (count) => (extokens = count),
        same: (a, b) => !("error" in a) && !("error" in b) && JSON.stringify(a) === JSON.stringify(b),
    });

    $effect.pre(() => {
        warns = templateCheck({ promptTemplate: editedPreset.promptTemplate });
    });
    $effect.pre(() => {
        let input: PromptTokenCountInput;
        try {
            input = { items: $state.snapshot(templateItems()), scope: tokenScopeKey() };
        } catch (error) {
            input = { error };
        }
        consistentTokens.update(input);
        expandedTokens.update(input);
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

        editedPreset.promptTemplate = templates;
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
        consistentTokens.dispose();
        expandedTokens.dispose();
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
    <Alert status="warning" title="Warning" className="mt-4">
        {#each warns as warn}
            <span>{warn}</span>
        {/each}
    </Alert>
{/if}

{#if subMenu === 0}
    <div class="contain w-full max-w-full mt-4 flex flex-col p-3 rounded-md">
        {#if templateItems().length === 0}
            <div class="text-textcolor2">No Format</div>
        {/if}
        {#key sorted}
            {#each getReorderedTemplate() as { item: prompt, originalIndex, displayIndex }}
                <PromptDataItem
                    bind:promptItem={editedPreset.promptTemplate[originalIndex]}
                    popupEditorContext={editedPreset.id}
                    isDragging={draggedIndex === originalIndex}
                    isOpened={openedItemIndices.has(originalIndex)}
                    bind:draggedIndex
                    bind:dragOverIndex
                    bind:openedItemIndices
                    currentIndex={originalIndex}
                    {displayIndex}
                    onDrop={handlePromptDrop}
                    onRemove={() => {
                        let templates = editedPreset.promptTemplate;
                        templates.splice(originalIndex, 1);
                        editedPreset.promptTemplate = templates;

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
                        if (originalIndex === editedPreset.promptTemplate.length - 1) {
                            return;
                        }
                        let templates = editedPreset.promptTemplate;
                        let temp = templates[originalIndex];
                        templates[originalIndex] = templates[originalIndex + 1];
                        templates[originalIndex + 1] = temp;
                        editedPreset.promptTemplate = templates;

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
                        let templates = editedPreset.promptTemplate;
                        let temp = templates[originalIndex];
                        templates[originalIndex] = templates[originalIndex - 1];
                        templates[originalIndex - 1] = temp;
                        editedPreset.promptTemplate = templates;

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
            let value = editedPreset.promptTemplate ?? [];
            value.push({
                type: "plain",
                text: "",
                role: "system",
                type2: "normal",
            });
            editedPreset.promptTemplate = value;
        }}><PlusIcon /></button
    >

    <span class="text-textcolor2 text-sm mt-2">{tokens} {language.fixedTokens}</span>
    <span class="text-textcolor2 mb-6 text-sm mt-2">{extokens} {language.exactTokens}</span>
{:else}
    <span class="text-textcolor mt-4">{language.postEndInnerFormat}</span>
    <TextInput bind:value={editedPreset.promptSettings.postEndInnerFormat} />

    <Check
        bind:check={editedPreset.promptSettings.sendChatAsSystem}
        name={language.sendChatAsSystem}
        className="mt-4"
    />
    <Check bind:check={editedPreset.promptSettings.sendName} name={language.formatGroupInSingle} className="mt-4" />
    <Check
        bind:check={editedPreset.promptSettings.trimStartNewChat}
        name={language.trimStartNewChat}
        className="mt-4"
    />
    <Check bind:check={editedPreset.promptSettings.utilOverride} name={language.utilOverride} className="mt-4" />
    <Check bind:check={editedPreset.jsonSchemaEnabled} name={language.enableJsonSchema} className="mt-4" />

    <Check bind:check={editedPreset.strictJsonSchema} name={language.strictJsonSchema} className="mt-4" />

    {#if settings.ui.showUnrecommended}
        <Check
            bind:check={editedPreset.promptSettings.customChainOfThought}
            name={language.customChainOfThought}
            className="mt-4"
        >
            <Help unrecommended key="customChainOfThought" />
        </Check>
    {/if}
    <span class="text-textcolor mt-4">{language.maxThoughtTagDepth}</span>
    <NumberInput bind:value={editedPreset.promptSettings.maxThoughtTagDepth} />
    <span class="text-textcolor mt-4">{language.groupOtherBotRole} <Help key="groupOtherBotRole" /></span>
    <SelectInput bind:value={editedPreset.groupOtherBotRole}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="system">System</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    <span class="text-textcolor mt-4"
        >{language.customPromptTemplateToggle} <Help key="customPromptTemplateToggle" /></span
    >
    <TextAreaInput bind:value={editedPreset.customPromptTemplateToggle} popupEditorContext={editedPreset.id} />
    <section class="mt-4 min-w-0" aria-labelledby="preset-ooc-toggles-title">
        <h3 id="preset-ooc-toggles-title" class="text-textcolor">{language.oocToggles.title}</h3>
        <p class="mb-3 mt-1 text-sm text-textcolor2">{language.oocToggles.help}</p>
        {#key editedPreset.id}
            <OocToggleEditor
                definitionsText={editedPreset.customPromptTemplateToggle}
                value={oocToggleMap(editedPreset.oocToggles)}
                onchange={(next) => (editedPreset.oocToggles = { ...next })}
            />
        {/key}
    </section>
    <span class="text-textcolor mt-4">{language.defaultVariables} <Help key="defaultVariables" /></span>
    <TextAreaInput bind:value={editedPreset.templateDefaultVariables} popupEditorContext={editedPreset.id} />
    <span class="text-textcolor mt-4">{language.predictedOutput}</span>
    <TextAreaInput bind:value={settings.providers.OAIPrediction} />
    <span class="text-textcolor mt-4">{language.autoSuggest} <Help key="autoSuggest" /></span>
    <TextAreaInput
        bind:value={editedPreset.autoSuggestPrompt}
        popupEditorContext={editedPreset.id}
        placeholder={defaultAutoSuggestPrompt}
    />
    <span class="text-textcolor mt-4">{language.groupInnerFormat} <Help key="groupInnerFormat" /></span>
    <TextAreaInput
        placeholder={`<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`}
        bind:value={editedPreset.groupTemplate}
        popupEditorContext={editedPreset.id}
    />
    {#if editedPreset.jsonSchemaEnabled}
        <span class="text-textcolor mt-4">{language.jsonSchema} <Help key="jsonSchema" /></span>
        <TextAreaInput bind:value={editedPreset.jsonSchema} popupEditorContext={editedPreset.id} />
        <span class="text-textcolor mt-4">{language.extractJson} <Help key="extractJson" /></span>
        <TextInput bind:value={editedPreset.extractJson} />
    {/if}
{/if}
