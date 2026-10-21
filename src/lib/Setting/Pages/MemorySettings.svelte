<script lang="ts">
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { activeMainProfile, settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { onMount, untrack } from "svelte";
    import { scrollToCredential, takeCredentialRequest } from "src/ts/setting/credentialLinks";
    import { tokenizePreset } from "src/ts/process/prompt";
    import { getCharToken } from "src/ts/tokenizer";
    import { PlusIcon, PencilIcon, TrashIcon, DownloadIcon, HardDriveUploadIcon } from "@lucide/svelte";
    import { alertError, alertInput, alertConfirm, alertNormal } from "src/ts/alert";
    import { createHypaV3Preset } from "src/ts/process/memory/hypav3";
    import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
    import { maxContextOverrideOf } from "../../../../shared/sections.ts";
    import {
        VOYAGE_CONTEXT_MODELS,
        VOYAGE_EMBEDDING_MODELS,
        isVoyageContextModel,
        isVoyageEmbeddingModel,
    } from "../../../../shared/memory.ts";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingsSections from "../SettingsSections.svelte";
    import { memorySettingsSections, memorySupaMemoryItems } from "src/ts/setting/memorySettingsData";

    const currentCharacter = $derived(selectedCharacter());

    // Summarization (HypaV2's and SupaMemory's OpenAI 3.5 Instruct, `supaMemory.ts`/`hypav2.ts`) and
    // the OpenAI embedding models share `supaMemoryKey`, so it has one input, below the embedding
    // model, while either uses it. The Playground's embedding tool links here and shows it regardless.
    const summaryUsesOpenAI = $derived(
        !settings.memoryTranslateMedia.hanuraiEnable &&
            (settings.memoryTranslateMedia.hypav2 || !settings.memoryTranslateMedia.hypaV3) &&
            settings.memoryTranslateMedia.supaModelType === "instruct35",
    );
    const embeddingUsesOpenAI = $derived(
        ["openai3small", "openai3large", "ada"].includes(settings.memoryTranslateMedia.hypaModel),
    );
    const embeddingUsesVoyage = $derived(
        isVoyageContextModel(settings.memoryTranslateMedia.hypaModel) ||
            isVoyageEmbeddingModel(settings.memoryTranslateMedia.hypaModel),
    );
    const revealMemoryKey = takeCredentialRequest("supaMemoryKey");
    onMount(() => {
        if (revealMemoryKey) void scrollToCredential("supaMemoryKey");
    });

    // HypaV3: the selected preset, by id (`hypaV3PresetId`); the first one when that id is gone.
    const currentHypaV3 = $derived(
        selectedHypaV3Preset({
            hypaV3Presets: settings.hypaV3Presets.items,
            hypaV3PresetId: settings.hypaV3Presets.selectedId,
        }),
    );

    $effect(() => {
        const settings = currentHypaV3?.settings;
        const currentValue = settings?.similarMemoryRatio;

        if (!currentValue) return;

        untrack(() => {
            const newValue = Math.min(currentValue, 1);

            settings.similarMemoryRatio = newValue;

            if (newValue + settings.recentMemoryRatio > 1) {
                settings.recentMemoryRatio = 1 - newValue;
            }
        });
    });

    $effect(() => {
        const settings = currentHypaV3?.settings;
        const currentValue = settings?.recentMemoryRatio;

        if (!currentValue) return;

        untrack(() => {
            const newValue = Math.min(currentValue, 1);

            settings.recentMemoryRatio = newValue;

            if (newValue + settings.similarMemoryRatio > 1) {
                settings.similarMemoryRatio = 1 - newValue;
            }
        });
    });

    async function getMaxMemoryRatio(): Promise<number> {
        const promptTemplateToken = await tokenizePreset(activePreset.promptTemplate);
        const char = currentCharacter;
        const charToken = await getCharToken(char);
        const maxLoreToken = char.loreSettings?.tokenBudget ?? settings.providers.loreBookToken;
        const maxResponse = activePreset.maxResponse;
        const requiredToken =
            promptTemplateToken + charToken.persistant + Math.min(charToken.dynamic, maxLoreToken) + maxResponse * 3;
        // The size the server's prompt assembly uses: the prompt preset's override, else the main profile's.
        const maxContext =
            maxContextOverrideOf(activePreset as unknown as Record<string, unknown>) ?? activeMainProfile.maxContext;

        if (maxContext === 0) {
            return 0;
        }

        const maxMemoryRatio = Math.max((maxContext - requiredToken) / maxContext, 0);

        return parseFloat(maxMemoryRatio.toFixed(2));
    }
    // End HypaV3
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.memorySettings}</h2>

