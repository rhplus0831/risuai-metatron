<script lang="ts">
    // Test-only: the function-binding wrapper pattern over `SelectInput`, keeping
    // `SettingSelect.svelte`'s hidden-option fallback (A16). The fallback is the one write that is
    // not a user edit: when the current value is not among the visible options, the last visible
    // option is written through `setSettingValue`, exactly as the current wrapper does through its
    // `localValue`. It reads the current value untracked, as the current wrapper does, so it
    // re-runs only when the visible options change, never on a selection switch. The registry calls
    // are the pre-slice-6 copies over `DBState.db` (`spikeRegistry.ts`), which reach the prototype.
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { candidateGetSettingValue, candidateSetSettingValue } from "./spikeRegistry";
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
        const currentValue = untrack(() => candidateGetSettingValue(item, ctx));
        if (
            processedOptions.length > 0 &&
            currentValue !== undefined &&
            !processedOptions.some((o) => o.value === currentValue)
        ) {
            candidateSetSettingValue(item, processedOptions[processedOptions.length - 1].value, ctx);
        }
    });
</script>

<SelectInput bind:value={() => candidateGetSettingValue(item, ctx), (v) => candidateSetSettingValue(item, v, ctx)}>
    {#each processedOptions as opt}
        <OptionInput value={opt.value}>{opt.label}</OptionInput>
    {/each}
</SelectInput>
