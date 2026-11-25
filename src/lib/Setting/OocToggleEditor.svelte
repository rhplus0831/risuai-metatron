<script lang="ts">
    /**
     * A controlled editor of bare-key forced values; each edit returns a fresh map through onchange. One row per value
     * toggle: its select reads "as in the chat" (key absent) or the forced value, so a checkbox or select toggle
     * needs no second control. A text toggle's select only switches forcing on, and its input follows below the row.
     */
    import { parseToggleSyntax, toggleKindOf, valueToggles, type ToggleKind } from "../../../shared/prompt/toggles.ts";
    import { language } from "src/lang";
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

    /** Select option values: a forced value carries a prefix, so no stored string can read as "as in the chat". */
    const CHAT = "chat";
    const FORCED = "=";
    const isText = (kind: ToggleKind) => kind === "text" || kind === "textarea";

    function write(key: string, next: string) {
        if (definedKeys.has(key) && Object.hasOwn(value, key)) onchange({ ...value, [key]: next });
    }

    function remove(key: string) {
        const next = { ...value };
        delete next[key];
        onchange(next);
    }

    function choose(key: string, kind: ToggleKind, option: string) {
        if (!definedKeys.has(key)) return;
        if (option === CHAT) remove(key);
        else if (!isText(kind)) onchange({ ...value, [key]: option.slice(FORCED.length) });
        else if (!Object.hasOwn(value, key)) onchange({ ...value, [key]: "" });
    }

    const isOptionIndex = (stored: string, options: readonly string[]) =>
        String(Number(stored)) === stored && Number(stored) in options;

    /** A stored checkbox value other than "1" reads as off, as the chat's own toggle does. */
    function selected(key: string, kind: ToggleKind) {
        if (!Object.hasOwn(value, key)) return CHAT;
        if (isText(kind)) return FORCED;
        return FORCED + (kind === "checkbox" && value[key] !== "1" ? "0" : value[key]);
    }
</script>

<div class="flex min-w-0 flex-col gap-1.5" data-ooc-toggle-editor>
    {#each toggles as toggle (toggle.key)}
        {@const kind = toggleKindOf(toggle)!}
        {@const forced = Object.hasOwn(value, toggle.key)}
        {@const inputId = `${editorId}-${toggle.key}`}
        <div class="min-w-0" role="group" aria-label={toggle.value} data-ooc-toggle={toggle.key}>
            <div class="flex min-w-0 items-center gap-2">
                <span
                    class={"min-w-0 flex-1 truncate text-sm " + (forced ? "text-textcolor" : "text-textcolor2")}
                    title={toggle.value}
                    data-ooc-toggle-name>{toggle.value}</span
                >
                <SelectInput
                    className="w-40 shrink-0"
                    size="sm"
                    aria-label={toggle.value}
                    value={selected(toggle.key, kind)}
                    onchange={(event) => choose(toggle.key, kind, event.currentTarget.value)}
                >
                    <OptionInput value={CHAT}>{language.oocToggles.asInChat}</OptionInput>
                    {#if kind === "checkbox"}
                        <OptionInput value={FORCED + "1"}>{language.oocToggles.on}</OptionInput>
                        <OptionInput value={FORCED + "0"}>{language.oocToggles.off}</OptionInput>
                    {:else if toggle.type === "select"}
                        {#each toggle.options as option, index}
                            <OptionInput value={FORCED + index}>{option}</OptionInput>
                        {/each}
                        {#if forced && !isOptionIndex(value[toggle.key], toggle.options)}
                            <!-- A forced value the options no longer hold stays selected until it is replaced. -->
                            <OptionInput value={FORCED + value[toggle.key]}>{value[toggle.key]}</OptionInput>
                        {/if}
                    {:else}
                        <OptionInput value={FORCED}>{language.oocToggles.forced}</OptionInput>
                    {/if}
                </SelectInput>
            </div>
            {#if forced && kind === "text"}
                <label for={inputId} class="sr-only">{toggle.value}</label>
                <TextInput
                    id={inputId}
                    className="mt-1"
                    fullwidth
                    value={value[toggle.key]}
                    onchange={(event) => write(toggle.key, event.currentTarget.value)}
                />
            {:else if forced && kind === "textarea"}
                <TextAreaInput
                    className="mt-1"
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
