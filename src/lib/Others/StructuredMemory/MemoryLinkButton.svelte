<script lang="ts">
    import type { HTMLButtonAttributes } from "svelte/elements";

    /**
     * Links to records and messages show `label` as plain text. Callers disable a link when its target
     * is gone; this component forwards that decision and the press handler without resolving the target.
     * `quiet` is for a link inside text that is read, where a box per link would outweigh the text: it
     * takes the line's color and size and marks itself with a dotted underline.
     */

    interface Props extends Omit<HTMLButtonAttributes, "type" | "class" | "children"> {
        label: string;
        quiet?: boolean;
    }

    let { label, quiet = false, ...attributes }: Props = $props();
</script>

<button
    {...attributes}
    type="button"
    class={quiet
        ? "max-w-full truncate text-left underline decoration-dotted decoration-textcolor2 underline-offset-4 transition-colors enabled:hover:text-textcolor disabled:no-underline disabled:opacity-50 disabled:cursor-not-allowed"
        : "max-w-full px-1.5 truncate transition-colors border rounded-sm border-darkborderc text-textcolor2 hover:text-textcolor disabled:opacity-50 disabled:cursor-not-allowed"}
>
    {label}
</button>
