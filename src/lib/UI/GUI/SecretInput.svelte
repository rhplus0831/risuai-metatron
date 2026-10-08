<script lang="ts">
    import { language } from "src/lang";
    import { clearSecret, secretStatus, setSecret } from "src/ts/storage/llmSecrets.svelte";
    import { encodeSecretPath, type SecretPath } from "../../../../shared/llmSecrets.ts";
    import Button from "./Button.svelte";
    import TextInput from "./TextInput.svelte";

    /**
     * A write-only credential (Phase 5 slice 7b): the stored key's status (set, with its last
     * characters when long enough; not set; saving), a password field whose value replaces it on
     * Enter or the button (once: the field is emptied when the write is queued), and a clear button.
     * The draft belongs to `path`: it is dropped when the input is moved to another target.
     */
    interface Props {
        path: SecretPath;
        size?: "sm" | "md" | "lg" | "xl";
        placeholder?: string;
        marginBottom?: boolean;
        /** Called after a replacement or a clear is queued. */
        onchange?: () => void;
    }

    let { path, size = "sm", placeholder = "", marginBottom = false, onchange }: Props = $props();

    let draft = $state("");
    const target = $derived(encodeSecretPath(path));
    let draftTarget = "";
    $effect(() => {
        if (target !== draftTarget) {
            draftTarget = target;
            draft = "";
        }
    });
    const status = $derived(secretStatus(path));

    function submit(event?: Event) {
        event?.preventDefault();
        if (draft === "") {
            return;
        }
        const value = draft;
        draft = "";
        setSecret(path, value);
        onchange?.();
    }

    function clear() {
        draft = "";
        clearSecret(path);
        onchange?.();
    }
</script>

<div class="flex flex-col" class:mb-4={marginBottom}>
    <span class="text-textcolor2 text-xs mb-1">
        {#if status.set}
            {language.secretSet}{status.hint ? ` (…${status.hint})` : ""}
        {:else}
            {language.secretNotSet}
        {/if}
        {#if status.pending}
            · {language.secretSaving}
        {/if}
    </span>
    <form class="flex flex-wrap gap-2 items-center" onsubmit={submit}>
        <TextInput {size} hideText fullwidth className="min-w-0 flex-1 basis-32" bind:value={draft} {placeholder} />
        <Button size="sm" styled="outlined" onclick={() => submit()}>{language.secretReplace}</Button>
        {#if status.set}
            <Button size="sm" styled="danger" onclick={clear}>{language.secretClear}</Button>
        {/if}
    </form>
</div>
