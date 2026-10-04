<script lang="ts">
    import { settings, activePreset, currentPresetRecord } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";

    import { customProviderStore } from "src/ts/plugins/pluginHooks";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { tokenizeAccurate, tokenizerList } from "src/ts/tokenizer";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import DropList from "src/lib/SideBars/DropList.svelte";
    import { PlusIcon, TrashIcon, HardDriveUploadIcon, DownloadIcon, UploadIcon } from "@lucide/svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import { isSecretSet, secretVersion } from "src/ts/storage/llmSecrets.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
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
    import OobaSettings from "./OobaSettings.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import OpenrouterSettings from "./OpenrouterSettings.svelte";
    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    import PromptSettings from "./PromptSettings.svelte";
    import { openPresetList } from "src/ts/stores.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { getModelInfo, LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { allBasicParameterItems } from "src/ts/setting/botSettingsParamsData";
    import SeparateParametersSection from "./SeparateParametersSection.svelte";
    import AuxModelSelectors from "./Model/AuxModelSelectors.svelte";

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

    let tokens = $state({
        mainPrompt: 0,
        jailbreak: 0,
        globalNote: 0,
    });

    interface Props {
        goPromptTemplate?: any;
    }

    let { goPromptTemplate = () => {} }: Props = $props();

    async function loadTokenize() {
        tokens.mainPrompt = await tokenizeAccurate(activePreset.mainPrompt, true);
        tokens.jailbreak = await tokenizeAccurate(activePreset.jailbreak, true);
        tokens.globalNote = await tokenizeAccurate(activePreset.globalNote, true);
    }

    $effect.pre(() => {
        if (activePreset.aiModel === "textgen_webui" || activePreset.subModel === "mancer") {
            settings.providers.useStreaming = activePreset.textgenWebUIStreamURL.startsWith("wss://");
        }
    });

    let submenu = $state(settings.ui.useLegacyGUI ? -1 : 0);
    let modelInfo = $derived(getModelInfo(activePreset.aiModel));
    let subModelInfo = $derived(getModelInfo(activePreset.subModel));
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
        activePreset.aiModel === "ollama-hosted" || activePreset.subModel === "ollama-hosted",
    );
    let usesOllamaCloud = $derived(activePreset.aiModel === "ollama-cloud" || activePreset.subModel === "ollama-cloud");
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.chatBot}</h2>

