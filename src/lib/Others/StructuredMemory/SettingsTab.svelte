<script lang="ts">
    import { language } from "src/lang";
    import type { MemoryPanelTabProps } from "src/ts/process/structuredMemory.svelte";
    import { findChat, setChatMeta } from "src/ts/storage/chatStore.svelte";
    import { hypaV3ModalOpen, MEMORY_SETTINGS_MENU, settingsOpen, SettingsMenuIndex } from "src/ts/stores.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import {
        STRUCTURED_MEMORY_HIGHLIGHT_MODES,
        structuredMemoryHighlightOverride,
        structuredMemoryLanguageOverride,
    } from "../../../../shared/structuredMemory.ts";

    // The Settings tab: the chat's own overrides, its recording language and its highlight mode. Both are
    // chat fields, written through the chat module and not through the routes, so they need the chat held
    // and nothing of its memory, and read-only only turns the controls off. Every other value is the
    // selected memory preset's, which the memory settings page edits; the tab links there.

    let { chatRef, readOnly }: MemoryPanelTabProps = $props();

    const text = language.structuredMemory.settingsTab;

    const heldChat = $derived(findChat(chatRef));
    const controlsOff = $derived(readOnly || heldChat === undefined);
    const languageOverride = $derived(structuredMemoryLanguageOverride(heldChat) ?? "");
    const highlightMode = $derived(structuredMemoryHighlightOverride(heldChat) ?? "");

    /** The chat's own language, or none for a blank. Not under `controlsOff`, and only on a held chat. */
    function setLanguage(value: string) {
        if (controlsOff || !findChat(chatRef)) {
            return;
        }
        const trimmed = value.trim();
        if (trimmed !== "") {
            setChatMeta(chatRef, { structuredMemoryLanguage: trimmed });
        } else {
            setChatMeta(chatRef, {}, ["structuredMemoryLanguage"]);
        }
    }

    /** The chat's own mode, or `""` for the default. Not under `controlsOff`, and only on a held chat. */
    function setHighlightMode(value: string) {
        if (controlsOff || !findChat(chatRef)) {
            return;
        }
        const mode = STRUCTURED_MEMORY_HIGHLIGHT_MODES.find((entry) => entry === value);
        if (mode) {
            setChatMeta(chatRef, { structuredMemoryHighlight: mode });
        } else {
            setChatMeta(chatRef, {}, ["structuredMemoryHighlight"]);
        }
    }

    /** Leaves the panel for the memory settings page, where the preset's values are. */
    function openMemorySettings() {
        $hypaV3ModalOpen = false;
        $settingsOpen = true;
        $SettingsMenuIndex = MEMORY_SETTINGS_MENU;
    }
</script>

<div class="flex flex-col min-w-0 gap-3 text-sm" data-memory-settings data-read-only={readOnly}>
    <label class="flex flex-col gap-1 sm:max-w-sm" data-memory-language>
        <span class="text-textcolor2">{text.language}</span>
        <TextInput
            size="sm"
            placeholder={text.languagePlaceholder}
            value={languageOverride}
            disabled={controlsOff}
            onchange={(event) => setLanguage(event.currentTarget.value)}
        />
    </label>
    <label class="flex flex-col self-start gap-1">
        <span class="text-textcolor2">{text.highlightMode}</span>
        <SelectInput
            size="sm"
            value={highlightMode}
            disabled={controlsOff}
            onchange={(event) => setHighlightMode(event.currentTarget.value)}
            data-memory-highlight-mode
        >
            <OptionInput value="">{text.highlightDefault}</OptionInput>
            {#each STRUCTURED_MEMORY_HIGHLIGHT_MODES as mode (mode)}
                <OptionInput value={mode}>{language.structuredMemory.highlightModes[mode]}</OptionInput>
            {/each}
        </SelectInput>
    </label>
    <div class="flex flex-wrap items-center justify-between gap-2 text-textcolor2">
        <span class="min-w-0">{text.presetValues}</span>
        <Button size="sm" styled="outlined" onclick={openMemorySettings}>
            <span data-memory-settings-link>{text.openMemorySettings}</span>
        </Button>
    </div>
</div>
