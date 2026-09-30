<script lang="ts">
    // Test-only: the function-binding wrapper pattern over `SelectInput`, keeping
    // `SettingSelect.svelte`'s hidden-option fallback (A16). The fallback is the one write that is
    // not a user edit: when the current value is not among the visible options, the last visible
    // option is written through `setSettingValue`, exactly as the current wrapper does through its
    // `localValue`. It reads the current value untracked, as the current wrapper does, so it
    // re-runs only when the visible options change, never on a selection switch.
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getSettingValue, setSettingValue } from "src/ts/setting/utils";
    import { untrack } from "svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let processedOptions = $derived(
        (item.options?.selectOptions ?? []).filter((opt) => !opt.condition || opt.condition(ctx)),
    );

    $effect(() => {
        const currentValue = untrack(() => getSettingValue(item, ctx));
        if (
            processedOptions.length > 0 &&
            currentValue !== undefined &&
            !processedOptions.some((o) => o.value === currentValue)
        ) {
            setSettingValue(item, processedOptions[processedOptions.length - 1].value, ctx);
        }
    });
</script>

<SelectInput bind:value={() => getSettingValue(item, ctx), (v) => setSettingValue(item, v, ctx)}>
    {#each processedOptions as opt}
        <OptionInput value={opt.value}>{opt.label}</OptionInput>
    {/each}
</SelectInput>
