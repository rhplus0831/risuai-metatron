<script lang="ts">
    import { language } from "src/lang";
    import { readEditedRoot, writeEditedRoot } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";

    interface Props {
        field: "textScreenColor" | "textScreenBorder";
        labelKey: "textBackgrounds" | "textScreenBorder";
        defaultColor: string;
    }

    let { field, labelKey, defaultColor }: Props = $props();
    let currentValue = $derived(readEditedRoot(field) as string | null | undefined);
</script>

{#if currentValue}
    <div class="flex items-center mt-2">
        <Check
            check={true}
            onChange={() => {
                writeEditedRoot(field, null);
            }}
            name={language[labelKey]}
            hiddenName
        />
        <input
            type="color"
            class="style2 text-sm mr-2"
            value={currentValue}
            oninput={(e) => {
                writeEditedRoot(field, e.currentTarget.value);
            }}
        />
        <span>{language[labelKey]}</span>
    </div>
{:else}
    <div class="flex items-center mt-2">
        <Check
            check={false}
            onChange={() => {
                writeEditedRoot(field, defaultColor);
            }}
            name={language[labelKey]}
        />
    </div>
{/if}
