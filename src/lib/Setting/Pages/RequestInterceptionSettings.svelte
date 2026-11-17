<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
    import type { PromptType } from "src/ts/process/prompt";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { newId } from "../../../../shared/ids.ts";
    import { MAX_REQUEST_INTERCEPTIONS, type RequestInterception } from "../../../../shared/llm/interception.ts";
    import { MODEL_MODES, type ModelModeExtended } from "../../../../shared/llm/request.ts";

    /**
     * The global request interception list (`settings.providers.requestInterceptions`). Every edit of a rule's own
     * fields and of the list assigns a new array; the prompt row edits the rule's prompt in place through the record
     * wrapper, as the template editor does. Controls resolve their rule by id on every read (`liveRule`): a rule edit
     * replaces the element, and a wrapper of the old element throws once it is gone. List order is insertion order,
     * so reordering, removal, and the opened rows follow `PromptSettings.svelte`'s index handling.
     */

    const PLAIN_ONLY: readonly PromptType[] = ["plain"];

    const rules = $derived(settings.providers.requestInterceptions ?? []);
    let draggedIndex = $state(-1);
    let dragOverIndex = $state(-1);
    let openedItemIndices = $state(new Set<number>());

    function currentRules(): RequestInterception[] {
        return settings.providers.requestInterceptions ?? [];
    }

    const liveRule = (id: string) => currentRules().find((rule) => rule.id === id);

    /** The row's prompt binding: field edits land in place; only a whole new prompt object replaces the rule. */
    function setPrompt(id: string, prompt: RequestInterception["prompt"]) {
        if (liveRule(id)?.prompt === prompt) return;
        update(id, (rule) => ({ ...rule, prompt }));
    }

    function update(id: string, edit: (rule: RequestInterception) => RequestInterception) {
        const current = currentRules();
        if (!current.some((rule) => rule.id === id)) return;
        settings.providers.requestInterceptions = current.map((rule) => (rule.id === id ? edit(rule) : rule));
    }

    function setEnabled(id: string, enabled: boolean) {
        update(id, (rule) => ({ ...rule, enabled }));
    }

    function setMode(id: string, mode: ModelModeExtended, checked: boolean) {
        update(id, (rule) => ({
            ...rule,
            modes: MODEL_MODES.filter((known) => (known === mode ? checked : rule.modes.includes(known))),
        }));
    }

    function setPosition(id: string, value: string | number) {
        if (value !== "start" && value !== "end") return;
        update(id, (rule) => ({ ...rule, position: value }));
    }

    function modeLabel(mode: ModelModeExtended): string {
        if (mode === "model") return language.model;
        if (mode === "submodel") return language.submodel;
        return language.modelProfiles.auxModes[mode];
    }

    function add() {
        const current = currentRules();
        if (current.length >= MAX_REQUEST_INTERCEPTIONS) return;
        settings.providers.requestInterceptions = [
            ...current,
            {
                id: newId(),
                enabled: true,
                modes: ["model"],
                position: "start",
                prompt: { type: "plain", type2: "normal", text: "", role: "system" },
            },
        ];
    }

    function remove(index: number, id: string) {
        const current = currentRules();
        if (current[index]?.id !== id) return;
        settings.providers.requestInterceptions = current.filter((_, i) => i !== index);

        const newOpenedIndices = new Set<number>();
        openedItemIndices.forEach((opened) => {
            if (opened === index) {
                return;
            } else if (opened > index) {
                newOpenedIndices.add(opened - 1);
            } else {
                newOpenedIndices.add(opened);
            }
        });
        openedItemIndices = newOpenedIndices;

        draggedIndex = -1;
        dragOverIndex = -1;
    }

    /** Swaps the rule at `index` with its neighbour at `index + step`, keeping each opened row opened. */
    function move(index: number, id: string, step: 1 | -1) {
        const current = currentRules();
        const target = index + step;
        if (current[index]?.id !== id || target < 0 || target >= current.length) return;
        const next = [...current];
        next[index] = current[target];
        next[target] = current[index];
        settings.providers.requestInterceptions = next;

        const newOpenedIndices = new Set<number>();
        openedItemIndices.forEach((opened) => {
            if (opened === index) {
                newOpenedIndices.add(target);
            } else if (opened === target) {
                newOpenedIndices.add(index);
            } else {
                newOpenedIndices.add(opened);
            }
        });
        openedItemIndices = newOpenedIndices;
    }

    /** The rows in display order (the drag preview included), as plain ids: a row never holds an element wrapper. */
    function displayRules() {
        const items = rules.map((rule, i) => ({ id: rule.id, originalIndex: i, displayIndex: i }));
        if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
            return items;
        }
        const [movedItem] = items.splice(draggedIndex, 1);
        const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex;
        items.splice(adjustedDropIndex, 0, movedItem);
        return items.map((item, displayIndex) => ({ ...item, displayIndex }));
    }

    function handleDrop() {
        if (draggedIndex === -1 || dragOverIndex === -1 || draggedIndex === dragOverIndex) {
            return;
        }

        const next = [...currentRules()];
        const [movedItem] = next.splice(draggedIndex, 1);

        const adjustedDropIndex = draggedIndex < dragOverIndex ? dragOverIndex - 1 : dragOverIndex;
        next.splice(adjustedDropIndex, 0, movedItem);

        const newOpenedIndices = new Set<number>();
        openedItemIndices.forEach((index) => {
            if (index === draggedIndex) {
                newOpenedIndices.add(adjustedDropIndex);
            } else if (draggedIndex < adjustedDropIndex) {
                if (index > draggedIndex && index <= adjustedDropIndex) {
                    newOpenedIndices.add(index - 1);
                } else {
                    newOpenedIndices.add(index);
                }
            } else {
                if (index >= adjustedDropIndex && index < draggedIndex) {
                    newOpenedIndices.add(index + 1);
                } else {
                    newOpenedIndices.add(index);
                }
            }
        });
        openedItemIndices = newOpenedIndices;

        settings.providers.requestInterceptions = next;
        draggedIndex = -1;
        dragOverIndex = -1;
    }
