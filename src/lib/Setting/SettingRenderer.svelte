<script lang="ts">
    import type { ModelProfileView } from "src/ts/storage/settingsViews.svelte";
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import type { LLMModel } from "src/ts/model/types";
    import { getModelInfoForMode } from "src/ts/model/modellist";
    import { settingRegistry } from "src/ts/setting/settingRegistry";
    import { checkCondition, settingContext } from "src/ts/setting/utils";

    interface Props {
        items: SettingItem[];
        /** An explicit editor target; omitted pages use the main slot's profile. */
        modelProfile?: ModelProfileView;
        /** Optional modelInfo, derived automatically if not provided */
        modelInfo?: LLMModel;
        /** Optional subModelInfo, derived automatically if not provided */
        subModelInfo?: LLMModel;
    }

    let { items, modelInfo, subModelInfo, modelProfile }: Props = $props();

    // Derive modelInfo if not provided
    let effectiveModelInfo = $derived(modelInfo ?? getModelInfoForMode("model"));
    let effectiveSubModelInfo = $derived(subModelInfo ?? getModelInfoForMode("submodel"));

    // Build context for condition checks
    let ctx: SettingContext = $derived(
        settingContext({ modelProfile, modelInfo: effectiveModelInfo, subModelInfo: effectiveSubModelInfo }),
    );
</script>

{#each items as item (item.id)}
    {#if checkCondition(item, ctx)}
        {@const Component = settingRegistry[item.type]}
        {#if Component}
            <Component {item} {ctx} />
        {:else}
            <div class="text-draculared text-xs mt-2">Unknown setting type: {item.type}</div>
        {/if}
    {/if}
{/each}
