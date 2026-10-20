<script lang="ts">
    import type { SettingContext, SettingSection } from "src/ts/setting/types";
    import { getModelInfoForMode } from "src/ts/model/modellist";
    import { languageText, sectionHasVisibleItems, settingContext } from "src/ts/setting/utils";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import SettingRenderer from "./SettingRenderer.svelte";
    import { currentJump } from "src/ts/setting/settingJump.svelte";

    interface Props {
        sections: SettingSection[];
    }

    let { sections }: Props = $props();
    const uid = $props.id();

    // The same context `SettingRenderer` builds, so a section whose items all hide renders nothing.
    let modelInfo = $derived(getModelInfoForMode("model"));
    let subModelInfo = $derived(getModelInfoForMode("submodel"));
    let ctx: SettingContext = $derived(settingContext({ modelInfo, subModelInfo }));
    // Capture the jump at mount; an Accordion starts open only while that jump is still pending,
    // so a later tab round trip cannot reopen its section after the jump finishes.
    const jump = currentJump();
    const openSectionId = jump?.available ? jump.sectionId : undefined;
</script>

{#each sections as section (section.id)}
    {#if sectionHasVisibleItems(section, ctx)}
        {@const label = languageText(section.labelKey)}
        {@const description = languageText(section.descriptionKey)}
        {@const badge = languageText(section.badgeKey)}
        {#if section.collapsible}
            <div class="mt-4 flex flex-col" data-settings-section={section.id}>
                <Accordion
                    styled
                    name={label}
                    {badge}
                    startOpen={section.id === openSectionId && currentJump()?.version === jump?.version}
                >
                    {#if description}
                        <p class="mt-1 text-sm text-textcolor2">{description}</p>
                    {/if}
                    <SettingRenderer items={section.items} {modelInfo} {subModelInfo} />
                </Accordion>
            </div>
        {:else}
            <section class="mt-6 flex flex-col" aria-labelledby="{uid}-{section.id}" data-settings-section={section.id}>
                <div class="flex flex-wrap items-center gap-2">
                    <h3 id="{uid}-{section.id}" class="text-lg font-semibold text-textcolor">{label}</h3>
                    {#if badge}
                        <span class="rounded-full border border-darkborderc px-2 py-0.5 text-xs text-textcolor2"
                            >{badge}</span
                        >
                    {/if}
                </div>
                {#if description}
                    <p class="mt-1 text-sm text-textcolor2">{description}</p>
                {/if}
                <SettingRenderer items={section.items} {modelInfo} {subModelInfo} />
            </section>
        {/if}
    {/if}
{/each}
