<script lang="ts">
    import { type AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { parseToggleSyntax, type sidebarToggle, type sidebarToggleGroup } from "src/ts/util";
    import { language } from "src/lang";
    import type { PromptItem } from "src/ts/process/prompt";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import Accordion from "../UI/Accordion.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { getGlobalChatVar } from "src/ts/parser/chatVar.svelte";
    import { chatToggleDefinitions, setChatToggle } from "src/ts/toggles/chatToggles.svelte";
    import { supaMemoryOnCount } from "../../../shared/characters.ts";
    import { resolveGlobalChatVar, valueToggles } from "../../../shared/prompt/toggles.ts";
    import { compareTogglePreset, toggleValuesForChat } from "../../../shared/togglePresets.ts";
    import {
        applyTogglePreset,
        deleteTogglePreset,
        overwriteTogglePreset,
        renameTogglePreset,
        saveTogglePresetFromChat,
        unlinkTogglePreset,
    } from "src/ts/toggles/togglePresets.svelte";
    import { alertConfirm, alertInput } from "src/ts/alert";
    import { CircleAlertIcon, CopyPlusIcon, PencilIcon, SaveIcon, TrashIcon } from "@lucide/svelte";

    interface Props {
        chara?: AnyClientCharacter;
        chatRef: ChatRef | null;
        presets?: boolean;
    }

    let { chara = $bindable(), chatRef, presets = true }: Props = $props();

    const chat = $derived(chatRef ? findChat(chatRef) : undefined);
    const loaded = $derived(chat !== undefined);
    const definitionsText = $derived(chatToggleDefinitions(chatRef));
    const definitions = $derived(parseToggleSyntax(definitionsText));
    const hasValueToggles = $derived(valueToggles(definitions).length > 0);
    const valueOf = (key: string) =>
        chatRef
            ? resolveGlobalChatVar(key, chat?.GLGlobalVariables, settings.globalChatVariables, definitionsText)
            : getGlobalChatVar(key);
    const linkedId = $derived(chat?.togglePresetId ?? "");
    const savedPresets = $derived(settings.togglePresets ?? []);
    const linkedPreset = $derived(savedPresets.find((preset) => preset.id === linkedId));
    const comparison = $derived(
        presets && linkedPreset ? compareTogglePreset(linkedPreset, definitionsText, valueOf) : undefined,
    );
    const differing = $derived(new Set(comparison?.differing ?? []));
    const presetState = $derived(
        !linkedId
            ? ""
            : !linkedPreset
              ? language.togglePresets.deleted
              : comparison?.hasMismatch
                ? language.togglePresets.mismatch
                : comparison?.hasDifference
                  ? language.togglePresets.edited
                  : "",
    );

    async function selectPreset(event: Event & { currentTarget: HTMLSelectElement }) {
        const select = event.currentTarget;
        const previous = linkedId;
        const id = select.value;
        const ref = chatRef;
        if (!ref || !findChat(ref)) {
            select.value = previous;
            return;
        }
        if (id === "") {
            unlinkTogglePreset(ref);
            return;
        }
        const preset = savedPresets.find((entry) => entry.id === id);
        if (!preset) {
            select.value = previous;
            return;
        }
        const { name } = preset;
        const changesValues = Object.entries(toggleValuesForChat(preset, definitionsText)).some(
            ([key, value]) => value !== valueOf(key),
        );
        if (changesValues && !(await alertConfirm(language.togglePresets.applyConfirm(name)))) {
            select.value = previous;
            return;
        }
        // Resolve again inside the operation: the record may have been removed during the dialog.
        if (!findChat(ref) || !applyTogglePreset(ref, id)) {
            select.value = previous;
        }
    }

    async function savePreset(asNew = false) {
        const ref = chatRef;
        if (!ref || !findChat(ref)) return;
        if (!asNew && linkedPreset) {
            const { id, name } = linkedPreset;
            if ((await alertConfirm(language.togglePresets.overwriteConfirm(name))) && findChat(ref)) {
                overwriteTogglePreset(ref, id);
            }
        } else {
            const name = await alertInput(language.togglePresets.namePrompt);
            if (name && findChat(ref)) saveTogglePresetFromChat(ref, name);
        }
    }

    async function renamePreset() {
        const ref = chatRef;
        if (!ref || !findChat(ref) || !linkedPreset) return;
        const { id, name } = linkedPreset;
        const nextName = await alertInput(language.togglePresets.namePrompt, [], name);
        if (nextName && findChat(ref)) renameTogglePreset(id, nextName);
    }

    async function removePreset() {
        const ref = chatRef;
        if (!ref || !findChat(ref) || !linkedPreset) return;
        const { id, name } = linkedPreset;
        if ((await alertConfirm(language.removeConfirm + name)) && findChat(ref)) deleteTogglePreset(id);
    }

    /** Re-check the target at event time: it may have unloaded or disappeared since rendering. */
    function write(key: string, value: string) {
        if (chatRef && findChat(chatRef)) {
            setChatToggle(chatRef, key, value);
        }
    }

    // Turning memory on counts (`supaMemoryOnCount`): it voids every chat's "don't ask again" answer to
    // the no-memory trim question.
    const getMemoryToggle = () => chara?.supaMemory ?? false;
    const setMemoryToggle = (on: boolean) => {
        if (!chara) {
            return;
        }
        if (on && !chara.supaMemory) {
            chara.supaMemoryOnCount = supaMemoryOnCount(chara) + 1;
        }
        chara.supaMemory = on;
    };

    const jailbreakToggleToken = "{{jbtoggled}}";
    const usesJailbreakToggle = (value?: string) => typeof value === "string" && value.includes(jailbreakToggleToken);
    const templateUsesJailbreakToggle = (template: PromptItem[]) =>
        template.some((item) => {
            if (item.type === "jailbreak") {
                return true;
            }
            if ("text" in item && usesJailbreakToggle(item.text)) {
                // plain, jailbreak, cot
                return true;
            }
            if ("innerFormat" in item && usesJailbreakToggle(item.innerFormat)) {
                // persona, description, lorebook, postEverything, memory
                return true;
            }
            if ("defaultText" in item && usesJailbreakToggle(item.defaultText)) {
                // author note
                return true;
            }
            return false;
        });

    let hasJailbreakPrompt = $derived.by(() => {
        const template = activePreset.promptTemplate;
        if (!template) {
            return (activePreset.jailbreak ?? "").trim().length > 0;
        }
        return templateUsesJailbreakToggle(template);
    });

    let groupedToggles = $derived.by(() => {
        let groupOpen = false;
        // group toggles together between group ... groupEnd
        return definitions.reduce<sidebarToggle[]>((acc, toggle) => {
            if (toggle.type === "group") {
                groupOpen = true;
                acc.push({ ...toggle, children: [] });
            } else if (toggle.type === "groupEnd") {
                groupOpen = false;
            } else if (groupOpen) {
                (acc.at(-1) as sidebarToggleGroup).children.push(toggle);
            } else {
                acc.push(toggle);
            }
            return acc;
        }, []);
    });
</script>

{#snippet differenceMarker(key: string)}
    {#if differing.has(key)}
        <span
            class="ml-1 shrink-0 inline-flex text-draculared"
            title={language.togglePresets.differs}
            data-toggle-differs
        >
            <CircleAlertIcon size={14} />
        </span>
    {/if}
{/snippet}

{#snippet toggles(items: sidebarToggle[], reverse: boolean = false)}
    {#each items as toggle, index}
        {#if toggle.type === "group" && toggle.children.length > 0}
            <div class="w-full">
                <Accordion styled name={toggle.value}>
                    {@render toggles((toggle as sidebarToggleGroup).children, reverse)}
                </Accordion>
            </div>
        {:else if toggle.type === "select"}
            <div class="w-full flex gap-2 mt-2 items-center">
                <span class="inline-flex items-center">{toggle.value}{@render differenceMarker(toggle.key)}</span>
                <SelectInput
                    className="w-32"
                    value={valueOf(`toggle_${toggle.key}`)}
                    onchange={(e) => {
                        write(`toggle_${toggle.key}`, e.currentTarget.value);
                    }}
                >
                    {#each toggle.options as option, i}
                        <OptionInput value={i.toString()}>{option}</OptionInput>
                    {/each}
                </SelectInput>
            </div>
        {:else if toggle.type === "text"}
            <div class="w-full flex gap-2 mt-2 items-center">
                <span class="inline-flex items-center">{toggle.value}{@render differenceMarker(toggle.key)}</span>
                <TextInput
                    className="w-32"
                    value={valueOf(`toggle_${toggle.key}`)}
                    onchange={(e) => {
                        write(`toggle_${toggle.key}`, e.currentTarget.value);
                    }}
                />
            </div>
        {:else if toggle.type === "textarea"}
            <div class="w-full flex gap-2 mt-2 items-start">
                <span class="mt-1.5 inline-flex items-center">{toggle.value}{@render differenceMarker(toggle.key)}</span
                >
                <TextAreaInput
                    className="w-32"
                    height="20"
                    value={valueOf(`toggle_${toggle.key}`)}
                    onchange={(e) => {
                        //check is div
                        if (e.currentTarget instanceof HTMLDivElement) {
                            write(`toggle_${toggle.key}`, e.currentTarget.innerText);
                        } else {
                            write(`toggle_${toggle.key}`, e.currentTarget.value);
                        }
                    }}
                />
            </div>
        {:else if toggle.type === "caption"}
            <div class="w-full mt-1 text-xs text-textcolor2">
                {toggle.value}
            </div>
        {:else if toggle.type === "divider"}
            <!-- Prevent multiple dividers appearing in a row -->
            {#if index === 0 || items[index - 1]?.type !== "divider" || items[index - 1]?.value !== toggle.value}
                <div class="w-full min-h-5 flex gap-2 mt-2 items-center" class:justify-end={!reverse}>
                    {#if toggle.value}
                        <span class="shrink-0">{toggle.value}</span>
                    {/if}
                    <hr class="border-t border-darkborderc m-0 grow" />
                </div>
            {/if}
        {:else}
            <div class="w-full flex mt-2 items-center">
                <CheckInput
                    check={valueOf(`toggle_${toggle.key}`) === "1"}
                    {reverse}
                    name={toggle.value}
                    onChange={(check) => write(`toggle_${toggle.key}`, check ? "1" : "0")}
                >
                    {@render differenceMarker(toggle.key)}
                </CheckInput>
            </div>
        {/if}
    {/each}
{/snippet}

{#if hasJailbreakPrompt}
    <div class="flex mt-2 items-center">
        <CheckInput bind:check={settings.ui.jailbreakToggle} name={language.jailbreakToggle} />
    </div>
{/if}
<fieldset disabled={!loaded} class="m-0 min-w-0 border-0 p-0">
    {#if presets && hasValueToggles}
        <div class="flex min-w-0 flex-col gap-2 mt-2 mb-3" data-toggle-presets>
            <div class="flex flex-wrap items-center gap-2 text-sm text-textcolor2">
                <span>{language.togglePresets.title}</span>
                {#if presetState}<span data-toggle-preset-state>{presetState}</span>{/if}
            </div>
            <SelectInput
                className="w-full min-w-0"
                size="sm"
                aria-label={language.togglePresets.title}
                data-toggle-preset-select
                value={linkedId}
                onchange={selectPreset}
            >
                <OptionInput value="">{language.togglePresets.none}</OptionInput>
                {#if linkedId && !linkedPreset}
                    <OptionInput value={linkedId}>{language.togglePresets.deleted}</OptionInput>
                {/if}
                {#each savedPresets as preset (preset.id)}
                    <OptionInput value={preset.id}>{preset.name}</OptionInput>
                {/each}
            </SelectInput>
            <div class="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    class="text-textcolor2 hover:text-green-500 cursor-pointer"
                    title={language.togglePresets.save}
                    aria-label={language.togglePresets.save}
                    onclick={() => savePreset()}><SaveIcon size={18} /></button
                >
                <button
                    type="button"
                    class="text-textcolor2 hover:text-green-500 cursor-pointer"
                    title={language.togglePresets.saveAsNew}
                    aria-label={language.togglePresets.saveAsNew}
                    onclick={() => savePreset(true)}><CopyPlusIcon size={18} /></button
                >
                {#if linkedPreset}
                    <button
                        type="button"
                        class="text-textcolor2 hover:text-green-500 cursor-pointer"
                        title={language.togglePresets.rename}
                        aria-label={language.togglePresets.rename}
                        onclick={renamePreset}><PencilIcon size={18} /></button
                    >
                    <button
                        type="button"
                        class="text-textcolor2 hover:text-green-500 cursor-pointer"
                        title={language.togglePresets.remove}
                        aria-label={language.togglePresets.remove}
                        onclick={removePreset}><TrashIcon size={18} /></button
                    >
                {/if}
            </div>
        </div>
    {/if}
    {@render toggles(groupedToggles)}
</fieldset>
{#if chara && (settings.memoryTranslateMedia.supaModelType !== "none" || settings.memoryTranslateMedia.hanuraiEnable || settings.memoryTranslateMedia.hypav2 || settings.memoryTranslateMedia.hypaV3)}
    <div class="flex mt-2 items-center">
        <CheckInput
            bind:check={getMemoryToggle, setMemoryToggle}
            name={settings.memoryTranslateMedia.hypaV3
                ? language.ToggleHypaMemory
                : settings.memoryTranslateMedia.hanuraiEnable
                  ? language.hanuraiMemory
                  : settings.memoryTranslateMedia.hypaMemory || settings.memoryTranslateMedia.hypav2
                    ? language.ToggleHypaMemory
                    : language.ToggleSuperMemory}
        />
    </div>
{/if}
