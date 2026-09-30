<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import ColorInput from "src/lib/UI/GUI/ColorInput.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();
</script>

<div class="flex items-center {item.classes ?? 'mt-2'}">
    <ColorInput
        bind:value={() => getSettingValue(item, ctx), (v) => updateSettingValue(item, v, ctx)}
        nullable={item.options?.nullable ?? false}
    />
    <span class="ml-2">{getLabel(item)}</span>
</div>
