<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { DownloadIcon, HardDriveUploadIcon, PencilIcon, PlusIcon, TrashIcon } from "@lucide/svelte";
    import Help from "src/lib/Others/Help.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { alertConfirm, alertError, alertInput, alertNormal } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import {
        createTranslatorPreset,
        decodeTranslatorPresetFile,
        defaultTranslatorPrompt,
        encodeTranslatorPresetFile,
        getCurrentTranslatorPresetFromState,
        getTranslatorPresetDownloadName,
        translatorPresetImportExtensions,
    } from "src/ts/translator/presets";
    import { selectSingleFile } from "src/ts/util";
    import { language } from "src/lang";

    /** The selected preset, by id (`translatorPresetId`); the first one when that id is gone. */
    const current = $derived(
        getCurrentTranslatorPresetFromState({
            translatorPresets: settings.translatorPresets.items,
            translatorPresetId: settings.translatorPresets.selectedId,
        }),
    );
</script>

<span class="text-textcolor mt-4">Preset</span>
<select
    class={"border border-darkborderc focus:border-borderc rounded-md shadow-xs text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden transition-colors duration-200 text-md px-4 py-2 mb-1"}
    bind:value={
        () => current.id,
        (value) => {
            settings.translatorPresets.selectedId = value;
        }
    }
>
    {#each settings.translatorPresets.items as preset (preset.id)}
        <option class="bg-darkbg appearance-none" value={preset.id}>{preset.name}</option>
    {/each}
</select>

<div class="flex items-center mb-4">
    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={() => {
            const newPreset = createTranslatorPreset();
            settings.translatorPresets.items.push(newPreset);
            settings.translatorPresets.selectedId = newPreset.id;
        }}
    >
        <PlusIcon size={24} />
    </button>

    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={async () => {
            const presets = settings.translatorPresets.items;

            if (presets.length === 0) {
                alertError("There must be at least one preset.");
                return;
            }

            // The dialog awaits; a conflict reload may replace the list meanwhile, so resolve by id after.
            const { id, name } = current;
            const newName = await alertInput(`Enter new name for ${name}`, [], name);

            if (!newName || newName.trim().length === 0) return;

            const preset = settings.translatorPresets.items.find((entry) => entry.id === id);
            if (preset) {
                preset.name = newName;
            }
        }}
    >
        <PencilIcon size={24} />
    </button>

    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={async () => {
            if (settings.translatorPresets.items.length <= 1) {
                alertError("There must be at least one preset.");
                return;
            }

            const { id, name } = current;
            const confirmed = await alertConfirm(`${language.removeConfirm}${name}`);

            if (!confirmed) return;

            // Resolved again after the dialog: a conflict reload may have replaced the list.
            const presets = settings.translatorPresets.items;
            const index = presets.findIndex((entry) => entry.id === id);
            if (index === -1 || presets.length <= 1) return;
            presets.splice(index, 1);
            if (settings.translatorPresets.selectedId === id) {
                settings.translatorPresets.selectedId = presets[0].id;
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
                const presets = settings.translatorPresets.items;

                if (presets.length === 0) {
                    alertError("There must be at least one preset.");
                    return;
                }

                const preset = current;
                await downloadFile(
                    getTranslatorPresetDownloadName(preset.name),
                    await encodeTranslatorPresetFile(preset),
                );
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
                const selectedFile = await selectSingleFile(translatorPresetImportExtensions);

                if (!selectedFile) return;

                const newPreset = await decodeTranslatorPresetFile(selectedFile.data);
                settings.translatorPresets.items.push(newPreset);
                settings.translatorPresets.selectedId = newPreset.id;

                alertNormal(language.successImport);
            } catch (error) {
                alertError(`${error}`);
            }
        }}
    >
        <HardDriveUploadIcon size={24} />
    </button>
</div>

{#if settings.translatorPresets.items?.some((entry) => entry.id === current.id) && current.steps[0]}
    <!-- One prompt until the step editor (translation slice 3.1): the first step's. Read through the
         preset at each access, so a conflict reload that replaces the steps is followed. -->
    {@const preset = current}
    <span class="text-textcolor mt-4">{language.translationResponseSize}</span>
    <NumberInput
        min={0}
        max={2048}
        marginBottom={true}
        bind:value={
            () => preset.steps[0].maxResponse,
            (value) => {
                preset.steps[0].maxResponse = value;
            }
        }
    />
    <span class="text-textcolor mt-4">{language.translatorPrompt} <Help key="translatorPrompt" /></span>
    <TextAreaInput
        bind:value={
            () => preset.steps[0].prompt,
            (value) => {
                preset.steps[0].prompt = value;
            }
        }
        placeholder={defaultTranslatorPrompt}
    />
{/if}
