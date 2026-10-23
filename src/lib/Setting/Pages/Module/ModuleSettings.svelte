<script lang="ts">
    import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";

    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, exportModuleLegacy, importModule, type RisuModule } from "src/ts/process/modules";
    import {
        SquarePen,
        TrashIcon,
        Globe,
        Share2Icon,
        PlusIcon,
        HardDriveUpload,
        Waypoints,
        UserIcon,
    } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertClear, alertConfirm, alertNormal, alertSelect } from "src/ts/alert";
    import { alertStore } from "src/ts/stores.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { matchesAny, prepareQuery, type PreparedQuery } from "src/ts/util/koreanSearch";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { addCharacter } from "src/ts/storage/characterStore.svelte";
    let tempModule: RisuModule = $state({
        name: "",
        description: "",
        id: v4(),
    });
    let mode = $state(0);
    let editModuleIndex = $state(-1);
    let moduleSearch = $state("");
    const moduleQuery = $derived(prepareQuery(moduleSearch));
    let charConversionMode = $state(false);

    // The export is over: a wait or progress status still set is stale (a failure the exporter
    // could not alert), so clear it and keep the row usable. A dialog is never closed here.
    function clearStaleExportWait() {
        const type = alertStore.status()?.type;
        if (type === "wait" || type === "progress") {
            alertClear();
        }
    }

    function sortModules(modules: RisuModule[], query: PreparedQuery | null) {
        return modules
            .filter((v) => !query || matchesAny([v.name], query))
            .sort((a, b) => {
                let score = (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase());
                return score;
            });
    }
</script>

{#if mode === 0}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.modules}</h2>

    <TextInput className="mt-4" placeholder={language.search} bind:value={moduleSearch} />

    <div
        class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md flex-1 overflow-y-auto"
    >
        {#if settings.modules.length === 0}
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        {:else}
            {#each sortModules(settings.modules, moduleQuery) as rmodule, i}
                {#if i !== 0}
                    <div class="border-t-1 border-selected"></div>
                {/if}

                <div class="pl-3 pt-3 text-left flex items-center">
                    {#if rmodule.mcp}
                        <Waypoints size={18} class="mr-2" />
                    {/if}
                    <span class="text-lg">{rmodule.name}</span>
                    <div class="grow flex justify-end">
                        {#if charConversionMode}
                            <button
                                class="cursor-pointer text-violet-500 mr-2"
                                onclick={async (e) => {
                                    e.stopPropagation();
                                    const module = settings.modules.find((v) => v.id === rmodule.id);
                                    const char = convertModuleToCharacter(module);
                                    addCharacter(char);
                                    alertNormal(language.successfullyConverted);
                                }}
                            >
                                <UserIcon size={18} />
                            </button>
                        {:else}
                            <button
                                class={settings.enabledModules.includes(rmodule.id)
                                    ? "mr-2 cursor-pointer text-blue-500"
                                    : rmodule.namespace &&
                                        activePreset.moduleIntergration
                                            ?.split(",")
                                            .map((s) => s.trim())
                                            .includes(rmodule.namespace)
                                      ? "text-amber-500 hover:text-green-500 mr-2 cursor-pointer"
                                      : "text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"}
                                use:tooltip={language.enableGlobal}
                                onclick={async (e) => {
                                    e.stopPropagation();
                                    if (settings.enabledModules.includes(rmodule.id)) {
                                        settings.enabledModules.splice(settings.enabledModules.indexOf(rmodule.id), 1);
                                    } else {
                                        settings.enabledModules.push(rmodule.id);
                                    }
                                    settings.enabledModules = settings.enabledModules;
                                    charConversionMode = false;
                                }}
                            >
                                <Globe size={18} />
                            </button>
                            {#if !rmodule.mcp}
                                <button
                                    class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                    use:tooltip={language.download}
                                    onclick={async (e) => {
                                        e.stopPropagation();
                                        const sel = parseInt(
                                            await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]),
                                        );
                                        try {
                                            if (sel === 0) {
                                                await exportModule(rmodule);
                                            } else {
                                                await exportModuleLegacy(rmodule);
                                            }
                                        } catch (error) {
                                            // Both exporters alert their own failure; add no second alert.
                                            console.error(error);
                                        } finally {
                                            clearStaleExportWait();
                                        }
                                    }}
                                >
                                    <Share2Icon size={18} />
                                </button>
                                <button
                                    class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                    use:tooltip={language.edit}
                                    onclick={async (e) => {
                                        e.stopPropagation();
                                        const index = settings.modules.findIndex((v) => v.id === rmodule.id);
                                        tempModule = rmodule;
                                        editModuleIndex = index;
                                        mode = 2;
                                    }}
                                >
                                    <SquarePen size={18} />
                                </button>
                            {:else}
                                <button class="text-textcolor2 mr-2 cursor-not-allowed">
                                    <Share2Icon size={18} />
                                </button>
                                <button class="text-textcolor2 mr-2 cursor-not-allowed">
                                    <SquarePen size={18} />
                                </button>
                            {/if}
                            <button
                                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                use:tooltip={language.remove}
                                onclick={async (e) => {
                                    e.stopPropagation();
                                    const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name);
                                    if (d) {
                                        if (settings.enabledModules.includes(rmodule.id)) {
                                            settings.enabledModules.splice(
                                                settings.enabledModules.indexOf(rmodule.id),
                                                1,
                                            );
                                            settings.enabledModules = settings.enabledModules;
                                        }
                                        const index = settings.modules.findIndex((v) => v.id === rmodule.id);
                                        settings.modules.splice(index, 1);
                                        settings.modules = settings.modules;
                                    }
                                }}
                            >
                                <TrashIcon size={18} />
                            </button>
                        {/if}
                    </div>
                </div>
                <div class="mt-1 mb-3 pl-3">
                    <span class="text-sm text-textcolor2">{rmodule.description || "No description provided"}</span>
                </div>
            {/each}
        {/if}
    </div>

    <div class="flex mr-2 mt-4">
        <button
            class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
            onclick={async () => {
                tempModule = {
                    name: "",
                    description: "",
                    id: v4(),
                };
                settings.modules.push(tempModule);
                mode = 1;
            }}
        >
            <PlusIcon />
        </button>
        <button
            class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
            onclick={async () => {
                charConversionMode = !charConversionMode;
            }}
        >
            <UserIcon />
        </button>
        <button
            class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
            onclick={async () => {
                importMCPModule();
            }}
        >
            <Waypoints />
        </button>
        <button
            class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
            onclick={async () => {
                importModule();
            }}
        >
            <HardDriveUpload />
        </button>
    </div>
{:else if mode === 1}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.createModule}</h2>
    <ModuleMenu bind:currentModule={tempModule} />
    <Button
        className="mt-6"
        onclick={() => {
            settings.modules.push(tempModule);
            mode = 0;
        }}>{language.createModule}</Button
    >
{:else if mode === 2}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.editModule}</h2>
    <ModuleMenu bind:currentModule={tempModule} />
    {#if tempModule.name !== ""}
        <Button
            className="mt-6"
            onclick={() => {
                settings.modules[editModuleIndex] = tempModule;
                mode = 0;
            }}>{language.editModule}</Button
        >
    {/if}
{/if}
