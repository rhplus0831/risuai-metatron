<script lang="ts">
    import type { MemoryPanelTabProps } from "src/ts/process/structuredMemory.svelte";
    import PagesTab from "./PagesTab.svelte";

    let props: MemoryPanelTabProps = $props();
</script>

<PagesTab {...props} only="unsupported" />
