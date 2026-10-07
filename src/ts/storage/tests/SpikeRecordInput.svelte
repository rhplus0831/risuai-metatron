<script lang="ts">
    // Test-only (Phase 6 spike, proof 1): a plain `bind:value` onto a field of a record wrapper,
    // the way the 394 `bind:` sites bound a field of the removed aggregate at the time of the spike.
    interface Props {
        record: any;
        field: string;
        id?: string;
    }

    let { record, field, id = undefined }: Props = $props();
</script>

<input {id} bind:value={record[field]} />
