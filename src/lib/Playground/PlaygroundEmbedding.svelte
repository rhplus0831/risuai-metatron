<script module lang="ts">
    // The tool's draft lives outside the component: the memory key's link opens the settings, which
    // replace the playground (`App.svelte`), and coming back remounts it (settings UI plan slice 8).
    const draft = $state({
        query: "",
        model: "MiniLM",
        customEmbeddingUrl: "",
        data: [] as string[],
        dataresult: [] as [string, number][],
        running: false,
    });
</script>

<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import CredentialStatusLink from "../Setting/CredentialStatusLink.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { HypaProcesser } from "src/ts/process/memory/hypamemory";

    const run = async () => {
        if (draft.running) return;
        draft.running = true;
        try {
            const processer = new HypaProcesser(draft.model as any, draft.customEmbeddingUrl);
            await processer.addText(draft.data);
            console.log(processer.vectors);
            draft.dataresult = await processer.similaritySearchScored(draft.query);
        } finally {
            draft.running = false;
        }
    };
</script>

<h2 class="text-4xl text-textcolor my-6 font-black relative">{language.embedding}</h2>

<span class="text-textcolor text-lg">Model</span>
<SelectInput bind:value={draft.model} className="mb-4">
    {#if "gpu" in navigator}
        <OptionInput value="MiniLMGPU">MiniLM L6 v2 (GPU)</OptionInput>
        <OptionInput value="nomicGPU">Nomic Embed Text v1.5 (GPU)</OptionInput>
        <OptionInput value="bgeSmallEnGPU">BGE Small English (GPU)</OptionInput>
        <OptionInput value="bgem3GPU">BGE Medium 3 (GPU)</OptionInput>
        <OptionInput value="multiMiniLMGPU">Multilingual MiniLM L12 v2 (GPU)</OptionInput>
        <OptionInput value="bgeM3KoGPU">BGE Medium 3 Korean (GPU)</OptionInput>
    {/if}
    <OptionInput value="MiniLM">MiniLM L6 v2 (CPU)</OptionInput>
    <OptionInput value="nomic">Nomic Embed Text v1.5 (CPU)</OptionInput>
    <OptionInput value="bgeSmallEn">BGE Small English (CPU)</OptionInput>
    <OptionInput value="bgem3">BGE Medium 3 (CPU)</OptionInput>
    <OptionInput value="multiMiniLM">Multilingual MiniLM L12 v2 (CPU)</OptionInput>
    <OptionInput value="bgeM3Ko">BGE Medium 3 Korean (CPU)</OptionInput>
    <OptionInput value="openai3small">OpenAI text-embedding-3-small</OptionInput>
    <OptionInput value="openai3large">OpenAI text-embedding-3-large</OptionInput>
    <OptionInput value="ada">OpenAI Ada</OptionInput>
    <OptionInput value="custom">Custom (OpenAI-compatible)</OptionInput>
</SelectInput>

{#if draft.model === "openai3small" || draft.model === "openai3large" || draft.model === "ada"}
    <CredentialStatusLink credential="supaMemoryKey" label="OpenAI API Key" />
{/if}

{#if draft.model === "custom"}
    <span class="text-textcolor text-lg">URL</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.hypaCustomSettings.url} />
    <span class="text-textcolor text-lg">Key/Password</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.hypaCustomSettings.key} />
    <span class="text-textcolor text-lg">Request Model</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.hypaCustomSettings.model} />
{/if}

<div class="mb-4"></div>

<span class="text-textcolor text-lg">Query</span>
<TextInput bind:value={draft.query} size="lg" fullwidth />

<span class="text-textcolor text-lg mt-6">Data</span>
{#each draft.data as item, i}
    <TextInput bind:value={draft.data[i]} size="lg" fullwidth marginBottom />
{/each}
<Button
    styled="outlined"
    onclick={() => {
        draft.data.push("");
    }}>+</Button
>

<span class="text-textcolor text-lg mt-6">Result</span>
{#if draft.dataresult.length === 0}
    <span class="text-textcolor2 text-lg">No result</span>
{/if}
{#each draft.dataresult as [item, score]}
    <div class="flex justify-between">
        <span>{item}</span>
        <span>{score.toFixed(2)}</span>
    </div>
{/each}

<Button
    className="mt-6 flex justify-center"
    size="lg"
    onclick={() => {
        run();
    }}
>
    {#if draft.running}
        <div class="loadmove"></div>
    {:else}
        {language.run?.toLocaleUpperCase()}
    {/if}
</Button>