{#if submenu !== -1}
    <div class="flex w-full rounded-md border border-darkborderc mb-4">
        <button
            onclick={() => {
                submenu = 0;
            }}
            class="p-2 flex-1 border-r border-darkborderc"
            class:bg-darkbutton={submenu === 0}
        >
            <span>{language.model}</span>
        </button>
        <button
            onclick={() => {
                submenu = 1;
            }}
            class="p2 flex-1 border-r border-darkborderc"
            class:bg-darkbutton={submenu === 1}
        >
            <span>{language.parameters}</span>
        </button>
        <button
            onclick={() => {
                submenu = 2;
            }}
            class="p-2 flex-1 border-r border-darkborderc"
            class:bg-darkbutton={submenu === 2}
        >
            <span>{language.prompt}</span>
        </button>
        <button
            onclick={() => {
                submenu = 3;
            }}
            class="p-2 flex-1"
            class:bg-darkbutton={submenu === 3}
        >
            <span>{language.others}</span>
        </button>
    </div>
{/if}

{#if submenu === 0 || submenu === -1}
    <span class="text-textcolor mt-4">{language.model} <Help key="model" /></span>
    <ModelList bind:value={activePreset.aiModel} />

    <span class="text-textcolor mt-2">{language.submodel} <Help key="submodel" /></span>
    <ModelList bind:value={activePreset.subModel} />

    {#if modelInfo.provider === LLMProvider.GoogleCloud || subModelInfo.provider === LLMProvider.GoogleCloud}
        <span class="text-textcolor">GoogleAI API Key</span>
        <SecretInput path={{ kind: "nested", field: "google" }} marginBottom />
    {/if}
    {#if modelInfo.provider === LLMProvider.VertexAI || subModelInfo.provider === LLMProvider.VertexAI}
        <span class="text-textcolor">Project ID</span>
        <TextInput
            marginBottom={true}
            size={"sm"}
            placeholder="..."
            bind:value={settings.llmSecrets.google.projectId}
        />
        <span class="text-textcolor">Vertex Client Email</span>
        <TextInput
            marginBottom={true}
            size={"sm"}
            placeholder="..."
            bind:value={settings.llmSecrets.vertexClientEmail}
        />
        <span class="text-textcolor">Vertex Private Key</span>
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
    {#if activePreset.aiModel.startsWith("mancer") || activePreset.subModel.startsWith("mancer")}
        <span class="text-textcolor">Mancer {language.apiKey}</span>
        <SecretInput path={{ kind: "flat", field: "mancerHeader" }} marginBottom />
    {/if}
    {#if modelInfo.provider === LLMProvider.Anthropic || subModelInfo.provider === LLMProvider.Anthropic || modelInfo.provider === LLMProvider.AWS || subModelInfo.provider === LLMProvider.AWS}
        <span class="text-textcolor">Claude {language.apiKey}</span>
        <SecretInput path={{ kind: "flat", field: "claudeAPIKey" }} marginBottom />
    {/if}
    {#if modelInfo.provider === LLMProvider.Mistral || subModelInfo.provider === LLMProvider.Mistral}
        <span class="text-textcolor">Mistral {language.apiKey}</span>
        <SecretInput path={{ kind: "flat", field: "mistralKey" }} marginBottom />
    {/if}
    {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
        <span class="text-textcolor">NovelAI Bearer Token</span>
        <SecretInput path={{ kind: "nested", field: "novelai" }} />
    {/if}
    {#if activePreset.aiModel === "reverse_proxy" || activePreset.subModel === "reverse_proxy"}
        <span class="text-textcolor mt-2">URL <Help key="forceUrl" /></span>
        <TextInput
            marginBottom={false}
            size={"sm"}
            bind:value={activePreset.forceReplaceUrl}
            placeholder="https//..."
        />
        <span class="text-textcolor mt-4"> {language.proxyAPIKey}</span>
        <SecretInput
            path={{ kind: "entry", field: "presets", id: activePreset.id ?? "" }}
            marginBottom
            placeholder="leave it blank if it hasn't password"
        />
        <span class="text-textcolor mt-4"> {language.proxyRequestModel}</span>
        <TextInput
            marginBottom={false}
            size={"sm"}
            bind:value={activePreset.customProxyRequestModel}
            placeholder="Name"
        />
        <span class="text-textcolor mt-4"> {language.format}</span>
        <SelectInput
            value={activePreset.customAPIFormat.toString()}
            onchange={(e) => {
                activePreset.customAPIFormat = parseInt(e.currentTarget.value) as LLMFormat;
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
        <span class="text-textcolor mt-4">Cohere {language.apiKey}</span>
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

            <span class="text-textcolor mt-4">Ollama {language.apiKey}</span>
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
    {#if activePreset.aiModel === "nanogpt" || activePreset.subModel === "nanogpt"}
        <span class="text-textcolor mt-4">NanoGPT {language.apiKey}</span>
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
    {#if activePreset.aiModel === "openrouter" || activePreset.subModel === "openrouter"}
        <span class="text-textcolor mt-4">OpenRouter {language.apiKey}</span>
        <SecretInput path={{ kind: "flat", field: "openrouterKey" }} marginBottom />

        <span class="text-textcolor mt-4">OpenRouter {language.model}</span>
        {#await getOpenRouterModels()}
            <ModelGrid
                bind:value={activePreset.openrouterRequestModel}
                pinnedItems={openrouterPinnedItems}
                loading={true}
            />
        {:then m}
            <ModelGrid
                bind:value={activePreset.openrouterRequestModel}
                items={(m ?? []).map(orToGridItem)}
                pinnedItems={openrouterPinnedItems}
            />
        {/await}
    {/if}
    {#if activePreset.aiModel === "openrouter" || activePreset.aiModel === "reverse_proxy"}
        <span class="text-textcolor">{language.tokenizer}</span>
        <SelectInput bind:value={settings.providers.customTokenizer}>
            {#each tokenizerList as entry}
                <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
            {/each}
        </SelectInput>
    {/if}
    {#if modelInfo.provider === LLMProvider.OpenAI || subModelInfo.provider === LLMProvider.OpenAI}
        <span class="text-textcolor">OpenAI {language.apiKey} <Help key="oaiapikey" /></span>
        <SecretInput path={{ kind: "flat", field: "openAIKey" }} marginBottom placeholder="sk-XXXXXXXXXXXXXXXXXXXX" />
    {/if}

    {#if modelInfo.keyIdentifier}
        <span class="text-textcolor">{modelInfo.name} {language.apiKey}</span>
        <SecretInput path={{ kind: "map", field: "OaiCompAPIKeys", id: modelInfo.keyIdentifier }} marginBottom />
    {/if}

    {#if subModelInfo.keyIdentifier && subModelInfo.keyIdentifier !== modelInfo.keyIdentifier}
        <span class="text-textcolor">{subModelInfo.name} {language.apiKey}</span>
        <SecretInput path={{ kind: "map", field: "OaiCompAPIKeys", id: subModelInfo.keyIdentifier }} marginBottom />
    {/if}

    <div class="py-2 flex flex-col gap-2 mb-4">
        {#if !usesOllamaCloud && (modelInfo.flags.includes(LLMFlags.hasStreaming) || subModelInfo.flags.includes(LLMFlags.hasStreaming))}
            <Check bind:check={settings.providers.useStreaming} name={`Response ${language.streaming}`} />

            {#if settings.providers.useStreaming && (modelInfo.flags.includes(LLMFlags.geminiThinking) || subModelInfo.flags.includes(LLMFlags.geminiThinking))}
                <Check bind:check={settings.providers.streamGeminiThoughts} name={`Stream Gemini Thoughts`} />
            {/if}
        {/if}

        {#if activePreset.aiModel === "reverse_proxy" || activePreset.subModel === "reverse_proxy"}
            <Check bind:check={settings.providers.reverseProxyOobaMode} name={`${language.reverseProxyOobaMode}`} />
        {/if}
        {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
            <Check bind:check={activePreset.NAIadventure} name={language.textAdventureNAI} />

            <Check bind:check={activePreset.NAIappendName} name={language.appendNameNAI} />
        {/if}
    </div>

    {#if activePreset.aiModel === "custom" || activePreset.subModel === "custom"}
        <span class="text-textcolor mt-2">{language.plugin}</span>
        <SelectInput className="mt-2 mb-4" bind:value={activePreset.currentPluginProvider}>
            <OptionInput value="">None</OptionInput>
            {#each $customProviderStore as plugin}
                <OptionInput value={plugin}>{plugin}</OptionInput>
            {/each}
        </SelectInput>
    {/if}

    {#if activePreset.aiModel === "kobold" || activePreset.subModel === "kobold"}
        <span class="text-textcolor">Kobold URL</span>
        <TextInput marginBottom={true} bind:value={activePreset.koboldURL} />
    {/if}

    {#if activePreset.aiModel === "echo_model" || activePreset.subModel === "echo_model"}
        <span class="text-textcolor mt-2">Echo Message</span>
        <TextAreaInput
            margin="bottom"
            bind:value={settings.providers.echoMessage}
            placeholder={"The message you want to receive as the bot's response\n(e.g., Lumi tilts her head, her white hair sliding down as her pretty green and aqua eyes sparkle…)"}
        />
        <span class="text-textcolor mt-2">Echo Delay (Seconds)</span>
        <NumberInput marginBottom={true} bind:value={settings.providers.echoDelay} min={0} />
    {/if}

    {#if activePreset.aiModel.startsWith("horde") || activePreset.subModel.startsWith("horde")}
        <span class="text-textcolor">Horde {language.apiKey}</span>
        <SecretInput path={{ kind: "nested", field: "hordeConfig" }} marginBottom />
    {/if}
    {#if activePreset.aiModel === "textgen_webui" || activePreset.subModel === "textgen_webui" || activePreset.aiModel === "mancer" || activePreset.subModel === "mancer"}
        <span class="text-textcolor mt-2">Blocking {language.providerURL}</span>
        <TextInput marginBottom={true} bind:value={activePreset.textgenWebUIBlockingURL} placeholder="https://..." />
        <span class="text-draculared text-xs mb-2">You must use textgen webui with --public-api</span>
        <span class="text-textcolor mt-2">Stream {language.providerURL}</span>
        <TextInput marginBottom={true} bind:value={activePreset.textgenWebUIStreamURL} placeholder="wss://..." />
        <span class="text-draculared text-xs mb-2"
            >Warning: For Ooba version over 1.7, use "Ooba" as model, and use url like
            http://127.0.0.1:5000/v1/chat/completions</span
        >
    {/if}
    {#if activePreset.aiModel === "ooba" || activePreset.subModel === "ooba"}
        <span class="text-textcolor mt-2">Ooba {language.providerURL}</span>
        <TextInput marginBottom={true} bind:value={activePreset.textgenWebUIBlockingURL} placeholder="https://..." />
    {/if}
    {#if activePreset.aiModel.startsWith("horde") || activePreset.aiModel === "kobold"}
        <ChatFormatSettings />
    {/if}

    {#if settings.ui.auxModelUnderModelSettings}
        <AuxModelSelectors />
    {/if}
{/if}

{#if submenu === 1 || submenu === -1}
    <!-- Data-driven basic parameters -->
    <SettingRenderer items={allBasicParameterItems} {modelInfo} {subModelInfo} />
    {#if activePreset.aiModel === "textgen_webui" || activePreset.aiModel === "mancer" || activePreset.aiModel.startsWith("local_") || activePreset.aiModel.startsWith("hf:::")}
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput
            min={1}
            max={1.5}
            step={0.01}
            fixed={2}
            marginBottom
            bind:value={activePreset.ooba.repetition_penalty}
        />
        <span class="text-textcolor">Length Penalty</span>
        <SliderInput
            min={-5}
            max={5}
            step={0.05}
            marginBottom
            fixed={2}
            bind:value={activePreset.ooba.length_penalty}
        />
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom bind:value={activePreset.ooba.top_k} />
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ooba.top_p} />
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ooba.typical_p} />
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ooba.top_a} />
        <span class="text-textcolor">No Repeat n-gram Size</span>
        <SliderInput min={0} max={20} step={1} marginBottom bind:value={activePreset.ooba.no_repeat_ngram_size} />
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.do_sample} name={"Do Sample"} />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.add_bos_token} name={"Add BOS Token"} />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.ban_eos_token} name={"Ban EOS Token"} />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.skip_special_tokens} name={"Skip Special Tokens"} />
        </div>
        <div class="flex items-center mt-4">
            <Check
                check={!!activePreset.localStopStrings}
                name={language.customStopWords}
                onChange={() => {
                    if (!activePreset.localStopStrings) {
                        activePreset.localStopStrings = [];
                    } else {
                        activePreset.localStopStrings = null;
                    }
                }}
            />
        </div>
        {#if activePreset.localStopStrings}
            <div class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1">
                <div class="p-2">
                    <button
                        class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                        onclick={() => {
                            let localStopStrings = activePreset.localStopStrings;
                            localStopStrings.push("");
                            activePreset.localStopStrings = localStopStrings;
                        }}><PlusIcon /></button
                    >
                </div>
                {#each activePreset.localStopStrings as stopString, i}
                    <div class="flex w-full">
                        <div class="grow">
                            <TextInput marginBottom bind:value={activePreset.localStopStrings[i]} fullwidth fullh />
                        </div>
                        <div>
                            <button
                                class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                                onclick={() => {
                                    let localStopStrings = activePreset.localStopStrings;
                                    localStopStrings.splice(i, 1);
                                    activePreset.localStopStrings = localStopStrings;
                                }}><TrashIcon /></button
                            >
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
        <div class="flex flex-col p-3 rounded-md border-selected border mt-4">
            <ChatFormatSettings />
        </div>
        <Check bind:check={activePreset.ooba.formating.useName} name={language.useNamePrefix} />
    {:else if modelInfo.format === LLMFormat.NovelAI}
        <div class="flex flex-col p-3 bg-darkbg mt-4">
            <span class="text-textcolor">Starter</span>
            <TextInput bind:value={activePreset.NAISettings.starter} placeholder={"⁂"} />
            <span class="text-textcolor">Seperator</span>
            <TextInput bind:value={activePreset.NAISettings.seperator} placeholder={"\\n"} />
        </div>
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.NAISettings.topP} />
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom bind:value={activePreset.NAISettings.topK} />
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.NAISettings.topA} />
        <span class="text-textcolor">Tailfree Sampling</span>
        <SliderInput
            min={0}
            max={1}
            step={0.001}
            marginBottom
            fixed={3}
            bind:value={activePreset.NAISettings.tailFreeSampling}
        />
        <span class="text-textcolor">Typical P</span>
        <SliderInput
            min={0}
            max={1}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.typicalp}
        />
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput
            min={0}
            max={3}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.repetitionPenalty}
        />
        <span class="text-textcolor">Repetition Penalty Range</span>
        <SliderInput
            min={0}
            max={8192}
            step={1}
            marginBottom
            fixed={0}
            bind:value={activePreset.NAISettings.repetitionPenaltyRange}
        />
        <span class="text-textcolor">Repetition Penalty Slope</span>
        <SliderInput
            min={0}
            max={10}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.repetitionPenaltySlope}
        />
        <span class="text-textcolor">Frequency Penalty</span>
        <SliderInput
            min={-2}
            max={2}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.frequencyPenalty}
        />
        <span class="text-textcolor">Presence Penalty</span>
        <SliderInput
            min={-2}
            max={2}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.presencePenalty}
        />
        <span class="text-textcolor">Mirostat LR</span>
        <SliderInput
            min={0}
            max={1}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.mirostat_lr}
        />
        <span class="text-textcolor">Mirostat Tau</span>
        <SliderInput
            min={0}
            max={6}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.mirostat_tau}
        />
        <span class="text-textcolor">Cfg Scale</span>
        <SliderInput
            min={1}
            max={3}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.cfg_scale}
        />
    {:else if modelInfo.format === LLMFormat.NovelList}
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.top_p} />
        <span class="text-textcolor">Reputation Penalty</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.rep_pen} />
        <span class="text-textcolor">Reputation Penalty Range</span>
        <SliderInput
            min={0}
            max={2048}
            step={1}
            marginBottom
            fixed={2}
            bind:value={activePreset.ainconfig.rep_pen_range}
        />
        <span class="text-textcolor">Reputation Penalty Slope</span>
        <SliderInput
            min={0}
            max={10}
            step={0.1}
            marginBottom
            fixed={2}
            bind:value={activePreset.ainconfig.rep_pen_slope}
        />
        <span class="text-textcolor">Top K</span>
        <SliderInput min={1} max={500} step={1} marginBottom fixed={2} bind:value={activePreset.ainconfig.top_k} />
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.top_a} />
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.typical_p} />
    {:else}
        <!-- Standard parameters now handled by SettingRenderer above -->
    {/if}

    {#if (settings.providers.reverseProxyOobaMode && activePreset.aiModel === "reverse_proxy") || activePreset.aiModel === "ooba"}
        <OobaSettings instructionMode={activePreset.aiModel === "ooba"} />
    {/if}

    {#if activePreset.aiModel.startsWith("openrouter")}
        <OpenrouterSettings />
    {/if}

    <!-- Separate Parameters - handled by custom component -->
    <SeparateParametersSection />
{/if}

{#if submenu === 3 || submenu === -1}
    <Accordion styled name="Bias " help="bias">
        <table class="contain w-full max-w-full tabler">
            <tbody>
                <tr>
                    <th class="font-medium">Bias</th>
                    <th class="font-medium">{language.value}</th>
                    <th>
                        <button
                            class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center"
                            onclick={() => {
                                let bia = activePreset.bias;
                                bia.push(["", 0]);
                                activePreset.bias = bia;
                            }}><PlusIcon /></button
                        >
                    </th>
                </tr>
                {#if activePreset.bias.length === 0}
                    <tr>
                        <td colspan="3" class="text-textcolor2">{language.noBias}</td>
                    </tr>
                {/if}
                {#each activePreset.bias as bias, i}
                    <tr>
                        <td class="font-medium truncate">
                            <TextInput bind:value={activePreset.bias[i][0]} size="lg" fullwidth />
                        </td>
                        <td class="font-medium truncate">
                            <NumberInput
                                bind:value={activePreset.bias[i][1]}
                                max={100}
                                min={-101}
                                size="lg"
                                fullwidth
                            />
                        </td>
                        <td>
                            <button
                                class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                                onclick={() => {
                                    let bia = activePreset.bias;
                                    bia.splice(i, 1);
                                    activePreset.bias = bia;
                                }}><TrashIcon /></button
                            >
                        </td>
                    </tr>
                {/each}
            </tbody>
        </table>
        <div class="text-textcolor2 mt-2 flex items-center gap-2">
            <button
                class="font-medium cursor-pointer hover:text-textcolor gap-2"
                onclick={() => {
                    const data = JSON.stringify(activePreset.bias, null, 2);
                    downloadFile("bias.json", data);
                }}><DownloadIcon /></button
            >
            <button
                class="font-medium cursor-pointer hover:text-textcolor"
                onclick={async () => {
                    const sel = await selectSingleFile(["json"]);
                    const utf8 = new TextDecoder().decode(sel.data);
                    if (Array.isArray(JSON.parse(utf8))) {
                        activePreset.bias = JSON.parse(utf8);
                    }
                }}><HardDriveUploadIcon /></button
            >
        </div>
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

    <Accordion styled name={language.promptTemplate}>
        {#if activePreset.promptTemplate}
            {#if submenu !== -1}
                <PromptSettings mode="inline" subMenu={1} />
            {/if}
        {:else}
            <Check
                check={false}
                name={language.usePromptTemplate}
                onChange={() => {
                    activePreset.promptTemplate = [];
                }}
            />
        {/if}
    </Accordion>

    {#snippet CustomFlagButton(name: string, flag: number)}
        <Button
            className="mt-2"
            onclick={(e) => {
                if (activePreset.customFlags.includes(flag as LLMFlags)) {
                    activePreset.customFlags = activePreset.customFlags.filter((f) => f !== flag);
                } else {
                    activePreset.customFlags.push(flag as LLMFlags);
                }
            }}
            styled={activePreset.customFlags.includes(flag as LLMFlags) ? "primary" : "outlined"}
        >
            {name}
        </Button>
    {/snippet}

    <Accordion styled name={language.customFlags}>
        <Check bind:check={activePreset.enableCustomFlags} name={language.enableCustomFlags} />

        {#if activePreset.enableCustomFlags}
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

    <Accordion styled name={language.moduleIntergration} help="moduleIntergration">
        <TextAreaInput bind:value={activePreset.moduleIntergration} fullwidth height={"32"} autocomplete="off" />
    </Accordion>

    <Accordion styled name={language.tools}>
        <Check
            name={language.search}
            check={activePreset.modelTools.includes("search")}
            onChange={() => {
                if (activePreset.modelTools.includes("search")) {
                    activePreset.modelTools = activePreset.modelTools.filter((tool) => tool !== "search");
                } else {
                    activePreset.modelTools.push("search");
                }
            }}
        />
    </Accordion>

    <Accordion styled name={language.regexScript}>
        <RegexList bind:value={activePreset.regex} buttons />
    </Accordion>

    <Accordion styled name={language.icon}>
        <div class="p-2 rounded-md border border-darkborderc flex flex-col items-center gap-2">
            <span>
                {language.preview}
            </span>
            <div class="flex items-center justify-center gap-2">
                {#if currentPresetRecord()?.image}
                    <img src={currentPresetRecord()?.image} alt="icon" class="w-6 h-6 rounded-md" decoding="async" />
                    <span class="text-textcolor2">{currentPresetRecord()?.name}</span>
                {:else}
                    <span class="text-textcolor2">{language.noImages}</span>
                {/if}
            </div>
        </div>
        <button
            class="mt-2 text-textcolor2 hover:text-textcolor focus-within:text-textcolor"
            onclick={async () => {
                // The selection can change while the file dialog is open: the image goes to this preset.
                const presetId = activePreset.id;
                const sel = await selectSingleFile(["png", "jpg", "jpeg", "webp"]);
                if (!sel) {
                    return;
                }
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                const img = new Image();
                //@ts-expect-error Uint8Array buffer type (ArrayBufferLike) is incompatible with BlobPart's ArrayBuffer
                const blob = new Blob([sel.data], { type: "image/png" });
                img.src = URL.createObjectURL(blob);
                await img.decode();
                canvas.width = 48;
                canvas.height = 48;
                ctx.drawImage(img, 0, 0, 48, 48);
                const data = canvas.toDataURL("image/jpeg", 0.7);
                const target = settings.presets.find((preset) => preset.id === presetId);
                if (target) {
                    target.image = data; //Since its small (max 2304 pixels), its okay to store it directly
                }
            }}
        >
            <UploadIcon />
        </button>
    </Accordion>
    {#if submenu !== -1}
        <Button
            onclick={() => {
                $openPresetList = true;
            }}
            className="mt-4">{language.presets}</Button
        >
    {/if}
{/if}

{#if submenu === 2 || submenu === -1}
    {#if !activePreset.promptTemplate}
        <span class="text-textcolor">{language.mainPrompt} <Help key="mainprompt" /></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={activePreset.mainPrompt}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.mainPrompt} {language.tokens}</span>
        <span class="text-textcolor">{language.jailbreakPrompt} <Help key="jailbreak" /></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={activePreset.jailbreak}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.jailbreak} {language.tokens}</span>
        <span class="text-textcolor">{language.globalNote} <Help key="globalNote" /></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={activePreset.globalNote}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.globalNote} {language.tokens}</span>
        <span class="text-textcolor mb-2 mt-4">{language.formatingOrder} <Help key="formatOrder" /></span>
        <DropList bind:list={activePreset.formatingOrder} />
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.promptPreprocess} name={language.promptPreprocess} />
        </div>
    {:else if submenu === 2}
        <PromptSettings mode="inline" />
    {/if}
{/if}

{#if activePreset.promptTemplate && submenu === -1}
    <div class="mt-2">
        <Button onclick={goPromptTemplate} size="sm">{language.promptTemplate}</Button>
    </div>
{/if}
{#if submenu === -1}
    <Button
        onclick={() => {
            $openPresetList = true;
        }}
        className="mt-4">{language.presets}</Button
    >
{/if}
