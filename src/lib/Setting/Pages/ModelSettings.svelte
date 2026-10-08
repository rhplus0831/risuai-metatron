<script lang="ts">
    import { activeModelPreset, settings } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";

    import { customProviderStore } from "src/ts/plugins/pluginHooks";
    import { tokenizerList } from "src/ts/tokenizer";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { PlusIcon, TrashIcon, ListIcon } from "@lucide/svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import CredentialSelect from "src/lib/UI/GUI/CredentialSelect.svelte";
    import { isSecretSet, secretVersion } from "src/ts/storage/llmSecrets.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { getOpenRouterModels, toModelGridItem as orToGridItem } from "src/ts/model/openrouter";
    import {
        getNanoGPTModels,
        getNanoGPTSubscriptionModels,
        toModelGridItem as ngToGridItem,
    } from "src/ts/model/nanogpt";
    import { getOllamaModels } from "src/ts/model/ollama";
    import ModelGrid from "src/lib/UI/ModelGrid.svelte";
    import NanoGPTDashboard from "src/lib/UI/NanoGPTDashboard.svelte";
    import NanoGPTProviderPicker from "src/lib/UI/NanoGPTProviderPicker.svelte";
    import type { ModelGridPinnedItem } from "src/ts/model/modelGrid";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    import { openModelPresetList } from "src/ts/stores.svelte";
    import { getModelInfo, LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { modelParameterItems } from "src/ts/setting/botSettingsParamsData";
    import AuxModelSelectors from "./Model/AuxModelSelectors.svelte";

    /**
     * The model preset's page (`docs/plan/split-preset.md`, slice 4): the selected model preset's
     * model and provider, endpoints, chat format, auxiliary and fallback models, custom flags, and
     * tools, beside the global provider settings (credentials, streaming, additional parameters).
     */

    const openrouterPinnedItems: ModelGridPinnedItem[] = [
        { id: "risu/free", displayName: "Free Auto", providerName: "Risu" },
        { id: "openrouter/auto", displayName: "OpenRouter Auto", providerName: "OpenRouter" },
    ];

    // Reset model selection and display name when subscription mode toggles
    let _nanogptSubModeInitialized = false;
    $effect(() => {
        const _sub = settings.providers.nanogptUseSubscriptionEndpoint;
        if (!_nanogptSubModeInitialized) {
            _nanogptSubModeInitialized = true;
            return;
        }
        settings.providers.nanogptRequestModel = "";
        settings.providers.nanogptRequestModelName = "";
    });

    // Reset provider selection to Auto when the model or subscription mode changes
    let _nanogptProviderResetInitialized = false;
    $effect(() => {
        const _model = settings.providers.nanogptRequestModel;
        const _sub = settings.providers.nanogptUseSubscriptionEndpoint;
        if (!_nanogptProviderResetInitialized) {
            _nanogptProviderResetInitialized = true;
            return;
        }
        settings.providers.nanogptProvider = "";
    });

    // Reset subscription mode (and related state) when API key is cleared
    const NANOGPT_KEY = { kind: "flat", field: "nanogptKey" } as const;
    let _nanogptKeyInitialized = false;
    $effect(() => {
        const _key = isSecretSet(NANOGPT_KEY);
        if (!_nanogptKeyInitialized) {
            _nanogptKeyInitialized = true;
            return;
        }
        if (!_key) {
            settings.providers.nanogptUseSubscriptionEndpoint = false;
            settings.providers.nanogptSubscriptionState = "";
            settings.providers.nanogptRequestModel = "";
            settings.providers.nanogptRequestModelName = "";
            settings.providers.nanogptProvider = "";
        }
    });

    $effect.pre(() => {
        if (activeModelPreset.aiModel === "textgen_webui" || activeModelPreset.subModel === "mancer") {
            settings.providers.useStreaming = activeModelPreset.textgenWebUIStreamURL.startsWith("wss://");
        }
    });

    let modelInfo = $derived(getModelInfo(activeModelPreset.aiModel));
    let subModelInfo = $derived(getModelInfo(activeModelPreset.subModel));
    let nanogptInputMode = $state<"list" | "manual">(
        settings.providers.nanogptRequestModel && !settings.providers.nanogptRequestModelName ? "manual" : "list",
    );
    // svelte-ignore state_referenced_locally
    let prevNanogptInputMode = nanogptInputMode;
    $effect(() => {
        if (nanogptInputMode !== prevNanogptInputMode) {
            settings.providers.nanogptRequestModel = "";
            settings.providers.nanogptRequestModelName = "";
            prevNanogptInputMode = nanogptInputMode;
        }
    });

    let usesOllamaLocal = $derived(
        activeModelPreset.aiModel === "ollama-hosted" || activeModelPreset.subModel === "ollama-hosted",
    );
    let usesOllamaCloud = $derived(
        activeModelPreset.aiModel === "ollama-cloud" || activeModelPreset.subModel === "ollama-cloud",
    );

    // The local and instruct backends that format the chat themselves.
    let usesChatFormat = $derived(
        activeModelPreset.aiModel.startsWith("horde") ||
            activeModelPreset.aiModel === "kobold" ||
            activeModelPreset.aiModel === "textgen_webui" ||
            activeModelPreset.aiModel === "mancer" ||
            activeModelPreset.aiModel.startsWith("local_") ||
            activeModelPreset.aiModel.startsWith("hf:::"),
    );
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.model}</h2>

