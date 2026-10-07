<script lang="ts">
    // Test-only: the replacement wrapper pattern from the spike (proof 4). No local copy and no
    // effects: a function binding reads through `getSettingValue` on every render and writes
    // synchronously through `setSettingValue`, which calls `item.onChange` once per user edit. Both
    // are the pre-slice-6 copies over the spike's root holder (`spikeRegistry.ts`), which reach the prototype.
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { candidateGetSettingValue, candidateSetSettingValue } from "./spikeRegistry";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        id?: string;
    }

    let { item, ctx, id = undefined }: Props = $props();
</script>

<NumberInput
    {id}
    size="sm"
    min={item.options?.min}
    max={item.options?.max}
    bind:value={() => candidateGetSettingValue(item, ctx), (v) => candidateSetSettingValue(item, v, ctx)}
/>
