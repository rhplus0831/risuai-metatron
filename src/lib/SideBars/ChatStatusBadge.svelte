<script lang="ts">
    import { BrainIcon, LoaderCircleIcon, MailIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { memoryCountText, type ChatStatus, type MemoryCount } from "./chatStatus";

    interface Props {
        status: ChatStatus;
        label: string;
        /** A memory status's count, shown as `k/n` instead of the icon; ignored for other statuses. */
        count?: MemoryCount | null;
    }

    let { status, label, count = null }: Props = $props();
    const countText = $derived(status === "memory" && count ? memoryCountText(count) : null);
</script>

<span
    class="pointer-events-none absolute right-0 top-0 z-10 flex h-5 min-w-5 select-none items-center justify-center rounded-full border-2 border-bgcolor text-textcolor"
    class:w-5={countText === null}
    class:px-1={countText !== null}
    class:bg-danger-500={status === "recovery"}
    class:bg-primary-500={status === "generating"}
    class:bg-secondary-500={status === "memory"}
    class:bg-success-500={status === "unseen"}
    role="status"
    aria-label={label}
    data-risu-chat-status={status}
>
    {#if status === "recovery"}
        <TriangleAlertIcon size={12} aria-hidden="true" />
    {:else if status === "generating"}
        <LoaderCircleIcon size={12} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    {:else if status === "memory"}
        {#if countText !== null}
            <span class="text-[10px] font-semibold leading-none" aria-hidden="true">{countText}</span>
        {:else}
            <BrainIcon size={12} aria-hidden="true" />
        {/if}
    {:else}
        <MailIcon size={12} aria-hidden="true" />
    {/if}
</span>
