<script lang="ts">
    import type { triggerscript } from "src/ts/storage/database.svelte";
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { openURL } from "src/ts/globalApi.svelte";
    import { hubURL } from "src/ts/characterCards";
    import TriggerV2List from "./TriggerV2List.svelte";

    interface Props {
        value?: triggerscript[];
        lowLevelAble?: boolean;
    }

    let { value = $bindable([]), lowLevelAble = false }: Props = $props();
</script>

<div class="flex items-start mt-2 gap-2">
    <button
        class="bg-bgcolor py-1 rounded-md text-sm px-2"
        class:ring-1={value?.[0]?.effect?.[0]?.type === "v2Header"}
        onclick={async (e) => {
            e.stopPropagation();
            const codeType = value?.[0]?.effect?.[0]?.type;
            if (codeType !== "v2Header") {
                if (value && value.length > 0) {
                    const t = await alertConfirm(language.triggerSwitchWarn);
                    if (!t) {
                        return;
                    }
                }
                value = [
                    {
                        comment: "",
                        type: "manual",
                        conditions: [],
                        effect: [
                            {
                                type: "v2Header",
                                code: "",
                                indent: 0,
                            },
                        ],
                    },
                    {
                        comment: "New Event",
                        type: "manual",
                        conditions: [],
                        effect: [],
                    },
                ];
            }
        }}>V2</button
    >
    <button
        class="bg-bgcolor py-1 rounded-md text-sm px-2"
        class:ring-1={value?.[0]?.effect?.[0]?.type === "triggerlua"}
        onclick={async (e) => {
            e.stopPropagation();
            if (value?.[0]?.effect?.[0]?.type !== "triggerlua") {
                if (value && value.length > 0) {
                    const t = await alertConfirm(language.triggerSwitchWarn);
                    if (!t) {
                        return;
                    }
                }
                value = [
                    {
                        comment: "",
                        type: "start",
                        conditions: [],
                        effect: [
                            {
                                type: "triggerlua",
                                code: "",
                            },
                        ],
                    },
                ];
            }
        }}>Lua</button
    >
</div>
{#if value?.[0]?.effect?.[0]?.type === "triggerlua"}
    <TextAreaInput margin="both" autocomplete="off" bind:value={value[0].effect[0].code} popupLanguage="lua"
    ></TextAreaInput>
    <Button
        onclick={() => {
            openURL(hubURL + "/redirect/docs/lua");
        }}>{language.helpBlock}</Button
    >
{:else if value?.[0]?.effect?.[0]?.type === "v2Header"}
    <TriggerV2List bind:value {lowLevelAble} />
{:else if value && value.length > 0}
    <span class="text-draculared">{language.triggerLegacyUnsupported}</span>
{/if}
