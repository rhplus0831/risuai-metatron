<script lang="ts">
    import { language } from "src/lang";
    import { chatMemoryEnabled, chatMemoryMode, legacyMemoryAlgorithm } from "../../../shared/chatMemory.ts";
    import { chatEntry, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatMemorySettings, setChatMemoryEnabled, setChatMemoryMode } from "src/ts/storage/chatMemory.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";

    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import { STRUCTURED_MEMORY_ALGORITHM } from "../../../shared/structuredMemory.ts";

    let { chatRef }: { chatRef: ChatRef } = $props();
    const entry = $derived(chatEntry(chatRef));
    const enabled = $derived(chatMemoryEnabled(entry, findCharacter(chatRef.chaId), chatMemorySettings()));

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
    </div>
{/if}
