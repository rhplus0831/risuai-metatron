<script lang="ts">
    import { language } from "src/lang";
    import { chatEntry, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import {
        chatTranslationSettings,
        chatTranslatorPreset,
        globalTranslatorPreset,
        setChatTranslationSettings,
    } from "src/ts/translator/chatTranslation.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";

    interface Props {
        chatRef: ChatRef;
    }

    /*
     * A chat's translation settings (`docs/plan/translation.md` slices 2.1 and 2.2): auto-translate,
     * and for the LLM translator the chat's translator preset ("Global" uses the global selection; a
     * deleted one is shown as such and falls back to it). They are list fields, so the panel works
     * while the chat loads; a chat that is not a member shows nothing. Bot-only translation (slice 2.3)
     * and the bilingual display (slice 2.4) get their rows with those slices.
     */
    let { chatRef }: Props = $props();
    const member = $derived(chatEntry(chatRef) !== undefined);
    const current = $derived(chatTranslationSettings(chatRef));
    const resolved = $derived(chatTranslatorPreset(chatRef));
    const presets = $derived(settings.translatorPresets.items);

    /** Writes only while the chat is still a member (it can be gone by the event). */
    function write(patch: Parameters<typeof setChatTranslationSettings>[1]) {
        if (chatEntry(chatRef)) {
            setChatTranslationSettings(chatRef, patch);
        }
    }
</script>

{#if member}
    <div class="flex flex-col gap-2 rounded-md border border-darkborderc p-2 mb-3" data-chat-translation-panel>
        <span class="text-sm text-textcolor2">{language.chatTranslation.title}</span>
        <CheckInput
            check={current.autoTranslate}
            name={language.autoTranslation}
            onChange={(check) => write({ autoTranslate: check ? true : null })}
        />
        {#if settings.memoryTranslateMedia.translatorType === "llm"}
            <div class="flex items-center gap-2">
                <span class="text-sm text-textcolor2 shrink-0">{language.chatTranslation.translatorPreset}</span>
                <SelectInput
                    className="grow min-w-0"
                    size="sm"
                    value={current.translatorPresetId ?? ""}
                    onchange={(event) => {
                        const id = event.currentTarget.value;
                        write({ translatorPresetId: id === "" ? null : id });
                    }}
                >
                    <OptionInput value="">{language.chatTranslation.global(globalTranslatorPreset().name)}</OptionInput>
                    {#if resolved.missing && current.translatorPresetId !== null}
                        <OptionInput value={current.translatorPresetId}
                            >{language.chatTranslation.goneUsingGlobal}</OptionInput
                        >
                    {/if}
                    {#each presets as preset (preset.id)}
                        <OptionInput value={preset.id}>{preset.name}</OptionInput>
                    {/each}
                </SelectInput>
            </div>
        {/if}
    </div>
{/if}
