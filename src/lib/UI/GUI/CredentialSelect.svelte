<script lang="ts">
    import { language } from "src/lang";
    import { credentialFor, credentialsAccepted } from "src/ts/model/credentials";
    import {
        setCustomModelCredential,
        setModelCredential,
        setProxyCredential,
    } from "src/ts/storage/collectionStore.svelte";
    import { activeModelPreset, type PresetScope } from "src/ts/storage/settingsViews.svelte";
    import type { CredentialSlot } from "../../../../shared/llm/credentialSlots.ts";
    import Button from "./Button.svelte";
    import OptionInput from "./OptionInput.svelte";
    import SelectInput from "./SelectInput.svelte";

    interface Props {
        modelId: string;
        scope?: PresetScope;
        /** The slot owns the target; this also names the target when an unsupported binding is removed. */
        bindingTarget?: CredentialSlot["binding"];
        compact?: boolean;
    }

    let { modelId, scope, bindingTarget = "global", compact = false }: Props = $props();
    const decision = $derived(credentialFor(modelId, scope));
    const target = $derived(decision.slot?.binding ?? bindingTarget);
    const options = $derived(credentialsAccepted(modelId));
    const selected = $derived(decision.state === "default" ? "" : decision.credentialId);

    function choose(value: string) {
        const id = value === "" ? null : value;
        switch (target) {
            case "customModel":
                setCustomModelCredential(modelId, id);
                break;
            case "modelPreset": {
                const presetId = scope?.modelPresetId ?? activeModelPreset.id;
                if (presetId) setProxyCredential(presetId, id);
                break;
            }
            default:
                setModelCredential(modelId, id);
        }
    }
</script>

{#if decision.slot || decision.state !== "default"}
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
