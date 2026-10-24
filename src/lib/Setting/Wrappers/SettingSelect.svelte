<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, setSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import { untrack } from "svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { language } from "src/lang";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    // Process options to support labelKey translation and conditional rendering
    let processedOptions = $derived(
        (item.options?.selectOptions ?? []).filter((opt) => !opt.condition || opt.condition(ctx)),
    );

    let visibleValues = $derived(JSON.stringify(processedOptions.map((o) => o.value)));

    // Only visible values trigger a reset; rebuilding the context with equal options keeps the stored value.
    $effect(() => {
        void visibleValues;
        untrack(() => {
            const currentValue = getSettingValue(item, ctx);
            if (
                processedOptions.length > 0 &&
                currentValue !== undefined &&
                !processedOptions.some((o) => o.value === currentValue)
            ) {
                const fallback = processedOptions[processedOptions.length - 1].value;
                setSettingValue(item, fallback, ctx);
            }
        });
    });
</script>

<span class="text-textcolor {item.classes ?? 'mt-4'}">
    {getLabel(item)}
    {#if item.helpKey}<Help key={item.helpKey as any} />{/if}
</span>
<SelectInput bind:value={() => getSettingValue(item, ctx), (v) => updateSettingValue(item, v, ctx)}>
    {#each processedOptions as opt}
        <OptionInput value={opt.value}>
            {opt.labelKey ? (language as any)[opt.labelKey] : opt.label}
        </OptionInput>
    {/each}
</SelectInput>
