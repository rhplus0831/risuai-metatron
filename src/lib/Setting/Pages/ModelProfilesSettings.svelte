<script module lang="ts">
    // The editor selection outlives the page: switching the Model menu's tabs remounts it
    // (`Settings.svelte` keys the page by the menu index), and a return keeps the connection.
    let selectedId = $state("");
</script>

<script lang="ts">
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import { getModelInfo } from "src/ts/model/modellist";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import {
        addModelProfile,
        copyModelProfile,
        updateModelProfile,
        deleteModelProfile,
        presetsUsingModelProfile,
        translatorPresetsUsingModelProfile,
    } from "src/ts/storage/collectionStore.svelte";
    import ModelProfileEditor from "./Model/ModelProfileEditor.svelte";
    import ModelMenuTabs from "./Model/ModelMenuTabs.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { currentJump } from "src/ts/setting/settingJump.svelte";

    // The editor selection does not change any preset's slot choices; a removed profile falls back
    // to the first.
    const profiles = $derived(settings.modelProfiles ?? []);
    // A search jump to a Connections item selects its target, the main slot's profile (Decision 16),
    // before the editor mounts.
    const jumpProfileId = currentJump()?.profileId;
    if (jumpProfileId !== undefined) selectedId = jumpProfileId;
    const selected = $derived(profiles.find((profile) => profile.id === selectedId) ?? profiles[0]);

    function add() {
        selectedId = addModelProfile({ name: language.modelProfiles.newName });
    }
    function copy(id: string, name: string) {
        const copiedId = copyModelProfile(id);
        if (copiedId) {
            updateModelProfile(copiedId, { name: language.modelProfiles.copyName(name) });
            selectedId = copiedId;
        }
    }
    async function remove(id: string, name: string) {
        const uses = presetsUsingModelProfile(id)
            .map((preset) => preset.name)
            .join("\n");
        const translatorUses = translatorPresetsUsingModelProfile(id)
            .map((preset) => preset.name)
            .join("\n");
        if (await alertConfirm(language.modelProfiles.deleteConfirm(name, uses, translatorUses))) {
            deleteModelProfile(id);
        }
    }
</script>

<ModelMenuTabs />
<p class="text-textcolor2 text-sm mb-4">{language.modelProfiles.description}</p>

<div class="flex flex-col gap-2 mb-4 p-3 rounded-md border border-darkborderc">
    {#each profiles as profile (profile.id)}
        <button
            class="text-left p-2 rounded-md hover:bg-selected break-words"
            class:bg-selected={selected?.id === profile.id}
            aria-pressed={selected?.id === profile.id}
            data-profile-id={profile.id}
            onclick={() => (selectedId = profile.id)}
        >
            {language.modelProfiles.profileLabel(profile.name, getModelInfo(profile.modelId, undefined, profile).name)}
        </button>
    {/each}
    <Button size="sm" onclick={add}>{language.modelProfiles.add}</Button>
</div>

{#if selected}
    <div class="flex flex-col gap-2 mb-4 p-3 rounded-md border border-darkborderc">
        <label for="model-profile-name" class="text-sm">{language.name}</label>
        <TextInput
            id="model-profile-name"
            fullwidth
            size="sm"
            bind:value={() => selected.name, (value) => updateModelProfile(selected.id, { name: value })}
        />
        <div class="flex flex-wrap gap-2">
            <Button size="sm" styled="outlined" onclick={() => copy(selected.id, selected.name)}
                >{language.modelProfiles.copy}</Button
            >
            <Button
                size="sm"
                styled="outlined"
                className="text-draculared"
                disabled={profiles.length <= 1}
                onclick={() => remove(selected.id, selected.name)}>{language.modelProfiles.delete}</Button
            >
        </div>
        {#if profiles.length <= 1}
            <p class="text-textcolor2 text-xs">{language.modelProfiles.keepOne}</p>
        {/if}
    </div>
    {#key selected.id}
        <ModelProfileEditor profileId={selected.id} />
    {/key}
{/if}
