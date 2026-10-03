<script lang="ts">
    // Test-only (Phase 6 spike, proof 1): the Phase 3 function-binding wrapper over the real
    // `getSettingValue` / `setSettingValue`, on a plain `<input>`, run against the root facade.
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getSettingValue, setSettingValue } from "src/ts/setting/utils";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        id?: string;
    }

    let { item, ctx, id = undefined }: Props = $props();
</script>

<input {id} bind:value={() => getSettingValue(item, ctx), (v) => setSettingValue(item, v, ctx)} />
