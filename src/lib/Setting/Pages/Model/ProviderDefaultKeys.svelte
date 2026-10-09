<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import { getModelInfoForMode, LLMProvider } from "src/ts/model/modellist";
    import { credentialSlotOf } from "../../../../../shared/llm/credentialSlots.ts";
    import { secretPathKey, type SecretPath } from "../../../../../shared/llmSecrets.ts";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";

    /**
     * Each provider's flat default key, for the models the selected model preset's slots use, and
     * the Vertex default key's client email and project id (the API Keys tab).
     */
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
</script>

{#if defaultKeys.length > 0 || usesVertex}
    <Accordion styled name={language.modelProfiles.defaultKeys}>
        <p class="text-textcolor2 text-sm mb-2">{language.modelProfiles.defaultKeysHint}</p>
        {#each defaultKeys as key (secretPathKey(key.path))}
            <span class="text-textcolor">{language.sharedApiKeys.defaultProviderKey(key.label)}</span>
            <SecretInput path={key.path} marginBottom />
        {/each}
        {#if usesVertex}
            <span class="text-textcolor">{language.sharedApiKeys.projectId}</span>
            <TextInput marginBottom size="sm" bind:value={settings.llmSecrets.google.projectId} />
            <span class="text-textcolor">{language.sharedApiKeys.clientEmail}</span>
            <TextInput marginBottom size="sm" bind:value={settings.llmSecrets.vertexClientEmail} />
        {/if}
    </Accordion>
{/if}
