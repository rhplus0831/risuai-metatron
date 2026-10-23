<script lang="ts">
    import { TrashIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { removeBlockedRealmCreator } from "src/ts/realmBlocking";
    import { settings } from "src/ts/storage/settingsViews.svelte";

    interface Props {
        onClose: () => void;
        onUnblock: () => void | Promise<void>;
    }

    let { onClose, onUnblock }: Props = $props();
    let creators = $derived(settings.ui.blockedRealmCreators ?? []);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
    class="top-0 left-0 z-50 fixed w-full h-full bg-black/50 flex justify-center items-center text-textcolor"
    role="button"
    tabindex="0"
    onclick={onClose}
>
    <div
        class="flex max-h-full w-xl max-w-full flex-col gap-4 overflow-y-auto rounded-md bg-darkbg p-6"
        role="presentation"
        onclick={(e) => e.stopPropagation()}
    >
        <div class="flex items-center justify-between gap-4">
            <h1 class="text-2xl font-bold">{language.blockedRealmCreators}</h1>
            <button
                class="text-textcolor2 hover:text-textcolor"
                onclick={onClose}
                aria-label={language.chatBinding.close}
            >
                <XIcon />
            </button>
        </div>

        {#if creators.length === 0}
            <p class="text-textcolor2">{language.noBlockedRealmCreators}</p>
        {:else}
            <div class="flex flex-col gap-2">
                {#each creators as creator (creator.id)}
                    <div class="flex items-center gap-3 rounded-md border border-darkborderc p-3">
                        <div class="min-w-0 grow">
                            <div class="truncate font-bold">{creator.name}</div>
                            <div class="truncate text-xs text-textcolor2">{creator.id}</div>
                        </div>
                        <button
                            class="flex items-center gap-2 rounded-md bg-selected p-2 hover:ring-3"
                            onclick={async () => {
                                settings.ui.blockedRealmCreators = removeBlockedRealmCreator(
                                    settings.ui.blockedRealmCreators ?? [],
                                    creator.id,
                                );
                                await onUnblock();
                            }}
                        >
                            <TrashIcon size={18} />
                            <span>{language.unblockRealmCreator}</span>
                        </button>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
</div>
