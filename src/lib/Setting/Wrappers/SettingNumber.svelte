<script lang="ts">
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getLabel, getSettingValue, updateSettingValue } from "src/ts/setting/utils";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import Help from "src/lib/Others/Help.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    function commit(value: number) {
        if (!item.options?.clampOnCommit) return;
        const { min, max, clampOnCommit } = item.options;
        if (!Number.isFinite(value)) {
            updateSettingValue(item, clampOnCommit.defaultValue, ctx);
        } else if (min !== undefined && max !== undefined) {
            const whole = clampOnCommit.wholeNumber ? Math.floor(value) : value;
            updateSettingValue(item, Math.min(max, Math.max(min, whole)), ctx);
        }
    }
</script>

<span class="text-textcolor {item.classes ?? ''}">
    {getLabel(item)}
    {#if item.helpKey}<Help key={item.helpKey as any} />{/if}
</span>
<NumberInput
    marginBottom={false}
    size="sm"
    min={item.options?.min}
    max={item.options?.max}
    bind:value={
        () => getSettingValue(item, ctx),
        (value) => {
            if (!item.options?.clampOnCommit || Number.isFinite(value)) {
                updateSettingValue(item, value, ctx);
            }
        }
    }
    onChange={(event) => commit(event.currentTarget.valueAsNumber)}
/>
