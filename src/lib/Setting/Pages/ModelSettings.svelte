<script lang="ts">
    import { activeModelPreset, settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import { openModelPresetList } from "src/ts/stores.svelte";
    import { getModelInfoForMode, LLMFlags, LLMProvider } from "src/ts/model/modellist";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import { PlusIcon, TrashIcon, ListIcon } from "@lucide/svelte";
    import ProfileSlotSelect from "./Model/ProfileSlotSelect.svelte";
    import AuxModelSelectors from "./Model/AuxModelSelectors.svelte";
    import ModelMenuTabs from "./Model/ModelMenuTabs.svelte";

    interface Props {
        /** Rendered in the quick settings panel (`QuickSettingsGUI`), outside the settings screen. */
        quick?: boolean;
    }

    let { quick = false }: Props = $props();

    const models = $derived(
        (["model", "submodel", "memory", "translate", "emotion", "otherAx"] as const).map((mode) =>
            getModelInfoForMode(mode),
        ),
    );
</script>

<ModelMenuTabs {quick} />

<div class="flex items-center gap-2 mb-4 p-2 rounded-md border border-darkborderc">
    <span class="text-textcolor2 text-sm shrink-0">{language.modelPreset}</span>
    <span class="grow truncate">{activeModelPreset.name}</span>
    <Button size="sm" onclick={() => ($openModelPresetList = true)}><ListIcon size={16} /></Button>
</div>

{#if activeModelPreset.id}
    <ProfileSlotSelect presetId={activeModelPreset.id} mode="model" label={language.model} />
    <ProfileSlotSelect presetId={activeModelPreset.id} mode="submodel" label={language.submodel} />
{/if}
<AuxModelSelectors />

{#if models.some((model) => model.provider === LLMProvider.VertexAI)}
    <span class="text-textcolor">{language.modelProfiles.vertexRegion}</span>
    <SelectInput bind:value={settings.providers.vertexRegion}>
        <OptionInput value="global">global</OptionInput>
        <OptionInput value="us-central1">us-central1</OptionInput>
        <OptionInput value="us-west1">us-west1</OptionInput>
    </SelectInput>
{/if}

<div class="py-2 flex flex-col gap-2 mb-4">
    {#if models.some((model) => model.flags.includes(LLMFlags.hasStreaming))}
        <Check bind:check={settings.providers.useStreaming} name={language.modelProfiles.responseStreaming} />
        {#if settings.providers.useStreaming && models.some((model) => model.flags.includes(LLMFlags.geminiThinking))}
            <Check
                bind:check={settings.providers.streamGeminiThoughts}
                name={language.modelProfiles.streamGeminiThoughts}
            />
        {/if}
    {/if}
    {#if models.some((model) => model.id === "reverse_proxy")}
        <Check bind:check={settings.providers.reverseProxyOobaMode} name={language.reverseProxyOobaMode} />
    {/if}
</div>
<Accordion styled name="{language.additionalParams} " help="additionalParams">
    <table class="contain w-full max-w-full tabler">
        <tbody>
            <tr>
                <th class="font-medium">{language.key}</th>
                <th class="font-medium">{language.value}</th>
                <th>
                    <button
                        class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center"
                        onclick={() => {
                            settings.providers.additionalParams.push(["", ""]);
                        }}><PlusIcon /></button
                    >
                </th>
            </tr>
            {#if settings.providers.additionalParams.length === 0}
                <tr class="text-textcolor2">
                    <td colspan="3">{language.noData}</td>
                </tr>
            {/if}
            {#each settings.providers.additionalParams as additionalParams, i}
                <tr>
                    <td class="font-medium truncate">
                        <TextInput bind:value={settings.providers.additionalParams[i][0]} size="lg" fullwidth />
                    </td>
                    <td class="font-medium truncate">
                        <TextInput bind:value={settings.providers.additionalParams[i][1]} size="lg" fullwidth />
                    </td>
                    <td>
                        <button
                            class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                            onclick={() => {
                                let additionalParams = settings.providers.additionalParams;
                                additionalParams.splice(i, 1);
                                settings.providers.additionalParams = additionalParams;
                            }}><TrashIcon /></button
                        >
                    </td>
                </tr>
            {/each}
        </tbody>
    </table>
</Accordion>
