<script lang="ts">
    import { untrack } from "svelte";
    import { settings, profileForSlot } from "src/ts/storage/settingsViews.svelte";
    import CredentialSelect from "src/lib/UI/GUI/CredentialSelect.svelte";
    import OpenrouterSettings from "../OpenrouterSettings.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";

    import { customProviderStore } from "src/ts/plugins/pluginHooks";
    import { tokenizerList } from "src/ts/tokenizer";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { credentialStatusFor } from "src/ts/model/credentials";
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
    import ChatFormatSettings from "../ChatFormatSettings.svelte";
    import { getModelInfo, LLMFlags, LLMFormat } from "src/ts/model/modellist";
    import SettingRenderer from "../../SettingRenderer.svelte";
    import { modelParameterItems } from "src/ts/setting/botSettingsParamsData";

    interface Props {
        profileId: string;
    }
    let { profileId }: Props = $props();
    const profile = profileForSlot(() => ({ profileId }));
    const record = $derived(settings.modelProfiles.find((entry) => entry.id === profileId));
    const modelInfo = $derived(getModelInfo(profile.modelId, undefined, record ?? null));
    const usesOllamaLocal = $derived(profile.modelId === "ollama-hosted");
    const usesOllamaCloud = $derived(profile.modelId === "ollama-cloud");
    const openrouterPinnedItems: ModelGridPinnedItem[] = [
        { id: "risu/free", displayName: "Free Auto", providerName: "Risu" },
        { id: "openrouter/auto", displayName: "OpenRouter Auto", providerName: "OpenRouter" },
    ];
    const NANOGPT_KEY = { kind: "flat", field: "nanogptKey" } as const;
    const nanogptKey = $derived(credentialStatusFor(record, NANOGPT_KEY));
    const ollamaKey = $derived(credentialStatusFor(record, { kind: "flat", field: "ollamaApiKey" }));
    const openrouterKey = $derived(credentialStatusFor(record, { kind: "flat", field: "openrouterKey" }));
    let nanogptInputMode = $state<"list" | "manual">(
        untrack(() => (profile.nanogptRequestModel && !profile.nanogptRequestModelName ? "manual" : "list")),
    );
    let nanogptKeyInitialized = false;
    $effect(() => {
        const keySet = nanogptKey.keySet;
        if (!nanogptKeyInitialized) {
            nanogptKeyInitialized = true;
            return;
        }
        if (!keySet && profile.modelId === "nanogpt") {
            settings.providers.nanogptSubscriptionState = "";
            chooseNanogptSubscription(false);
        }
    });
    function chooseNanogptInputMode(value: string | number) {
        const next = value as "list" | "manual";
        if (next !== nanogptInputMode) {
            profile.nanogptRequestModel = "";
            profile.nanogptRequestModelName = "";
            profile.nanogptProvider = "";
            nanogptInputMode = next;
        }
    }
    function chooseNanogptSubscription(value: boolean) {
        settings.providers.nanogptUseSubscriptionEndpoint = value;
        profile.nanogptRequestModel = "";
        profile.nanogptRequestModelName = "";
        profile.nanogptProvider = "";
    }
</script>

<span class="text-textcolor mt-4">{language.model} <Help key="model" /></span>
<ModelList bind:value={profile.modelId} />
<CredentialSelect {profileId} />
<SettingRenderer items={modelParameterItems} {modelInfo} subModelInfo={modelInfo} modelProfile={profile} />
<Check bind:check={profile.outputImageModal} name={language.outputImageModal} className="mt-2" />

