<script lang="ts">
    /**
     * Inline status box: an icon, an optional title, body text, and optional actions under the body.
     *
     * The status colors only the border, the tint, and the icon; the text stays `textcolor`, so it
     * reads on every theme. `role` defaults to a live region (`alert` for an error, `status` for the
     * rest), which suits a box that appears in answer to something. Pass `role="note"` for text that
     * is part of the page from the start.
     *
     * Dialogs still go through `src/ts/alert.ts`.
     */
    import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "@lucide/svelte";
    import type { Snippet } from "svelte";

    type AlertStatus = "info" | "warning" | "error" | "success" | "neutral";

    interface Props {
        status?: AlertStatus;
        title?: string;
        size?: "sm" | "md";
        showIcon?: boolean;
        role?: "alert" | "status" | "note";
        className?: string;
        children?: Snippet;
        actions?: Snippet;
    }

    let {
        status = "info",
        title = "",
        size = "md",
        showIcon = true,
        role,
        className = "",
        children,
        actions,
    }: Props = $props();

    // Whole class names, so Tailwind finds them in this file.
    const tones = {
        info: { box: "border-primary-500/50 bg-primary-500/10", icon: "text-primary-500", Icon: InfoIcon },
        warning: {
            box: "border-warning-500/50 bg-warning-500/10",
            icon: "text-warning-500",
            Icon: TriangleAlertIcon,
        },
        error: { box: "border-danger-500/50 bg-danger-500/10", icon: "text-danger-500", Icon: CircleAlertIcon },
        success: {
            box: "border-success-500/50 bg-success-500/10",
            icon: "text-success-500",
            Icon: CircleCheckIcon,
        },
        neutral: { box: "border-darkborderc", icon: "text-textcolor2", Icon: InfoIcon },
    } satisfies Record<AlertStatus, { box: string; icon: string; Icon: typeof InfoIcon }>;

    const tone = $derived(tones[status]);
</script>

<div
    class="flex items-start gap-2 rounded-md border text-textcolor {tone.box} {size === 'sm'
        ? 'p-2 text-xs'
        : 'p-3 text-sm'}{className ? ' ' + className : ''}"
    role={role ?? (status === "error" ? "alert" : "status")}
    data-risu-alert={status}
>
    {#if showIcon}
        <tone.Icon
            size={size === "sm" ? 14 : 16}
            class="shrink-0 {size === 'sm' ? 'mt-px' : 'mt-0.5'} {tone.icon}"
            aria-hidden="true"
        />
    {/if}
    <div class="flex min-w-0 grow flex-col gap-1 break-words">
        {#if title}
            <span class="font-semibold">{title}</span>
        {/if}
        {@render children?.()}
        {#if actions}
            <div class="mt-1 flex flex-wrap gap-2">
                {@render actions()}
            </div>
        {/if}
    </div>
</div>
