<script lang="ts">
    import { settings, activePreset, activeModelPreset } from "src/ts/storage/settingsViews.svelte";
    import { alertConfirm, alertError } from "../../ts/alert";
    import { language } from "../../lang";
    import {
        copyModelPreset,
        copyPreset,
        downloadPreset,
        importPreset,
        removeModelPreset,
    } from "../../ts/storage/presets.svelte";
    import { addModelPreset } from "../../ts/storage/collectionStore.svelte";
    import {
        ArchiveIcon,
        ArchiveRestoreIcon,
        CopyIcon,
        Share2Icon,
        PencilIcon,
        HardDriveUploadIcon,
        PlusIcon,
        TrashIcon,
        XIcon,
        GitCompare,
    } from "@lucide/svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { prebuiltPresets } from "src/ts/process/templates/templates";
    import { MODEL_PRESET_DEFAULT_NAME, normalizePreset } from "../../../shared/presets.ts";
    import PromptDiffModal from "../Others/PromptDiffModal.svelte";
    import { RISU_PRESET_DRAG_TYPE } from "src/ts/dragTypes";
    import { moveRecordListItem } from "src/ts/storage/records.svelte";
    import { chatEntry, currentChatRef, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { chatsBoundTo, pickedId } from "src/ts/storage/chatBinding.svelte";
    import { pickBinding } from "src/ts/storage/chatBindingPick";
    import { selectPreset, selection } from "src/ts/storage/selection.svelte";

    let editMode = $state(false);
    let isDragging = $state(false);
    /** The drop slot under the pointer, as a position in the shown rows (`visibleEntries`). */
    let dragOverIndex = $state(-1);
    /** The prompt list's archived view: only archived presets (the default view hides them). */
    let showArchived = $state(false);
    let viewToggle = $state<HTMLButtonElement>();
    let renaming = $state<string | null>(null);

    /** A listed record: name and id for both kinds; `image` and `archived` only on a prompt preset. */
    type ListedPreset = { id: string; name?: string; image?: string; archived?: boolean };

    interface Props {
        close?: any;
        /** Which presets the list shows: the prompt presets (`settings.presets`) or the model presets. */
        kind?: "prompt" | "model";
        /** The chat whose binding a pick changes (the binding panel's row); else the open chat, else the tab's selection. */
        chatRef?: ChatRef;
    }

    let { close = () => {}, kind = "prompt", chatRef }: Props = $props();
    const isPrompt = $derived(kind === "prompt");
    const field = $derived<"promptPresetId" | "modelPresetId">(isPrompt ? "promptPresetId" : "modelPresetId");
    /** The records of this kind, in list order. */
    const presets = $derived<ListedPreset[]>(isPrompt ? settings.presets : settings.modelPresets);
    /**
     * The shown rows, each with its position in `presets` (`index`): on the prompt list the active
     * or the archived presets by the view, on the model list every preset.
     */
    const visibleEntries = $derived.by(() =>
        presets.flatMap((preset, index) =>
            !isPrompt || (preset.archived === true) === showArchived ? [{ preset, index }] : [],
        ),
    );
    /** The chat the list picks for (decision 8): the given chat, else the open chat; null at home. */
    const shownRef = $derived(chatRef ?? currentChatRef());
    const shownChatName = $derived(shownRef ? chatEntry(shownRef)?.name : undefined);
    // Read once per render, not once per row (the selected index searched the list for every row).
    const selectedPresetId = $derived(pickedId(field, shownRef, isPrompt ? activePreset.id : activeModelPreset.id));

    // A list opened for a chat closes when that chat is gone; it never falls back to the open chat.
    $effect(() => {
        if (chatRef && !chatEntry(chatRef)) {
            close();
        }
    });

    /** A remote archive must move focus away from the editor whose preset left the view. */
    $effect(() => {
        if (renaming !== null && !visibleEntries.some((entry) => entry.preset.id === renaming)) {
            renaming = null;
            viewToggle?.focus();
        }
    });

    /** Picks preset `id` for the given chat, else the open chat at this click, else the tab's selection. */
    function selectListed(id: string): boolean {
        return pickBinding(field, id, chatRef);
    }

    function copyListed(id: string) {
        if (isPrompt) {
            copyPreset(id);
        } else {
            copyModelPreset(id);
        }
    }

    function addListed() {
        if (isPrompt) {
            settings.presets.push(normalizePreset({ ...prebuiltPresets.OAI2, name: `New Preset` }));
        } else {
            addModelPreset({ name: MODEL_PRESET_DEFAULT_NAME });
        }
    }

    function toggleArchiveView() {
        isDragging = false;
        dragOverIndex = -1;
        showArchived = !showArchived;
    }

    /**
     * Archives or restores prompt preset `id` (by id: the list can change). Only its list metadata
     * changes: the tab's selection and the chats bound to it stay. Its row leaves the view, so the
     * focus moves to the view toggle instead of staying on the control the next row reuses.
     */
    function setArchived(id: string, archived: boolean) {
        const target = settings.presets.find((preset) => preset.id === id);
        if (!target || (target.archived === true) === archived) {
            return;
        }
        target.archived = archived;
        viewToggle?.focus();
    }

    /** Removes preset `id` after the dialog; the list can change meanwhile, so it acts by id. */
    async function removeListed(id: string, name: string) {
        if (presets.length === 1) {
            alertError(language.errors.onlyOneChat);
            return;
        }
        const bound = chatsBoundTo(field, id);
        const d = await alertConfirm(
            `${language.removeConfirm}${name}` + (bound > 0 ? `\n\n${language.chatBinding.usedByChats(bound)}` : ""),
        );
        if (!d) {
            return;
        }
        if (!isPrompt) {
            if (!removeModelPreset(id)) {
                alertError(language.errors.onlyOneChat);
            }
            return;
        }
        const botPresets = settings.presets;
        const index = botPresets.findIndex((entry) => entry.id === id);
        if (index === -1) {
            return;
        }
        if (botPresets.length === 1) {
            alertError(language.errors.onlyOneChat);
            return;
        }
        // Chats bound to it keep the id and show it as deleted; only the tab's selection moves on.
        if (selection.presetId === id) {
            const next =
                botPresets.find((entry) => entry.id !== id && entry.archived !== true) ??
                botPresets.find((entry) => entry.id !== id);
            selectPreset(next.id);
        }
        botPresets.splice(index, 1);
    }

    // The comparison picks by preset id (a reorder, deletion, or the view toggle in between leaves
    // them on the same presets); `PromptDiffModal` takes positions, resolved when it opens.
    let showDiffModal = $state(false);
    let selectedDiffPreset = $state<string | null>(null);
    let firstPresetId = $state<string | null>(null);
    let diffPair = $state<{ first: number; second: number } | null>(null);

    function movePreset(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= presets.length || toIndex > presets.length) return;

        const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        if (adjustedToIndex === fromIndex) return;
        // One write of the presets record (Phase 6 slice 4: a reorder past a frame budget through the
        // record's wrappers). The selection is by id, so a reorder leaves it on the same preset.
        moveRecordListItem(isPrompt ? settings.presets : settings.modelPresets, fromIndex, adjustedToIndex);
    }

    function isPresetDrag(e: DragEvent) {
        return e.dataTransfer?.types.includes(RISU_PRESET_DRAG_TYPE) ?? false;
    }

    /** The drag carries the preset's id, resolved on drop: the list can change during a drag. */
    function markPresetDrag(e: DragEvent, id: string) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "preset");
        e.dataTransfer.setData(RISU_PRESET_DRAG_TYPE, id);
    }

    /**
     * The position in `presets` a drop on shown slot `slot` inserts at: before that shown row, or,
     * past the last one, just after it (the hidden rows keep their places). -1 for no slot.
     */
    function dropIndexOfSlot(slot: number): number {
        if (!Number.isInteger(slot) || slot < 0) {
            return -1;
        }
        if (slot < visibleEntries.length) {
            return visibleEntries[slot].index;
        }
        const last = visibleEntries.at(-1);
        return last ? last.index + 1 : presets.length;
    }

    function handlePresetDrop(slot: number, e: DragEvent) {
        if (!isPresetDrag(e)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const sourceId = e.dataTransfer?.getData(RISU_PRESET_DRAG_TYPE) ?? "";
        // A vanished source or unchanged shown order must not move hidden rows or queue a write.
        const sourceSlot = visibleEntries.findIndex((entry) => entry.preset.id === sourceId);
        if (sourceSlot === -1 || slot === sourceSlot || slot === sourceSlot + 1) {
            return;
        }
        const sourceIndex = presets.findIndex((preset) => preset.id === sourceId);
        const targetIndex = dropIndexOfSlot(slot);
        if (sourceIndex === -1 || targetIndex === -1) {
            return;
        }
        movePreset(sourceIndex, targetIndex);
    }

    function handleDiffMode(id: string) {
        if (selectedDiffPreset === id) {
            selectedDiffPreset = null;
            firstPresetId = null;
            return;
        }

        selectedDiffPreset = id;

        if (firstPresetId === null) {
            firstPresetId = id;
            return;
        }

        const first = settings.presets.findIndex((preset) => preset.id === firstPresetId);
        const second = settings.presets.findIndex((preset) => preset.id === id);
        selectedDiffPreset = null;
        firstPresetId = null;
        if (first === -1 || second === -1) {
            return;
        }
        diffPair = { first, second };
        showDiffModal = true;
    }

    function closeDiff() {
        showDiffModal = false;
        diffPair = null;
        firstPresetId = null;
        selectedDiffPreset = null;
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{isPrompt ? language.promptPresets : language.modelPresets}</h2>
            <div class="grow flex justify-end items-center">
                {#if isPrompt}
                    <button
                        type="button"
                        bind:this={viewToggle}
                        data-preset-archive-view
                        class="flex items-center gap-1 rounded-sm border border-darkborderc px-2 py-1 mr-2 text-sm cursor-pointer hover:text-green-500"
                        class:text-textcolor={showArchived}
                        class:text-textcolor2={!showArchived}
                        aria-label={showArchived
                            ? language.showActivePromptPresets
                            : language.showArchivedPromptPresets}
                        title={showArchived ? language.showActivePromptPresets : language.showArchivedPromptPresets}
                        onclick={toggleArchiveView}
                    >
                        {#if showArchived}
                            <ArchiveRestoreIcon size={18} />
                            <span>{language.activePromptPresets}</span>
                        {:else}
                            <ArchiveIcon size={18} />
                            <span>{language.archivedPromptPresets}</span>
                        {/if}
                    </button>
                {/if}
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24} />
                </button>
            </div>
        </div>
        {#if shownRef}
            <span class="text-textcolor2 text-sm mb-2">{language.chatBinding.forChat(shownChatName ?? "")}</span>
        {/if}
        {#if isPrompt && visibleEntries.length === 0}
            <span class="text-textcolor2 text-sm" data-preset-empty-state>
                {showArchived ? language.noArchivedPromptPresets : language.noActivePromptPresets}
            </span>
        {/if}
        <!-- `v` is the row's shown position (the drop slots and the numbers); actions go by the preset's id. -->
        {#each visibleEntries as entry, v}
            {@const preset = entry.preset}
            <div
                class="w-full transition-all duration-200"
                class:h-0.5={!isDragging || dragOverIndex !== v}
                class:h-1={isDragging && dragOverIndex === v}
                class:bg-blue-500={isDragging && dragOverIndex === v}
                class:shadow-lg={isDragging && dragOverIndex === v}
                class:hover:bg-gray-600={!isDragging}
                role="listitem"
                ondragover={(e) => {
                    if (!isPresetDrag(e)) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    dragOverIndex = v;
                }}
                ondragleave={(e) => {
                    dragOverIndex = -1;
                }}
                ondrop={(e) => {
                    handlePresetDrop(v, e);
                    dragOverIndex = -1;
                }}
            ></div>

            <button
                onclick={() => {
                    if (!editMode && selectListed(preset.id)) {
                        close();
                    }
                }}
                class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer"
                class:bg-selected={preset.id === selectedPresetId}
                class:draggable-preset={!editMode}
                draggable={!editMode ? "true" : "false"}
                onfocusin={() => (renaming = preset.id)}
                onfocusout={() => (renaming = null)}
                ondragstart={(e) => {
                    if (editMode) {
                        e.preventDefault();
                        return;
                    }
                    isDragging = true;
                    markPresetDrag(e, preset.id);

                    const dragElement = document.createElement("div");
                    dragElement.textContent = preset?.name || "Unnamed Preset";
                    dragElement.className =
                        "absolute -top-96 -left-96 px-4 py-2 bg-darkbg text-textcolor2 rounded-sm text-sm whitespace-nowrap shadow-lg pointer-events-none z-50";
                    document.body.appendChild(dragElement);
                    e.dataTransfer?.setDragImage(dragElement, 10, 10);

                    setTimeout(() => {
                        document.body.removeChild(dragElement);
                    }, 0);
                }}
                ondragend={(e) => {
                    isDragging = false;
                    dragOverIndex = -1;
                }}
                ondragover={(e) => {
                    if (!isPresetDrag(e)) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    const rect = e.currentTarget.getBoundingClientRect();
                    const mouseY = e.clientY;
                    const elementCenter = rect.top + rect.height / 2;

                    if (mouseY < elementCenter) {
                        dragOverIndex = v;
                    } else {
                        dragOverIndex = v + 1;
                    }
                }}
                ondrop={(e) => {
                    handlePresetDrop(dragOverIndex, e);
                    dragOverIndex = -1;
                }}
            >
                {#if editMode}
                    {#key preset.id}
                        <TextInput
                            bind:value={() => preset.name, (value) => (preset.name = value)}
                            placeholder="string"
                            padding={false}
                        />
                    {/key}
                {:else}
                    <!-- The Ctrl+1..9 numbers count the active presets (`hotkey.ts`), so the archived view has none. -->
                    {#if isPrompt && !showArchived && v < 9}
                        <span class="w-2 text-center mr-2 text-textcolor2">{v + 1}</span>
                    {/if}
                    {#if isPrompt && preset.image}
                        <img
                            src={preset.image}
                            alt="icon"
                            class="mr-2 min-w-6 min-h-6 w-6 h-6 rounded-md"
                            decoding="async"
                        />
                    {/if}
                    <span>{preset.name}</span>
                {/if}
                <div class="grow flex justify-end">
                    {#if isPrompt && settings.ui.showPromptComparison}
                        <div
                            class="{selectedDiffPreset === preset.id
                                ? 'text-green-500'
                                : 'text-textcolor2 hover:text-green-500'} cursor-pointer mr-2"
                            role="button"
                            tabindex="0"
                            onclick={(e) => {
                                e.stopPropagation();
                                handleDiffMode(preset.id);
                            }}
                            onkeydown={(e) => {
                                if (e.key === "Enter" && e.currentTarget instanceof HTMLElement) {
                                    e.currentTarget.click();
                                }
                            }}
                        >
                            <GitCompare size={18} />
                        </div>
                    {/if}
                    <div
                        class="text-textcolor2 hover:text-green-500 cursor-pointer mr-2"
                        role="button"
                        tabindex="0"
                        onclick={(e) => {
                            e.stopPropagation();
                            copyListed(preset.id);
                        }}
                        onkeydown={(e) => {
                            if (e.key === "Enter" && e.currentTarget instanceof HTMLElement) {
                                e.currentTarget.click();
                            }
                        }}
                    >
                        <CopyIcon size={18} />
                    </div>
                    {#if isPrompt}
                        {@const archiveLabel =
                            preset.archived === true ? language.restorePromptPreset : language.archivePromptPreset}
                        <div
                            class="text-textcolor2 hover:text-green-500 cursor-pointer mr-2"
                            role="button"
                            tabindex="0"
                            data-preset-archive-action
                            aria-label={`${archiveLabel}: ${preset.name ?? ""}`}
                            title={archiveLabel}
                            onclick={(e) => {
                                e.stopPropagation();
                                setArchived(preset.id, preset.archived !== true);
                            }}
                            onkeydown={(e) => {
                                if ((e.key === "Enter" || e.key === " ") && e.currentTarget instanceof HTMLElement) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.currentTarget.click();
                                }
                            }}
                        >
                            {#if preset.archived === true}
                                <ArchiveRestoreIcon size={18} />
                            {:else}
                                <ArchiveIcon size={18} />
                            {/if}
                        </div>
                        <div
                            class="text-textcolor2 hover:text-green-500 cursor-pointer mr-2"
                            role="button"
                            tabindex="0"
                            onclick={async (e) => {
                                e.stopPropagation();
                                downloadPreset(preset.id, "risupreset");
                            }}
                            onkeydown={(e) => {
                                if (e.key === "Enter" && e.currentTarget instanceof HTMLElement) {
                                    e.currentTarget.click();
                                }
                            }}
                        >
                            <Share2Icon size={18} />
                        </div>
                    {/if}
                    <div
                        class="text-textcolor2 hover:text-green-500 cursor-pointer"
                        role="button"
                        tabindex="0"
                        onclick={async (e) => {
                            e.stopPropagation();
                            await removeListed(preset.id, preset.name);
                        }}
                        onkeydown={(e) => {
                            if (e.key === "Enter" && e.currentTarget instanceof HTMLElement) {
                                e.currentTarget.click();
                            }
                        }}
                    >
                        <TrashIcon size={18} />
                    </div>
                </div>
            </button>
        {/each}

        <div
            class="w-full transition-all duration-200"
            class:h-0.5={!isDragging || dragOverIndex !== visibleEntries.length}
            class:h-1={isDragging && dragOverIndex === visibleEntries.length}
            class:bg-blue-500={isDragging && dragOverIndex === visibleEntries.length}
            class:shadow-lg={isDragging && dragOverIndex === visibleEntries.length}
            class:hover:bg-gray-600={!isDragging}
            role="listitem"
            ondragover={(e) => {
                if (!isPresetDrag(e)) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                dragOverIndex = visibleEntries.length;
            }}
            ondragleave={(e) => {
                dragOverIndex = -1;
            }}
            ondrop={(e) => {
                handlePresetDrop(visibleEntries.length, e);
                dragOverIndex = -1;
            }}
        ></div>

        <div class="flex mt-2 items-center">
            <!-- The archived view only lists: a new or imported preset starts active. -->
            {#if !showArchived}
                <button
                    class="text-textcolor2 hover:text-green-500 cursor-pointer mr-1"
                    onclick={() => {
                        addListed();
                    }}
                >
                    <PlusIcon />
                </button>
                {#if isPrompt}
                    <button
                        class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer"
                        onclick={() => {
                            importPreset();
                        }}
                    >
                        <HardDriveUploadIcon size={18} />
                    </button>
                {/if}
            {/if}
            <button
                class="text-textcolor2 hover:text-green-500 cursor-pointer"
                onclick={() => {
                    editMode = !editMode;
                }}
            >
                <PencilIcon size={18} />
            </button>
        </div>
        {#if isPrompt && !showArchived}
            <span class="text-textcolor2 text-sm">{language.quickPreset}</span>
        {/if}
    </div>
</div>

{#if showDiffModal && diffPair}
    <PromptDiffModal firstPresetId={diffPair.first} secondPresetId={diffPair.second} onClose={closeDiff} />
{/if}

<style>
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }

    /* Drag and drop styles */
    .draggable-preset:hover {
        cursor: grab;
    }

    .draggable-preset:active {
        cursor: grabbing;
    }

    .h-0\.5 {
        min-height: 2px;
        height: 2px;
    }

    .h-1 {
        min-height: 4px;
        height: 4px;
    }
</style>
