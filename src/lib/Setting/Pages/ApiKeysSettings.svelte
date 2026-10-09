<script lang="ts">
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import { credentialsUsing, type CredentialUsage } from "src/ts/model/credentials";
    import {
        addCredential,
        updateCredential,
        deleteCredential,
        setProfileCredential,
    } from "src/ts/storage/collectionStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { CREDENTIAL_TYPES, type CredentialType } from "../../../../shared/database.ts";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import ModelMenuTabs from "./Model/ModelMenuTabs.svelte";
    import ProviderDefaultKeys from "./Model/ProviderDefaultKeys.svelte";
    import { tick } from "svelte";

    let name = $state("");
    let type = $state<CredentialType>("openai");
    let clientEmail = $state("");
    let projectId = $state("");
    let keyList: HTMLDivElement;

    const credentials = $derived(settings.credentials ?? []);
    const bindings = $derived(
        (settings.modelProfiles ?? [])
            .filter((profile) => profile.credentialId !== undefined)
            .map((profile) => ({
                kind: "modelProfile" as const,
                id: profile.id,
                name: profile.name,
                credentialId: profile.credentialId!,
            })),
    );

    function keyName(id: string) {
        const record = credentials.find((credential) => credential.id === id);
        return record ? record.name || language.sharedApiKeys.unnamedKey : language.sharedApiKeys.missingKey;
    }

    async function removeKey(id: string, name: string) {
        const uses = credentialsUsing(id)
            .map((use) => language.sharedApiKeys.usageLabel(language.sharedApiKeys.usageKinds[use.kind], use.name))
            .join("\n");
        if (await alertConfirm(language.sharedApiKeys.deleteConfirm(name || language.sharedApiKeys.unnamedKey, uses))) {
            deleteCredential(id);
        }
    }

    async function addKey() {
        if (!name.trim()) return;
        const id = addCredential({ name: name.trim(), type, ...(type === "vertex" ? { clientEmail, projectId } : {}) });
        name = "";
        clientEmail = "";
        projectId = "";
        await tick();
        const row = keyList?.querySelector<HTMLElement>(`[data-credential-id="${id}"]`);
        row?.scrollIntoView({ block: "nearest" });
        row?.querySelector<HTMLInputElement>('input[type="password"]')?.focus({ preventScroll: true });
    }

    function removeBinding(binding: CredentialUsage) {
        setProfileCredential(binding.id, null);
    }
</script>

<ModelMenuTabs />
<p class="text-textcolor2 text-sm mb-4">{language.sharedApiKeys.description}</p>

<ProviderDefaultKeys />

<div class="flex flex-col gap-4 min-w-0" bind:this={keyList}>
    {#each credentials as credential (credential.id)}
        <div
            class="flex flex-col gap-2 min-w-0 p-3 border border-darkborderc rounded-md"
            data-credential-id={credential.id}
        >
            <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-textcolor2 text-sm">{language.sharedApiKeys.types[credential.type]}</span>
                <Button
                    size="sm"
                    styled="outlined"
                    className="text-draculared"
                    onclick={() => removeKey(credential.id, credential.name)}>{language.sharedApiKeys.deleteKey}</Button
                >
            </div>
            <label for={`credential-name-${credential.id}`} class="text-sm">{language.name}</label>
            <TextInput
                id={`credential-name-${credential.id}`}
                size="sm"
                fullwidth
                bind:value={() => credential.name, (value) => updateCredential(credential.id, { name: value })}
            />
            {#if credential.type === "vertex"}
                <label for={`credential-email-${credential.id}`} class="text-sm"
                    >{language.sharedApiKeys.clientEmail}</label
                >
                <TextInput
                    id={`credential-email-${credential.id}`}
                    size="sm"
                    fullwidth
                    bind:value={
                        () => credential.clientEmail ?? "",
                        (value) => updateCredential(credential.id, { clientEmail: value })
                    }
                />
                <label for={`credential-project-${credential.id}`} class="text-sm"
                    >{language.sharedApiKeys.projectId}</label
                >
                <TextInput
                    id={`credential-project-${credential.id}`}
                    size="sm"
                    fullwidth
                    bind:value={
                        () => credential.projectId ?? "",
                        (value) => updateCredential(credential.id, { projectId: value })
                    }
                />
                <p class="text-textcolor2 text-xs">{language.sharedApiKeys.projectIdHint}</p>
            {/if}
            <span class="text-sm"
                >{credential.type === "vertex" ? language.sharedApiKeys.privateKey : language.apiKey}</span
            >
            {#if credential.type === "bedrock"}<p class="text-textcolor2 text-xs">
                    {language.sharedApiKeys.bedrockHint}
                </p>{/if}
            <SecretInput path={{ kind: "entry", field: "credentials", id: credential.id }} />
        </div>
    {:else}
        <p class="text-textcolor2 text-sm">{language.sharedApiKeys.noKeys}</p>
    {/each}
</div>

<div class="flex flex-col gap-2 min-w-0 p-3 my-4 border border-darkborderc rounded-md">
    <h3 class="text-lg font-bold">{language.sharedApiKeys.addKey}</h3>
    <label for="new-credential-name" class="text-sm">{language.name}</label>
    <TextInput id="new-credential-name" size="sm" fullwidth bind:value={name} />
    <span class="text-sm">{language.type}</span>
    <SelectInput
        size="sm"
        className="w-full min-w-0"
        bind:value={() => type, (value) => (type = value as CredentialType)}
    >
        {#each CREDENTIAL_TYPES as keyType}
            <OptionInput value={keyType}>{language.sharedApiKeys.types[keyType]}</OptionInput>
        {/each}
    </SelectInput>
    {#if type === "vertex"}
        <label for="new-credential-email" class="text-sm">{language.sharedApiKeys.clientEmail}</label>
        <TextInput id="new-credential-email" size="sm" fullwidth bind:value={clientEmail} />
        <label for="new-credential-project" class="text-sm">{language.sharedApiKeys.projectId}</label>
        <TextInput id="new-credential-project" size="sm" fullwidth bind:value={projectId} />
        <p class="text-textcolor2 text-xs">{language.sharedApiKeys.projectIdHint}</p>
    {/if}
    <Button size="sm" disabled={!name.trim()} onclick={addKey}>{language.sharedApiKeys.addKey}</Button>
</div>

<h3 class="text-lg font-bold mb-2">{language.sharedApiKeys.bindings}</h3>
<div class="flex flex-col gap-2 min-w-0">
    {#each bindings as binding (`${binding.kind}:${binding.id}`)}
        <div class="flex flex-wrap items-center gap-2 p-3 border border-darkborderc rounded-md">
            <div class="flex-1 min-w-0 basis-40 break-words">
                <p class="text-textcolor2 text-xs">{language.sharedApiKeys.usageKinds[binding.kind]}</p>
                <p>{binding.name}</p>
                <p
                    class="text-sm"
                    class:text-draculared={!credentials.some((credential) => credential.id === binding.credentialId)}
                >
                    {keyName(binding.credentialId)}
                </p>
            </div>
            <Button size="sm" styled="outlined" onclick={() => removeBinding(binding)}
                >{language.sharedApiKeys.removeBinding}</Button
            >
        </div>
    {:else}
        <p class="text-textcolor2 text-sm">{language.sharedApiKeys.noBindings}</p>
    {/each}
</div>
