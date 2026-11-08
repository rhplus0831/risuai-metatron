<script lang="ts">
    import { activeMainProfile, settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { PlusIcon, TrashIcon, LinkIcon, CodeXmlIcon, PowerIcon, PowerOffIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertConfirmWithCheckbox, alertError, alertSelect } from "src/ts/alert";

    import { hotReloading } from "src/ts/stores.svelte";
    import {
        checkPluginUpdate,
        createBlankPlugin,
        importPlugin,
        loadPlugins,
        updatePlugin,
    } from "src/ts/plugins/plugins.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { hotReloadPluginFiles } from "src/ts/plugins/apiV3/developMode";
    import { safeBootOff } from "src/ts/safeBoot";
    import { resetPluginPermissions } from "src/ts/plugins/apiV3/v3.svelte";
    import PluginDataSettings from "./PluginDataSettings.svelte";
    import { deleteOwnedPluginStorage } from "src/ts/storage/pluginStorageStore.svelte";

    /**
     * Edits the persisted plugin list and arguments. Legacy entries stay visible with the
     * "Unsupported API" badge; only API `3.0` loads through `src/ts/plugins/plugins.svelte.ts`.
     * During safe boot, toggling, removing, and importing still save, but `loadPlugins` starts no
     * sandbox. Custom links accept only HTTP/HTTPS and open without access to the opener.
     */

    let showParams = $state([]);
    let showPluginData = $state(false);
    let changingPermissions = $state(false);
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.plugin}</h2>

<button class="rounded bg-darkbutton p-2 mb-4 text-textcolor" onclick={() => (showPluginData = !showPluginData)}>
    {showPluginData ? language.goback : language.pluginData}
</button>

