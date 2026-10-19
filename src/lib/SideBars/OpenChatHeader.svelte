<script lang="ts">
    import { CheckIcon, DownloadIcon, PencilIcon, PinIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { exportChat } from "src/ts/characters";
    import { chatEntry, setChatMeta, type ChatRef } from "src/ts/storage/chatStore.svelte";

    interface Props {
        /** The chat this header names and writes to; read once (the parent recreates it for another chat). */
        chat: ChatRef;
    }

    /*
     * The open chat's name with rename and export, under Go Back. The name comes from the chat's list
     * entry, so it shows while the chat loads. A rename edits a draft and writes once, on Enter or when
     * the field loses focus; Escape, an empty name, or an unchanged one writes nothing.
     */
    let { chat }: Props = $props();
    // Captured at creation: a commit on blur can run after the selection moved to another chat.
    // svelte-ignore state_referenced_locally
    const owner: ChatRef = { chaId: chat.chaId, chatId: chat.chatId };
    const entry = $derived(chatEntry(owner));

    let editing = $state(false);
    let draft = $state("");
    let input: HTMLInputElement | undefined = $state();

    $effect(() => {
        if (editing && input) {
            input.focus();
            input.select();
        }
    });

    function startEdit() {
        draft = entry?.name ?? "";
        editing = true;
    }

    function commit() {
        if (!editing) {
            return;
        }
        editing = false;
        // A chat deleted meanwhile takes no write.
        const current = chatEntry(owner);
        if (current && draft.trim() !== "" && draft !== current.name) {
            setChatMeta(owner, { name: draft });
        }
    }

    function cancel() {
        editing = false;
    }

    function onkeydown(e: KeyboardEvent) {
        // Enter that ends an IME composition (Korean, Japanese, Chinese input) is not a commit.
        if (e.isComposing) {
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            commit();
        } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
        }
    }
</script>

{#if entry}
    <!-- The name and its field share one box (padding and a border), so a rename does not move the panel. -->
    <div class="mb-3 flex items-center gap-1 border-b border-darkborderc pb-2" data-open-chat-header>
        {#if editing}
            <input
                bind:this={input}
                bind:value={draft}
                class="min-w-0 grow rounded-md border border-darkborderc bg-transparent px-2 py-1 text-lg font-semibold text-textcolor focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                aria-label={language.openChat.name}
                autocomplete="off"
                onblur={commit}
                {onkeydown}
                data-open-chat-name-input
            />
            <button
                class="shrink-0 rounded-md p-1.5 text-textcolor2 hover:bg-selected hover:text-textcolor cursor-pointer"
                title={language.openChat.saveName}
                aria-label={language.openChat.saveName}
                onmousedown={(e) => e.preventDefault()}
                onclick={commit}
                data-open-chat-rename
            >
                <CheckIcon size={18} />
            </button>
        {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="flex min-w-0 grow items-center gap-1 border border-transparent px-2 py-1 text-lg"
                title={entry.name}
                ondblclick={startEdit}
            >
                {#if entry.pinned === true}
                    <PinIcon size={14} class="shrink-0 text-textcolor2" aria-hidden="true" />
                {/if}
                <span class="min-w-0 truncate font-semibold text-textcolor" data-open-chat-name>{entry.name}</span>
            </div>
            <button
                class="shrink-0 rounded-md p-1.5 text-textcolor2 hover:bg-selected hover:text-textcolor cursor-pointer"
                title={language.openChat.rename}
                aria-label={language.openChat.rename}
                onclick={startEdit}
                data-open-chat-rename
            >
                <PencilIcon size={18} />
            </button>
        {/if}
        <button
            class="shrink-0 rounded-md p-1.5 text-textcolor2 hover:bg-selected hover:text-textcolor cursor-pointer"
            title={language.openChat.export}
            aria-label={language.openChat.export}
            onclick={() => exportChat(owner.chatId)}
            data-open-chat-export
        >
            <DownloadIcon size={18} />
        </button>
    </div>
{/if}
