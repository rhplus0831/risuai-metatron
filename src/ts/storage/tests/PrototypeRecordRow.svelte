<script lang="ts">
    // Test-only (the keyed-rows cases): one keyed row; `name` through a plain input,
    // `flag` through the real `CheckInput.svelte` (a nested `bind:check` on a `$bindable` prop).
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";

    interface Props {
        id: string;
        name?: string;
        flag?: boolean;
    }

    let { id, name = $bindable(), flag = $bindable() }: Props = $props();
</script>

<div data-row={id}>
    <input data-name bind:value={name} />
    <CheckInput bind:check={flag} name="flag" />
</div>
