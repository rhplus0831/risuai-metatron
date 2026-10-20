<script module lang="ts">
    import { type loreBook } from "src/ts/storage/database.svelte";
    import { type PreparedQuery, matchesAny } from "src/ts/util/koreanSearch";

    /**
     * The one filter of a recursive list: the outermost `LoreBookList` owns the query and the
     * matches; each nested (folder) list reads them and adds its folder to `chain`.
     */
    interface LoreFilter {
        readonly query: PreparedQuery | null;
        readonly matches: Set<loreBook> | null;
        /** The folder keys shown by this list and the lists above it. */
        readonly chain: readonly string[];
    }
    const LORE_FILTER = Symbol("loreFilter");

    /**
     * The entries a query shows (Decision 5): an entry on its `comment`, `key` and `secondkey` (a
     * chat's `child` link also on the entry it links, whose name it shows), a folder on its name.
     * A folder whose name matches shows all of its entries; a shown entry shows its folders.
     */
    function filterMatches(
        list: readonly loreBook[],
        query: PreparedQuery,
        linked: (id: string) => loreBook | undefined,
    ): Set<loreBook> {
        const fields = (book: loreBook) => [book.comment, book.key, book.secondkey];
        const ownMatch = (book: loreBook) => {
            if (book.mode === "folder") return matchesAny([book.comment], query);
            if (matchesAny(fields(book), query)) return true;
            const parent = book.mode === "child" && book.id ? linked(book.id) : undefined;
            return !!parent && matchesAny(fields(parent), query);
        };
        const folders = new Map<string, loreBook>();
        for (const book of list) {
            if (book.mode === "folder" && !folders.has(book.key)) folders.set(book.key, book);
        }
        const shown = new Set<loreBook>();
        for (const book of list) {
            const chain: loreBook[] = [];
            let named = false;
            for (let key = book.folder; key;) {
                const parent = folders.get(key);
                // A folder inside itself (an imported list can hold one) ends the walk.
                if (!parent || parent === book || chain.includes(parent)) break;
                chain.push(parent);
                named ||= matchesAny([parent.comment], query);
                key = parent.folder;
            }
            if (named || ownMatch(book)) {
                shown.add(book);
                for (const parent of chain) shown.add(parent);
            }
        }
        return shown;
    }
</script>