<span class="text-textcolor mt-4">{language.type}</span>

<SelectInput
    className="mb-4"
    value={settings.memoryTranslateMedia.hypaV3
        ? "hypaV3"
        : settings.memoryTranslateMedia.hypav2
          ? "hypaV2"
          : settings.memoryTranslateMedia.supaModelType !== "none"
            ? "supaMemory"
            : settings.memoryTranslateMedia.hanuraiEnable
              ? "hanuraiMemory"
              : "none"}
    onchange={(v) => {
        //@ts-expect-error 'value' doesn't exist on EventTarget, but target is HTMLSelectElement here
        const value = v.target.value;
        if (value === "supaMemory") {
            settings.memoryTranslateMedia.supaModelType = "distilbart";
            settings.ui.memoryAlgorithmType = "supaMemory";
            settings.memoryTranslateMedia.hypav2 = false;
            settings.memoryTranslateMedia.hanuraiEnable = false;
            settings.memoryTranslateMedia.hypaV3 = false;
        } else if (value === "hanuraiMemory") {
            settings.memoryTranslateMedia.supaModelType = "none";
            settings.ui.memoryAlgorithmType = "hanuraiMemory";
            settings.memoryTranslateMedia.hypav2 = false;
            settings.memoryTranslateMedia.hanuraiEnable = true;
            settings.memoryTranslateMedia.hypaV3 = false;
        } else if (value === "hypaV2") {
            settings.memoryTranslateMedia.supaModelType = "distilbart";
            settings.ui.memoryAlgorithmType = "hypaMemoryV2";
            settings.memoryTranslateMedia.hypav2 = true;
            settings.memoryTranslateMedia.hanuraiEnable = false;
            settings.memoryTranslateMedia.hypaV3 = false;
        } else if (value === "hypaV3") {
            settings.ui.memoryAlgorithmType = "hypaMemoryV3";
            settings.memoryTranslateMedia.supaModelType = "none";
            settings.memoryTranslateMedia.hanuraiEnable = false;
            settings.memoryTranslateMedia.hypav2 = false;
            settings.memoryTranslateMedia.hypaV3 = true;
        } else {
            settings.memoryTranslateMedia.supaModelType = "none";
            settings.ui.memoryAlgorithmType = "none";
            settings.memoryTranslateMedia.hypav2 = false;
            settings.memoryTranslateMedia.hanuraiEnable = false;
            settings.memoryTranslateMedia.hypaV3 = false;
        }
    }}
>
    <OptionInput value="none">None</OptionInput>
    <OptionInput value="supaMemory">{language.SuperMemory}</OptionInput>
    <OptionInput value="hypaV2">{language.HypaMemory} V2</OptionInput>
    <OptionInput value="hanuraiMemory">{language.hanuraiMemory}</OptionInput>
    <OptionInput value="hypaV3">{language.HypaMemory} V3</OptionInput>
</SelectInput>

