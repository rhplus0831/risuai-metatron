<script lang="ts">
    /** A controlled editor of bare-key forced values; each edit returns a fresh map through onchange. */
    import {
        parseToggleSyntax,
        toggleDefault,
        toggleKindOf,
        valueToggles,
        type ToggleKind,
    } from "../../../shared/prompt/toggles.ts";
    import { language } from "src/lang";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";

    interface Props {
        definitionsText: string;
        value: Record<string, string>;
        onchange: (next: Record<string, string>) => void;
    }

    let { definitionsText, value, onchange }: Props = $props();
    const editorId = $props.id();
    const toggles = $derived(valueToggles(parseToggleSyntax(definitionsText)));
    const definedKeys = $derived(new Set(toggles.map((toggle) => toggle.key)));
    const staleKeys = $derived(Object.keys(value).filter((key) => !definedKeys.has(key)));

    function write(key: string, next: string) {
        if (definedKeys.has(key) && Object.hasOwn(value, key)) onchange({ ...value, [key]: next });
    }

    function remove(key: string) {
        const next = { ...value };
        delete next[key];
        onchange(next);
    }

    function mode(key: string, kind: ToggleKind, forced: boolean) {
        if (!definedKeys.has(key)) return;
        if (!forced) remove(key);
        else if (!Object.hasOwn(value, key))
            onchange({ ...value, [key]: kind === "checkbox" ? "1" : toggleDefault(kind) });
    }
</script>

<div class="flex min-w-0 flex-col gap-3" data-ooc-toggle-editor>
    {#each toggles as toggle (toggle.key)}
        {@const kind = toggleKindOf(toggle)!}
        {@const forced = Object.hasOwn(value, toggle.key)}
        {@const inputId = `${editorId}-${toggle.key}`}
        <fieldset class="min-w-0 rounded-md border border-darkborderc p-3" data-ooc-toggle={toggle.key}>
            <legend class="px-1 text-sm text-textcolor">{toggle.value}</legend>
            <SelectInput
                className="w-full min-w-0"
                size="sm"
                aria-label={toggle.value}
                value={forced ? "forced" : "chat"}
                onchange={(event) => mode(toggle.key, kind, event.currentTarget.value === "forced")}
            >
                <OptionInput value="chat">{language.oocToggles.asInChat}</OptionInput>
                <OptionInput value="forced">{language.oocToggles.forced}</OptionInput>
            </SelectInput>
            {#if forced}
                <div class="mt-2 min-w-0">
                    {#if kind === "checkbox"}
                        <CheckInput
                            name={toggle.value}
                            check={value[toggle.key] === "1"}
                            onChange={(check) => write(toggle.key, check ? "1" : "0")}
                        />
                    {:else if toggle.type === "select"}
                        <SelectInput
                            className="w-full min-w-0"
                            aria-label={toggle.value}
                            value={value[toggle.key]}
                            onchange={(event) => write(toggle.key, event.currentTarget.value)}
                        >
                            {#each toggle.options as option, index}
                                <OptionInput value={String(index)}>{option}</OptionInput>
                            {/each}
                        </SelectInput>
                    {:else if kind === "text"}
                        <label for={inputId} class="sr-only">{toggle.value}</label>
                        <TextInput
                            id={inputId}
                            fullwidth
                            value={value[toggle.key]}
                            onchange={(event) => write(toggle.key, event.currentTarget.value)}
                        />
                    {:else if kind === "textarea"}
                        <TextAreaInput
                            fullwidth
                            height="20"
                            ariaLabel={toggle.value}
                            value={value[toggle.key]}
                            popupEditorContext={inputId}
                            onchange={(event) =>
                                write(
                                    toggle.key,
                                    event.currentTarget instanceof HTMLDivElement
                                        ? event.currentTarget.innerText
                                        : event.currentTarget.value,
                                )}
                        />
                    {/if}
                </div>
            {/if}
        </fieldset>
    {/each}
    {#if staleKeys.length}
        <div class="text-sm text-textcolor2" data-ooc-stale-toggles>
            <p class="mb-2">{language.oocToggles.stale}</p>
            {#each staleKeys as key (key)}
                <div class="mb-2 flex items-center justify-between gap-2">
                    <span class="min-w-0 break-words">{key}</span>
                    <button
                        type="button"
                        class="shrink-0 rounded-md border border-darkborderc px-2 py-1 hover:bg-selected"
                        aria-label={language.oocToggles.removeKey(key)}
                        onclick={() => remove(key)}>{language.oocToggles.remove}</button
                    >
                </div>
            {/each}
        </div>
    {/if}
</div>
