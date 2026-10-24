<script lang="ts">
    import { onDestroy, type Snippet } from "svelte";
    import { language } from "src/lang";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import { countTokens, tokenCountInput, type TokenCountInput } from "src/ts/tokenizer";
    import { createTokenCountField } from "src/ts/tokenCountField";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import Help from "../../Others/Help.svelte";
    import TextInput from "../../UI/GUI/TextInput.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import TextAreaInput from "../../UI/GUI/TextAreaInput.svelte";

    interface Props {
        value: loreBook;
        disabled?: boolean;
        lorePlus?: boolean;
        localActivation?: Snippet;
    }
    let { value = $bindable(), disabled = false, lorePlus = false, localActivation }: Props = $props();
    function setField<K extends keyof loreBook>(key: K, next: loreBook[K]) {
        if (!disabled) value[key] = next;
    }
    let tokens = $state(0);
    const tokenField = createTokenCountField<TokenCountInput>({
        count: async (input, signal) => {
            if ("error" in input) throw input.error;
            return countTokens(input.expanded, undefined, signal);
        },
        apply: (count) => (tokens = count),
        same: (a, b) => !("error" in a) && !("error" in b) && a.expanded === b.expanded && a.scope === b.scope,
    });

    $effect(() => {
        tokenField.update(tokenCountInput(value.content));
    });

    onDestroy(() => tokenField.dispose());
</script>

<div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2">
    <span class="text-textcolor mt-6">{language.name} <Help key="loreName" /></span>
    <TextInput {disabled} size="sm" bind:value={() => value.comment, (next) => setField("comment", next)} />
    {#if !lorePlus}
        {#if !value.alwaysActive}
            <span class="text-textcolor mt-6">{language.activationKeys} <Help key="loreActivationKey" /></span>
            <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
            <TextInput {disabled} size="sm" bind:value={() => value.key, (next) => setField("key", next)} />

            {#if value.selective}
                <span class="text-textcolor mt-6">{language.SecondaryKeys}</span>
                <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
                <TextInput
                    {disabled}
                    size="sm"
                    bind:value={() => value.secondkey, (next) => setField("secondkey", next)}
                />
            {/if}
        {/if}
    {/if}
    {#if !lorePlus}
        {#if !(value.activationPercent === undefined || value.activationPercent === null)}
            <span class="text-textcolor mt-6">{language.activationProbability}</span>
            <NumberInput
                {disabled}
                size="sm"
                bind:value={() => value.activationPercent, (next) => setField("activationPercent", next)}
                onChange={() => {
                    if (disabled) return;
                    if (isNaN(value.activationPercent) || !value.activationPercent || value.activationPercent < 0) {
                        value.activationPercent = 0;
                    }
                    if (value.activationPercent > 100) {
                        value.activationPercent = 100;
                    }
                }}
            />
        {/if}
    {/if}
    {#if !lorePlus}
        <span class="text-textcolor mt-4">{language.insertOrder} <Help key="loreorder" /></span>
        <NumberInput
            {disabled}
            size="sm"
            bind:value={() => value.insertorder, (next) => setField("insertorder", next)}
            min={0}
            max={1000}
        />
    {/if}
    <span class="text-textcolor mt-4 mb-2">{language.prompt}</span>
    {#if disabled}
        <textarea
            readonly
            aria-label={language.prompt}
            value={value.content}
            class="w-full min-h-32 rounded-md border border-darkborderc bg-darkbg text-textcolor2 p-2"></textarea>
    {:else}
        <TextAreaInput
            highlight
            autocomplete="off"
            bind:value={() => value.content, (next) => setField("content", next)}
        />
    {/if}
    <span class="text-textcolor2 mt-2 mb-2 text-sm">{tokens} {language.tokens}</span>
    <div class="flex items-center mt-4">
        <Check
            {disabled}
            bind:check={() => value.alwaysActive, (next) => setField("alwaysActive", next)}
            name={language.alwaysActive}
        />
    </div>
    {@render localActivation?.()}
    {#if !lorePlus && !value.useRegex}
        <div class="flex items-center mt-2">
            <Check
                {disabled}
                bind:check={() => value.selective, (next) => setField("selective", next)}
                name={language.selective}
            />
            <Help key="loreSelective" name={language.selective} />
        </div>
    {/if}
    {#if !lorePlus && !value.alwaysActive}
        <div class="flex items-center mt-2">
            <Check
                {disabled}
                bind:check={() => value.useRegex, (next) => setField("useRegex", next)}
                name={language.useRegexLorebook}
            />
            <Help key="useRegexLorebook" name={language.useRegexLorebook} />
        </div>
    {/if}
</div>
