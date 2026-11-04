<script lang="ts">
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import {
        type MemoryTestResultView,
        readStructuredMemoryDefaultPrompts,
    } from "src/ts/process/structuredMemory.svelte";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import { currentChatRef } from "src/ts/storage/chatStore.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import type {
        StructuredMemoryDefaultPromptsAnswer,
        StructuredMemorySettings,
        StructuredMemorySlotWarnings,
    } from "../../../../shared/structuredMemory.ts";
    import { pressMemoryTest } from "../../Others/StructuredMemory/memoryRecordPress";
    import { codeText, memoryReadFailureText, memoryReasonText } from "../../Others/StructuredMemory/memoryText";

    /**
     * The preset's `fineTuning`, `analysisPrompt`, and `patchPrompt` controls. Enabling asks first and
     * seeds only blank texts from server/src/routes/structuredMemory.ts's default-prompts answer; a
     * failed read leaves fine-tuning off. Disabling preserves texts. Seeded frames are copies and never
     * follow later default-frame changes. The same answer supplies the displayed defaults; `promptGuide`
     * in src/lang/en.ts supplies the instructions shown here.
     *
     * `pressMemoryTest` in src/lib/Others/StructuredMemory/memoryRecordPress.ts runs the open chat's
     * writer test. It first flushes pending settings through src/ts/process/serverCommands.ts; the test
     * writes no memory records, while request and job logs remain. Its window may be a replay or the
     * first open cadence window. Results and all server/model data render as plain text.
     */

    interface Props {
        /** The preset's writer settings as read, every field filled. */
        structured: StructuredMemorySettings;
        /** The preset's id, which the popup editor keys its drafts by. */
        presetId: string | undefined;
        /** Changes the preset's writer settings, as the parent stores them. */
        setStructured: (change: (structured: StructuredMemorySettings) => void) => void;
    }

    let { structured, presetId, setStructured }: Props = $props();

    const text = language.structuredMemory.settings;
    const receiptText = language.structuredMemory.receipt;
    const resultText = text.testResult;

    let defaults = $state<StructuredMemoryDefaultPromptsAnswer | null>(null);
    let defaultsFailure = $state<string | null>(null);
    let showDefaults = $state(false);
    let ticking = $state(false);
    let testing = $state(false);
    let result = $state<MemoryTestResultView | null>(null);

    const chatRef = $derived(currentChatRef());
    const owner = $derived(characterList().find((entry) => entry?.chaId === chatRef?.chaId));

    /** The defaults, read once; null after a read that did not answer, with the failure shown. */
    async function loadDefaults(): Promise<StructuredMemoryDefaultPromptsAnswer | null> {
        if (defaults) {
            return defaults;
        }
        const read = await readStructuredMemoryDefaultPrompts();
        if (read.outcome === "ok") {
            defaults = read.value;
            defaultsFailure = null;
            return defaults;
        }
        defaultsFailure = memoryReadFailureText(read);
        return null;
    }

    /** Turns fine-tuning on after the warning, seeding blank prompts from the defaults, or off, keeping the texts. */
    async function tick(on: boolean) {
        if (!on) {
            setStructured((next) => (next.fineTuning = false));
            return;
        }
        if (ticking) {
            return;
        }
        ticking = true;
        try {
            if (!(await alertConfirm(text.fineTuningConfirm))) {
                return;
            }
            const loaded = await loadDefaults();
            if (!loaded) {
                return;
            }
            setStructured((next) => {
                next.fineTuning = true;
                if (next.analysisPrompt.trim() === "") {
                    next.analysisPrompt = loaded.analysis.frame;
                }
                if (next.patchPrompt.trim() === "") {
                    next.patchPrompt = loaded.patch.frame;
                }
            });
        } finally {
            ticking = false;
        }
    }

    async function toggleDefaults() {
        if (showDefaults) {
            showDefaults = false;
            return;
        }
        if (await loadDefaults()) {
            showDefaults = true;
        }
    }

    async function test() {
        const ref = chatRef;
        if (!ref || !owner || testing) {
            return;
        }
        testing = true;
        try {
            const answered = await pressMemoryTest(owner, ref);
            if (answered) {
                result = answered;
            }
        } finally {
            testing = false;
        }
    }

    /** A parsed answer as the result shows it: JSON, indented, as text. */
    const asText = (value: unknown) => JSON.stringify(value, null, 2) ?? "";

    /** A stored code's text; the code itself for one this tab does not know. */
    const warningText = (kind: string) => codeText(language.structuredMemory.warningKinds, kind);
</script>

