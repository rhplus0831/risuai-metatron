<script lang="ts">
    // Test-only (Phase 6 spike, proof 5): one `bind:value` per field of a record wrapper (60 in the
    // cost proof), for the mount and re-render measurements.
    interface Props {
        record: any;
        fields: string[];
    }

    let { record, fields }: Props = $props();
</script>

{#each fields as field (field)}
    <input data-field={field} bind:value={record[field]} />
{/each}
