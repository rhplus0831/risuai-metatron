<script lang="ts">
    // Test-only (Phase 6 spike, round 2, point 5): a keyed list of records (as
    // `CustomModelsSettings.svelte` renders `customModels`), each row a child component bound to
    // the item's fields through `$bindable` props.
    import SpikeRecordRow from "./SpikeRecordRow.svelte";

    interface Props {
        list: any[];
    }

    let { list }: Props = $props();
</script>

{#each list as item (item.id)}
    <SpikeRecordRow id={item.id} bind:name={item.name} bind:flag={item.useInstructPrompt} />
{/each}
