<script lang="ts">
    // Test-only (the keyed-rows cases): a keyed list of records (as
    // `CustomModelsSettings.svelte` renders `customModels`), each row a child component bound to
    // the item's fields through `$bindable` props.
    import PrototypeRecordRow from "./PrototypeRecordRow.svelte";

    interface Props {
        list: any[];
    }

    let { list }: Props = $props();
</script>

{#each list as item (item.id)}
    <PrototypeRecordRow id={item.id} bind:name={item.name} bind:flag={item.seperateParametersEnabled} />
{/each}
