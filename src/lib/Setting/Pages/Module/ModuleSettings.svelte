<script lang="ts">
    // This page shows what the open chat runs with, so it reads the active family on purpose.
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
        FolderInput,
        FolderPlus,
        PencilIcon,
    } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, alertInput, alertNormal, alertSelect, type alertData } from "src/ts/alert";
    import { alertStore } from "src/ts/stores.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { prepareQuery } from "src/ts/util/koreanSearch";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { addCharacter } from "src/ts/storage/characterStore.svelte";
    import { recordValueIdentity } from "src/ts/storage/records.svelte";
    import {
        addItemFolder,
        moveItemToFolder,
        removeItemFolder,
        removeModule,
        renameItemFolder,
    } from "src/ts/storage/collectionStore.svelte";
    import { isFolderFolded, setFolderFolded } from "src/ts/gui/itemFolderFold.svelte";
    import ModuleFolderRow from "./ModuleFolderRow.svelte";
    import {
        allMembersEnabled,
        catalogRows,
        choiceForAnswer,
        folderChoices,
        moduleCatalog,
        switchAllGlobally,
    } from "./moduleCatalog";

    /**
     * The module catalog, with its create (mode 1) and edit (mode 2) views of `ModuleMenu.svelte`. Edit mode retains
     * only the module id and resolves its live record wrapper from the current list, so the editor's edits save
     * immediately and follow a remote list replacement; a missing module returns to the catalog without a write.
     * Create mode adds its plain-object draft to `settings.modules` once, by the final button, only when a non-`id`
     * field has content; asset bytes uploaded meanwhile stay stored. The share button adds no error alert (both
     * exporters alert their own failure); once the export settles, `clearStaleExportWait` clears only the exact status
     * the export last passed to `onInstall`, so a newer status and any error or success dialog stay.
     *
     * The list follows `moduleCatalog.ts`: module folders (`settings.moduleFolders`, absent in older mocks and flat
     * databases) by name with their modules, then the root modules. Every folder action captures its module or folder
     * id before a dialog and acts on the id afterwards, only while what it names still exists; fold state stays on
     * this device (`itemFolderFold.svelte.ts`).
     */

    let tempModule: RisuModule = $state({
        name: "",
        description: "",
        id: v4(),
    });
    const hasDraftContent = $derived(
        Object.entries(tempModule).some(([key, value]) => {
            if (key === "id") return false;
            if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
            if (typeof value === "boolean") return value;
            return value != null;
        }),
    );
    let mode = $state(0);
    let editModuleId = $state<string | null>(null);
    const editModule = $derived(
        editModuleId === null ? undefined : settings.modules.find((module) => module.id === editModuleId),
    );

    $effect.pre(() => {
        if (mode === 2 && !editModule) {
            mode = 0;
        }
    });

    let moduleSearch = $state("");
    const moduleQuery = $derived(prepareQuery(moduleSearch));
    let charConversionMode = $state(false);

    // Clear a wait left by this export only while it still owns the status slot.
    function clearStaleExportWait(status: alertData | null) {
        if (status) {
            alertStore.clearStatus(status);
        }
    }

    const moduleFolders = $derived(settings.moduleFolders ?? []);
    const catalog = $derived(moduleCatalog(settings.modules, moduleFolders, moduleQuery));
    const rows = $derived(catalogRows(catalog, (folderId) => isFolderFolded("moduleFolders", folderId)));

    function toggleFolder(folderId: string) {
        // A search shows every listed folder open; its fold state waits for the search to clear.
        if (catalog.searching) return;
        setFolderFolded(
            "moduleFolders",
            folderId,
            !isFolderFolded("moduleFolders", folderId),
            moduleFolders.map((folder) => folder.id),
        );
    }

    function folderExists(folderId: string) {
        return (settings.moduleFolders ?? []).some((folder) => folder.id === folderId);
    }

    async function moveModule(moduleId: string) {
        const choices = folderChoices(
            settings.moduleFolders ?? [],
            language.itemFolders.unnamed,
            language.itemFolders.noFolder,
        );
        const answer = await alertSelect(
            choices.map((choice) => choice.label),
            language.itemFolders.moveToWhich,
        );
        const choice = choiceForAnswer(choices, answer);
        if (!choice) return;
        if (!settings.modules.some((module) => module.id === moduleId)) return;
        if (choice.id !== null && !folderExists(choice.id)) return;
        moveItemToFolder("moduleFolders", moduleId, choice.id);
    }

    function switchFolderGlobally(memberIds: string[]) {
        if (memberIds.length === 0) return;
        settings.enabledModules = switchAllGlobally(memberIds, settings.enabledModules ?? []);
    }

    async function renameFolder(folderId: string) {
        const folder = (settings.moduleFolders ?? []).find((entry) => entry.id === folderId);
        if (!folder) return;
        const name = (await alertInput(language.itemFolders.rename, [], folder.name)).trim();
        if (name === "" || !folderExists(folderId)) return;
        renameItemFolder("moduleFolders", folderId, name);
    }

    async function deleteFolder(folderId: string) {
        if (!(await alertConfirm(language.itemFolders.removeModuleFolderConfirm))) return;
        removeItemFolder("moduleFolders", folderId);
    }

    async function newFolder() {
        const name = (await alertInput(language.itemFolders.folderName)).trim();
        if (name === "") return;
        addItemFolder("moduleFolders", name);
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
        {/if}
        {#each rows as row, i}
            {#if i !== 0 || settings.modules.length === 0}
                <div class="border-t-1 border-selected"></div>
            {/if}
            {#if row.type === "module"}
                {@const rmodule = row.module}
                {@const indented = row.folderId !== null}
                <div class="{indented ? 'pl-8' : 'pl-3'} pt-3 text-left flex items-center">
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
                                        const moduleId = rmodule.id;
                                        const sel = parseInt(
                                            await alertSelect([`CharX (${language.recommended})`, `RisuM (Legacy)`]),
                                        );
                                        const module = settings.modules.find((entry) => entry.id === moduleId);
                                        if (!module) return;
                                        let exportStatus: alertData | null = null;
                                        const onInstall = (status: alertData) => (exportStatus = status);
                                        try {
                                            if (sel === 0) {
                                                await exportModule($state.snapshot(module), { onInstall });
                                            } else {
                                                await exportModuleLegacy($state.snapshot(module), { onInstall });
                                            }
                                        } catch (error) {
                                            // Both exporters alert their own failure; add no second alert.
                                            console.error(error);
                                        } finally {
                                            clearStaleExportWait(exportStatus);
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
                                        editModuleId = rmodule.id;
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
                                use:tooltip={language.itemFolders.moveToFolder}
                                onclick={async (e) => {
                                    e.stopPropagation();
                                    const moduleId = rmodule.id;
                                    await moveModule(moduleId);
                                }}
                            >
                                <FolderInput size={18} />
                            </button>
                            <button
                                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                use:tooltip={language.remove}
                                onclick={async (e) => {
                                    e.stopPropagation();
                                    const moduleId = rmodule.id;
                                    const identity = recordValueIdentity(rmodule);
                                    const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name);
                                    if (d) {
                                        removeModule(moduleId, identity);
                                    }
                                }}
                            >
                                <TrashIcon size={18} />
                            </button>
                        {/if}
                    </div>
                </div>
                <div class="mt-1 mb-3 {indented ? 'pl-8' : 'pl-3'}">
                    <span class="text-sm text-textcolor2">{rmodule.description || "No description provided"}</span>
                </div>
            {:else}
                {@const folderId = row.folder.id}
                <ModuleFolderRow
                    name={row.folder.name}
                    count={row.memberIds.length}
                    open={row.open}
                    ontoggle={() => toggleFolder(folderId)}
                >
                    {#snippet buttons()}
                        {#if !charConversionMode}
                            <button
                                class={allMembersEnabled(row.memberIds, settings.enabledModules ?? [])
                                    ? "mr-2 cursor-pointer text-blue-500"
                                    : "text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"}
                                use:tooltip={language.itemFolders.enableAllGlobally}
                                onclick={(e) => {
                                    e.stopPropagation();
                                    switchFolderGlobally(row.memberIds);
                                }}
                            >
                                <Globe size={18} />
                            </button>
                            <button
                                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                use:tooltip={language.itemFolders.rename}
                                onclick={async (e) => {
                                    e.stopPropagation();
                                    await renameFolder(folderId);
                                }}
                            >
                                <PencilIcon size={18} />
                            </button>
                            <button
                                class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                                use:tooltip={language.itemFolders.remove}
                                onclick={async (e) => {
                                    e.stopPropagation();
                                    await deleteFolder(folderId);
                                }}
                            >
                                <TrashIcon size={18} />
                            </button>
                        {/if}
                    {/snippet}
                </ModuleFolderRow>
            {/if}
        {/each}
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
                mode = 1;
            }}
        >
            <PlusIcon />
        </button>
        <button
            class="text-textcolor2 hover:text-blue-500 mr-2 cursor-pointer"
            use:tooltip={language.itemFolders.newFolder}
            onclick={async () => {
                await newFolder();
            }}
        >
            <FolderPlus />
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
            if (hasDraftContent) {
                settings.modules.push(tempModule);
            }
            mode = 0;
        }}>{hasDraftContent ? language.createModule : language.cancel}</Button
    >
{:else if mode === 2 && editModule}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.editModule}</h2>
    <ModuleMenu currentModule={editModule} />
    {#if editModule.name !== ""}
        <Button
            className="mt-6"
            onclick={() => {
                mode = 0;
            }}>{language.editModule}</Button
        >
    {/if}
{/if}
