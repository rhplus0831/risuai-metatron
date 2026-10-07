<script lang="ts">
    import { activeModelPreset, settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";

    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    import OpenrouterProviderList from "src/lib/UI/OpenrouterProviderList.svelte";
    import { PlusIcon, TrashIcon } from "@lucide/svelte";
    import { getOpenRouterProviders } from "src/ts/model/openrouter";
</script>

<Accordion name={`OpenRouter ${language.settings}`} styled>
    <div class="flex items-center mb-4">
        <Check bind:check={settings.providers.openrouterFallback} name={language.openRouterFallback} />
    </div>
    <div class="flex items-center mb-4">
        <Check bind:check={settings.providers.openrouterMiddleOut} name={language.openRouterMiddleOut} />
    </div>
    <div class="flex items-center mb-4">
        <Check bind:check={activeModelPreset.useInstructPrompt} name={language.useInstructPrompt} />
    </div>
    {#await getOpenRouterProviders()}
        <Accordion name={language.openRouterProviderOrder} help="openRouterProviderOrder" styled>
            <p>{language.loading}...</p>
        </Accordion>
        <Accordion name={language.openRouterProviderOnly} help="openRouterProviderOnly" styled>
            <p>{language.loading}...</p>
        </Accordion>
        <Accordion name={language.openRouterProviderIgnore} help="openRouterProviderIgnore" styled>
            <p>{language.loading}...</p>
        </Accordion>
    {:then openRouterProviders}
        <Accordion name={language.openRouterProviderOrder} help="openRouterProviderOrder" styled>
            {#each activeModelPreset.openrouterProvider.order as _, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={activeModelPreset.openrouterProvider.order[i]}
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        let value = activeModelPreset.openrouterProvider.order ?? [];
                        value.push("");
                        activeModelPreset.openrouterProvider.order = value;
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        let value = activeModelPreset.openrouterProvider.order ?? [];
                        value.pop();
                        activeModelPreset.openrouterProvider.order = value;
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderOnly} help="openRouterProviderOnly" styled>
            {#each activeModelPreset.openrouterProvider.only as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={activeModelPreset.openrouterProvider.only[i]}
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        let value = activeModelPreset.openrouterProvider.only ?? [];
                        value.push("");
                        activeModelPreset.openrouterProvider.only = value;
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        let value = activeModelPreset.openrouterProvider.only ?? [];
                        value.pop();
                        activeModelPreset.openrouterProvider.only = value;
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderIgnore} help="openRouterProviderIgnore" styled>
            {#each activeModelPreset.openrouterProvider.ignore as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={activeModelPreset.openrouterProvider.ignore[i]}
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        let value = activeModelPreset.openrouterProvider.ignore ?? [];
                        value.push("");
                        activeModelPreset.openrouterProvider.ignore = value;
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        let value = activeModelPreset.openrouterProvider.ignore ?? [];
                        value.pop();
                        activeModelPreset.openrouterProvider.ignore = value;
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>
    {/await}

    {#if activeModelPreset.useInstructPrompt}
        <ChatFormatSettings />
    {/if}
</Accordion>
