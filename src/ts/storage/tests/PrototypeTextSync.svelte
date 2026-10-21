<script lang="ts">
    // Test-only: the function-binding wrapper pattern over `TextInput` (the binding cases: a top-level
    // and a nested `bindPath` key, and the persona fields), through the older registry copy over the
    // prototype root holder (`prototypeRegistry.ts`), which reaches the prototype.
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { candidateGetSettingValue, candidateSetSettingValue } from "./prototypeRegistry";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        id?: string;
    }

    let { item, ctx, id = undefined }: Props = $props();
</script>

<TextInput {id} bind:value={() => candidateGetSettingValue(item, ctx), (v) => candidateSetSettingValue(item, v, ctx)} />
