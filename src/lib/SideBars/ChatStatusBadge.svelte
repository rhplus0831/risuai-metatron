<script lang="ts">
    import {
        BrainIcon,
        HeartPulseIcon,
        LoaderCircleIcon,
        MailIcon,
        ShieldXIcon,
        TriangleAlertIcon,
    } from "@lucide/svelte";
    import type { MemoryHealthState } from "../../../shared/structuredMemory.ts";
    import { memoryCountText, type ChatStatus, type MemoryCount } from "./chatStatus";

    interface Props {
        status: ChatStatus;
        label: string;
        /** A memory status's count, shown as `k/n` instead of the icon; ignored for other statuses. */
        count?: MemoryCount | null;
        /** A health status's state: `customPrompt` is a notice and looks neutral; ignored for other statuses. */
        health?: MemoryHealthState | null;
        /** A chip in the flow with the label as text, in place of the corner dot over an avatar. */
        inline?: boolean;
    }

    let { status, label, count = null, health = null, inline = false }: Props = $props();
    const countText = $derived(status === "memory" && count ? memoryCountText(count) : null);
    const neutral = $derived(status === "refused" || (status === "health" && health === "customPrompt"));
</script>

{#snippet icon()}
    {#if status === "recovery"}
        <TriangleAlertIcon size={12} aria-hidden="true" />
    {:else if status === "refused"}
        <ShieldXIcon size={12} aria-hidden="true" />
    {:else if status === "generating"}
        <LoaderCircleIcon size={12} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    {:else if status === "memory"}
        {#if countText !== null}
            <span class="text-[10px] font-semibold leading-none" aria-hidden="true">{countText}</span>
        {:else}
            <BrainIcon size={12} aria-hidden="true" />
        {/if}
    {:else if status === "health"}
        <HeartPulseIcon size={12} aria-hidden="true" />
    {:else}
        <MailIcon size={12} aria-hidden="true" />
    {/if}
{/snippet}

{#if inline}
    <span
        class="inline-flex h-5 max-w-full min-w-0 select-none items-center gap-1 rounded-full border px-2 text-xs leading-none"
        class:border-danger-500={status === "recovery" || (status === "health" && !neutral)}
        class:text-danger-500={status === "recovery" || (status === "health" && !neutral)}
        class:border-darkborderc={neutral}
        class:text-textcolor2={neutral}
        class:border-primary-500={status === "generating"}
        class:text-primary-500={status === "generating"}
        class:border-secondary-500={status === "memory"}
        class:text-secondary-500={status === "memory"}
        class:border-success-500={status === "unseen"}
        class:text-success-500={status === "unseen"}
        role="status"
        data-risu-chat-status={status}
        data-risu-chat-health={status === "health" ? health : undefined}
    >
        {@render icon()}
        <span class="truncate">{label}</span>
    </span>
{:else}
    <span
        class="pointer-events-none absolute right-0 top-0 z-10 flex h-5 min-w-5 select-none items-center justify-center rounded-full border-2 border-bgcolor text-textcolor"
        class:w-5={countText === null}
        class:px-1={countText !== null}
        class:bg-danger-500={status === "recovery" || (status === "health" && !neutral)}
        class:bg-neutral-500={neutral}
        class:bg-primary-500={status === "generating"}
        class:bg-secondary-500={status === "memory"}
        class:bg-success-500={status === "unseen"}
        role="status"
        aria-label={label}
        data-risu-chat-status={status}
        data-risu-chat-health={status === "health" ? health : undefined}
    >
        {@render icon()}
    </span>
{/if}