{#if showPluginData}
    <PluginDataSettings />
{:else}
    <span class="text-draculared text-xs mb-4">{language.pluginWarn}</span>

    {#if safeBootOff("plugins")}
        <!-- Safe boot: `loadPlugins` loads nothing in this page load, so the controls below only save. -->
        <span class="text-textcolor2 text-sm mb-4">{language.safeBootPluginsOff}</span>
    {/if}

    <div class="border-solid border-darkborderc p-2 flex flex-col border-1">
        {#if !settings.plugins || settings.plugins?.length === 0}
            <span class="text-textcolor2">{language.noPlugins}</span>
        {/if}
        {#each settings.plugins as plugin, i}
            {#if i !== 0}
                <div class="border-darkborderc mt-2 mb-2 w-full border-solid border-b-1 seperator"></div>
            {/if}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
                class="flex gap-2"
                aria-labelledby="show-params"
                role="button"
                tabindex="0"
                onclick={() => {
                    if (showParams.includes(i)) {
                        showParams.splice(showParams.indexOf(i), 1);
                    } else {
                        showParams.push(i);
                    }
                }}
            >
                <div class="font-bold grow">
                    <span>
                        {plugin.displayName ?? plugin.name}
                    </span>
                    {#if hotReloading.includes(plugin.name)}
                        <span class="text-sm rounded bg-amber-700 ml-2 px-2 py-1 text-white"> Hot </span>
                    {/if}
                    {#if plugin.version !== "3.0"}
                        <span
                            class="text-xs rounded border border-draculared text-draculared ml-2 px-2 py-0.5"
                            title={language.pluginApiVersionUnsupported}
                        >
                            {language.pluginApiVersionUnsupportedBadge} (API {plugin.version ?? "?"})
                        </span>
                    {/if}
                </div>
                {#if plugin.customLink}
                    {#each plugin.customLink as link}
                        {#if typeof link.link === "string" && (link.link.startsWith("http://") || link.link.startsWith("https://"))}
                            <a
                                href={link.link}
                                target="_blank"
                                rel="nofollow noopener noreferrer"
                                class="text-textcolor2 hover:text-textcolor cursor-pointer"
                                title={link.hoverText}
                            >
                                <LinkIcon></LinkIcon>
                            </a>
                        {/if}
                    {/each}
                {/if}

                {#if plugin.updateURL}
                    {#await checkPluginUpdate(plugin) then updateInfo}
                        {#if updateInfo}
                            <button
                                class="text-green-400 hover:gray-200 cursor-pointer"
                                onclick={async () => {
                                    const v = await alertConfirm(language.pluginUpdateFoundInstallIt);
                                    if (v) {
                                        updatePlugin(plugin);
                                    }
                                }}
                            >
                                <PlusIcon />
                            </button>
                        {/if}
                    {/await}
                {/if}

                <button
                    class="textcolor2 hover:gray-200 cursor-pointer"
                    onclick={async (e) => {
                        plugin.enabled = !plugin.enabled;
                        settings.plugins[i] = plugin;
                        loadPlugins();
                        e.preventDefault();
                    }}
                >
                    {#if plugin.enabled}
                        <PowerIcon />
                    {:else}
                        <PowerOffIcon />
                    {/if}
                </button>

                <button
                    class="text-textcolor2 hover:text-textcolor cursor-pointer disabled:opacity-50"
                    disabled={changingPermissions}
                    onclick={async (event) => {
                        event.stopPropagation();
                        const { name, script } = plugin;
                        changingPermissions = true;
                        try {
                            if (
                                await alertConfirm(
                                    language.pluginResetPermissionsConfirm.replace(
                                        "{name}",
                                        plugin.displayName ?? name,
                                    ),
                                )
                            ) {
                                const current = settings.plugins?.find((entry) => entry.name === name);
                                const failure = await resetPluginPermissions(name, current?.script ?? script).then(
                                    () => null,
                                    (error: unknown) => ({ error }),
                                );
                                // Restart running plugins so none keeps a capability it already obtained,
                                // even when the revoke failed.
                                await loadPlugins();
                                if (failure) throw failure.error;
                            }
                        } catch (error) {
                            alertError(language.pluginPermissionResetError.replace("{error}", String(error)));
                        } finally {
                            changingPermissions = false;
                        }
                    }}>{language.pluginResetPermissions}</button
                >

                <button
                    class="text-textcolor2 hover:text-textcolor cursor-pointer disabled:opacity-50"
                    disabled={changingPermissions}
                    aria-label={language.pluginRemove}
                    onclick={async (event) => {
                        event.stopPropagation();
                        const { name } = plugin;
                        changingPermissions = true;
                        try {
                            const removal = await alertConfirmWithCheckbox(
                                language.removeConfirm + (plugin.displayName ?? name),
                                language.pluginRemoveStoredData,
                            );
                            if (!removal.confirmed) return;
                            const plugins = settings.plugins ?? [];
                            const index = plugins.findIndex((entry) => entry.name === name);
                            if (index === -1) return;
                            const script = plugins[index].script;
                            if (activeMainProfile.currentPluginProvider === name) {
                                activeMainProfile.currentPluginProvider = "";
                            }
                            plugins.splice(index, 1);
                            settings.plugins = plugins;
                            // Capture the loaded script before reload can unload it. Removal persists even if revocation fails.
                            const revocation = resetPluginPermissions(name, script);
                            await Promise.all([
                                revocation,
                                (async () => {
                                    await loadPlugins();
                                    // onUnload can still write; delete only after the local sandbox is gone.
                                    if (removal.checked) deleteOwnedPluginStorage(name);
                                })(),
                            ]);
                        } catch (error) {
                            alertError(language.pluginPermissionResetError.replace("{error}", String(error)));
                        } finally {
                            changingPermissions = false;
                        }
                    }}
                >
                    <TrashIcon />
                </button>
            </div>
            <!--List up args-->
            {#if Object.keys(plugin.arguments).filter((i) => !i.startsWith("hidden_")).length > 0 && showParams.includes(i)}
                <div class="flex flex-col mt-2 bg-dark-900/50 p-3">
                    {#each Object.keys(plugin.arguments) as arg}
                        {#if !arg.startsWith("hidden_")}
                            {#if typeof plugin?.argMeta?.[arg]?.divider === "string"}
                                {#if plugin?.argMeta?.[arg]?.divider}
                                    <div class="flex items-center mt-6">
                                        <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                        <div class="relative flex justify-center">
                                            <span class="px-2 text-sm text-textarea text-nowrap"
                                                >{plugin?.argMeta?.[arg]?.divider}</span
                                            >
                                        </div>
                                        <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                    </div>
                                {:else}
                                    <div aria-hidden="true" class="w-full border-t border-darkborderc mt-6"></div>
                                {/if}
                            {/if}
                            <span class="mb-2 mt-6">{plugin?.argMeta?.[arg]?.name || arg}</span>
                            {#if plugin?.argMeta?.[arg]?.description}
                                <span class="mb-2 text-sm text-textcolor2">{plugin?.argMeta?.[arg]?.description}</span>
                            {/if}
                            {#if Array.isArray(plugin.arguments[arg])}
                                <SelectInput
                                    className="mt-2 mb-4"
                                    bind:value={settings.plugins[i].realArg[arg] as string}
                                >
                                    {#each plugin.arguments[arg] as a}
                                        <OptionInput value={a}>a</OptionInput>
                                    {/each}
                                </SelectInput>
                            {:else if plugin.arguments[arg] === "string"}
                                {#if plugin?.argMeta?.[arg]?.textarea}
                                    <TextAreaInput
                                        bind:value={settings.plugins[i].realArg[arg] as string}
                                        popupEditorContext={`${plugin.name}\u0000${arg}`}
                                        placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                    />
                                {:else if plugin?.argMeta?.[arg]?.radio}
                                    {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                        <CheckInput
                                            check={settings.plugins[i].realArg[arg] === radioOption.split("|").at(-1)}
                                            onChange={(e) => {
                                                if (e) {
                                                    settings.plugins[i].realArg[arg] = radioOption.split("|").at(-1);
                                                }
                                            }}
                                            margin={false}
                                            name={radioOption.split("|").at(0)}
                                        />
                                    {/each}
                                {:else}
                                    <TextInput
                                        bind:value={settings.plugins[i].realArg[arg] as string}
                                        placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                    />
                                {/if}
                            {:else if plugin.arguments[arg] === "int"}
                                {#if plugin?.argMeta?.[arg]?.checkbox}
                                    <CheckInput
                                        check={settings.plugins[i].realArg[arg] === "1"}
                                        onChange={(e) => {
                                            settings.plugins[i].realArg[arg] = e ? "1" : "0";
                                        }}
                                        margin={false}
                                        name={plugin?.argMeta?.[arg]?.checkbox === "1"
                                            ? language.enable
                                            : plugin?.argMeta?.[arg]?.checkbox}
                                    />
                                {:else if plugin?.argMeta?.[arg]?.radio}
                                    {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                        <CheckInput
                                            check={settings.plugins[i].realArg[arg] ===
                                                parseInt(radioOption.split("|").at(-1))}
                                            onChange={(e) => {
                                                if (e) {
                                                    settings.plugins[i].realArg[arg] = parseInt(
                                                        radioOption.split("|").at(-1),
                                                    );
                                                }
                                            }}
                                            margin={false}
                                            name={radioOption.split("|").at(0)}
                                        />
                                    {/each}
                                {:else}
                                    <NumberInput
                                        bind:value={settings.plugins[i].realArg[arg] as number}
                                        placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                    />
                                {/if}
                            {/if}
                        {/if}
                    {/each}
                </div>
            {/if}
        {/each}
    </div>
    <div class="text-textcolor2 mt-2 flex gap-2">
        <button
            onclick={() => {
                importPlugin();
            }}
            class="hover:text-textcolor cursor-pointer"
        >
            <PlusIcon />
        </button>

        <button
            onclick={async () => {
                const v = parseInt(
                    await alertSelect(["Import plugin with hot reload", "Download plugin template", language.cancel]),
                );
                switch (v) {
                    case 0:
                        await hotReloadPluginFiles();
                        break;
                    case 1: {
                        const a = document.createElement("a");
                        a.href = "/plugin_start.7z";
                        a.download = "plugin_starter.7z";
                        document.body.appendChild(a);
                    }
                }
            }}
            class="hover:text-textcolor cursor-pointer"
        >
            <CodeXmlIcon />
        </button>
    </div>
{/if}
