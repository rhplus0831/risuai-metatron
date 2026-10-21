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
    import { usesStoredTranslation } from "src/ts/translator/storedTranslation.svelte";
    import { MAX_BILINGUAL_SENTENCES } from "../../../shared/translation/chatSettings.ts";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";

    interface Props {
        chatRef: ChatRef;
    }

    /*
     * A chat's translation settings: auto-translate; with the stored translation (LLM on
     * `"message"`) and auto-translate on, "bot replies only" (a send hands only its replies to the
     * server); and for the LLM translator the chat's translator preset ("Global" uses the global
     * selection; a deleted one is shown as such and falls back to it); with the stored translation,
     * the bilingual display with its emphasis and pairing. They are list fields, so the panel works
     * while the chat loads; a chat that is not a member shows nothing.
     */
    let { chatRef }: Props = $props();
    const member = $derived(chatEntry(chatRef) !== undefined);
    const current = $derived(chatTranslationSettings(chatRef));
    const resolved = $derived(chatTranslatorPreset(chatRef));
    const presets = $derived(settings.translatorPresets.items);
    const sentenceCounts = Array.from({ length: MAX_BILINGUAL_SENTENCES }, (_, index) => index + 1);

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
        {#if usesStoredTranslation() && current.autoTranslate}
            <CheckInput
                check={current.translateBotOnly}
                name={language.chatTranslation.botOnly}
                onChange={(check) => write({ translateBotOnly: check ? true : null })}
            />
        {/if}
        {#if usesStoredTranslation()}
            <CheckInput
                check={current.bilingualDisplay}
                name={language.chatTranslation.bilingual}
                onChange={(check) => write({ bilingualDisplay: check ? true : null })}
            />
            {#if current.bilingualDisplay}
                <div class="flex items-center gap-2">
                    <span class="text-sm text-textcolor2 shrink-0">{language.chatTranslation.emphasis}</span>
                    <SelectInput
                        className="grow min-w-0"
                        size="sm"
                        value={current.bilingualEmphasis}
                        onchange={(event) => {
                            write({
                                bilingualEmphasis: event.currentTarget.value === "translation" ? "translation" : null,
                            });
                        }}
                    >
                        <OptionInput value="original">{language.chatTranslation.emphasisOriginal}</OptionInput>
                        <OptionInput value="translation">{language.chatTranslation.emphasisTranslation}</OptionInput>
                    </SelectInput>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-sm text-textcolor2 shrink-0">{language.chatTranslation.pairing}</span>
                    <SelectInput
                        className="grow min-w-0"
                        size="sm"
                        value={String(current.bilingualSentences)}
                        onchange={(event) => {
                            const count = Number(event.currentTarget.value);
                            write({ bilingualSentences: count >= 1 ? count : null });
                        }}
                    >
                        <OptionInput value="0">{language.chatTranslation.pairByLine}</OptionInput>
                        {#each sentenceCounts as count (count)}
                            <OptionInput value={String(count)}
                                >{language.chatTranslation.pairBySentences(count)}</OptionInput
                            >
                        {/each}
                    </SelectInput>
                </div>
            {/if}
        {/if}
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
