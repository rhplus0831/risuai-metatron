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
    import { getGlobalChatVar, getGlobalChatVarOf } from "src/ts/parser/chatVar.svelte";
    import { chatToggleDefinitions, setChatToggle } from "src/ts/toggles/chatToggles.svelte";
    import { supaMemoryOnCount } from "../../../shared/characters.ts";

    interface Props {
        chara?: AnyClientCharacter;
        chatRef: ChatRef | null;
    }

    let { chara = $bindable(), chatRef }: Props = $props();

    const chat = $derived(chatRef ? findChat(chatRef) : undefined);
    const loaded = $derived(chat !== undefined);
    const valueOf = (key: string) => (chatRef ? getGlobalChatVarOf(chatRef, key) : getGlobalChatVar(key));

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
        const ungrouped = parseToggleSyntax(chatToggleDefinitions(chatRef));

        let groupOpen = false;
        // group toggles together between group ... groupEnd
        return ungrouped.reduce<sidebarToggle[]>((acc, toggle) => {
            if (toggle.type === "group") {
                groupOpen = true;
                acc.push(toggle);
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
                <span>{toggle.value}</span>
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
                <span>{toggle.value}</span>
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
                <span class="mt-1.5">{toggle.value}</span>
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
                />
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
