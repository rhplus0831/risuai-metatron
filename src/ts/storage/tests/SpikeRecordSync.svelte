<script lang="ts">
    // Test-only (Phase 6 spike, proof 1): the Phase 3 function-binding wrapper over the registry's
    // resolution, on a plain `<input>`, run against the root facade. Since Phase 6 slice 6 the real
    // registry reads the record views, so this binds through the pre-slice-6 copy over the spike's
    // root holder (`spikeRegistry.ts`).
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { candidateGetSettingValue, candidateSetSettingValue } from "./spikeRegistry";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        id?: string;
    }

    let { item, ctx, id = undefined }: Props = $props();
</script>

<input {id} bind:value={() => candidateGetSettingValue(item, ctx), (v) => candidateSetSettingValue(item, v, ctx)} />
