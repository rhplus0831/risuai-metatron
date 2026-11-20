<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import ColorInput from "src/lib/UI/GUI/ColorInput.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        /** True when `SettingRenderer`'s spacing rule sets this item's top margin; the default one is then left out. */
        itemSpacing?: boolean;
    }

    let { item, ctx, itemSpacing = false }: Props = $props();
</script>

<div class="flex items-center {item.classes ?? (itemSpacing ? '' : 'mt-2')}">
    <ColorInput
        bind:value={() => getSettingValue(item, ctx), (v) => updateSettingValue(item, v, ctx)}
        nullable={item.options?.nullable ?? false}
    />
    <span class="ml-2">{getLabel(item)}</span>
</div>
