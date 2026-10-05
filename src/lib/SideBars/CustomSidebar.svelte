<script lang="ts">
    import { settings, activePreset, activePersona, currentPresetRecord } from "src/ts/storage/settingsViews.svelte";
    import { Cog, PinIcon } from "@lucide/svelte";
    import { DBState, openPersonaList, openPresetList, selectedCharID } from "src/ts/stores.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import type { CustomSideBarItem } from "src/ts/storage/database.svelte";
    import { language } from "src/lang";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { getFullSettingsData } from "src/ts/setting/utils";
    import ModelList from "../UI/ModelList.svelte";
    import { get } from "svelte/store";
    import SettingRenderer from "../Setting/SettingRenderer.svelte";
    import { checkPersonaBinded, getUserName } from "src/ts/util";
    import { setCurrentChatMeta } from "src/ts/storage/chatEdits";
    let configPage: "list" | "add" | "addSettingsSubmenu" = $state("list");
    let search = $state("");

    let bindedPersona = $derived.by(() => {
        DBState.db.characters[$selectedCharID].chatPage;
        return checkPersonaBinded();
    });

    let personaName = $derived.by(() => {
        if (bindedPersona) {
            return bindedPersona?.name;
        }
        return activePersona.name;
    });
</script>

<div class="rounded-sm flex flex-col w-full gap-2">
    {#each settings.customSidebarItems as item}
        {#if item.type === "model"}
            <ModelList bind:value={activePreset.aiModel} noMargin />
        {:else if item.type === "preset"}
            <Button
                onclick={() => {
                    openPresetList.set(!get(openPresetList));
                }}>{currentPresetRecord()?.name || language.presets}</Button
            >
        {:else if item.type === "persona"}
            <Button
                className="flex"
                onclick={() => {
                    if (bindedPersona) {
                        return;
                    }
                    openPersonaList.set(!get(openPersonaList));
                }}
            >
                <div class="flex-1 flex-col flex text-left">
                    <span>{personaName}</span>
                    {#if bindedPersona?.note}
                        <span class="text-xs text-textcolor2">{bindedPersona?.note}</span>
                    {/if}
                </div>

                <button
                    class={{
                        "ml-2": true,
                        "text-textcolor2": !bindedPersona,
                        "text-textcolor": bindedPersona,
                    }}
                    onclick={(e) => {
                        e.stopPropagation();
                        if (checkPersonaBinded()) {
                            setCurrentChatMeta({ bindedPersona: "" });
                        } else {
                            setCurrentChatMeta({ bindedPersona: activePersona.id });
                        }
                    }}
                >
                    <PinIcon size={20} />
                </button>
            </Button>
        {:else if item.type === "setting"}
            <SettingRenderer items={[getFullSettingsData().find((s) => s.id === item.subType)]} />
        {/if}
    {/each}
</div>
