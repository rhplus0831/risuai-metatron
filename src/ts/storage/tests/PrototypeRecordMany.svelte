<script lang="ts">
    // Test-only (the cost cases): one `bind:value` per field of a record wrapper (60 in the
    // cost measurement), for the mount and re-render measurements.
    interface Props {
        record: any;
        fields: string[];
    }

    let { record, fields }: Props = $props();
</script>

{#each fields as field (field)}
    <input data-field={field} bind:value={record[field]} />
{/each}
