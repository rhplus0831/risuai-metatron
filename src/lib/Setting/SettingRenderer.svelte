<script lang="ts">
    import { editedScope, type ModelProfileView } from "src/ts/storage/settingsViews.svelte";
    import type { SettingItem, SettingContext, SettingType } from "src/ts/setting/types";
    import type { LLMModel } from "src/ts/model/types";
    import { getModelInfoForMode } from "src/ts/model/modellist";
    import { settingRegistry } from "src/ts/setting/settingRegistry";
    import { checkCondition, settingContext } from "src/ts/setting/utils";

    /**
     * Registry renderer: `src/ts/setting/utils.ts`'s `settingContext` uses the live views and supplied
     * model info, or main/sub slot info from `src/ts/model/modellist.ts`. Rows passing `checkCondition`
     * use `settingRegistry[item.type]`, keyed by id. Their `data-setting-id` anchor is `display: contents`;
     * search highlights its first boxed child (`src/ts/setting/settingJump.svelte.ts`).
     */

    interface Props {
        items: SettingItem[];
        /** An explicit editor target; omitted pages use the main slot's profile. */
        modelProfile?: ModelProfileView;
        /** Optional modelInfo, derived automatically if not provided */
        modelInfo?: LLMModel;
        /** Optional subModelInfo, derived automatically if not provided */
        subModelInfo?: LLMModel;
        /**
         * Spaces the items by the rule in this file's style block: each anchor names its item's kind, and
         * the row and field wrappers leave their own outer margins out. Without it the anchors carry no
         * kind and every wrapper keeps its default margins.
         */
        itemSpacing?: boolean;
    }

    let { items, modelInfo, subModelInfo, modelProfile, itemSpacing = false }: Props = $props();

    /**
     * What an item is to the spacing rule: a row is one line with its label beside the control, a field
     * is a label above its control, and a block keeps the margins of its own wrapper or component.
     */
    const spacingKinds: Record<SettingType, "row" | "field" | "block"> = {
        check: "row",
        color: "row",
        number: "field",
        slider: "field",
        text: "field",
        select: "field",
        segmented: "field",
        textarea: "field",
        header: "block",
        button: "block",
        accordion: "block",
        custom: "block",
    };

    // Derive modelInfo if not provided
    let effectiveModelInfo = $derived(modelInfo ?? getModelInfoForMode("model", editedScope()));
    let effectiveSubModelInfo = $derived(subModelInfo ?? getModelInfoForMode("submodel", editedScope()));

    // Build context for condition checks
    let ctx: SettingContext = $derived(
        settingContext({ modelProfile, modelInfo: effectiveModelInfo, subModelInfo: effectiveSubModelInfo }),
    );
</script>

{#each items as item (item.id)}
    {#if checkCondition(item, ctx)}
        {@const Component = settingRegistry[item.type]}
        <!-- The search jump's anchor (`settingJump.svelte.ts`): no box of its own, so no layout change. -->
        <div
            class="contents"
            data-setting-id={item.id}
            data-spacing-kind={itemSpacing ? spacingKinds[item.type] : undefined}
        >
            {#if Component}
                <Component {item} {ctx} {itemSpacing} />
            {:else}
                <div class="text-draculared text-xs mt-2">Unknown setting type: {item.type}</div>
            {/if}
        </div>
    {/if}
{/each}

<style>
    /*
     * The space between two items follows from their kinds (`spacingKinds`), measured between their
     * boxes; a field's box runs from its label's top to its control's bottom. Rows are 0.5rem apart. A
     * field has 1rem on each side, which does not add up with a neighbour's: field after row, row after
     * field, and field after field are 1rem each, and a field that ends a run keeps the 1rem below it.
     * The first row or field of a run is 0.5rem below what precedes it; after a block or a handwritten
     * element, that element's own bottom margin adds to the 0.5rem. Nothing is set on a block.
     *
     * The margins assume a flex column parent, where they add and never collapse. The anchors are
     * `display: contents`, so they stay siblings and `+` pairs two items of one run. An item's elements
     * belong to its wrapper, so the child is named inside `:global(...)`: a scoped child selector
     * would match nothing. The rule is unlayered, so it wins over a Tailwind utility on the same
     * element (a wrapper's or an item's `classes`), except a `!` one.
     */
    [data-spacing-kind="row"] > :global(:first-child),
    [data-spacing-kind="field"] > :global(:first-child) {
        margin-top: 0.5rem;
    }

    [data-spacing-kind="row"] + [data-spacing-kind="field"] > :global(:first-child) {
        margin-top: 1rem;
    }

    /* The field before already ends with 1rem. */
    [data-spacing-kind="field"] + [data-spacing-kind="row"] > :global(:first-child),
    [data-spacing-kind="field"] + [data-spacing-kind="field"] > :global(:first-child) {
        margin-top: 0;
    }

    [data-spacing-kind="field"] > :global(:last-child) {
        margin-bottom: 1rem;
    }
</style>