<div class="flex items-center gap-2 mb-4 p-2 rounded-md border border-darkborderc">
    <span class="text-textcolor2 text-sm shrink-0">{language.modelPreset}</span>
    <span class="grow truncate">{activeModelPreset.name}</span>
    <Button
        size="sm"
        onclick={() => {
            $openModelPresetList = true;
        }}
    >
        <ListIcon size={16} />
    </Button>
</div>

<span class="text-textcolor mt-4">{language.model} <Help key="model" /></span>
<ModelList bind:value={activeModelPreset.aiModel} />
<CredentialSelect modelId={activeModelPreset.aiModel} />

<span class="text-textcolor mt-2">{language.submodel} <Help key="submodel" /></span>
<ModelList bind:value={activeModelPreset.subModel} />
<CredentialSelect modelId={activeModelPreset.subModel} />

<SettingRenderer items={modelParameterItems} {modelInfo} {subModelInfo} />
<Check bind:check={activeModelPreset.outputImageModal} name={language.outputImageModal} className="mt-2" />

{#if modelInfo.provider === LLMProvider.GoogleCloud || subModelInfo.provider === LLMProvider.GoogleCloud}
    <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.google)}</span>
    <SecretInput path={{ kind: "nested", field: "google" }} marginBottom />
{/if}
{#if modelInfo.provider === LLMProvider.VertexAI || subModelInfo.provider === LLMProvider.VertexAI}
    <span class="text-textcolor">{language.sharedApiKeys.projectId}</span>
    <TextInput marginBottom={true} size={"sm"} placeholder="..." bind:value={settings.llmSecrets.google.projectId} />
    <span class="text-textcolor">{language.sharedApiKeys.clientEmail}</span>
    <TextInput marginBottom={true} size={"sm"} placeholder="..." bind:value={settings.llmSecrets.vertexClientEmail} />
    <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.vertex)}</span>
    <SecretInput path={{ kind: "flat", field: "vertexPrivateKey" }} marginBottom />
    <span class="text-textcolor">Region</span>
    <SelectInput
        value={settings.providers.vertexRegion}
        onchange={(e) => {
            settings.providers.vertexRegion = e.currentTarget.value;
        }}
    >
        <OptionInput value={"global"}>global</OptionInput>
        <OptionInput value={"us-central1"}>us-central1</OptionInput>
        <OptionInput value={"us-west1"}>us-west1</OptionInput>
    </SelectInput>
{/if}
{#if modelInfo.provider === LLMProvider.NovelList || subModelInfo.provider === LLMProvider.NovelList}
    <span class="text-textcolor">NovelList {language.apiKey}</span>
    <SecretInput path={{ kind: "flat", field: "novellistAPI" }} marginBottom />
{/if}
{#if activeModelPreset.aiModel.startsWith("mancer") || activeModelPreset.subModel.startsWith("mancer")}
    <span class="text-textcolor">Mancer {language.apiKey}</span>
    <SecretInput path={{ kind: "flat", field: "mancerHeader" }} marginBottom />
{/if}
{#if modelInfo.provider === LLMProvider.Anthropic || subModelInfo.provider === LLMProvider.Anthropic || modelInfo.provider === LLMProvider.AWS || subModelInfo.provider === LLMProvider.AWS}
    <span class="text-textcolor"
        >{language.sharedApiKeys.defaultProviderKey(
            `${language.sharedApiKeys.types.anthropic} / ${language.sharedApiKeys.types.bedrock}`,
        )}</span
    >
    <SecretInput path={{ kind: "flat", field: "claudeAPIKey" }} marginBottom />
{/if}
{#if modelInfo.provider === LLMProvider.Mistral || subModelInfo.provider === LLMProvider.Mistral}
    <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.mistral)}</span
    >
    <SecretInput path={{ kind: "flat", field: "mistralKey" }} marginBottom />
{/if}
{#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
    <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.novelai)}</span
    >
    <SecretInput path={{ kind: "nested", field: "novelai" }} />
{/if}
{#if activeModelPreset.aiModel === "reverse_proxy" || activeModelPreset.subModel === "reverse_proxy"}
    <span class="text-textcolor mt-2">URL <Help key="forceUrl" /></span>
    <TextInput
        marginBottom={false}
        size={"sm"}
        bind:value={activeModelPreset.forceReplaceUrl}
        placeholder="https//..."
    />
    <div class="mt-4">
        <CredentialSelect modelId="reverse_proxy" bindingTarget="modelPreset" />
    </div>
    <span class="text-textcolor">{language.sharedApiKeys.defaultProxyKey}</span>
    <SecretInput
        path={{ kind: "entry", field: "modelPresets", id: activeModelPreset.id ?? "" }}
        marginBottom
        placeholder={language.sharedApiKeys.proxyKeyPlaceholder}
    />
    <span class="text-textcolor mt-4"> {language.proxyRequestModel}</span>
    <TextInput
        marginBottom={false}
        size={"sm"}
        bind:value={activeModelPreset.customProxyRequestModel}
        placeholder="Name"
    />
    <span class="text-textcolor mt-4"> {language.format}</span>
    <SelectInput
        value={activeModelPreset.customAPIFormat.toString()}
        onchange={(e) => {
            activeModelPreset.customAPIFormat = parseInt(e.currentTarget.value) as LLMFormat;
        }}
    >
        <OptionInput value={LLMFormat.OpenAICompatible.toString()}>OpenAI Compatible</OptionInput>
        <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>OpenAI Response API</OptionInput>
        <OptionInput value={LLMFormat.Anthropic.toString()}>Anthropic Claude</OptionInput>
        <OptionInput value={LLMFormat.Mistral.toString()}>Mistral</OptionInput>
        <OptionInput value={LLMFormat.GoogleCloud.toString()}>Google Cloud</OptionInput>
        <OptionInput value={LLMFormat.Cohere.toString()}>Cohere</OptionInput>
    </SelectInput>
{/if}
{#if modelInfo.provider === LLMProvider.Cohere || subModelInfo.provider === LLMProvider.Cohere}
    <span class="text-textcolor mt-4"
        >{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.cohere)}</span
    >
    <SecretInput path={{ kind: "flat", field: "cohereAPIKey" }} marginBottom />
{/if}
{#if usesOllamaLocal || usesOllamaCloud}
    {#if usesOllamaLocal}
        <span class="text-textcolor mt-4">Ollama URL</span>
        <TextInput marginBottom={false} size={"sm"} bind:value={settings.providers.ollamaURL} />
    {/if}

    {#if usesOllamaCloud}
        <span class="text-textcolor mt-4">Ollama {language.model}</span>
        <SegmentedControl
            bind:value={settings.providers.ollamaInputMode}
            options={[
                { value: "list", label: (language as any).nanoGPTSelectFromList || "Select from List" },
                { value: "manual", label: (language as any).nanoGPTManualInput || "Manual Input" },
            ]}
            size="md"
        />

        {#if settings.providers.ollamaInputMode === "manual"}
            <TextInput
                marginBottom={false}
                size={"sm"}
                bind:value={settings.providers.ollamaCloudModel}
                placeholder="Model"
                oninput={() => (settings.providers.ollamaCloudModelName = "")}
            />
        {:else}
            {#await (secretVersion( { kind: "flat", field: "ollamaApiKey" } ), getOllamaModels(settings.providers.ollamaURL, "cloud"))}
                <ModelGrid bind:value={settings.providers.ollamaCloudModel} loading={true} />
            {:then cloudModels}
                <ModelGrid
                    bind:value={settings.providers.ollamaCloudModel}
                    items={cloudModels ?? []}
                    selectedLabelOverride={settings.providers.ollamaCloudModel
                        ? `Cloud / ${settings.providers.ollamaCloudModelName || settings.providers.ollamaCloudModel}`
                        : undefined}
                    onselect={(_id, name) => {
                        settings.providers.ollamaModelSource = "cloud";
                        settings.providers.ollamaCloudModelName = name;
                    }}
                />
            {/await}
        {/if}

        <span class="text-textcolor mt-4"
            >{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.ollama)}</span
        >
        <SecretInput path={{ kind: "flat", field: "ollamaApiKey" }} marginBottom />

        <span class="text-textcolor mt-4">Ollama {language.format}</span>
        <SelectInput
            value={settings.providers.ollamaRequestFormat.toString()}
            onchange={(e) => {
                settings.providers.ollamaRequestFormat = parseInt(e.currentTarget.value) as LLMFormat;
            }}
        >
            <OptionInput value={LLMFormat.Ollama.toString()}>Ollama SDK</OptionInput>
            <OptionInput value={LLMFormat.OpenAICompatible.toString()}>OpenAI Compatible</OptionInput>
            <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>OpenAI Response API</OptionInput>
            <OptionInput value={LLMFormat.Anthropic.toString()}>Anthropic Claude</OptionInput>
        </SelectInput>

        <div class="mt-2">
            <CheckInput bind:check={settings.providers.useStreaming} name={`Response ${language.streaming}`} />
        </div>
    {/if}

    {#if usesOllamaLocal}
        <span class="text-textcolor mt-4">Ollama Model</span>
        <TextInput
            marginBottom={false}
            size={"sm"}
            bind:value={settings.providers.ollamaModel}
            placeholder="Model"
            oninput={() => {
                settings.providers.ollamaModelSource = "local";
                settings.providers.ollamaModelName = "";
            }}
        />
    {/if}

    {#if usesOllamaLocal || (usesOllamaCloud && settings.providers.ollamaRequestFormat === LLMFormat.Ollama)}
        <span class="text-textcolor mt-4">Ollama Thinking</span>
        <SelectInput bind:value={settings.providers.ollamaThinkingMode}>
            <OptionInput value="auto">Auto</OptionInput>
            <OptionInput value="off">Off</OptionInput>
            <OptionInput value="on">On</OptionInput>
            <OptionInput value="low">Low</OptionInput>
            <OptionInput value="medium">Medium</OptionInput>
            <OptionInput value="high">High</OptionInput>
        </SelectInput>
    {/if}
{/if}
{#if activeModelPreset.aiModel === "nanogpt" || activeModelPreset.subModel === "nanogpt"}
    <span class="text-textcolor mt-4"
        >{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.nanogpt)}</span
    >
    <SecretInput path={{ kind: "flat", field: "nanogptKey" }} marginBottom />

    <NanoGPTDashboard keySet={isSecretSet(NANOGPT_KEY)} keyVersion={secretVersion(NANOGPT_KEY)} />

    {#if settings.providers.nanogptSubscriptionState === "active" || settings.providers.nanogptSubscriptionState === "grace"}
        <div class="flex items-center mt-3">
            <CheckInput
                bind:check={settings.providers.nanogptUseSubscriptionEndpoint}
                name={language.nanoGPTUseSubscriptionEndpoint}
            />
        </div>
    {/if}

    <span class="text-textcolor mt-4">NanoGPT {language.model}</span>
    <SegmentedControl
        bind:value={nanogptInputMode}
        options={[
            { value: "list", label: (language as any).nanoGPTSelectFromList || "Select from List" },
            { value: "manual", label: (language as any).nanoGPTManualInput || "Manual Input" },
        ]}
        size="md"
    />

    {#if nanogptInputMode === "manual"}
        <TextInput
            marginBottom={false}
            size={"sm"}
            bind:value={settings.providers.nanogptRequestModel}
            placeholder={(language as any).nanoGPTManualModelSelect || "Manual Model Select"}
            oninput={() => (settings.providers.nanogptRequestModelName = "")}
        />
    {:else}
        {#await Promise.all([getNanoGPTModels(), (secretVersion(NANOGPT_KEY), getNanoGPTSubscriptionModels())])}
            <ModelGrid bind:value={settings.providers.nanogptRequestModel} loading={true} />
        {:then [regular, sub]}
            <ModelGrid
                bind:value={settings.providers.nanogptRequestModel}
                items={settings.providers.nanogptUseSubscriptionEndpoint
                    ? (sub ?? []).map(ngToGridItem)
                    : (regular ?? []).map(ngToGridItem)}
                showSubBadge={settings.providers.nanogptUseSubscriptionEndpoint}
                selectedLabelOverride={settings.providers.nanogptRequestModel &&
                !settings.providers.nanogptRequestModelName
                    ? settings.providers.nanogptRequestModel
                    : undefined}
                onselect={(_id, name) => {
                    settings.providers.nanogptRequestModelName = name;
                }}
            />
            {#if !settings.providers.nanogptUseSubscriptionEndpoint}
                <NanoGPTProviderPicker
                    keySet={isSecretSet(NANOGPT_KEY)}
                    keyVersion={secretVersion(NANOGPT_KEY)}
                    modelId={settings.providers.nanogptRequestModel}
                    bind:value={settings.providers.nanogptProvider}
                />
            {/if}
        {/await}
    {/if}
{/if}
{#if activeModelPreset.aiModel === "openrouter" || activeModelPreset.subModel === "openrouter"}
    <span class="text-textcolor mt-4"
        >{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.openrouter)}</span
    >
    <SecretInput path={{ kind: "flat", field: "openrouterKey" }} marginBottom />

    <span class="text-textcolor mt-4">OpenRouter {language.model}</span>
    {#await getOpenRouterModels()}
        <ModelGrid
            bind:value={activeModelPreset.openrouterRequestModel}
            pinnedItems={openrouterPinnedItems}
            loading={true}
        />
    {:then m}
        <ModelGrid
            bind:value={activeModelPreset.openrouterRequestModel}
            items={(m ?? []).map(orToGridItem)}
            pinnedItems={openrouterPinnedItems}
        />
    {/await}
{/if}
{#if activeModelPreset.aiModel === "openrouter" || activeModelPreset.aiModel === "reverse_proxy"}
    <span class="text-textcolor">{language.tokenizer}</span>
    <SelectInput bind:value={settings.providers.customTokenizer}>
        {#each tokenizerList as entry}
            <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
        {/each}
    </SelectInput>
{/if}
{#if modelInfo.provider === LLMProvider.OpenAI || subModelInfo.provider === LLMProvider.OpenAI}
    <span class="text-textcolor"
        >{language.sharedApiKeys.defaultProviderKey(language.sharedApiKeys.types.openai)} <Help key="oaiapikey" /></span
    >
    <SecretInput path={{ kind: "flat", field: "openAIKey" }} marginBottom placeholder="sk-XXXXXXXXXXXXXXXXXXXX" />
{/if}

{#if modelInfo.keyIdentifier}
    <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(modelInfo.name)}</span>
    <SecretInput path={{ kind: "map", field: "OaiCompAPIKeys", id: modelInfo.keyIdentifier }} marginBottom />
{/if}

{#if subModelInfo.keyIdentifier && subModelInfo.keyIdentifier !== modelInfo.keyIdentifier}
    <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(subModelInfo.name)}</span>
    <SecretInput path={{ kind: "map", field: "OaiCompAPIKeys", id: subModelInfo.keyIdentifier }} marginBottom />
{/if}

<div class="py-2 flex flex-col gap-2 mb-4">
    {#if !usesOllamaCloud && (modelInfo.flags.includes(LLMFlags.hasStreaming) || subModelInfo.flags.includes(LLMFlags.hasStreaming))}
        <Check bind:check={settings.providers.useStreaming} name={`Response ${language.streaming}`} />

        {#if settings.providers.useStreaming && (modelInfo.flags.includes(LLMFlags.geminiThinking) || subModelInfo.flags.includes(LLMFlags.geminiThinking))}
            <Check bind:check={settings.providers.streamGeminiThoughts} name={`Stream Gemini Thoughts`} />
        {/if}
    {/if}

    {#if activeModelPreset.aiModel === "reverse_proxy" || activeModelPreset.subModel === "reverse_proxy"}
        <Check bind:check={settings.providers.reverseProxyOobaMode} name={`${language.reverseProxyOobaMode}`} />
    {/if}
</div>

{#if activeModelPreset.aiModel === "custom" || activeModelPreset.subModel === "custom"}
    <span class="text-textcolor mt-2">{language.plugin}</span>
    <SelectInput className="mt-2 mb-4" bind:value={activeModelPreset.currentPluginProvider}>
        <OptionInput value="">None</OptionInput>
        {#each $customProviderStore as plugin}
            <OptionInput value={plugin}>{plugin}</OptionInput>
        {/each}
    </SelectInput>
{/if}

{#if activeModelPreset.aiModel === "kobold" || activeModelPreset.subModel === "kobold"}
    <span class="text-textcolor">Kobold URL</span>
    <TextInput marginBottom={true} bind:value={activeModelPreset.koboldURL} />
{/if}

{#if activeModelPreset.aiModel === "echo_model" || activeModelPreset.subModel === "echo_model"}
    <span class="text-textcolor mt-2">Echo Message</span>
    <TextAreaInput
        margin="bottom"
        bind:value={settings.providers.echoMessage}
        placeholder={"The message you want to receive as the bot's response\n(e.g., Lumi tilts her head, her white hair sliding down as her pretty green and aqua eyes sparkle…)"}
    />
    <span class="text-textcolor mt-2">Echo Delay (Seconds)</span>
    <NumberInput marginBottom={true} bind:value={settings.providers.echoDelay} min={0} />
{/if}

{#if activeModelPreset.aiModel.startsWith("horde") || activeModelPreset.subModel.startsWith("horde")}
    <span class="text-textcolor">Horde {language.apiKey}</span>
    <SecretInput path={{ kind: "nested", field: "hordeConfig" }} marginBottom />
{/if}
{#if activeModelPreset.aiModel === "textgen_webui" || activeModelPreset.subModel === "textgen_webui" || activeModelPreset.aiModel === "mancer" || activeModelPreset.subModel === "mancer"}
    <span class="text-textcolor mt-2">Blocking {language.providerURL}</span>
    <TextInput marginBottom={true} bind:value={activeModelPreset.textgenWebUIBlockingURL} placeholder="https://..." />
    <span class="text-draculared text-xs mb-2">You must use textgen webui with --public-api</span>
    <span class="text-textcolor mt-2">Stream {language.providerURL}</span>
    <TextInput marginBottom={true} bind:value={activeModelPreset.textgenWebUIStreamURL} placeholder="wss://..." />
    <span class="text-draculared text-xs mb-2"
        >Warning: For Ooba version over 1.7, use "Ooba" as model, and use url like
        http://127.0.0.1:5000/v1/chat/completions</span
    >
{/if}
{#if activeModelPreset.aiModel === "ooba" || activeModelPreset.subModel === "ooba"}
    <span class="text-textcolor mt-2">Ooba {language.providerURL}</span>
    <TextInput marginBottom={true} bind:value={activeModelPreset.textgenWebUIBlockingURL} placeholder="https://..." />
{/if}
{#if usesChatFormat}
    <div class="flex flex-col p-3 rounded-md border-selected border mt-4">
        <ChatFormatSettings />
    </div>
{/if}

<AuxModelSelectors />

{#snippet fallbackModelList(arg: "model" | "memory" | "translate" | "emotion" | "otherAx")}
    {#each activeModelPreset.fallbackModels[arg] as model, i}
        <span class="text-textcolor mt-4">
            {language.model}
            {i + 1}
        </span>
        <ModelList bind:value={activeModelPreset.fallbackModels[arg][i]} blankable />
        {#if model}
            <CredentialSelect modelId={model} compact />
        {/if}
    {/each}
    <div class="flex gap-2">
        <button
            class="bg-selected text-textcolor p-2 rounded-md"
            onclick={() => {
                let value = activeModelPreset.fallbackModels[arg] ?? [];
                value.push("");
                activeModelPreset.fallbackModels[arg] = value;
            }}><PlusIcon /></button
        >
        <button
            class="bg-red-500 text-white p-2 rounded-md"
            onclick={() => {
                let value = activeModelPreset.fallbackModels[arg] ?? [];
                value.pop();
                activeModelPreset.fallbackModels[arg] = value;
            }}><TrashIcon /></button
        >
    </div>
{/snippet}

<Accordion name={language.fallbackModel} styled>
    <Check
        bind:check={activeModelPreset.fallbackWhenBlankResponse}
        name={language.fallbackWhenBlankResponse}
        className="mt-4"
    />

    <Accordion name={language.model} styled>
        {@render fallbackModelList("model")}
    </Accordion>
    <Accordion name={"Memory"} styled>
        {@render fallbackModelList("memory")}
    </Accordion>
    <Accordion name={"Translations"} styled>
        {@render fallbackModelList("translate")}
    </Accordion>
    <Accordion name={"Emotion"} styled>
        {@render fallbackModelList("emotion")}
    </Accordion>
    <Accordion name={"OtherAx"} styled>
        {@render fallbackModelList("otherAx")}
    </Accordion>
</Accordion>

<Accordion styled name={language.systemContentReplacement} help="systemContentReplacement">
    <span class="text-textcolor">{language.systemContentReplacement}</span>
    <TextAreaInput bind:value={activeModelPreset.systemContentReplacement} />
    <span class="text-textcolor mt-4">{language.systemRoleReplacement} <Help key="systemRoleReplacement" /></span>
    <SelectInput bind:value={activeModelPreset.systemRoleReplacement}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
</Accordion>

<Accordion styled name="{language.additionalParams} " help="additionalParams">
    <table class="contain w-full max-w-full tabler">
        <tbody>
            <tr>
                <th class="font-medium">{language.key}</th>
                <th class="font-medium">{language.value}</th>
                <th>
                    <button
                        class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center"
                        onclick={() => {
                            settings.providers.additionalParams.push(["", ""]);
                        }}><PlusIcon /></button
                    >
                </th>
            </tr>
            {#if settings.providers.additionalParams.length === 0}
                <tr class="text-textcolor2">
                    <td colspan="3">{language.noData}</td>
                </tr>
            {/if}
            {#each settings.providers.additionalParams as additionalParams, i}
                <tr>
                    <td class="font-medium truncate">
                        <TextInput bind:value={settings.providers.additionalParams[i][0]} size="lg" fullwidth />
                    </td>
                    <td class="font-medium truncate">
                        <TextInput bind:value={settings.providers.additionalParams[i][1]} size="lg" fullwidth />
                    </td>
                    <td>
                        <button
                            class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                            onclick={() => {
                                let additionalParams = settings.providers.additionalParams;
                                additionalParams.splice(i, 1);
                                settings.providers.additionalParams = additionalParams;
                            }}><TrashIcon /></button
                        >
                    </td>
                </tr>
            {/each}
        </tbody>
    </table>
</Accordion>

{#snippet CustomFlagButton(name: string, flag: number)}
    <Button
        className="mt-2"
        onclick={(e) => {
            if (activeModelPreset.customFlags.includes(flag as LLMFlags)) {
                activeModelPreset.customFlags = activeModelPreset.customFlags.filter((f) => f !== flag);
            } else {
                activeModelPreset.customFlags.push(flag as LLMFlags);
            }
        }}
        styled={activeModelPreset.customFlags.includes(flag as LLMFlags) ? "primary" : "outlined"}
    >
        {name}
    </Button>
{/snippet}

<Accordion styled name={language.customFlags}>
    <Check bind:check={activeModelPreset.enableCustomFlags} name={language.enableCustomFlags} />

    {#if activeModelPreset.enableCustomFlags}
        {@render CustomFlagButton("hasImageInput", 0)}
        {@render CustomFlagButton("hasImageOutput", 1)}
        {@render CustomFlagButton("hasAudioInput", 2)}
        {@render CustomFlagButton("hasAudioOutput", 3)}
        {@render CustomFlagButton("hasPrefill", 4)}
        {@render CustomFlagButton("hasCache", 5)}
        {@render CustomFlagButton("hasFullSystemPrompt", 6)}
        {@render CustomFlagButton("hasFirstSystemPrompt", 7)}
        {@render CustomFlagButton("hasStreaming", 8)}
        {@render CustomFlagButton("requiresAlternateRole", 9)}
        {@render CustomFlagButton("mustStartWithUserInput", 10)}
        {@render CustomFlagButton("hasVideoInput", 12)}
        {@render CustomFlagButton("OAICompletionTokens", 13)}
        {@render CustomFlagButton("DeveloperRole", 14)}
        {@render CustomFlagButton("geminiThinking", 15)}
        {@render CustomFlagButton("geminiBlockOff", 16)}
        {@render CustomFlagButton("deepSeekPrefix", 17)}
        {@render CustomFlagButton("deepSeekThinkingInput", 18)}
        {@render CustomFlagButton("deepSeekThinkingOutput", 19)}
        {@render CustomFlagButton("noCivilIntegrity", 20)}
        {@render CustomFlagButton("claudeThinking", 21)}
        {@render CustomFlagButton("claudeAdaptiveThinking", 22)}
        {@render CustomFlagButton("claudeXHighEffort", 23)}
        {@render CustomFlagButton("deepSeekThinkingToggle", 24)}
    {/if}
</Accordion>

<Accordion styled name={language.tools}>
    <Check
        name={language.search}
        check={activeModelPreset.modelTools.includes("search")}
        onChange={() => {
            if (activeModelPreset.modelTools.includes("search")) {
                activeModelPreset.modelTools = activeModelPreset.modelTools.filter((tool) => tool !== "search");
            } else {
                activeModelPreset.modelTools.push("search");
            }
        }}
    />
</Accordion>
