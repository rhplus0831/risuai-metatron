<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();
</script>

<div class="flex items-center {item.classes ?? 'mt-2'}">
    <Check bind:check={() => getSettingValue(item, ctx), (v) => updateSettingValue(item, v, ctx)} name={getLabel(item)}>
        {#if item.showExperimental}<Help key="experimental" />{/if}
        {#if item.helpKey}<Help key={item.helpKey as any} unrecommended={item.helpUnrecommended ?? false} />{/if}
    </Check>
</div>
