<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { updateTextThemeAndCSS } from "src/ts/gui/colorscheme";
    import ColorInput from "src/lib/UI/GUI/ColorInput.svelte";

    const colors = [
        ["FontColorStandard", "Normal Text", false],
        ["FontColorItalic", "Italic Text", false],
        ["FontColorBold", "Bold Text", false],
        ["FontColorItalicBold", "Italic Bold Text", false],
        ["FontColorQuote1", "Single Quote Text", true],
        ["FontColorQuote2", "Double Quote Text", true],
    ] as const;
</script>

<!--
    The rows stand 1rem from the field on each side in Display's Colors & typography section: the text
    color select above ends with its own 1rem, and the last row's 0.5rem adds to the 0.5rem above the
    font select's label.
-->
{#if settings.ui.textTheme === "custom"}
    {#each colors as color, index}
        <div class="flex items-center" class:mt-2={index > 0} class:mb-2={index === colors.length - 1}>
            <ColorInput
                nullable={color[2]}
                bind:value={settings.ui.customTextTheme[color[0]]}
                oninput={updateTextThemeAndCSS}
            />
            <span class="ml-2">{color[1]}</span>
        </div>
    {/each}
{/if}
