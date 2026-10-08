<script lang="ts">
    interface Props {
        value: string | number;
        selected?: boolean;
        disabled?: boolean;
        children?: import("svelte").Snippet;
    }

    let { value, selected = false, disabled = false, children }: Props = $props();
</script>

<option {value} {selected} {disabled} class="bg-darkbg appearance-none">{@render children?.()}</option>
