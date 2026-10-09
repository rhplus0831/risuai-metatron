<script lang="ts">
    import { activeMainProfile, settings, type ModelProfileView } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";

    import OpenrouterProviderList from "src/lib/UI/OpenrouterProviderList.svelte";
    import { PlusIcon, TrashIcon } from "@lucide/svelte";
    import { getOpenRouterProviders } from "src/ts/model/openrouter";

    interface Props {
        profile?: ModelProfileView;
    }
    let { profile = activeMainProfile }: Props = $props();
    const provider = $derived(profile.openrouterProvider ?? { order: [], only: [], ignore: [] });
    function setProviders(field: "order" | "only" | "ignore", values: string[]) {
        profile.openrouterProvider = { ...provider, [field]: values };
    }
</script>

<Accordion name={`OpenRouter ${language.settings}`} styled>
    <div class="flex items-center mb-4">
        <Check bind:check={settings.providers.openrouterFallback} name={language.openRouterFallback} />
    </div>
    <div class="flex items-center mb-4">
        <Check bind:check={settings.providers.openrouterMiddleOut} name={language.openRouterMiddleOut} />
    </div>
    <div class="flex items-center mb-4">
        <Check bind:check={profile.useInstructPrompt} name={language.useInstructPrompt} />
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
            {#each provider.order as _, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={
                        () => provider.order[i],
                        (value) =>
                            setProviders(
                                "order",
                                provider.order.map((entry, index) => (index === i ? value : entry)),
                            )
                    }
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        setProviders("order", [...provider.order, ""]);
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        setProviders("order", provider.order.slice(0, -1));
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderOnly} help="openRouterProviderOnly" styled>
            {#each provider.only as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={
                        () => provider.only[i],
                        (value) =>
                            setProviders(
                                "only",
                                provider.only.map((entry, index) => (index === i ? value : entry)),
                            )
                    }
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        setProviders("only", [...provider.only, ""]);
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        setProviders("only", provider.only.slice(0, -1));
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderIgnore} help="openRouterProviderIgnore" styled>
            {#each provider.ignore as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider}
                    {i + 1}
                </span>
                <OpenrouterProviderList
                    bind:value={
                        () => provider.ignore[i],
                        (value) =>
                            setProviders(
                                "ignore",
                                provider.ignore.map((entry, index) => (index === i ? value : entry)),
                            )
                    }
                    options={openRouterProviders}
                />
            {/each}
            <div class="flex gap-2">
                <button
                    class="bg-selected text-textcolor p-2 rounded-md"
                    onclick={() => {
                        setProviders("ignore", [...provider.ignore, ""]);
                    }}><PlusIcon /></button
                >
                <button
                    class="bg-red-500 text-white p-2 rounded-md"
                    onclick={() => {
                        setProviders("ignore", provider.ignore.slice(0, -1));
                    }}><TrashIcon /></button
                >
            </div>
        </Accordion>
    {/await}
</Accordion>
