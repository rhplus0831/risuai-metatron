<script module lang="ts">
    import { SvelteSet } from "svelte/reactivity";

    // A discard can outlive a screen switch; both banner forms share its pending keys.
    const discarding = new SvelteSet<string>();
    const displayedChatKeys = new SvelteSet<string>();
</script>

<script lang="ts">
    import { language } from "src/lang";
    import { ChevronDownIcon } from "@lucide/svelte";
    import { alertConfirm, alertError } from "src/ts/alert";
    import { exportChat } from "src/ts/characters";
    import { downloadFile, openPinnedChat } from "src/ts/globalApi.svelte";
    import { DynamicGUI, gridOpenStore, settingsOpen, sideBarStore } from "src/ts/stores.svelte";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatEntry } from "src/ts/storage/chatStore.svelte";
    import { characterData, recordData, type RecordKind } from "src/ts/storage/records.svelte";
    import { discardRefused, refusedItems, retryRefused, type RefusedItem } from "src/ts/storage/resourceSync.svelte";
    import { refusedItemsFor, refusedRecordExportText, type RefusedRecordItem } from "./refusedData";

    type Props = { form: "chat"; chaId: string; chatId: string } | { form: "app" };

    let props: Props = $props();
    let expanded = $state(false);
    const listId = $props.id();
    const ownChatKey = $derived(props.form === "chat" ? `${props.chaId}\u0000${props.chatId}` : null);
    $effect(() => {
        const key = ownChatKey;
        if (key === null) return;
        displayedChatKeys.add(key);
        return () => {
            displayedChatKeys.delete(key);
        };
    });
    const items = $derived(
        refusedItemsFor(refusedItems(), ownChatKey === null ? displayedChatKeys : new Set([ownChatKey]), props.form),
    );
    const title = $derived(props.form === "chat" ? language.refusedData.chatTitle : language.refusedData.appTitle);

    function localRecord(item: RefusedRecordItem): unknown {
        return item.resourceKind === "characters"
            ? characterData().find((record) => record.chaId === item.id)
            : recordData(item.resourceKind as RecordKind);
    }

    function characterName(chaId: string): string {
        return findCharacter(chaId)?.name || language.unnamedCharacter;
    }

    function recordLabel(item: RefusedRecordItem): string {
        if (item.resourceKind === "characters")
            return findCharacter(item.id)?.name || language.refusedData.recordKinds.characters;
        const labels = language.refusedData.recordKinds;
        return Object.hasOwn(labels, item.resourceKind)
            ? labels[item.resourceKind as keyof typeof labels]
            : language.refusedData.recordKind(item.resourceKind);
    }

    const rows = $derived(
        items.map((item) => {
            if (item.kind === "chat") {
                const entry = chatEntry(item);
                return {
                    item,
                    hasLocal: entry !== undefined,
                    label: entry
                        ? language.refusedData.chatLabel(
                              entry.name || language.unnamedPinnedChat,
                              characterName(item.chaId),
                          )
                        : language.refusedData.deletedChat(characterName(item.chaId), item.chatId),
                };
            }
            if (item.kind === "order") {
                return { item, hasLocal: false, label: language.refusedData.orderLabel(characterName(item.chaId)) };
            }
            const hasLocal = localRecord(item) !== undefined;
            const label = recordLabel(item);
            return { item, hasLocal, label: hasLocal ? label : language.refusedData.deletedRecord(label, item.id) };
        }),
    );

    async function exportItem(item: RefusedItem) {
        try {
            if (item.kind === "chat") {
                if (chatEntry(item)) await exportChat(item.chatId);
            } else if (item.kind === "record") {
                const text = refusedRecordExportText(item, localRecord(item));
                if (text !== undefined) {
                    const filename = `refused-${item.resourceKind}-${item.id}`.replace(
                        /[<>:"/\\|?*\u0000-\u001f]/g,
                        "_",
                    );
                    await downloadFile(`${filename}.json`, text);
                }
            }
        } catch (error) {
            alertError(error instanceof Error ? error : String(error));
        }
    }

    function openChat(item: Extract<RefusedItem, { kind: "chat" }>) {
        openPinnedChat(item, () => {
            settingsOpen.set(false);
            gridOpenStore.set(false);
            if ($DynamicGUI) sideBarStore.set(false);
        });
    }

    function retry(key: string) {
        try {
            retryRefused(key);
        } catch (error) {
            alertError(error instanceof Error ? error : String(error));
        }
    }

    async function discard(item: RefusedItem, label: string, hasLocal: boolean) {
        if (discarding.has(item.key)) return;
        discarding.add(item.key);
        try {
            const confirmation =
                !hasLocal && item.kind !== "order"
                    ? language.refusedData.discardDeletionConfirm(label)
                    : language.refusedData.discardConfirm(label);
            if (await alertConfirm(confirmation)) await discardRefused(item.key);
        } catch (error) {
            alertError(error instanceof Error ? error : String(error));
        } finally {
            discarding.delete(item.key);
        }
    }
</script>

{#snippet refusalRows()}
    <ul class="m-0 list-none p-0">
        {#each rows as { item, hasLocal, label } (item.key)}
            {@const busy = discarding.has(item.key)}
            <li
                class="refused-item flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-darkborderc py-2 first:border-0"
                data-risu-refused-key={item.key}
                data-risu-refused-kind={item.kind}
                aria-busy={busy}
            >
                <div class="min-w-0 flex-1 basis-48">
                    <p class="font-medium" data-risu-refused-label>{label}</p>
                    <p class="whitespace-pre-wrap text-textcolor2" data-risu-refused-reason>{item.reason}</p>
                </div>
                <div class="flex flex-wrap gap-1">
                    {#if hasLocal && item.kind === "chat" && props.form === "app"}
                        <button
                            type="button"
                            disabled={busy}
                            data-risu-refused-action="open"
                            onclick={() => openChat(item)}>{language.refusedData.open}</button
                        >
                    {:else if hasLocal && (item.kind === "record" || item.kind === "chat")}
                        <button
                            type="button"
                            disabled={busy}
                            data-risu-refused-action="export"
                            onclick={() => exportItem(item)}>{language.refusedData.export}</button
                        >
                    {/if}
                    <button
                        type="button"
                        disabled={busy}
                        data-risu-refused-action="retry"
                        onclick={() => retry(item.key)}>{language.refusedData.retry}</button
                    >
                    <button
                        type="button"
                        disabled={busy}
                        data-risu-refused-action="discard"
                        onclick={() => discard(item, label, hasLocal)}>{language.refusedData.discard}</button
                    >
                </div>
            </li>
        {/each}
    </ul>
{/snippet}

{#if rows.length > 0}
    <section
        role="status"
        aria-label={title}
        data-risu-refused-banner={props.form}
        class="refused-banner text-sm text-textcolor"
        class:app-banner={props.form === "app"}
        class:chat-banner={props.form === "chat"}
    >
        {#if props.form === "app"}
            <button
                type="button"
                class="refused-toggle flex max-w-full items-center gap-2 shadow-lg"
                aria-expanded={expanded}
                aria-controls={listId}
                data-risu-refused-toggle
                onclick={() => {
                    expanded = !expanded;
                }}
                onkeydown={(event) => {
                    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                }}
            >
                <span class="truncate">{language.refusedData.appSummary(rows.length)}</span>
                <ChevronDownIcon size={16} class={expanded ? "shrink-0 rotate-180" : "shrink-0"} aria-hidden="true" />
            </button>
            {#if expanded}
                <div
                    id={listId}
                    class="refused-list w-full overflow-y-auto overscroll-contain rounded-md border border-neutral-500 bg-bgcolor p-2 shadow-lg"
                >
                    {@render refusalRows()}
                </div>
            {/if}
        {:else}
            <p class="font-semibold">{title}</p>
            {@render refusalRows()}
        {/if}
    </section>
{/if}

<style>
    .refused-banner {
        overflow-wrap: anywhere;
    }
    .chat-banner {
        position: relative;
        max-height: min(12rem, 24dvh);
        overflow-y: auto;
        overscroll-behavior: contain;
        border: 1px solid var(--color-neutral-500);
        background: var(--color-bgcolor);
        padding: 0.5rem;
    }
    .app-banner {
        position: fixed;
        top: max(0.5rem, env(safe-area-inset-top));
        left: max(6rem, calc(50% - 16rem));
        right: max(0.5rem, calc(50% - 16rem));
        z-index: 40;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        pointer-events: none;
    }
    .refused-toggle,
    .refused-list {
        pointer-events: auto;
    }
    .refused-list {
        max-height: min(16rem, 30dvh);
    }
    .refused-toggle {
        border-color: var(--color-neutral-500);
        border-radius: 9999px;
        background: var(--color-bgcolor);
        padding: 0.375rem 0.75rem;
    }
    button {
        border: 1px solid var(--color-borderc);
        border-radius: 0.25rem;
        background: var(--color-darkbutton);
        padding: 0.25rem 0.5rem;
    }
    button:hover:not(:disabled) {
        background: var(--color-selected);
    }
    button:disabled {
        opacity: 0.5;
        cursor: wait;
    }
</style>
