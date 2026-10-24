<script lang="ts">
    import type { SerializableHypaV3Data } from "src/ts/process/memory/hypav3";
    import { StarIcon } from "@lucide/svelte";
    import type { BulkEditState, Category } from "./types";
    import { language } from "src/lang";

    interface Props {
        /** The modal's editing copy of the memory data (its changes are saved by the modal). */
        hypaV3Data: SerializableHypaV3Data;
        bulkEditState: BulkEditState;
        categories: Category[];
        showImportantOnly: boolean;
        selectedCategoryFilter: string;
        onResummarize: () => void;
        onClearSelection: () => void;
        onUpdateSelectedCategory: (categoryId: string) => void;
        onUpdateBulkSelectInput: (input: string) => void;
        onApplyCategory: () => void;
        onToggleImportant: () => void;
        onParseAndSelectSummaries: () => void;
    }

    let {
        hypaV3Data,
        bulkEditState,
        categories,
        showImportantOnly,
        selectedCategoryFilter,
        onResummarize,
        onClearSelection,
        onUpdateSelectedCategory,
        onUpdateBulkSelectInput,
        onApplyCategory,
        onToggleImportant,
        onParseAndSelectSummaries,
    }: Props = $props();

    function applyCategoryToSelected() {
        onApplyCategory();
    }

    function bulkToggleImportant() {
        onToggleImportant();
    }

    function parseAndSelectSummaries() {
        onParseAndSelectSummaries();
    }

    function clearSelection() {
        onClearSelection();
    }

    function handleCategoryChange(event: Event) {
        const target = event.target as HTMLSelectElement;
        onUpdateSelectedCategory(target.value);
    }

    function handleBulkSelectInputChange(event: Event) {
        const target = event.target as HTMLInputElement;
        onUpdateBulkSelectInput(target.value);
    }

    function handleBulkSelectKeydown(e: KeyboardEvent) {
        if (e.key === "Enter") {
            parseAndSelectSummaries();
        }
    }
</script>

<!-- Bulk Edit Action Bar -->
{#if bulkEditState.isEnabled}
    <div class="sticky bottom-0 p-3 bg-darkbg border-t border-darkborderc rounded-b-lg">
        <div class="flex items-center justify-between">
            <!-- Left Side: Resummarize Button -->
            <div class="flex items-center gap-2">
                <!-- Resummarize Button -->
                <button
                    class="px-4 py-2 rounded text-sm font-medium transition-colors {bulkEditState.selectedSummaries
                        .size > 1
                        ? 'bg-success-600 hover:bg-success-700 text-neutral-50'
                        : 'bg-darkbutton text-textcolor2 cursor-not-allowed'}"
                    onclick={onResummarize}
                    disabled={bulkEditState.selectedSummaries.size < 2}
                >
                    {language.hypaV3Modal.reSummarize}
                </button>
            </div>

            <!-- Right Side: Category, Important, Bulk Select, Clear -->
            <div class="flex items-center gap-2">
                <!-- Category Selection -->
                <select
                    class="risu-select px-3 py-2 rounded-sm border border-darkborderc bg-bgcolor text-textcolor text-sm focus:outline-hidden focus:ring-2 focus:ring-borderc"
                    value={bulkEditState.selectedCategory}
                    onchange={handleCategoryChange}
                >
                    {#each categories as category}
                        <option value={category.id}>{category.name}</option>
                    {/each}
                </select>

                <!-- Apply Category Button -->
                <button
                    class="px-4 py-2 rounded text-sm font-medium transition-colors {bulkEditState.selectedSummaries
                        .size > 0
                        ? 'bg-primary-600 hover:bg-primary-700 text-neutral-50'
                        : 'bg-darkbutton text-textcolor2 cursor-not-allowed'}"
                    onclick={applyCategoryToSelected}
                    disabled={bulkEditState.selectedSummaries.size === 0}
                >
                    {language.apply}
                </button>

                <!-- Bulk Toggle Important Button -->
                <button
                    class="px-3 py-2 rounded-sm border border-secondary-600 hover:bg-secondary-700 text-secondary-300 text-sm transition-colors flex items-center gap-2 {bulkEditState
                        .selectedSummaries.size === 0
                        ? 'opacity-50 cursor-not-allowed'
                        : ''}"
                    onclick={bulkToggleImportant}
                    disabled={bulkEditState.selectedSummaries.size === 0}
                >
                    <StarIcon class="w-4 h-4" />
                </button>

                <!-- Bulk Select by Numbers -->
                <div class="flex gap-2">
                    <input
                        type="text"
                        value={bulkEditState.bulkSelectInput}
                        oninput={handleBulkSelectInputChange}
                        placeholder="1,3,5-8"
                        class="w-32 px-3 py-2 text-sm bg-darkbg border border-darkborderc rounded-sm text-textcolor placeholder:text-textcolor2 focus:border-borderc outline-hidden"
                        onkeydown={handleBulkSelectKeydown}
                    />
                    <button
                        class="px-3 py-2 rounded-sm border border-primary-600 hover:bg-primary-700 text-primary-300 text-sm transition-colors"
                        onclick={parseAndSelectSummaries}
                    >
                        {language.select}
                    </button>
                </div>

                <!-- Clear Selection Button -->
                <button
                    class="px-3 py-2 rounded-sm border border-danger-600 hover:bg-danger-700 text-danger-300 text-sm transition-colors"
                    onclick={clearSelection}
                >
                    {language.cancel}
                </button>
            </div>
        </div>
    </div>
{/if}