<script lang="ts">
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings, selectedLoreBookPage } from "src/ts/storage/settingsViews.svelte";
    import LoreBookData from "./LoreBookData.svelte";
    import Sortable from "sortablejs/modular/sortable.core.esm.js";
    import { DetachedWrapperError, replaceRecordList } from "src/ts/storage/records.svelte";
    import { getContext, onDestroy, onMount, setContext, tick, untrack } from "svelte";
    import { sleep, sortableOptions } from "src/ts/util";
    import { v4 } from "uuid";
    import { alertError } from "src/ts/alert";
    import { useLocalLoreDraft } from "src/ts/storage/localLoreDraft.svelte";
    import { language } from "src/lang";
    import { prepareQuery } from "src/ts/util/koreanSearch";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";

    const currentCharacter = $derived(selectedCharacter());
    // The selected chat's local lorebook is edited on a copy that is saved through the chat module.
    const localLore = useLocalLoreDraft();

    let reinitializeSortable = false;

    interface Props {
        globalMode?: boolean;
        submenu?: number;
        lorePlus?: boolean;
        externalLoreBooks?: loreBook[];
        showFolder?: string;
    }

    let {
        globalMode = false,
        submenu = 0,
        lorePlus = false,
        externalLoreBooks = null,
        showFolder = "",
    }: Props = $props();
    let stb: Sortable = null;
    // The `disabled` option `stb` has now (set while the filter is non-empty).
    let stbDisabled = false;
    let ele: HTMLDivElement = $state();
    let sorted = $state(0);
    let idgroup = "a" + v4(); //make should it starts with alphabetic character

    // Filter. Only the outermost list renders the field; a folder's nested list (mounted by
    // `LoreBookData`) reads the root's query and matches through context.
    const parentFilter = getContext<LoreFilter | undefined>(LORE_FILTER);
    const isRootList = !parentFilter;
    // The query resets when the shown list's owner changes: the character, the chat, or the tab
    // between them. A module's list is remounted by `ModuleSettings` for another module.
    const filterOwner = $derived(
        externalLoreBooks
            ? "module"
            : submenu === 1
              ? `chat\u0000${localLore.key}`
              : `character\u0000${currentCharacter?.chaId ?? ""}`,
    );
    let query = $derived.by(() => {
        filterOwner;
        return "";
    });
    const preparedQuery = $derived(isRootList ? prepareQuery(query) : null);
    // Matched once for the whole list (nested lists show the same array). The entries are read as a
    // tracked copy, so any membership change matches again; their fields are read untracked, so a
    // row renamed under the filter stays shown while it is edited.
    const rootMatches = $derived.by(() => {
        const prepared = preparedQuery;
        if (!prepared) return null;
        try {
            const list = shownList();
            const books = list ? [...list] : [];
            return untrack(() =>
                filterMatches(books, prepared, (id) => selectedCharacter()?.globalLore.find((e) => e.id === id)),
            );
        } catch (error) {
            // The list can belong to a removed record (for example a deleted module).
            if (error instanceof DetachedWrapperError) return new Set<loreBook>();
            throw error;
        }
    });
    const folderChain = $derived([...(parentFilter?.chain ?? []), showFolder || ""]);
    setContext<LoreFilter>(
        LORE_FILTER,
        parentFilter
            ? {
                  get query() {
                      return parentFilter.query;
                  },
                  get matches() {
                      return parentFilter.matches;
                  },
                  get chain() {
                      return folderChain;
                  },
              }
            : {
                  get query() {
                      return preparedQuery;
                  },
                  get matches() {
                      return rootMatches;
                  },
                  get chain() {
                      return folderChain;
                  },
              },
    );
    const filtering = () => (parentFilter ? parentFilter.query : preparedQuery) !== null;
    const matches = $derived(parentFilter ? parentFilter.matches : rootMatches);
    /** Whether the filter hides `book` (a row the shown list holds). */
    const filteredOut = (book: loreBook) => !!matches && !matches.has(book);
    /**
     * A shown folder is expanded while filtering, without writing `openedRefs`. A folder whose key
     * this list or one above it already shows is not (an imported list can repeat a key).
     */
    const filterOpens = (book: loreBook, index: number) =>
        !!matches &&
        matches.has(book) &&
        !!listHolding(book, index) &&
        book.mode === "folder" &&
        !folderChain.includes(book.key);

    // DOM stabilization waiting function
    const waitForDOMReady = async () => {
        // 1. Wait for Svelte tick - component state update completion
        await tick();

        // 2. Wait for next frame - DOM rendering completion
        await new Promise((resolve) => requestAnimationFrame(resolve));

        // 3. Element validity verification
        if (!ele || !ele.isConnected) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (!ele || !ele.isConnected) {
                throw new Error("Container element is not ready");
            }
        }

        // Drag is off while filtering: no instance is created to wait for.
        if (untrack(filtering)) return;

        // 4. Calculate expected number of child elements
        let expectedElements = 0;
        if (externalLoreBooks) {
            expectedElements = externalLoreBooks.filter(
                (item) => (!showFolder && !item.folder) || showFolder === item.folder,
            ).length;
        } else if (submenu === 1) {
            expectedElements = localLore.value.filter(
                (item) => (!showFolder && !item.folder) || showFolder === item.folder,
            ).length;
        } else if (globalMode) {
            expectedElements = settings.loreBook[selectedLoreBookPage()].data.filter(
                (item) => (!showFolder && !item.folder) || showFolder === item.folder,
            ).length;
        } else {
            expectedElements = currentCharacter.globalLore.filter(
                (item) => (!showFolder && !item.folder) || showFolder === item.folder,
            ).length;
        }

        // 5. Wait until all child elements are rendered (max 200ms)
        let attempts = 0;
        const maxAttempts = 20;
        while (ele.children.length < expectedElements && attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
        }

        // 6. Final stabilization wait (short time)
        await new Promise((resolve) => setTimeout(resolve, 10));
    };

    // SortableJS recreation function
    const recreateStb = async () => {
        try {
            stb.destroy();
        } catch (error) {
            // Ignore destroy failure (may already be removed)
        }

        // Svelte reactivity trigger - force re-render {#key} block by changing sorted value
        sorted += 1;

        // Wait for DOM stabilization (dynamic measurement)
        try {
            await waitForDOMReady();
        } catch (error) {
            console.warn("DOM stabilization failed:", error);
            // Fallback to short fixed wait
            await sleep(100);
        }

        // Reactivate drag function only when lorebook detail is not open
        // (drag should be disabled when detail is open)
        if (openedDetails === 0) {
            try {
                createStb(); // Create new SortableJS instance
            } catch (error) {
                console.error("Failed to recreate sortable:", error);
                // Retry
                await sleep(50);
                try {
                    createStb();
                } catch (retryError) {
                    console.error("Retry failed:", retryError);
                }
            }
        }
    };

    const createStb = () => {
        // No drag reorders a filtered view: every instance starts disabled while filtering.
        const disabled = untrack(filtering);
        stbDisabled = disabled;
        stb = Sortable.create(ele, {
            ...sortableOptions,
            disabled,
            group: "lorebook", // Enable cross-container drag
            swapThreshold: 0.9, // More sensitive drag response
            preventOnFilter: false, // Allow click events on filtered elements
            animation: 150, // Animation
            chosenClass: "risu-chosen-item", // Class for the item being dragged
            ghostClass: "risu-ghost-item", // Class for the drop placeholder

            onEnd: async (evt) => {
                // Basic condition check
                if (!evt.from || !evt.to) {
                    alertError("Error: 'evt.from' or 'evt.to' is null");
                    await recreateStb();
                    return;
                }

                if (evt.oldIndex === undefined || evt.newIndex === undefined) {
                    alertError("Error: oldIndex or newIndex is undefined");
                    await recreateStb();
                    return;
                }

                // Cancel movement; a drag that ends after the filter started writes nothing either
                if ((evt.oldIndex === evt.newIndex && evt.from === evt.to) || untrack(filtering)) {
                    // The re-render below rebuilds this list only: take the row back from another one.
                    if (evt.item.parentNode !== evt.from) {
                        evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex] ?? null);
                    }
                    await recreateStb();
                    return;
                }

                // ===== Stage 1: Revert SortableJS DOM manipulation =====
                // SortableJS automatically manipulates DOM upon drag completion,
                // but Svelte uses data-driven rendering, so DOM manipulation must be invalidated
                const originalParent = evt.from; // Drag start container
                const originalIndex = evt.oldIndex; // Drag start position

                // Invalidate DOM manipulation: return item to original position
                // (so Svelte can render correctly after data change)
                if (originalParent && evt.item.parentNode !== originalParent) {
                    const referenceNode = originalParent.children[originalIndex];
                    if (referenceNode) {
                        // Insert before if another element exists at original position
                        originalParent.insertBefore(evt.item, referenceNode);
                    } else {
                        // Append to end if original position was last
                        originalParent.appendChild(evt.item);
                    }
                }

                // ===== Stage 2: Collect drag event information =====
                // Identify source and target folders (using data-show-folder attribute)
                const sourceFolder = evt.from.getAttribute("data-show-folder") || "";
                const targetFolder = evt.to.getAttribute("data-show-folder") || "";
                const oldIndex = evt.oldIndex; // Drag start index provided by SortableJS
                const newIndex = evt.newIndex; // Drag end index provided by SortableJS

                // ===== Stage 3: Identify current data array =====
                // Select the correct data array based on component props and state
                let currentArray: loreBook[];
                if (externalLoreBooks) {
                    // Use externally passed lorebook array
                    currentArray = externalLoreBooks;
                } else if (submenu === 1) {
                    // Use local chat lorebook
                    currentArray = localLore.value;
                } else if (globalMode) {
                    // Use global lorebook
                    currentArray = settings.loreBook[selectedLoreBookPage()].data;
                } else {
                    // Use character global lorebook (default)
                    currentArray = currentCharacter.globalLore;
                }

                const sourceIdx = oldIndex; // Store SortableJS provided index

                let realSourceIdx = sourceIdx;

                // Abort if invalid index (0 is valid index, so check !== undefined)
                if (realSourceIdx === undefined || realSourceIdx === null || realSourceIdx < 0) return;
                const movedItem = currentArray[realSourceIdx]; // Actual item to move
                if (!movedItem) return;

                // ===== Stage 4: Array reconstruction and data application (improved logic) =====

                // 4-1. Create copies of item to move and array
                const newArray = [...currentArray]; // Copy array
                const updatedMovedItem = { ...movedItem }; // Copy item to move
                let moveFolder = false;

                // 4-2. Change folder property of copied item
                if (sourceFolder !== targetFolder) {
                    if (targetFolder) {
                        updatedMovedItem.folder = targetFolder;
                    } else {
                        delete updatedMovedItem.folder;
                    }
                    moveFolder = true;
                }

                // 4-3. Sort item to appropriate position
                let finalNewIndex = newIndex; // Final insertion position
                if (moveFolder && oldIndex < newIndex) {
                    finalNewIndex -= 1; // Adjust index when moving folder
                }

                // 4-3-1. Move item in array using oldIndex and modified finalNewIndex
                // First remove original item from array

                newArray.splice(realSourceIdx, 1);

                // SortableJS newIndex means final target position, so use without adjustment
                let adjustedFinalIndex = finalNewIndex;

                // Only perform range check
                if (adjustedFinalIndex > newArray.length) {
                    adjustedFinalIndex = newArray.length;
                }

                // For debugging: output drag and drop information
                /*
                alertError('=== Drag and Drop Debugging Info ===\n' +
                          'finalNewIndex: ' + finalNewIndex + '\n' +
                          'realSourceIdx: ' + realSourceIdx + '\n' +
                          'newArray.length (제거 후): ' + newArray.length + '\n' +
                          'adjustedFinalIndex: ' + adjustedFinalIndex + '\n' +
                          'oldIndex < newIndex: ' + (moveFolder && oldIndex < newIndex));*/

                // Insert updated item at new position
                newArray.splice(adjustedFinalIndex, 0, updatedMovedItem);

                // 4-3-2. Reorganize entire array according to folder structure
                const sortedArray = [];
                const processedItems = new Set();

                // Maintain basic order while organizing folder structure only
                for (const item of newArray) {
                    if (processedItems.has(item)) continue;

                    // Add current item first (whether folder or regular item)
                    sortedArray.push(item);
                    processedItems.add(item);

                    // If current item is a folder, add items belonging to that folder immediately after
                    if (item.mode === "folder") {
                        for (const subItem of newArray) {
                            if (processedItems.has(subItem)) continue;
                            if (subItem.folder === item.key) {
                                sortedArray.push(subItem);
                                processedItems.add(subItem);
                            }
                        }
                    }
                }

                // Assign final sorted array to newArray
                newArray.splice(0, newArray.length, ...sortedArray);

                // For debugging: output current array and new array
                /*alertErrorWait('=== Drag and Drop Debugging Info ===\n' +
                      'oldIndex: ' + oldIndex + ', newIndex: ' + newIndex + '\n' +
                      'Original Array:\n' + JSON.stringify(currentArray, null, 2) + '\n\n' +
                      'Final Sorted Array:\n' + JSON.stringify(newArray, null, 2));*/

                // 4-4. Apply final changed array to appropriate data store
                if (externalLoreBooks) {
                    // Arrays passed as props must be modified internally to reflect in parent
                    // One write when it is a record's list (a module's lorebook, Phase 6 slice 4).
                    replaceRecordList(externalLoreBooks, newArray);
                } else if (submenu === 1) {
                    localLore.value = newArray;
                } else if (globalMode) {
                    settings.loreBook[selectedLoreBookPage()].data = newArray;
                } else {
                    currentCharacter.globalLore = newArray;
                }

                // ===== Stage 5: Force UI synchronization and SortableJS reinitialization =====
                // Remove existing SortableJS instance (prevent DOM inconsistency due to data change)
                await recreateStb();
            },
        });
    };

    onMount(createStb);

    // Turn drag off while filtering and back on after clearing (an instance created meanwhile
    // already has the current state).
    $effect(() => {
        const disabled = filtering();
        untrack(() => {
            if (stb && stbDisabled !== disabled) {
                stb.option("disabled", disabled);
                stbDisabled = disabled;
            }
        });
    });

    // Rows are keyed by their entry and bind to the entry they were mounted for (D1). A row whose
    // entry the shown list no longer holds (deleted, or the list now belongs to another character,
    // chat, or module) gets a throwaway entry: a write it still makes while it unmounts (a focused
    // prompt's `change` as Chrome removes it) lands nowhere, and reading it never throws.
    const shownList = (): loreBook[] => {
        if (externalLoreBooks) return externalLoreBooks;
        if (submenu === 1) return localLore.value;
        if (globalMode) return settings.loreBook[selectedLoreBookPage()].data;
        return selectedCharacter()?.globalLore;
    };
    const listHolding = (book: loreBook, index = -1): loreBook[] | null => {
        try {
            const list = shownList();
            // Derived membership can be stale while a nested list is inert/destroyed. Read the
            // live list, using the row index only as a hint: identity must still match. This keeps
            // repeated binding reads O(1) in the usual case, with a scan only after a row moves.
            return list && (list[index] === book || list.includes(book)) ? list : null;
        } catch (error) {
            // The list itself can belong to a removed record (for example a deleted module).
            if (error instanceof DetachedWrapperError) return null;
            throw error;
        }
    };
    const goneEntry = (): loreBook => ({
        key: "",
        comment: "",
        content: "",
        mode: "normal",
        insertorder: 100,
        alwaysActive: false,
        secondkey: "",
        selective: false,
    });
    const liveEntry = (book: loreBook, index: number) => (listHolding(book, index) ? book : goneEntry());
    const replaceEntry = (book: loreBook, next: loreBook) => {
        const list = listHolding(book);
        if (!list) return;
        const index = list.indexOf(book);
        if (index !== -1) list[index] = next;
    };
    /** Removes `book` (a folder with its entries) from the shown list, if the list still holds it. */
    const removeEntry = (book: loreBook) => {
        const lore = listHolding(book);
        if (!lore) return;
        if (openedRefs.has(book)) {
            onClose(!book.folder, book);
        }
        if (book.mode === "folder") {
            // Close items belonging to the folder if they are open
            lore.forEach((item) => {
                if (item.folder === book.key && openedRefs.has(item)) {
                    onClose(true, item);
                }
            });
            // Filter out the folder and all items belonging to it, in place (one write of the list)
            replaceRecordList(
                lore,
                lore.filter((item) => item !== book && item.folder !== book.key),
            );
        } else {
            const index = lore.indexOf(book);
            if (index !== -1) lore.splice(index, 1);
        }
    };

    let openedDetails = 0; // Count only lorebook details (for drag deactivation)
    let openedRefs = $state(new Set()); // Track both folders + lorebooks (for UI state)

    // Derived state to calculate number of open folders
    let openFolders = $derived(() => {
        let count = 0;
        for (const ref of openedRefs) {
            // A ref the list no longer holds may be a removed record element: never read it.
            if (!listHolding(ref as loreBook)) continue;
            if (ref && typeof ref === "object" && "mode" in ref && ref.mode === "folder") {
                count++;
            }
        }
        return count;
    });

    const onOpen = (isDetail: boolean = true, bookRef?: any) => {
        if (isDetail) {
            // Disable drag only when lorebook detail opens
            openedDetails += 1;
            if (stb) {
                try {
                    stb.destroy();
                } catch (error) {}
            }
        }
        if (bookRef) {
            openedRefs.add(bookRef);
            openedRefs = new Set(openedRefs); // Trigger reactivity
        }
    };
    const onClose = (isDetail: boolean = true, bookRef?: any) => {
        if (isDetail) {
            // Consider reactivating drag only when lorebook detail closes
            openedDetails -= 1;
            if (openedDetails === 0) {
                createStb();
            }
        }
        if (bookRef) {
            openedRefs.delete(bookRef);
            openedRefs = new Set(openedRefs); // Trigger reactivity
        }
    };

    onDestroy(() => {
        if (stb) {
            try {
                stb.destroy();
            } catch (error) {}
        }
    });
