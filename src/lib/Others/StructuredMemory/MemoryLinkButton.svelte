<script lang="ts">
    import type { HTMLButtonAttributes } from "svelte/elements";

    /**
     * Links to records and messages show `label` as plain text. Callers disable a link when its target
     * is gone; this component forwards that decision and the press handler without resolving the target.
     */

    interface Props extends Omit<HTMLButtonAttributes, "type" | "class" | "children"> {
        label: string;
    }

    let { label, ...attributes }: Props = $props();
</script>

<button
    {...attributes}
    type="button"
    class="max-w-full px-1.5 truncate transition-colors border rounded-sm border-darkborderc text-textcolor2 hover:text-textcolor disabled:opacity-50 disabled:cursor-not-allowed"
>
    {label}
</button>
