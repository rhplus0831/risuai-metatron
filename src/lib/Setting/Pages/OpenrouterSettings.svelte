<script lang="ts">
    import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
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
        <Check bind:check={activePreset.useInstructPrompt} name={language.useInstructPrompt} />
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
            {#each activePreset.openrouterProvider.order as _, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={activePreset.openrouterProvider.order[i]}
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        let value = activePreset.openrouterProvider.order ?? [];
                        value.push("");
                        activePreset.openrouterProvider.order = value;
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        let value = activePreset.openrouterProvider.order ?? [];
                        value.pop();
                        activePreset.openrouterProvider.order = value;
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderOnly} help="openRouterProviderOnly" styled>
            {#each activePreset.openrouterProvider.only as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={activePreset.openrouterProvider.only[i]}
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        let value = activePreset.openrouterProvider.only ?? [];
                        value.push("");
                        activePreset.openrouterProvider.only = value;
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        let value = activePreset.openrouterProvider.only ?? [];
                        value.pop();
                        activePreset.openrouterProvider.only = value;
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderIgnore} help="openRouterProviderIgnore" styled>
            {#each activePreset.openrouterProvider.ignore as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={activePreset.openrouterProvider.ignore[i]}
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        let value = activePreset.openrouterProvider.ignore ?? [];
                        value.push("");
                        activePreset.openrouterProvider.ignore = value;
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        let value = activePreset.openrouterProvider.ignore ?? [];
                        value.pop();
                        activePreset.openrouterProvider.ignore = value;
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>
    {/await}

    {#if activePreset.useInstructPrompt}
        <ChatFormatSettings />
    {/if}
</Accordion>
