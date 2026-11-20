<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import Help from "src/lib/Others/Help.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        /** True when `SettingRenderer`'s spacing rule sets the control's bottom margin; its own is then left out. */
        itemSpacing?: boolean;
    }

    let { item, ctx, itemSpacing = false }: Props = $props();
</script>

<span class="text-textcolor {item.classes ?? ''}">
    {getLabel(item)}
    {#if item.helpKey}<Help key={item.helpKey as any} />{/if}
</span>
<TextInput
    marginBottom={!itemSpacing}
    size="sm"
    bind:value={() => getSettingValue(item, ctx), (v) => updateSettingValue(item, v, ctx)}
    placeholder={item.options?.placeholder}
    hideText={item.options?.hideText}
    secret={item.options?.secret}
/>
