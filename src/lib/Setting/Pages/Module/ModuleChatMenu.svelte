<script lang="ts">
    import { selectedChat } from "src/ts/storage/chatStore.svelte";
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { CircleCheckIcon, Waypoints, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { prepareQuery } from "src/ts/util/koreanSearch";
    import { tooltip } from "src/ts/gui/tooltip";
    import { isFolderFolded, setFolderFolded } from "src/ts/gui/itemFolderFold.svelte";
    import ModuleFolderRow from "./ModuleFolderRow.svelte";
    import {
        allTargetsInChat,
        catalogRows,
        chatOnCount,
        chatSwitchTargets,
        moduleCatalog,
        switchAllForChat,
    } from "./moduleCatalog";

    import { setCurrentChatMeta } from "src/ts/storage/chatEdits";
    import { SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
    import { checkPersonaBinded } from "src/ts/util";
    import { personaLinksModule, personaModuleIdSet } from "../../../../../shared/personas.ts";

    /**
     * The chat's module toggles, or with `alertMode` the module picker of `alertModuleSelect` (closing with the picked
     * id). A click toggles the selected chat's `modules` (nothing while the chat loads), a right click the character's;
     * a globally enabled module is not toggled here. It writes only the chat's or the character's list. `getModules`
     * matches those tokens by id or namespace (persona links by id only) and keeps the first module of an id, so
     * toggling a module already active through another source usually leaves the effective set as it was, but can
     * change it when ids and namespaces collide.
     *
     * The rows follow `moduleCatalog.ts` (module folders by name with their modules, then the root modules; fold state
     * is this device's), with no folder editing. A folder row counts its modules on (globally or in the chat's
     * `modules`) and, while the chat is loaded, switches its modules that are not globally enabled for this chat in
     * one write; the character's `modules` stay per module.
     */

    const currentCharacter = $derived(selectedCharacter());
    const currentChat = $derived(selectedChat());
    // The modules the selected chat's bound persona links: active for this chat besides its own toggles.
    const personaLinked = $derived(personaModuleIdSet(checkPersonaBinded()));
    interface Props {
        close?: any;
        alertMode?: boolean;
    }

    let { close = (i: string) => {}, alertMode = false }: Props = $props();
    let moduleSearch = $state("");
    const moduleQuery = $derived(prepareQuery(moduleSearch));

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

    function folderCount(memberIds: string[]) {
        if (alertMode) return memberIds.length;
        const { on, total } = chatOnCount(memberIds, settings.enabledModules ?? [], currentChat?.modules ?? []);
        return `${on} / ${total}`;
    }

    function switchFolderForChat(memberIds: string[]) {
        if (!currentChat) {
            // The selected chat is loading.
            return;
        }
        const enabled = settings.enabledModules ?? [];
        if (chatSwitchTargets(memberIds, enabled).length === 0) return;
        setCurrentChatMeta({ modules: switchAllForChat(memberIds, enabled, currentChat.modules ?? []) });
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-full max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor">
            <h2 class="mt-0 mb-0 text-lg">{language.modules}</h2>
            <div class="grow flex justify-end">
                <button
                    class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center"
                    onclick={() => {
                        close("");
                    }}
                >
                    <XIcon size={24} />
                </button>
            </div>
        </div>

        <span class="text-sm text-textcolor2">{language.chatModulesInfo}</span>

        <TextInput className="mt-4" placeholder={language.search} bind:value={moduleSearch} />

        <div class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md">
            {#if settings.modules.length === 0}
                <div class="text-textcolor2 p-3">{language.noModules}</div>
            {/if}
            {#each rows as row, i}
                {#if i !== 0 || settings.modules.length === 0}
                    <div class="border-t-1 border-selected"></div>
                {/if}
                {#if row.type === "module"}
                    {@const rmodule = row.module}
                    <div class="{row.folderId !== null ? 'pl-8' : 'pl-3'} py-3 text-left flex items-center">
                        {#if rmodule.mcp}
                            <Waypoints size={18} class="mr-2" />
                        {/if}
                        {#if !alertMode && settings.enabledModules.includes(rmodule.id)}
                            <span class="text-textcolor2">{rmodule.name}</span>
                        {:else}
                            <span class="">{rmodule.name}</span>
                        {/if}
                        <div class="grow flex justify-end items-center">
                            {#if !alertMode && personaLinksModule(personaLinked, rmodule)}
                                <span class="mr-2 text-xs text-primary-400">{language.personaModuleLinkActive}</span>
                            {/if}
                            {#if alertMode}
                                <button
                                    class={"text-textcolor2 mr-2 cursor-pointer hover:text-blue-500 transition-colors"}
                                    onclick={async (e) => {
                                        e.stopPropagation();

                                        close(rmodule.id);
                                    }}
                                >
                                    <CircleCheckIcon size={18} />
                                </button>
                            {:else if settings.enabledModules.includes(rmodule.id)}
                                <button class="mr-2 text-textcolor2 cursor-not-allowed" aria-labelledby="disabled">
                                </button>
                            {:else}
                                <button
                                    class={currentChat?.modules?.includes(rmodule.id)
                                        ? "mr-2 cursor-pointer text-blue-500"
                                        : currentCharacter?.modules?.includes(rmodule.id)
                                          ? "mr-2 cursor-pointer text-violet-500"
                                          : "text-textcolor2 hover:text-blue-400 mr-2 cursor-pointer"}
                                    onclick={async (e) => {
                                        e.stopPropagation();
                                        if (!currentChat) {
                                            // The selected chat is loading.
                                            return;
                                        }
                                        const chatModules = [...(currentChat.modules ?? [])];
                                        setCurrentChatMeta({
                                            modules: chatModules.includes(rmodule.id)
                                                ? chatModules.filter((id) => id !== rmodule.id)
                                                : [...chatModules, rmodule.id],
                                        });
                                    }}
                                    oncontextmenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (!currentCharacter.modules) {
                                            currentCharacter.modules = [];
                                        }
                                        if (currentCharacter.modules.includes(rmodule.id)) {
                                            currentCharacter.modules.splice(
                                                currentCharacter.modules.indexOf(rmodule.id),
                                                1,
                                            );
                                        } else {
                                            currentCharacter.modules.push(rmodule.id);
                                        }
                                    }}
                                >
                                    <CircleCheckIcon size={18} />
                                </button>
                            {/if}
                        </div>
                    </div>
                {:else}
                    {@const folderId = row.folder.id}
                    <ModuleFolderRow
                        name={row.folder.name}
                        count={folderCount(row.memberIds)}
                        open={row.open}
                        ontoggle={() => toggleFolder(folderId)}
                    >
                        {#snippet buttons()}
                            {#if !alertMode && currentChat && chatSwitchTargets(row.memberIds, settings.enabledModules ?? []).length > 0}
                                <button
                                    class={allTargetsInChat(
                                        row.memberIds,
                                        settings.enabledModules ?? [],
                                        currentChat.modules ?? [],
                                    )
                                        ? "mr-2 cursor-pointer text-blue-500"
                                        : "text-textcolor2 hover:text-blue-400 mr-2 cursor-pointer"}
                                    use:tooltip={language.itemFolders.switchAllForChat}
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        switchFolderForChat(row.memberIds);
                                    }}
                                >
                                    <CircleCheckIcon size={18} />
                                </button>
                            {/if}
                        {/snippet}
                    </ModuleFolderRow>
                {/if}
            {/each}
        </div>
        <div>
            <Button
                className="mt-4 grow-0"
                size="sm"
                onclick={() => {
                    $SettingsMenuIndex = 14;
                    $settingsOpen = true;
                    close("");
                }}>{language.edit}</Button
            >
        </div>
    </div>
</div>

<style>
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