{#snippet slotLines(call: string, slots: StructuredMemorySlotWarnings)}
    {#if slots.unquoted.length > 0}
        <span data-memory-test-unquoted={call}>
            {resultText.unquoted(call)}: {slots.unquoted.map((name) => `{{slot::${name}}}`).join(", ")}
        </span>
    {/if}
    {#if slots.unknown.length > 0}
        <span data-memory-test-unknown={call}>
            {resultText.unknown(call)}: {slots.unknown.map((name) => `{{slot::${name}}}`).join(", ")}
        </span>
    {/if}
{/snippet}

{#snippet defaultPrompt(title: string, prompt: { frame: string; format: string; rules: string })}
    <span class="font-semibold">{title}</span>
    <pre
        class="max-h-96 overflow-auto rounded-md border border-darkborderc p-2 whitespace-pre-wrap">{prompt.frame}</pre>
    <span>{text.defaultFormat}</span>
    <pre
        class="max-h-96 overflow-auto rounded-md border border-darkborderc p-2 whitespace-pre-wrap">{prompt.format}</pre>
    <span>{text.defaultRules}</span>
    <pre
        class="max-h-96 overflow-auto rounded-md border border-darkborderc p-2 whitespace-pre-wrap">{prompt.rules}</pre>
{/snippet}

<div class="mb-4 flex flex-col gap-2" data-structured-memory-prompts>
    <div class="flex items-center">
        <Check
            name={text.fineTuning}
            disabled={ticking}
            bind:check={() => structured.fineTuning, (value) => void tick(value)}
        />
    </div>
    {#if defaultsFailure !== null}
        <span class="text-xs text-draculared" data-structured-memory-defaults-failure>
            {text.fineTuningDefaultsUnavailable}
            {defaultsFailure}
        </span>
    {/if}
    <ul class="list-disc pl-5 text-xs text-textcolor2" data-structured-memory-prompt-guide>
        {#each text.promptGuide as line}
            <li>{line}</li>
        {/each}
    </ul>
    {#if structured.fineTuning}
        <span class="text-textcolor">{text.analysisPrompt}</span>
        <div>
            <TextAreaInput
                size="sm"
                popupEditorContext={presetId}
                bind:value={
                    () => structured.analysisPrompt, (value) => setStructured((next) => (next.analysisPrompt = value))
                }
            />
        </div>
        <span class="text-textcolor">{text.patchPrompt}</span>
        <div>
            <TextAreaInput
                size="sm"
                popupEditorContext={presetId}
                bind:value={
                    () => structured.patchPrompt, (value) => setStructured((next) => (next.patchPrompt = value))
                }
            />
        </div>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" styled="outlined" onclick={toggleDefaults}>
            <span data-structured-memory-view-default>{showDefaults ? text.hideDefault : text.viewDefault}</span>
        </Button>
        <Button size="sm" styled="outlined" disabled={!chatRef || !owner || testing} onclick={test}>
            <span data-structured-memory-test-run>{testing ? text.testRunning : text.testRun}</span>
        </Button>
    </div>
    <span class="text-xs text-textcolor2">{chatRef && owner ? text.testHelp : text.testNoChat}</span>
    {#if showDefaults && defaults}
        <div class="flex flex-col gap-1 text-xs" data-structured-memory-default-prompts>
            {@render defaultPrompt(text.defaultAnalysis, defaults.analysis)}
            {@render defaultPrompt(text.defaultPatch, defaults.patch)}
        </div>
    {/if}
    {#if result}
        <div
            class="flex flex-col gap-1 rounded-md border border-darkborderc p-2 text-xs break-words"
            data-structured-memory-test-result={result.outcome}
        >
            <span>{result.customPrompt ? receiptText.customPrompt : resultText.defaultPrompt}</span>
            {@render slotLines(resultText.analysisCall, result.slots.analysis)}
            {@render slotLines(resultText.patchCall, result.slots.patch)}
            {#if result.outcome === "none"}
                <span>{resultText.nothing}</span>
            {:else}
                <span>{resultText.window(result.messageIds.length)}</span>
                <span>{resultText.outcome}: {codeText(language.structuredMemory.log.results, result.outcome)}</span>
                {#if result.reason !== undefined}
                    <span>{resultText.reason}: {memoryReasonText(result.reason)}</span>
                {/if}
                {#if result.error !== undefined}
                    <span class="text-draculared" data-memory-test-error>{resultText.error}: {result.error}</span>
                {/if}
                {#if result.model !== undefined}
                    <span>{receiptText.model}: {result.model}</span>
                {/if}
                <span>{receiptText.tokens(result.inputTokens, result.outputTokens)}</span>
                <span>{result.patchCalled ? resultText.patchCalled : resultText.patchNotCalled}</span>
                {#if result.warnings.length > 0}
                    <span class="font-semibold">{receiptText.warnings}</span>
                    {#each result.warnings as warning}
                        <span>{warningText(warning.kind)}{warning.detail ? `: ${warning.detail}` : ""}</span>
                    {/each}
                {/if}
                {#if result.unverified.length > 0}
                    <span class="font-semibold">{receiptText.unverified}</span>
                    {#each result.unverified as item}
                        <span>
                            {item.text}{item.reason
                                ? ` (${codeText(language.structuredMemory.unverifiedReasons, item.reason)})`
                                : ""}
                        </span>
                    {/each}
                {/if}
                {#if result.refused.length > 0}
                    <span class="font-semibold">{receiptText.refused}</span>
                    {#each result.refused as item}
                        <span>
                            {item.candidate}{item.refusal
                                ? `: ${codeText(language.structuredMemory.refusalKinds, item.refusal)}`
                                : ""}
                        </span>
                    {/each}
                {/if}
                <span class="font-semibold">{resultText.analysis}</span>
                {#if result.analysis !== undefined}
                    <pre
                        class="max-h-96 overflow-auto rounded-md border border-darkborderc p-2 whitespace-pre-wrap"
                        data-memory-test-analysis>{asText(result.analysis)}</pre>
                {:else}
                    <span>{resultText.noAnalysis}</span>
                {/if}
                {#if result.patches !== undefined}
                    <span class="font-semibold">{resultText.patches}</span>
                    <pre
                        class="max-h-96 overflow-auto rounded-md border border-darkborderc p-2 whitespace-pre-wrap"
                        data-memory-test-patches>{asText(result.patches)}</pre>
                {/if}
            {/if}
        </div>
    {/if}
</div>
