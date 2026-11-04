<script lang="ts">
    import { currentChatRef, findChat } from "src/ts/storage/chatStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { onDestroy, untrack } from "svelte";
    import { closePopupEditorSession, popUpEditorStore } from "../../ts/stores.svelte";
    import type MonacoEditorType from "./MonacoEditor.svelte";
    import { language } from "src/lang";
    import { ParseMarkdown, risuChatParserForDisplay } from "src/ts/parser/parser.svelte";
    import { countTokens, tokenScopeKey } from "src/ts/tokenizer";
    import { createTokenCountField } from "src/ts/tokenCountField";
    import Toggles from "../SideBars/Toggles.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import { readPopupEditorMonaco, writePopupEditorMonaco } from "src/ts/gui/popupEditorMode";

    /**
     * The full-page popup editor over `popUpEditorStore` (`src/ts/popupEditorSession.svelte.ts`). `src/App.svelte`
     * mounts it keyed by the session id, so each open gets a new instance, and it closes only the session it was
     * mounted for. It edits the store's text only: the field that opened it polls the session and writes the text
     * back. Monaco or the plain textarea is a per-device choice (`src/ts/gui/popupEditorMode.ts`).
     */

    const sessionId = untrack(() => popUpEditorStore.sessionId);
    let languageMode = $state(popUpEditorStore.language || "markdown");
    let previewing = $state(false);
    let tokens = $state(0);
    let MonacoComponent: typeof MonacoEditorType | null = $state(null);
    let showToggles = $state(false);
    let useMonaco = $state(readPopupEditorMonaco());

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

    // Monaco loads only once it is chosen, so a device that keeps the textarea never downloads it.
    $effect(() => {
        if (!useMonaco || MonacoComponent) return;
        import("./MonacoEditor.svelte").then((module) => {
            MonacoComponent = module.default;
        });
    });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed top-0 left-0 w-full h-full bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
    onclick={() => closePopupEditorSession(sessionId)}
>
    <div class="bg-darkbg rounded-lg p-4 w-11/12 h-11/12 flex flex-col gap-2" onclick={(e) => e.stopPropagation()}>
        <!-- <h2 class="text-xl font-bold">Popup Editor</h2> -->
        <!-- Header Toolbar -->
        <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-xl font-bold">Popup Editor</h2>
            <div class="flex flex-wrap items-center gap-2">
                {#if !previewing}
                    <CheckInput
                        bind:check={useMonaco}
                        onChange={(check) => writePopupEditorMonaco(check)}
                        name={language.popupEditorMonaco}
                        margin={false}
                        className="text-sm"
                    />
                {/if}
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
                    onclick={() => closePopupEditorSession(sessionId)}
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
            {:else if !useMonaco}
                <textarea
                    class="block w-full h-full resize-none bg-bgcolor text-textcolor p-2 font-mono text-sm focus:outline-none"
                    aria-label={language.hotkeyDesc.popupEditor}
                    spellcheck="false"
                    bind:value={popUpEditorStore.value}></textarea>
            {:else if MonacoComponent}
                <MonacoComponent bind:value={popUpEditorStore.value} language={languageMode} theme="vs-dark" />
            {:else}
                <div class="flex items-center justify-center h-full text-gray-500">{language.loading}</div>
            {/if}
        </div>
    </div>
</div>
