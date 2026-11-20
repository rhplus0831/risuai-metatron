<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import Help from "src/lib/Others/Help.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        /** True when `SettingRenderer`'s spacing rule sets the control's bottom margin; its own is then left out. */
        itemSpacing?: boolean;
    }

    let { item, ctx, itemSpacing = false }: Props = $props();

    let customText = $derived(
        typeof item.options?.customText === "function"
            ? item.options.customText(getSettingValue(item, ctx))
            : item.options?.customText,
    );
</script>

<span class="text-textcolor {item.classes ?? ''}">
    {getLabel(item)}
    {#if item.helpKey}<Help key={item.helpKey as any} />{/if}
</span>
<SliderInput
    marginBottom={!itemSpacing}
    min={item.options?.min}
    max={item.options?.max}
    step={item.options?.step}
    fixed={item.options?.fixed}
    multiple={item.options?.multiple}
    disableable={item.options?.disableable}
    {customText}
    bind:value={() => getSettingValue(item, ctx), (v) => updateSettingValue(item, v, ctx)}
/>
