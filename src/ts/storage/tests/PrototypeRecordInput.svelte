<script lang="ts">
    // Test-only (the binding cases): a plain `bind:value` onto a field of a record wrapper, the way
    // the app's `bind:` sites bound a field of the removed aggregate.
    interface Props {
        record: any;
        field: string;
        id?: string;
    }

    let { record, field, id = undefined }: Props = $props();
</script>

<input {id} bind:value={record[field]} />