{#if profile.modelId === "reverse_proxy"}
    <span class="text-textcolor mt-2">URL <Help key="forceUrl" /></span>
    <TextInput marginBottom={false} size={"sm"} bind:value={profile.forceReplaceUrl} placeholder="https//..." />

    <span class="text-textcolor mt-4"> {language.proxyRequestModel}</span>
    <TextInput marginBottom={false} size={"sm"} bind:value={profile.customProxyRequestModel} placeholder="Name" />
    <span class="text-textcolor mt-4"> {language.format}</span>
    <SelectInput
        value={profile.customAPIFormat.toString()}
        onchange={(e) => {
            profile.customAPIFormat = parseInt(e.currentTarget.value) as LLMFormat;
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

{#if usesOllamaLocal || usesOllamaCloud}
    {#if usesOllamaLocal}
        <span class="text-textcolor mt-4">Ollama URL</span>
        <TextInput marginBottom={false} size={"sm"} bind:value={profile.ollamaURL} />
    {/if}

    {#if usesOllamaCloud}
        <span class="text-textcolor mt-4">Ollama {language.model}</span>
        <SegmentedControl
            bind:value={profile.ollamaInputMode}
            options={[
                { value: "list", label: language.nanoGPTSelectFromList },
                { value: "manual", label: language.nanoGPTManualInput },
            ]}
            size="md"
        />

        {#if profile.ollamaInputMode === "manual"}
            <TextInput
                marginBottom={false}
                size={"sm"}
                bind:value={profile.ollamaCloudModel}
                placeholder="Model"
                oninput={() => (profile.ollamaCloudModelName = "")}
            />
        {:else}
            {#await (ollamaKey.keyVersion, getOllamaModels(profile.ollamaURL, "cloud", record))}
                <ModelGrid bind:value={profile.ollamaCloudModel} loading={true} />
            {:then cloudModels}
                <ModelGrid
                    bind:value={profile.ollamaCloudModel}
                    items={cloudModels ?? []}
                    selectedLabelOverride={profile.ollamaCloudModel
                        ? `Cloud / ${profile.ollamaCloudModelName || profile.ollamaCloudModel}`
                        : undefined}
                    onselect={(_id, name) => {
                        profile.ollamaModelSource = "cloud";
                        profile.ollamaCloudModelName = name;
                    }}
                />
            {/await}
        {/if}

        <span class="text-textcolor mt-4">Ollama {language.format}</span>
        <SelectInput
            value={profile.ollamaRequestFormat.toString()}
            onchange={(e) => {
                profile.ollamaRequestFormat = parseInt(e.currentTarget.value) as LLMFormat;
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
            bind:value={profile.ollamaModel}
            placeholder="Model"
            oninput={() => {
                profile.ollamaModelSource = "local";
                profile.ollamaModelName = "";
            }}
        />
    {/if}

    {#if usesOllamaLocal || (usesOllamaCloud && profile.ollamaRequestFormat === LLMFormat.Ollama)}
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
{#if profile.modelId === "nanogpt"}
    <NanoGPTDashboard profile={record} keySet={nanogptKey.keySet} keyVersion={nanogptKey.keyVersion} />

    {#if settings.providers.nanogptSubscriptionState === "active" || settings.providers.nanogptSubscriptionState === "grace"}
        <div class="flex items-center mt-3">
            <CheckInput
                bind:check={() => settings.providers.nanogptUseSubscriptionEndpoint, chooseNanogptSubscription}
                name={language.nanoGPTUseSubscriptionEndpoint}
            />
        </div>
    {/if}

    <span class="text-textcolor mt-4">NanoGPT {language.model}</span>
    <SegmentedControl
        bind:value={() => nanogptInputMode, chooseNanogptInputMode}
        options={[
            { value: "list", label: language.nanoGPTSelectFromList },
            { value: "manual", label: language.nanoGPTManualInput },
        ]}
        size="md"
    />

    {#if nanogptInputMode === "manual"}
        <TextInput
            marginBottom={false}
            size={"sm"}
            bind:value={profile.nanogptRequestModel}
            placeholder={language.nanoGPTManualModelSelect}
            oninput={() => {
                profile.nanogptRequestModelName = "";
                profile.nanogptProvider = "";
            }}
        />
    {:else}
        {#await (nanogptKey.keyVersion, Promise.all([getNanoGPTModels(record), getNanoGPTSubscriptionModels(record)]))}
            <ModelGrid bind:value={profile.nanogptRequestModel} loading={true} />
        {:then [regular, sub]}
            <ModelGrid
                bind:value={profile.nanogptRequestModel}
                items={settings.providers.nanogptUseSubscriptionEndpoint
                    ? (sub ?? []).map(ngToGridItem)
                    : (regular ?? []).map(ngToGridItem)}
                showSubBadge={settings.providers.nanogptUseSubscriptionEndpoint}
                selectedLabelOverride={profile.nanogptRequestModel && !profile.nanogptRequestModelName
                    ? profile.nanogptRequestModel
                    : undefined}
                onselect={(_id, name) => {
                    profile.nanogptRequestModelName = name;
                    profile.nanogptProvider = "";
                }}
            />
            {#if !settings.providers.nanogptUseSubscriptionEndpoint}
                <NanoGPTProviderPicker
                    profile={record}
                    keySet={nanogptKey.keySet}
                    keyVersion={nanogptKey.keyVersion}
                    modelId={profile.nanogptRequestModel}
                    bind:value={profile.nanogptProvider}
                />
            {/if}
        {/await}
    {/if}
{/if}
{#if profile.modelId === "openrouter"}
    <span class="text-textcolor mt-4">OpenRouter {language.model}</span>
    {#await (openrouterKey.keyVersion, getOpenRouterModels(record))}
        <ModelGrid bind:value={profile.openrouterRequestModel} pinnedItems={openrouterPinnedItems} loading={true} />
    {:then m}
        <ModelGrid
            bind:value={profile.openrouterRequestModel}
            items={(m ?? []).map(orToGridItem)}
            pinnedItems={openrouterPinnedItems}
        />
    {/await}
{/if}
{#if profile.modelId === "openrouter"}
    <OpenrouterSettings {profile} />
{/if}
{#if profile.modelId === "openrouter" || profile.modelId === "reverse_proxy"}
    <span class="text-textcolor">{language.tokenizer}</span>
    <SelectInput bind:value={profile.customTokenizer}>
        {#each tokenizerList as entry}
            <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
        {/each}
    </SelectInput>
{/if}

{#if profile.modelId === "custom"}
    <span class="text-textcolor mt-2">{language.plugin}</span>
    <SelectInput className="mt-2 mb-4" bind:value={profile.currentPluginProvider}>
        <OptionInput value="">{language.none}</OptionInput>
        {#each $customProviderStore as plugin}
            <OptionInput value={plugin}>{plugin}</OptionInput>
        {/each}
    </SelectInput>
{/if}

{#if profile.modelId === "kobold"}
    <span class="text-textcolor">Kobold URL</span>
    <TextInput marginBottom={true} bind:value={profile.koboldURL} />
{/if}

{#if profile.modelId === "echo_model"}
    <span class="text-textcolor mt-2">Echo Message</span>
    <TextAreaInput
        margin="bottom"
        bind:value={settings.providers.echoMessage}
        placeholder={"The message you want to receive as the bot's response\n(e.g., Lumi tilts her head, her white hair sliding down as her pretty green and aqua eyes sparkle…)"}
    />
    <span class="text-textcolor mt-2">Echo Delay (Seconds)</span>
    <NumberInput marginBottom={true} bind:value={settings.providers.echoDelay} min={0} />
{/if}

{#if profile.modelId === "textgen_webui" || profile.modelId === "textgen_webui" || profile.modelId === "mancer" || profile.modelId === "mancer"}
    <span class="text-textcolor mt-2">Blocking {language.providerURL}</span>
    <TextInput marginBottom={true} bind:value={profile.textgenWebUIBlockingURL} placeholder="https://..." />
    <span class="text-draculared text-xs mb-2">You must use textgen webui with --public-api</span>
    <span class="text-textcolor mt-2">Stream {language.providerURL}</span>
    <TextInput marginBottom={true} bind:value={profile.textgenWebUIStreamURL} placeholder="wss://..." />
    <span class="text-draculared text-xs mb-2"
        >Warning: For Ooba version over 1.7, use "Ooba" as model, and use url like
        http://127.0.0.1:5000/v1/chat/completions</span
    >
{/if}
{#if profile.modelId === "ooba"}
    <span class="text-textcolor mt-2">Ooba {language.providerURL}</span>
    <TextInput marginBottom={true} bind:value={profile.textgenWebUIBlockingURL} placeholder="https://..." />
{/if}
<Accordion styled name={language.chatFormating}>
    <ChatFormatSettings {profile} />
</Accordion>

<Accordion styled name={language.systemContentReplacement} help="systemContentReplacement">
    <span class="text-textcolor">{language.systemContentReplacement}</span>
    <TextAreaInput bind:value={profile.systemContentReplacement} />
    <span class="text-textcolor mt-4">{language.systemRoleReplacement} <Help key="systemRoleReplacement" /></span>
    <SelectInput bind:value={profile.systemRoleReplacement}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
</Accordion>

{#snippet CustomFlagButton(name: string, flag: number)}
    <Button
        className="mt-2"
        onclick={(e) => {
            if (profile.customFlags.includes(flag as LLMFlags)) {
                profile.customFlags = profile.customFlags.filter((f) => f !== flag);
            } else {
                profile.customFlags.push(flag as LLMFlags);
            }
        }}
        styled={profile.customFlags.includes(flag as LLMFlags) ? "primary" : "outlined"}
    >
        {name}
    </Button>
{/snippet}

<Accordion styled name={language.customFlags}>
    <Check bind:check={profile.enableCustomFlags} name={language.enableCustomFlags} />

    {#if profile.enableCustomFlags}
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
        check={profile.modelTools.includes("search")}
        onChange={() => {
            if (profile.modelTools.includes("search")) {
                profile.modelTools = profile.modelTools.filter((tool) => tool !== "search");
            } else {
                profile.modelTools.push("search");
            }
        }}
    />
</Accordion>

<Accordion styled name={language.modelProfiles.localNetworkMode}>
    <Check bind:check={profile.localNetworkMode} name={language.modelProfiles.localNetworkMode} />
    <Help key="localNetworkModeDesc" />
    <span class="text-textcolor mt-2">{language.modelProfiles.localNetworkTimeoutSec}</span>
    <NumberInput bind:value={profile.localNetworkTimeoutSec} min={30} max={3600} />
</Accordion>
