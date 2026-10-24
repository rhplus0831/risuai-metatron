<script lang="ts">
    import { currentChatRef, findChat } from "src/ts/storage/chatStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { onDestroy, onMount } from "svelte";
    import { popUpEditorStore } from "../../ts/stores.svelte";
    import type MonacoEditorType from "./MonacoEditor.svelte";
    import { language } from "src/lang";
    import { ParseMarkdown, risuChatParserForDisplay } from "src/ts/parser/parser.svelte";
    import { countTokens, tokenScopeKey } from "src/ts/tokenizer";
    import { createTokenCountField } from "src/ts/tokenCountField";
    import Toggles from "../SideBars/Toggles.svelte";

    let languageMode = $state(popUpEditorStore.language || "markdown");
    let previewing = $state(false);
    let tokens = $state(0);
    let MonacoComponent: typeof MonacoEditorType | null = $state(null);
    let showToggles = $state(false);

    let chatParserValue = $derived.by(() => {
        if (!previewing) {
            return "";
        }

        try {
            $state.snapshot(settings.globalChatVariables);
            const ref = currentChatRef();
            $state.snapshot(ref ? findChat(ref)?.GLGlobalVariables : undefined);
        } catch (error) {}
        return risuChatParserForDisplay(popUpEditorStore.value);
    });

    type PreviewTokenCountInput = { text: string; scope: string } | { error: unknown };
    const tokenField = createTokenCountField<PreviewTokenCountInput>({
        count: async (input, signal) => {
            if ("error" in input) throw input.error;
            return countTokens(input.text, undefined, signal);
        },
        apply: (count) => (tokens = count),
        same: (a, b) => !("error" in a) && !("error" in b) && a.text === b.text && a.scope === b.scope,
    });

    $effect(() => {
        if (!previewing) {
            tokenField.reset();
            return;
        }
        let input: PreviewTokenCountInput;
        try {
            input = { text: chatParserValue, scope: tokenScopeKey() };
        } catch (error) {
            input = { error };
        }
        tokenField.update(input);
    });

    onDestroy(() => tokenField.dispose());

    onMount(() => {
        import("./MonacoEditor.svelte").then((module) => {
            MonacoComponent = module.default;
        });
    });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed top-0 left-0 w-full h-full bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
    onclick={() => (popUpEditorStore.open = false)}
>
    <div class="bg-darkbg rounded-lg p-4 w-11/12 h-11/12 flex flex-col gap-2" onclick={(e) => e.stopPropagation()}>
        <!-- <h2 class="text-xl font-bold">Popup Editor</h2> -->
        <!-- Header Toolbar -->
        <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold">Popup Editor</h2>
            <div class="flex items-center gap-2">
                {#if ["markdown", "cbs"].includes(languageMode)}
                    {#if !previewing}
                        <select
                            bind:value={languageMode}
                            class="risu-select bg-bgcolor border-none rounded px-2 py-1 text-sm"
                        >
                            <option value="markdown">Markdown</option>
                            <option value="cbs" disabled>CBS</option>
                        </select>
                    {/if}
                    <button
                        class="bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 transition"
                        onclick={() => (previewing = !previewing)}
                    >
                        {previewing ? language.edit : language.preview}
                    </button>
                {:else}
                    <span class="bg-bgcolor border-none rounded px-2 py-1 text-sm">{languageMode}</span>
                {/if}
                <button
                    class="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 transition"
                    onclick={() => (popUpEditorStore.open = false)}
                >
                    X
                </button>
            </div>
        </div>
        <div class="flex-1 rounded-md overflow-hidden border border-darkborderc">
            {#if previewing}
                <div class="h-full w-full flex">
                    <div class="flex-1 flex flex-col gap-4 overflow-hidden">
                        <div
                            class="flex-1 overflow-y-auto overflow-x-auto max-w-full border border-darkborderc bg-bgcolor p-4"
                        >
                            <pre class="m-0">{chatParserValue}</pre>
                        </div>

                        <div class="text-sm p-4 text-gray-500 flex overflow-x-auto">
                            <button
                                class={{
                                    "bg-blue-500 text-white hover:bg-blue-600": showToggles,
                                    "bg-gray-500 text-white hover:bg-gray-600": !showToggles,
                                    "px-3 py-1 rounded transition": true,
                                }}
                                onclick={() => {
                                    showToggles = !showToggles;
                                }}>{language.customPromptTemplateToggle}</button
                            >

                            <span class="ml-4">{language.tokens}: {tokens}</span>
                        </div>
                    </div>

                    {#if showToggles}
                        <div class="w-96 border-l border-darkborderc overflow-y-auto p-4">
                            <Toggles chatRef={currentChatRef()} presets={false} />
                        </div>
                    {/if}
                </div>
            {:else if MonacoComponent}
                <MonacoComponent bind:value={popUpEditorStore.value} language={languageMode} theme="vs-dark" />
            {:else}
                <div class="flex items-center justify-center h-full text-gray-500">{language.loading}</div>
            {/if}
        </div>
    </div>
</div>
