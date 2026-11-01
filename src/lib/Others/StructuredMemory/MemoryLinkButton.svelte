<script lang="ts">
    import type { HTMLButtonAttributes } from "svelte/elements";

    // A small button that leads somewhere else: to an event, a page, or a message. It is off when what it
    // names is gone, and shows `label` as plain text.

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
