<script lang="ts">
    import { LoaderCircleIcon, MailIcon, TriangleAlertIcon } from "@lucide/svelte";
    import type { ChatStatus } from "./chatStatus";

    interface Props {
        status: ChatStatus;
        label: string;
    }

    let { status, label }: Props = $props();
</script>

<span
    class="pointer-events-none absolute right-0 top-0 z-10 flex h-5 w-5 select-none items-center justify-center rounded-full border-2 border-bgcolor text-textcolor"
    class:bg-danger-500={status === "recovery"}
    class:bg-primary-500={status === "generating"}
    class:bg-success-500={status === "unseen"}
    role="status"
    aria-label={label}
    data-risu-chat-status={status}
>
    {#if status === "recovery"}
        <TriangleAlertIcon size={12} aria-hidden="true" />
    {:else if status === "generating"}
        <LoaderCircleIcon size={12} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    {:else}
        <MailIcon size={12} aria-hidden="true" />
    {/if}
</span>
