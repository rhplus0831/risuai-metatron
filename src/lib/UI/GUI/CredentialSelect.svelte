<script lang="ts">
    import { language } from "src/lang";
    import { credentialFor, credentialsAccepted } from "src/ts/model/credentials";
    import { setProfileCredential } from "src/ts/storage/collectionStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import Button from "./Button.svelte";
    import OptionInput from "./OptionInput.svelte";
    import SelectInput from "./SelectInput.svelte";

    /**
     * The per-profile key select. The options are the provider default and the records the model's credential slot
     * accepts (`src/ts/model/credentials.ts` `credentialsAccepted`); a bound key outside them (missing or of another
     * type) shows as a disabled entry, and a refusal shows its reason (`credentialFor`). Choosing writes the profile's
     * `credentialId` through `collectionStore.svelte.ts` `setProfileCredential` (`null` for the default). A model with
     * no slot shows nothing, or only the refusal and a remove button while a binding remains.
     */

    interface Props {
        profileId: string;
        compact?: boolean;
    }

    let { profileId, compact = false }: Props = $props();
    const profile = $derived(settings.modelProfiles.find((entry) => entry.id === profileId));
    const decision = $derived(credentialFor(profile));
    const options = $derived(credentialsAccepted(profile?.modelId ?? ""));
    const selected = $derived(decision.state === "default" ? "" : decision.credentialId);

    function choose(value: string) {
        setProfileCredential(profileId, value === "" ? null : value);
    }
</script>

{#if profile && (decision.slot || decision.state !== "default")}
    <div class="flex min-w-0 flex-col gap-1" class:mb-2={!compact}>
        {#if decision.slot}
            <span class="text-textcolor2 text-xs">{language.apiKey}</span>
            <SelectInput
                size="sm"
                className="w-full min-w-0"
                bind:value={() => selected, (value) => choose(String(value))}
            >
                <OptionInput value=""
                    >{language.sharedApiKeys.defaultOption(
                        language.sharedApiKeys.defaults[decision.slot.slot],
                    )}</OptionInput
                >
                {#each options as credential (credential.id)}
                    <OptionInput value={credential.id}
                        >{credential.name || language.sharedApiKeys.unnamedKey}</OptionInput
                    >
                {/each}
                {#if decision.state !== "default" && !options.some((credential) => credential.id === selected)}
                    <OptionInput value={selected} disabled selected>
                        {decision.record?.name ||
                            (decision.record ? language.sharedApiKeys.unnamedKey : language.sharedApiKeys.missingKey)}
                    </OptionInput>
                {/if}
            </SelectInput>
        {/if}
        {#if decision.state === "refused"}
            <p class="text-draculared text-xs">{language.sharedApiKeys.refused[decision.reason]}</p>
            {#if !decision.slot}
                <Button size="sm" styled="outlined" onclick={() => choose("")}
                    >{language.sharedApiKeys.removeBinding}</Button
                >
            {/if}
        {/if}
    </div>
{/if}
