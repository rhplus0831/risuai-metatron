<script lang="ts">
    import { encodeWithTokenizer, tokenizerList } from "src/ts/tokenizer";
    import { createTokenCountField } from "src/ts/tokenCountField";
    import { onDestroy } from "svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import { language } from "src/lang";

    let input = $state("");
    let output = $state("");
    let outputLength = $state(0);
    let time = $state(0);
    let selectedTokenizer = $state("tik");
    let hasEnteredText = false;

    const tokenField = createTokenCountField<{ text: string; tokenizer: string }, { ids: number[]; time: number }>({
        count: async ({ text, tokenizer }) => {
            if (text === "") return { ids: [], time: 0 };
            const start = performance.now();
            const ids = await encodeWithTokenizer(text, tokenizer);
            return { ids: Array.from(ids), time: performance.now() - start };
        },
        apply: (result) => {
            time = result.time;
            outputLength = result.ids.length;
            if (hasEnteredText) output = JSON.stringify(result.ids);
        },
        onError: (error) => (output = `Error: ${error}`),
        same: (a, b) => a.text === b.text && a.tokenizer === b.tokenizer,
    });

    $effect(() => {
        const text = input;
        tokenField.update({ text, tokenizer: selectedTokenizer });
        if (text !== "") {
            hasEnteredText = true;
        } else if (hasEnteredText) {
            output = "[]";
            outputLength = 0;
            time = 0;
        }
    });

    onDestroy(() => tokenField.dispose());
</script>

<h2 class="text-4xl text-textcolor my-6 font-black relative">{language.tokenizer}</h2>

<span class="text-textcolor text-lg">Tokenizer</span>

<SelectInput bind:value={selectedTokenizer}>
    {#each tokenizerList as [value, label]}
        <option {value} class="bg-bgcolor">{label}</option>
    {/each}
</SelectInput>

<span class="text-textcolor text-lg">Input</span>

<TextAreaInput bind:value={input} optimaizedInput={false} />

<span class="text-textcolor text-lg">Result</span>

<TextAreaInput value={output} />

<span class="text-textcolor2 text-lg">{outputLength} {language.tokens}</span>
<span class="text-textcolor2 text-lg">{time} ms</span>