{#if settings.memoryTranslateMedia.hanuraiEnable}
    <span class="mb-2 text-textcolor2 text-sm text-wrap wrap-break-word max-w-full">{language.hanuraiDesc}</span>
    <span>Chunk Size</span>
    <NumberInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.hanuraiTokens} min={100} />
    <div class="flex mb-4">
        <Check bind:check={settings.memoryTranslateMedia.hanuraiSplit} name="Text Spliting" />
    </div>
{:else if settings.memoryTranslateMedia.hypav2}
    <span class="mb-2 text-textcolor2 text-sm text-wrap wrap-break-word max-w-full">{language.hypaV2Desc}</span>
    <span class="text-textcolor mt-4">{language.SuperMemory} {language.model}</span>
    <SelectInput className="mt-2 mb-2" bind:value={settings.memoryTranslateMedia.supaModelType}>
        <OptionInput value="distilbart">distilbart-cnn-6-6 (Free/Local)</OptionInput>
        <OptionInput value="instruct35">OpenAI 3.5 Turbo Instruct</OptionInput>
        <OptionInput value="subModel">{language.submodel}</OptionInput>
    </SelectInput>
    {#if settings.memoryTranslateMedia.supaModelType === "instruct35"}
        <span class="mb-2 text-xs text-textcolor2">{language.supaMemoryKeyBelow}</span>
    {/if}
    <span class="text-textcolor">{language.summarizationPrompt} <Help key="summarizationPrompt" /></span>
    <TextAreaInput
        size="sm"
        bind:value={settings.memoryTranslateMedia.supaMemoryPrompt}
        placeholder="Leave it blank to use default"
    />
    <span class="text-textcolor">{language.hypaChunkSize}</span>
    <NumberInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.hypaChunkSize} min={100} />
    <span class="text-textcolor">{language.hypaAllocatedTokens}</span>
    <NumberInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.hypaAllocatedTokens} min={100} />
{:else if settings.memoryTranslateMedia.hypaV3}
    <span class="max-w-full mb-6 text-sm text-wrap wrap-break-word text-textcolor2"
        >{language.hypaV3Settings.descriptionLabel}</span
    >
    <span class="text-textcolor">Preset</span>
    <select
        class={"border border-darkborderc focus:border-borderc rounded-md shadow-xs text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden transition-colors duration-200 text-md px-4 py-2 mb-1"}
        bind:value={
            () => currentHypaV3?.id,
            (value) => {
                settings.hypaV3Presets.selectedId = value;
            }
        }
    >
        {#each settings.hypaV3Presets.items as preset (preset.id)}
            <option class="bg-darkbg appearance-none" value={preset.id}>{preset.name}</option>
        {/each}
    </select>

    <div class="flex items-center mb-8">
        <button
            class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
            onclick={() => {
                const newPreset = createHypaV3Preset();
                settings.hypaV3Presets.items.push(newPreset);
                settings.hypaV3Presets.selectedId = newPreset.id;
            }}
        >
            <PlusIcon size={24} />
        </button>

        <button
            class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
            onclick={async () => {
                const presets = settings.hypaV3Presets.items;

                if (presets.length === 0) {
                    alertError("There must be least one preset.");
                    return;
                }

                if (!currentHypaV3) return;
                // The dialog awaits; a conflict reload may replace the list, so resolve by id after.
                const { id, name } = currentHypaV3;
                const newName = await alertInput(`Enter new name for ${name}`, [], name);

                if (!newName || newName.trim().length === 0) return;

                const preset = settings.hypaV3Presets.items.find((entry) => entry.id === id);
                if (preset) {
                    preset.name = newName;
                }
            }}
        >
            <PencilIcon size={24} />
        </button>

        <button
            class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
            onclick={async (e) => {
                if (settings.hypaV3Presets.items.length <= 1) {
                    alertError("There must be least one preset.");
                    return;
                }

                if (!currentHypaV3) return;
                const { id, name } = currentHypaV3;
                const confirmed = await alertConfirm(`${language.removeConfirm}${name}`);

                if (!confirmed) return;

                // Resolved again after the dialog: a conflict reload may have replaced the list.
                const presets = settings.hypaV3Presets.items;
                const index = presets.findIndex((entry) => entry.id === id);
                if (index === -1 || presets.length <= 1) return;
                presets.splice(index, 1);
                if (settings.hypaV3Presets.selectedId === id) {
                    settings.hypaV3Presets.selectedId = presets[0].id;
                }
            }}
        >
            <TrashIcon size={24} />
        </button>

        <div class="ml-2 mr-4 w-px h-full bg-darkborderc"></div>

        <button
            class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
            onclick={async () => {
                try {
                    const presets = settings.hypaV3Presets.items;

                    if (presets.length === 0) {
                        alertError("There must be least one preset.");
                        return;
                    }

                    const preset = currentHypaV3;
                    if (!preset) return;
                    const bytesExport = Buffer.from(
                        // The export format has no id; an import assigns a fresh one.
                        JSON.stringify({
                            type: "risu",
                            ver: 1,
                            data: { name: preset.name, settings: preset.settings },
                        }),
                        "utf-8",
                    );

                    await downloadFile(`hypaV3_export_${preset.name}.json`, bytesExport);
                    alertNormal(language.successExport);
                } catch (error) {
                    alertError(`${error}`);
                }
            }}
        >
            <DownloadIcon size={24} />
        </button>

        <button
            class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
            onclick={async () => {
                try {
                    const bytesImport = (await selectSingleFile(["json"])).data;

                    if (!bytesImport) return;

                    const objImport = JSON.parse(Buffer.from(bytesImport).toString("utf-8"));

                    if (objImport.type !== "risu" || !objImport.data) return;

                    const newPreset = createHypaV3Preset(
                        objImport.data.name || "Imported Preset",
                        objImport.data.settings || {},
                    );
                    settings.hypaV3Presets.items.push(newPreset);
                    settings.hypaV3Presets.selectedId = newPreset.id;

                    alertNormal(language.successImport);
                } catch (error) {
                    alertError(`${error}`);
                }
            }}
        >
            <HardDriveUploadIcon size={24} />
        </button>
    </div>

    {#if currentHypaV3?.settings}
        {@const settings = currentHypaV3.settings}

        <span class="text-textcolor">{language.SuperMemory} {language.model}</span>
        <SelectInput className="mb-4" bind:value={settings.summarizationModel}>
            <OptionInput value="subModel">{language.submodel}</OptionInput>
            {#if "gpu" in navigator}
                <OptionInput value="Qwen3-1.7B-q4f32_1-MLC">Qwen3 1.7B (GPU)</OptionInput>
                <OptionInput value="Qwen3-4B-q4f32_1-MLC">Qwen3 4B (GPU)</OptionInput>
                <OptionInput value="Qwen3-8B-q4f32_1-MLC">Qwen3 8B (GPU)</OptionInput>
            {/if}
        </SelectInput>
        <span class="text-textcolor">{language.summarizationPrompt} <Help key="summarizationPrompt" /></span>
        <div class="mb-4">
            <TextAreaInput
                size="sm"
                placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}
                bind:value={settings.summarizationPrompt}
            />
        </div>
        <span class="text-textcolor">{language.reSummarizationPrompt} <Help key="reSummarizationPrompt" /></span>
        <div class="mb-4">
            <TextAreaInput
                size="sm"
                placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}
                bind:value={settings.reSummarizationPrompt}
            />
        </div>
        {#await getMaxMemoryRatio() then maxMemoryRatio}
            <span class="text-textcolor">{language.hypaV3Settings.maxMemoryTokensRatioLabel}</span>
            <NumberInput marginBottom disabled size="sm" value={maxMemoryRatio} />
        {:catch error}
            <span class="mb-4 text-red-400">{language.hypaV3Settings.maxMemoryTokensRatioError}</span>
        {/await}
        <span class="text-textcolor"
            >{language.hypaV3Settings.memoryTokensRatioLabel} <Help key="hypaV3MemoryTokensRatio" /></span
        >
        <SliderInput marginBottom min={0} max={1} step={0.01} fixed={2} bind:value={settings.memoryTokensRatio} />
        <span class="text-textcolor"
            >{language.hypaV3Settings.extraSummarizationRatioLabel}
            <Help key="hypaV3ExtraSummarizationRatio" /></span
        >
        <SliderInput
            marginBottom
            min={0}
            max={1 - settings.memoryTokensRatio}
            step={0.01}
            fixed={2}
            bind:value={settings.extraSummarizationRatio}
        />
        <span class="text-textcolor"
            >{language.hypaV3Settings.maxChatsPerSummaryLabel} <Help key="hypaV3MaxChatsPerSummary" /></span
        >
        <NumberInput marginBottom size="sm" min={1} bind:value={settings.maxChatsPerSummary} />
        <span class="text-textcolor"
            >{language.hypaV3Settings.queryChatCountLabel} <Help key="hypaV3QueryChatCount" /></span
        >
        <NumberInput marginBottom size="sm" min={1} max={20} bind:value={settings.queryChatCount} />
        <span class="text-textcolor"
            >{language.hypaV3Settings.summaryChunkSeparatorLabel}
            <Help key="hypaV3SummaryChunkSeparator" /></span
        >
        <TextInput marginBottom size="sm" bind:value={settings.summaryChunkSeparator} />
        <span class="text-textcolor"
            >{language.hypaV3Settings.recentMemoryRatioLabel} <Help key="hypaV3RecentMemoryRatio" /></span
        >
        <SliderInput marginBottom min={0} max={1} step={0.01} fixed={2} bind:value={settings.recentMemoryRatio} />
        <span class="text-textcolor"
            >{language.hypaV3Settings.similarMemoryRatioLabel} <Help key="hypaV3SimilarMemoryRatio" /></span
        >
        <SliderInput marginBottom min={0} max={1} step={0.01} fixed={2} bind:value={settings.similarMemoryRatio} />
        <span class="text-textcolor"
            >{language.hypaV3Settings.randomMemoryRatioLabel} <Help key="hypaV3RandomMemoryRatio" /></span
        >
        <NumberInput
            marginBottom
            disabled
            size="sm"
            value={parseFloat((1 - settings.recentMemoryRatio - settings.similarMemoryRatio).toFixed(2))}
        />
        <div class="mb-2 flex items-center">
            <Check
                name={language.hypaV3Settings.preserveOrphanedMemoryLabel}
                bind:check={settings.preserveOrphanedMemory}
            />
            <Help key="hypaV3PreserveOrphanedMemory" />
        </div>
        <div class="mb-2 flex items-center">
            <Check
                name={language.hypaV3Settings.applyRegexScriptWhenRerollingLabel}
                bind:check={settings.processRegexScript}
            />
            <Help key="hypaV3ProcessRegexScript" />
        </div>
        <div class="mb-2 flex items-center">
            <Check
                name={language.hypaV3Settings.doNotSummarizeUserMessageLabel}
                bind:check={settings.doNotSummarizeUserMessage}
            />
            <Help key="hypaV3DoNotSummarizeUserMessage" />
        </div>
        <Accordion name="Advanced Settings" styled>
            <div class="mb-2 flex items-center">
                <Check name="Use Experimental Implementation" bind:check={settings.useExperimentalImpl} />
                <Help key="hypaV3UseExperimentalImpl" />
            </div>
            <div class="mb-2 flex items-center">
                <Check name="Always Toggle On" bind:check={settings.alwaysToggleOn} />
                <Help key="hypaV3AlwaysToggleOn" />
            </div>
            {#if settings.useExperimentalImpl}
                <span class="text-textcolor"
                    >Summarization Requests Per Minute <Help key="hypaV3SummarizationRequestsPerMinute" /></span
                >
                <NumberInput marginBottom size="sm" min={1} bind:value={settings.summarizationRequestsPerMinute} />
                <span class="text-textcolor"
                    >Summarization Max Concurrent <Help key="hypaV3SummarizationMaxConcurrent" /></span
                >
                <NumberInput marginBottom size="sm" min={1} max={10} bind:value={settings.summarizationMaxConcurrent} />
                <span class="text-textcolor"
                    >Embedding Requests Per Minute <Help key="hypaV3EmbeddingRequestsPerMinute" /></span
                >
                <NumberInput marginBottom size="sm" min={1} bind:value={settings.embeddingRequestsPerMinute} />
                <span class="text-textcolor">Embedding Max Concurrent <Help key="hypaV3EmbeddingMaxConcurrent" /></span>
                <NumberInput marginBottom size="sm" min={1} max={10} bind:value={settings.embeddingMaxConcurrent} />
            {:else}
                <div class="mb-2 flex items-center">
                    <Check
                        name={language.hypaV3Settings.enableSimilarityCorrectionLabel}
                        bind:check={settings.enableSimilarityCorrection}
                    />
                    <Help key="hypaV3EnableSimilarityCorrection" />
                </div>
            {/if}
        </Accordion>
    {/if}

    <div class="mb-8"></div>
{:else if settings.memoryTranslateMedia.supaModelType !== "none" && settings.memoryTranslateMedia.hypav2 === false && settings.memoryTranslateMedia.hypaV3 === false}
    <span class="mb-2 text-textcolor2 text-sm text-wrap wrap-break-word max-w-full">{language.supaDesc}</span>
    <span class="text-textcolor mt-4">{language.SuperMemory} {language.model}</span>
    <SelectInput className="mt-2 mb-2" bind:value={settings.memoryTranslateMedia.supaModelType}>
        <OptionInput value="distilbart">distilbart-cnn-6-6 (Free/Local)</OptionInput>
        <OptionInput value="instruct35">OpenAI 3.5 Turbo Instruct</OptionInput>
        <OptionInput value="subModel">{language.submodel}</OptionInput>
    </SelectInput>
    {#if settings.memoryTranslateMedia.supaModelType === "instruct35"}
        <span class="mb-2 text-xs text-textcolor2">{language.supaMemoryKeyBelow}</span>
    {/if}
    <span class="text-textcolor">{language.maxSupaChunkSize}</span>
    <NumberInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.maxSupaChunkSize} min={100} />
    {#if settings.memoryTranslateMedia.supaModelType !== "none"}
        <span class="text-textcolor">{language.SuperMemory} Prompt</span>
        <TextInput
            size="sm"
            marginBottom
            bind:value={settings.memoryTranslateMedia.supaMemoryPrompt}
            placeholder="Leave it blank to use default"
        />
    {/if}
    <div class="flex mb-4">
        <Check
            bind:check={settings.memoryTranslateMedia.hypaMemory}
            name={language.enable + " " + language.HypaMemory}
        />
    </div>
    <SettingRenderer items={memorySupaMemoryItems} />
{/if}

<span class="text-textcolor">{language.embedding} <Help key="embedding" /></span>
<SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.hypaModel}>
    {#if "gpu" in navigator}
        <OptionInput value="MiniLMGPU">MiniLM L6 v2 (GPU)</OptionInput>
        <OptionInput value="nomicGPU">Nomic Embed Text v1.5 (GPU)</OptionInput>
        <OptionInput value="bgeSmallEnGPU">BGE Small English (GPU)</OptionInput>
        <OptionInput value="bgem3GPU">BGE Medium 3 (GPU)</OptionInput>
        <OptionInput value="multiMiniLMGPU">Multilingual MiniLM L12 v2 (GPU)</OptionInput>
        <OptionInput value="bgeM3KoGPU">BGE Medium 3 Korean (GPU)</OptionInput>
    {/if}
    <OptionInput value="MiniLM">MiniLM L6 v2 (CPU)</OptionInput>
    <OptionInput value="nomic">Nomic Embed Text v1.5 (CPU)</OptionInput>
    <OptionInput value="bgeSmallEn">BGE Small English (CPU)</OptionInput>
    <OptionInput value="bgem3">BGE Medium 3 (CPU)</OptionInput>
    <OptionInput value="multiMiniLM">Multilingual MiniLM L12 v2 (CPU)</OptionInput>
    <OptionInput value="bgeM3Ko">BGE Medium 3 Korean (CPU)</OptionInput>
    <OptionInput value="openai3small">OpenAI text-embedding-3-small</OptionInput>
    <OptionInput value="openai3large">OpenAI text-embedding-3-large</OptionInput>
    <OptionInput value="ada">OpenAI Ada</OptionInput>
    {#each Object.entries(VOYAGE_EMBEDDING_MODELS) as [value, model] (value)}
        <OptionInput {value}>{model.name}</OptionInput>
    {/each}
    {#each Object.entries(VOYAGE_CONTEXT_MODELS) as [value, model] (value)}
        <OptionInput {value}>{model.name}</OptionInput>
    {/each}
    <OptionInput value="custom">Custom (OpenAI-compatible)</OptionInput>
</SelectInput>

{#if summaryUsesOpenAI || embeddingUsesOpenAI || revealMemoryKey}
    <div class="flex flex-col" data-credential="supaMemoryKey">
        <span class="text-textcolor">{language.supaMemoryKeyShared}</span>
        <SecretInput path={{ kind: "flat", field: "supaMemoryKey" }} marginBottom />
    </div>
{/if}

{#if settings.memoryTranslateMedia.hypaModel === "custom"}
    <span class="text-textcolor">URL</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.hypaCustomSettings.url} />
    <span class="text-textcolor">Key/Password</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.hypaCustomSettings.key} />
    <span class="text-textcolor">Request Model</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.hypaCustomSettings.model} />
{/if}

{#if embeddingUsesVoyage}
    <span class="text-textcolor">Voyage API Key</span>
    <TextInput size="sm" marginBottom hideText={settings.ui.hideApiKey} bind:value={settings.secrets.voyageApiKey} />
{/if}

<SettingsSections sections={memorySettingsSections} />
