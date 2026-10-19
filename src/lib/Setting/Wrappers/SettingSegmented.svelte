<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, setSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { language } from "src/lang";
    import { untrack } from "svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    // Transform options: filter by condition + resolve labelKey translations
    let processedOptions = $derived(
        (item.options?.segmentOptions ?? [])
            .filter((opt) => !opt.condition || opt.condition(ctx))
            .map((opt) => ({
                value: opt.value,
                label: opt.labelKey ? ((language as any)[opt.labelKey] ?? opt.label ?? "") : (opt.label ?? ""),
            })),
    );

    // The visible option values as one string: a rebuilt context (a fresh model info after a switch)
    // that shows the same options leaves it equal, so the reset below does not run again.
    let visibleValues = $derived(JSON.stringify(processedOptions.map((o) => o.value)));

    // Reset value if current selection becomes hidden. Only the visible values are tracked; the value is
    // read untracked, as in `SettingSelect`, so this runs when the visible options change, never on a
    // switch of the selected preset alone (a preset holding a hidden option keeps its value).
    $effect(() => {
        void visibleValues;
        untrack(() => {
            const currentVal = getSettingValue(item, ctx);
            if (
                processedOptions.length > 0 &&
                currentVal !== undefined &&
                !processedOptions.some((o) => o.value === currentVal)
            ) {
                const numericOptions = processedOptions.filter(
                    (o): o is { value: number; label: string } => typeof o.value === "number",
                );
                const fallback =
                    typeof currentVal === "number" && numericOptions.length > 0
                        ? numericOptions.reduce((closest, option) =>
                              Math.abs(option.value - currentVal) < Math.abs(closest.value - currentVal)
                                  ? option
                                  : closest,
                          ).value
                        : processedOptions[processedOptions.length - 1].value;
                setSettingValue(item, fallback, ctx);
            }
        });
    });
</script>

<span class="text-textcolor {item.classes ?? ''}">
    {getLabel(item)}
    {#if item.showExperimental}<Help key="experimental" />{/if}
    {#if item.helpKey}<Help key={item.helpKey as any} unrecommended={item.helpUnrecommended ?? false} />{/if}
</span>
<SegmentedControl
    bind:value={() => getSettingValue(item, ctx), (value) => updateSettingValue(item, value, ctx)}
    options={processedOptions}
/>
