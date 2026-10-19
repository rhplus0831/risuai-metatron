<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import { getModelInfoForMode, LLMProvider } from "src/ts/model/modellist";
    import { credentialSlotOf } from "../../../../../shared/llm/credentialSlots.ts";
    import { secretPathKey, type SecretPath } from "../../../../../shared/llmSecrets.ts";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import { onMount } from "svelte";
    import { scrollToCredential, takeCredentialRequest } from "src/ts/setting/credentialLinks";

    /**
     * Each provider's flat default key, for the models the selected model preset's slots use, and
     * the Vertex default key's client email and project id (the API Keys tab). The OpenAI and Google
     * keys are also the image providers' (DALL-E, Imagen) and OpenAI TTS's keys, edited only here
     * (settings UI plan slice 8): they are listed while the image provider uses them, and when a
     * status link on another page asked for them (then the accordion opens on them).
     */
    /** The `data-credential` name of a row a status link can scroll to. */
    function credentialOf(path: SecretPath): string | undefined {
        if (path.kind === "flat" && path.field === "openAIKey") return "openAIKey";
        if (path.kind === "nested" && path.field === "google") return "google";
        return undefined;
    }
    const requestedOpenAI = takeCredentialRequest("openAIKey");
    const requestedGoogle = takeCredentialRequest("google");
    const models = $derived(
        (["model", "submodel", "memory", "translate", "emotion", "otherAx"] as const).map((mode) =>
            getModelInfoForMode(mode),
        ),
    );
    const usesVertex = $derived(models.some((model) => model.provider === LLMProvider.VertexAI));
    const defaultKeys = $derived.by(() => {
        const keys = new Map<string, { path: SecretPath; label: string }>();
        const add = (path: SecretPath, label: string) => keys.set(secretPathKey(path), { path, label });
        const paths: Record<string, SecretPath> = {
            openai: { kind: "flat", field: "openAIKey" },
            anthropic: { kind: "flat", field: "claudeAPIKey" },
            bedrock: { kind: "flat", field: "claudeAPIKey" },
            google: { kind: "nested", field: "google" },
            vertex: { kind: "flat", field: "vertexPrivateKey" },
            mistral: { kind: "flat", field: "mistralKey" },
            cohere: { kind: "flat", field: "cohereAPIKey" },
            novelai: { kind: "nested", field: "novelai" },
            openrouter: { kind: "flat", field: "openrouterKey" },
            nanogpt: { kind: "flat", field: "nanogptKey" },
            ollama: { kind: "flat", field: "ollamaApiKey" },
        };
        const sdProvider = settings.memoryTranslateMedia.sdProvider;
        if (requestedOpenAI || sdProvider === "dalle") add(paths.openai, language.sharedApiKeys.types.openai);
        if (requestedGoogle || sdProvider === "Imagen") add(paths.google, language.sharedApiKeys.types.google);
        for (const model of models) {
            if (!model.id) continue;
            const slot = credentialSlotOf(model.id, model);
            if (slot && paths[slot.slot]) {
                add(
                    paths[slot.slot],
                    language.sharedApiKeys.types[slot.slot as keyof typeof language.sharedApiKeys.types],
                );
            }
            if (model.keyIdentifier) add({ kind: "map", field: "OaiCompAPIKeys", id: model.keyIdentifier }, model.name);
            if (model.id.startsWith("mancer")) add({ kind: "flat", field: "mancerHeader" }, "Mancer");
            if (model.provider === LLMProvider.NovelList) add({ kind: "flat", field: "novellistAPI" }, "NovelList");
            if (model.id.startsWith("horde")) add({ kind: "nested", field: "hordeConfig" }, "Horde");
        }
        return [...keys.values()];
    });

    onMount(() => {
        if (requestedOpenAI) void scrollToCredential("openAIKey");
        if (requestedGoogle) void scrollToCredential("google");
    });
</script>

{#if defaultKeys.length > 0 || usesVertex}
    <Accordion styled name={language.modelProfiles.defaultKeys} startOpen={requestedOpenAI || requestedGoogle}>
        <p class="text-textcolor2 text-sm mb-2">{language.modelProfiles.defaultKeysHint}</p>
        {#each defaultKeys as key (secretPathKey(key.path))}
            <div class="flex flex-col" data-credential={credentialOf(key.path)}>
                <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(key.label)}</span>
                <SecretInput path={key.path} marginBottom />
            </div>
        {/each}
        {#if usesVertex}
            <span class="text-textcolor">{language.sharedApiKeys.projectId}</span>
            <TextInput marginBottom size="sm" bind:value={settings.llmSecrets.google.projectId} />
            <span class="text-textcolor">{language.sharedApiKeys.clientEmail}</span>
            <TextInput marginBottom size="sm" bind:value={settings.llmSecrets.vertexClientEmail} />
        {/if}
    </Accordion>
{/if}
