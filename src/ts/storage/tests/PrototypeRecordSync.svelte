<script lang="ts">
    // Test-only (the binding cases): the function-binding wrapper over the registry's resolution, on
    // a plain `<input>`, run against the root facade. The real registry reads the record views, so
    // this binds through the older registry copy over the prototype root holder
    // (`prototypeRegistry.ts`).
    import type { SettingItem, SettingContext } from "src/ts/setting/types";
    import { candidateGetSettingValue, candidateSetSettingValue } from "./prototypeRegistry";

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
        id?: string;
    }

    let { item, ctx, id = undefined }: Props = $props();
</script>

<input {id} bind:value={() => candidateGetSettingValue(item, ctx), (v) => candidateSetSettingValue(item, v, ctx)} />
