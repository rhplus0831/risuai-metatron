<script lang="ts">
    import { language } from "src/lang";
    import {
        chatMemoryEnabled,
        chatMemoryMode,
        chatMemoryProfileId,
        legacyMemoryAlgorithm,
    } from "../../../shared/chatMemory.ts";
    import { chatEntry, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import {
        chatMemorySettings,
        setChatMemoryEnabled,
        setChatMemoryMode,
        setChatMemoryPreset,
        setChatMemoryProfile,
    } from "src/ts/storage/chatMemory.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";

    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import { STRUCTURED_MEMORY_ALGORITHM } from "../../../shared/structuredMemory.ts";

    import { selectedHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
    import { settings } from "src/ts/storage/settingsViews.svelte";

    // Chat list metadata supports the same controls for loaded and unloaded chats.
    let { chatRef }: { chatRef: ChatRef } = $props();
    const entry = $derived(chatEntry(chatRef));
    const enabled = $derived(chatMemoryEnabled(entry, findCharacter(chatRef.chaId), chatMemorySettings()));

    const presetId = $derived(typeof entry?.memoryPresetId === "string" ? entry.memoryPresetId : undefined);
    const defaultPreset = $derived(
        selectedHypaV3Preset({
            hypaV3Presets: settings.hypaV3Presets.items,
            hypaV3PresetId: settings.hypaV3Presets.selectedId,
        }),
    );
    const presetDeleted = $derived(
        presetId !== undefined && !settings.hypaV3Presets.items.some((preset) => preset.id === presetId),
    );

    const profiles = $derived(settings.modelProfiles ?? []);
    const profileId = $derived(chatMemoryProfileId(entry));
    const profileDeleted = $derived(profileId !== undefined && !profiles.some((profile) => profile.id === profileId));

    const legacyName = $derived.by(() => {
        switch (legacyMemoryAlgorithm(chatMemorySettings())) {
            case STRUCTURED_MEMORY_ALGORITHM:
                return language.structuredMemory.name;
            case "hypaMemoryV3":
                return `${language.HypaMemory} V3`;
            case "hypaMemoryV2":
                return `${language.HypaMemory} V2`;
            case "hanuraiMemory":
                return language.hanuraiMemory;
            case "supaMemory":
                return language.SuperMemory;
            default:
                return language.none;
        }
    });

    function setEnabled(on: boolean) {
        if (chatEntry(chatRef)) setChatMemoryEnabled(chatRef, on);
    }
</script>

{#if entry}
    <div class="mb-3 min-w-0 rounded-md border border-darkborderc p-2" data-chat-memory-panel>
        <CheckInput check={enabled} name={language.chatMemory.enabled} onChange={setEnabled} className="min-w-0" />
        <label class="mt-2 block min-w-0 text-sm text-textcolor">
            <span class="mb-1 block">{language.chatMemory.mode}</span>
            <SelectInput
                size="sm"
                className="w-full min-w-0 max-w-full"
                value={chatMemoryMode(entry) ?? "legacy"}
                onchange={({ currentTarget }) => {
                    if (chatEntry(chatRef))
                        setChatMemoryMode(chatRef, chatMemoryMode({ memoryMode: currentTarget.value }));
                }}
            >
                <OptionInput value="legacy">{language.chatMemory.legacy(legacyName)}</OptionInput>
                <OptionInput value="hypaV3">{language.chatMemory.hypaV3}</OptionInput>
                <OptionInput value={STRUCTURED_MEMORY_ALGORITHM}>{language.structuredMemory.name}</OptionInput>
            </SelectInput>
        </label>
        <label class="mt-2 block min-w-0 text-sm text-textcolor">
            <span class="mb-1 block">{language.chatMemory.preset}</span>
            <SelectInput
                size="sm"
                className="w-full min-w-0 max-w-full"
                value={presetId === undefined ? "" : `preset:${presetId}`}
                onchange={({ currentTarget }) => {
                    if (chatEntry(chatRef))
                        setChatMemoryPreset(
                            chatRef,
                            currentTarget.value === "" ? undefined : currentTarget.value.slice("preset:".length),
                        );
                }}
            >
                <OptionInput value=""
                    >{language.chatMemory.defaultPreset(defaultPreset?.name ?? language.none)}</OptionInput
                >
                {#if presetId !== undefined && presetDeleted}
                    <OptionInput value={`preset:${presetId}`}>{language.chatMemory.deletedPreset(presetId)}</OptionInput
                    >
                {/if}
                {#each settings.hypaV3Presets.items as preset (preset.id)}
                    <OptionInput value={`preset:${preset.id}`}>{preset.name}</OptionInput>
                {/each}
            </SelectInput>
        </label>
        <label class="mt-2 block min-w-0 text-sm text-textcolor">
            <span class="mb-1 block">{language.chatMemory.connection}</span>
            <SelectInput
                size="sm"
                className="w-full min-w-0 max-w-full"
                value={profileId === undefined ? "" : `profile:${profileId}`}
                onchange={({ currentTarget }) => {
                    if (chatEntry(chatRef))
                        setChatMemoryProfile(
                            chatRef,
                            currentTarget.value === "" ? undefined : currentTarget.value.slice("profile:".length),
                        );
                }}
            >
                <OptionInput value="">{language.chatMemory.defaultConnection}</OptionInput>
                {#if profileId !== undefined && profileDeleted}
                    <OptionInput value={`profile:${profileId}`}
                        >{language.chatMemory.deletedConnection(profileId)}</OptionInput
                    >
                {/if}
                {#each profiles as profile (profile.id)}
                    <OptionInput value={`profile:${profile.id}`}>{profile.name}</OptionInput>
                {/each}
            </SelectInput>
        </label>
        <p class="mt-1 text-xs text-textcolor/60">{language.chatMemory.connectionHelp}</p>
    </div>
{/if}