</script>

{#if isRootList && !globalMode}
    <TextInput
        size="sm"
        fullwidth
        className="mb-2"
        placeholder={language.search}
        bind:value={() => query, (next) => (query = next)}
    />
{/if}
{#key sorted}
    <div
        class="border-solid border-selected p-2 flex flex-col border-1 rounded-md"
        bind:this={ele}
        data-show-folder={showFolder || ""}
    >
        {#if globalMode}
            <!--
                This was a place for global lorebooks, but it was removed :)
            -->
        {:else if externalLoreBooks}
            {@const visibleItems = externalLoreBooks.filter(
                (book) => ((!showFolder && !book.folder) || showFolder === book.folder) && !filteredOut(book),
            )}
            {@const lastVisibleItem = visibleItems[visibleItems.length - 1]}
            {#if externalLoreBooks.length === 0}
                <span class="text-textcolor2">No Lorebook</span>
            {:else}
                {#each externalLoreBooks as book, i (book)}
                    {#if (!showFolder && !book.folder) || showFolder === book.folder}
                        <LoreBookData
                            {idgroup}
                            bind:value={() => liveEntry(book, i), (next) => replaceEntry(book, next)}
                            idx={i}
                            isOpen={!!listHolding(book, i) && openedRefs.has(book)}
                            forceOpen={filterOpens(book, i)}
                            hidden={filteredOut(book)}
                            openFolders={openFolders()}
                            isLastInContainer={book === lastVisibleItem}
                            onRemove={() => removeEntry(book)}
                            onOpen={(isDetail = true) => onOpen(isDetail, book)}
                            onClose={(isDetail = true) => onClose(isDetail, book)}
                            bind:externalLoreBooks
                        />
                    {:else}
                        <!-- Hidden marker for filtered items (for SortableJS) -->
                        <div data-risu-idx={i} data-risu-idgroup={idgroup} style="display: none;"></div>
                    {/if}
                {/each}
            {/if}
        {:else if submenu === 0}
            {@const visibleItems = currentCharacter.globalLore.filter(
                (book) => ((!showFolder && !book.folder) || showFolder === book.folder) && !filteredOut(book),
            )}
            {@const lastVisibleItem = visibleItems[visibleItems.length - 1]}
            {#if currentCharacter.globalLore.length === 0}
                <span class="text-textcolor2">No Lorebook</span>
            {:else}
                {#each currentCharacter.globalLore as book, i (book)}
                    {#if (!showFolder && !book.folder) || showFolder === book.folder}
                        <LoreBookData
                            {idgroup}
                            bind:value={() => liveEntry(book, i), (next) => replaceEntry(book, next)}
                            idx={i}
                            isOpen={!!listHolding(book, i) && openedRefs.has(book)}
                            forceOpen={filterOpens(book, i)}
                            hidden={filteredOut(book)}
                            openFolders={openFolders()}
                            isLastInContainer={book === lastVisibleItem}
                            onRemove={() => removeEntry(book)}
                            onOpen={(isDetail = true) => onOpen(isDetail, book)}
                            onClose={(isDetail = true) => onClose(isDetail, book)}
                            {lorePlus}
                            bind:externalLoreBooks={currentCharacter.globalLore}
                        />
                    {:else}
                        <!-- Hidden marker for filtered items (for SortableJS) -->
                        <div data-risu-idx={i} data-risu-idgroup={idgroup} style="display: none;"></div>
                    {/if}
                {/each}
            {/if}
        {:else if submenu === 1}
            {@const visibleItems = localLore.value.filter(
                (book) => ((!showFolder && !book.folder) || showFolder === book.folder) && !filteredOut(book),
            )}
            {@const lastVisibleItem = visibleItems[visibleItems.length - 1]}
            {#if localLore.value.length === 0}
                <span class="text-textcolor2">No Lorebook</span>
            {:else}
                {#each localLore.value as book, i (book)}
                    {#if (!showFolder && !book.folder) || showFolder === book.folder}
                        <LoreBookData
                            {idgroup}
                            bind:value={() => liveEntry(book, i), (next) => replaceEntry(book, next)}
                            idx={i}
                            isOpen={!!listHolding(book, i) && openedRefs.has(book)}
                            forceOpen={filterOpens(book, i)}
                            hidden={filteredOut(book)}
                            openFolders={openFolders()}
                            isLastInContainer={book === lastVisibleItem}
                            onRemove={() => removeEntry(book)}
                            onOpen={(isDetail = true) => onOpen(isDetail, book)}
                            onClose={(isDetail = true) => onClose(isDetail, book)}
                            {lorePlus}
                            bind:externalLoreBooks={localLore.value}
                        />
                    {:else}
                        <!-- Hidden marker for filtered items (for SortableJS) -->
                        <div data-risu-idx={i} data-risu-idgroup={idgroup} style="display: none;"></div>
                    {/if}
                {/each}
            {/if}
        {/if}
    </div>
{/key}