</script>

<h2 class="text-lg mb-2">{language.requestInterception.title}</h2>
<div class="flex flex-col gap-2 text-sm text-textcolor2 mb-4 break-words">
    <p>{language.requestInterception.description}</p>
</div>

<div class="contain w-full max-w-full flex flex-col rounded-md min-w-0">
    {#if rules.length === 0}
        <p class="text-sm text-textcolor2">{language.requestInterception.empty}</p>
    {/if}
    {#each displayRules() as entry (entry.id)}
        {@const ruleId = entry.id}
        <div class="min-w-0" data-request-interception={ruleId}>
            <PromptDataItem
                bind:promptItem={() => liveRule(ruleId)!.prompt, (value) => setPrompt(ruleId, value)}
                popupEditorContext={ruleId}
                allowedTypes={PLAIN_ONLY}
                showType2={false}
                cbs={false}
                isDragging={draggedIndex === entry.originalIndex}
                isOpened={openedItemIndices.has(entry.originalIndex)}
                bind:draggedIndex
                bind:dragOverIndex
                bind:openedItemIndices
                currentIndex={entry.originalIndex}
                displayIndex={entry.displayIndex}
                onDrop={handleDrop}
                onRemove={() => remove(entry.originalIndex, ruleId)}
                moveDown={() => move(entry.originalIndex, ruleId, 1)}
                moveUp={() => move(entry.originalIndex, ruleId, -1)}
            >
                {#snippet extra()}
                    <Check
                        name={language.requestInterception.enabled}
                        bind:check={() => liveRule(ruleId)?.enabled ?? false, (value) => setEnabled(ruleId, value)}
                    />
                    <span class="mt-2">{language.requestInterception.modes}</span>
                    <div class="flex flex-wrap gap-x-4">
                        {#each MODEL_MODES as mode (mode)}
                            <Check
                                name={modeLabel(mode)}
                                bind:check={
                                    () => liveRule(ruleId)?.modes.includes(mode) ?? false,
                                    (value) => setMode(ruleId, mode, value)
                                }
                            />
                        {/each}
                    </div>
                    <span class="mt-2">{language.requestInterception.position}</span>
                    <SelectInput
                        bind:value={() => liveRule(ruleId)?.position ?? "start", (value) => setPosition(ruleId, value)}
                    >
                        <OptionInput value="start">{language.requestInterception.start}</OptionInput>
                        <OptionInput value="end">{language.requestInterception.end}</OptionInput>
                    </SelectInput>
                {/snippet}
            </PromptDataItem>
        </div>
    {/each}
</div>

<div class="mt-4">
    <Button size="sm" disabled={rules.length >= MAX_REQUEST_INTERCEPTIONS} onclick={add}>
        {language.requestInterception.add}
    </Button>
</div>

<div class="mt-6 flex flex-col gap-2 text-sm text-textcolor2 break-words">
    <h3 class="text-textcolor">{language.requestInterception.notesTitle}</h3>
    <ul class="list-disc pl-5 flex flex-col gap-1">
        {#each language.requestInterception.notes as note, i (i)}
            <li>{note}</li>
        {/each}
    </ul>
</div>
