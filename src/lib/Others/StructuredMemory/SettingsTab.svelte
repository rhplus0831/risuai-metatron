<script lang="ts">
    import { language } from "src/lang";
    import type { MemoryPanelTabProps } from "src/ts/process/structuredMemory.svelte";
    import { findCharacter, updateCharacter } from "src/ts/storage/characterStore.svelte";
    import { findChat, setChatMeta } from "src/ts/storage/chatStore.svelte";
    import { hypaV3ModalOpen, MEMORY_SETTINGS_MENU, settingsOpen, SettingsMenuIndex } from "src/ts/stores.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import {
        STRUCTURED_MEMORY_HIGHLIGHT_MODES,
        STRUCTURED_MEMORY_LIMITS,
        structuredMemoryHighlightOverride,
        structuredMemoryLanguageOverride,
    } from "../../../../shared/structuredMemory.ts";

    /**
     * The chat's language and highlight overrides are chat fields written through
     * src/ts/storage/chatStore.svelte.ts's `setChatMeta`, not memory routes. The chat must be held;
     * read-only disables the controls. The owner's instructions are a field of the chat's character or
     * group, written through src/ts/storage/characterStore.svelte.ts's `updateCharacter`; they apply to
     * every chat of that owner, and the writer reads at most `ownerInstructionsChars` of them. The writer
     * sends them as written, with no CBS, so their popup editor opens in its literal mode. Other
     * values belong to the selected memory preset, so the link closes the panel and opens the Memory
     * settings page rather than editing them here.
     */

    let { chatRef, readOnly }: MemoryPanelTabProps = $props();

    const text = language.structuredMemory.settingsTab;

    const heldChat = $derived(findChat(chatRef));
    const controlsOff = $derived(readOnly || heldChat === undefined);
    const languageOverride = $derived(structuredMemoryLanguageOverride(heldChat) ?? "");
    const highlightMode = $derived(structuredMemoryHighlightOverride(heldChat) ?? "");
    const { ownerInstructionsChars } = STRUCTURED_MEMORY_LIMITS;
    const ownerInstructions = $derived.by(() => {
        const stored = findCharacter(chatRef.chaId)?.structuredMemoryInstructions;
        return typeof stored === "string" ? stored : "";
    });

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

    /** The owner's instructions as typed, or none for a blank. Not under `controlsOff`. */
    function setOwnerInstructions(value: string) {
        if (controlsOff || value === ownerInstructions) {
            return;
        }
        updateCharacter(chatRef.chaId, { structuredMemoryInstructions: value.trim() === "" ? undefined : value });
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
    <div class="flex flex-col min-w-0 gap-1" data-memory-owner-instructions>
        <span class="text-textcolor2">{text.ownerInstructions}</span>
        <span class="text-xs text-textcolor2">{text.ownerInstructionsHelp}</span>
        {#if controlsOff}
            {#if ownerInstructions !== ""}
                <p class="p-2 whitespace-pre-wrap border rounded-md wrap-break-word border-darkborderc">
                    {ownerInstructions}
                </p>
            {/if}
        {:else}
            <TextAreaInput
                height="32"
                popupEditorContext={chatRef.chaId}
                popupMode="literal"
                ariaLabel={text.ownerInstructions}
                bind:value={() => ownerInstructions, setOwnerInstructions}
            />
        {/if}
        <span
            class={"text-xs " +
                (ownerInstructions.length > ownerInstructionsChars ? "text-draculared" : "text-textcolor2")}
            data-memory-owner-instructions-count
        >
            {text.ownerInstructionsCount(ownerInstructions.length, ownerInstructionsChars)}
        </span>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2 text-textcolor2">
        <span class="min-w-0">{text.presetValues}</span>
        <Button size="sm" styled="outlined" onclick={openMemorySettings}>
            <span data-memory-settings-link>{text.openMemorySettings}</span>
        </Button>
    </div>
</div>
