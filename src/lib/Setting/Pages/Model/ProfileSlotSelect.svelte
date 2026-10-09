<script lang="ts">
    import { language } from "src/lang";
    import { getModelInfo } from "src/ts/model/modellist";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import {
        addModelProfile,
        setMainModelSlot,
        setSubModelSlot,
        setAuxModelSlot,
    } from "src/ts/storage/collectionStore.svelte";
    import type { AuxModelMode, ModelSlot } from "../../../../../shared/database.ts";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";

    interface Props {
        presetId: string;
        mode: "model" | "submodel" | AuxModelMode;
        label: string;
    }
    let { presetId, mode, label }: Props = $props();
    const preset = $derived(settings.modelPresets.find((entry) => entry.id === presetId));
    const auxiliary = $derived(mode !== "model" && mode !== "submodel");
    const slot: ModelSlot | undefined = $derived(
        mode === "model" ? preset?.mainSlot : mode === "submodel" ? preset?.subSlot : preset?.auxSlots[mode],
    );
    const profiles = $derived(settings.modelProfiles ?? []);
    const missing = $derived(slot && "profileId" in slot && !profiles.some((profile) => profile.id === slot.profileId));
    const selected = $derived(!slot ? "" : "profileId" in slot ? `profile:${slot.profileId}` : `bare:${slot.modelId}`);

    function choose(value: string | number) {
        if (value === "" && auxiliary) {
            setAuxModelSlot(presetId, mode as AuxModelMode, null);
        } else if (typeof value === "string" && value.startsWith("profile:")) {
            const id = value.slice("profile:".length);
            if (mode === "model") setMainModelSlot(presetId, id);
            else if (mode === "submodel") setSubModelSlot(presetId, id);
            else setAuxModelSlot(presetId, mode, id);
        }
    }

    function createFromBare() {
        if (!slot || !("modelId" in slot) || !auxiliary) return;
        const id = addModelProfile({ modelId: slot.modelId, name: getModelInfo(slot.modelId, undefined, null).name });
        setAuxModelSlot(presetId, mode as AuxModelMode, id);
    }
</script>

<div class="flex flex-col gap-2 mt-4 min-w-0" data-model-slot={mode}>
    <label class="flex flex-col gap-1 min-w-0">
        <span class="text-textcolor">{label}</span>
        <SelectInput className="w-full min-w-0" bind:value={() => selected, choose}>
            {#if auxiliary}
                <OptionInput value="">{language.modelProfiles.useSubProfile}</OptionInput>
            {/if}
            {#if missing && slot && "profileId" in slot}
                <OptionInput value={selected} disabled selected
                    >{language.modelProfiles.missingProfile(slot.profileId)}</OptionInput
                >
            {/if}
            {#if slot && "modelId" in slot}
                <OptionInput value={selected} disabled selected
                    >{language.modelProfiles.noProfile(getModelInfo(slot.modelId, undefined, null).name)}</OptionInput
                >
            {/if}
            {#each profiles as profile (profile.id)}
                <OptionInput value={`profile:${profile.id}`}
                    >{language.modelProfiles.profileLabel(
                        profile.name,
                        getModelInfo(profile.modelId, undefined, profile).name,
                    )}</OptionInput
                >
            {/each}
        </SelectInput>
    </label>
    {#if missing}
        <p class="text-draculared text-xs">{language.modelProfiles.missingSlotHint}</p>
    {/if}
    {#if slot && "modelId" in slot}
        <Button size="sm" styled="outlined" onclick={createFromBare}>{language.modelProfiles.createFromBare}</Button>
    {/if}
</div>
