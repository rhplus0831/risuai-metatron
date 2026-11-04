<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, setSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import { untrack } from "svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { language } from "src/lang";

    /**
     * At mount and when visible option values change, a defined value missing from nonempty options
     * is replaced by the last visible option. Value reads/writes are untracked, so while mounted a
     * preset switch with the same options keeps even a hidden value.
     * An option's `labelKey` has no label fallback; missing translations rely on `src/lang/index.ts`'s merge.
     */

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

    // Runs at mount and when visible values change; an equal context rebuild keeps the stored value.
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
