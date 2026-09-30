<script lang="ts">
    // Test-only: the function-binding wrapper pattern over `TextInput` (proof 1: a top-level and a
    // nested `bindPath` key, and the persona fields).
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { getSettingValue, setSettingValue } from "src/ts/setting/utils";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        id?: string;
    }

    let { item, ctx, id = undefined }: Props = $props();
</script>

<TextInput {id} bind:value={() => getSettingValue(item, ctx), (v) => setSettingValue(item, v, ctx)} />
