<script lang="ts">
    import { language } from "src/lang";
    import { secretStatus } from "src/ts/storage/llmSecrets.svelte";
    import { maskedLeaf } from "../../../shared/llmSecrets.ts";
    import { CREDENTIAL_OWNERS, openCredentialOwner, type SharedCredential } from "src/ts/setting/credentialLinks";

    /**
     * A shared credential where its owning page is not: the status `src/lib/UI/GUI/SecretInput.svelte` shows
     * (set, with its last characters when long enough; not set; saving) and an "Edit in …" button opening the
     * owner with the field shown. Nothing here edits the key.
     * Plain `secrets.NAIApiKey` uses `shared/llmSecrets.ts`'s `maskedLeaf`. Consumers:
     * `src/lib/Setting/Pages/VoiceSettings.svelte` (OpenAI, NovelAI),
     * `src/lib/Setting/Pages/ImageGenerationSettings.svelte` (DALL-E's OpenAI, Imagen's Google),
     * `src/lib/Playground/PlaygroundEmbedding.svelte` (`supaMemoryKey`).
     */

    interface Props {
        credential: SharedCredential;
        label: string;
    }

    let { credential, label }: Props = $props();

    const owner = $derived(CREDENTIAL_OWNERS[credential]);
    const status = $derived(owner.path ? secretStatus(owner.path) : { ...maskedLeaf(owner.value?.()), pending: false });
</script>

<div class="flex flex-col mb-4" data-credential-status={credential}>
    <span class="text-textcolor">{label}</span>
    <span class="text-textcolor2 text-xs mt-1">
        {#if status.set}
            {language.secretSet}{status.hint ? ` (…${status.hint})` : ""}
        {:else}
            {language.secretNotSet}
        {/if}
        {#if status.pending}
            · {language.secretSaving}
        {/if}
    </span>
    <button
        class="mt-1 self-start text-left text-sm text-textcolor2 underline hover:text-textcolor"
        onclick={() => openCredentialOwner(credential)}>{language.credentialEditIn(owner.place())}</button
    >
</div>
