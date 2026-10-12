<script lang="ts">
    import { ArrowDownIcon, ArrowUpIcon, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm } from "src/ts/alert";
    import { getModelInfo } from "src/ts/model/modellist";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { defaultTranslatorPrompt } from "src/ts/translator/presets";
    import { TRANSLATOR_OUTPUT_KEY_PATTERN } from "../../../../../shared/translatorPresets.ts";

    /**
     * One step of a translator preset (`docs/plan/translation.md` slice 3.1). The step is found by
     * its preset's id and its own id on every read and write, so a conflict reload that replaces the
     * list is followed and a step removed meanwhile is not written. Only values the server's
     * normalizer keeps as they are (`normalizeTranslatorSteps`) are written, so the tab holds the
     * server's text: a blank name and an invalid or taken output key stay drafts here, shown with a
     * hint and dropped once what they were typed over changes; a cleared or invalid response size is
     * not written, and the field shows the stored size again when it is committed.
     */
    interface Props {
        presetId: string;
        stepId: string;
        index: number;
        count: number;
    }

    let { presetId, stepId, index, count }: Props = $props();

    const livePreset = () => settings.translatorPresets.items.find((entry) => entry.id === presetId);
    const liveStep = () => livePreset()?.steps.find((entry) => entry.id === stepId);
    const step = $derived(liveStep());
    const profiles = $derived(settings.modelProfiles ?? []);

    /**
     * The output keys of the preset's other steps, disabled ones included, as one comparable value:
     * whether an output key draft is valid depends on them.
     */
    const otherOutputKeys = $derived(
        JSON.stringify(
            (step ? (livePreset()?.steps ?? []) : [])
                .filter((entry) => entry.id !== stepId)
                .map((entry) => entry.outputKey ?? null),
        ),
    );

    /**
     * Text typed that is not written: shown only while what it was typed over is unchanged (the
     * stored value `base` and, for an output key, the other steps' keys `context`), and dropped for
     * good once that changes (the effect below). A draft is never written later.
     */
    type Draft = { text: string; base: string | undefined; context: string };
    let nameDraft = $state<Draft | null>(null);
    let outputKeyDraft = $state<Draft | null>(null);

    const nameDraftLive = (draft: Draft | null) => draft !== null && draft.base === step?.name;
    const outputKeyDraftLive = (draft: Draft | null) =>
        draft !== null && draft.base === step?.outputKey && draft.context === otherOutputKeys;

    $effect(() => {
        // Local state only: an outdated draft is discarded, never written.
        if (nameDraft !== null && !nameDraftLive(nameDraft)) {
            nameDraft = null;
        }
        if (outputKeyDraft !== null && !outputKeyDraftLive(outputKeyDraft)) {
            outputKeyDraft = null;
        }
    });

    const shownName = $derived(nameDraftLive(nameDraft) ? nameDraft!.text : (step?.name ?? ""));
    const shownOutputKey = $derived(
        outputKeyDraftLive(outputKeyDraft) ? outputKeyDraft!.text : (step?.outputKey ?? ""),
    );

    function outputKeyProblem(value: string): "invalid" | "taken" | null {
        if (!TRANSLATOR_OUTPUT_KEY_PATTERN.test(value)) {
            return "invalid";
        }
        const others = livePreset()?.steps.filter((entry) => entry.id !== stepId) ?? [];
        return others.some((entry) => entry.outputKey === value) ? "taken" : null;
    }

    /** The hint of a shown output key draft. A draft only exists while its key is invalid or taken. */
    const outputKeyHint = $derived(
        !outputKeyDraftLive(outputKeyDraft)
            ? null
            : outputKeyProblem(outputKeyDraft!.text) === "taken"
              ? language.translatorSteps.outputKeyTaken
              : language.translatorSteps.outputKeyInvalid,
    );

    function setName(value: string) {
        const live = liveStep();
        if (!live) return;
        if (value.trim().length > 0) {
            live.name = value;
            nameDraft = null;
        } else {
            nameDraft = { text: value, base: live.name, context: "" };
        }
    }

    function setOutputKey(value: string) {
        const live = liveStep();
        if (!live) return;
        if (value === "") {
            delete live.outputKey;
            outputKeyDraft = null;
        } else if (outputKeyProblem(value) === null) {
            live.outputKey = value;
            outputKeyDraft = null;
        } else {
            outputKeyDraft = { text: value, base: live.outputKey, context: otherOutputKeys };
        }
    }

    function setMaxResponse(value: number) {
        const live = liveStep();
        // A cleared or invalid field is not written (the normalizer would replace it); see `restoreMaxResponse`.
        if (live && typeof value === "number" && Number.isFinite(value)) {
            live.maxResponse = value;
        }
    }

    /** On commit, a field left empty or invalid shows the stored size again. */
    function restoreMaxResponse(event: Event & { currentTarget: EventTarget & HTMLInputElement }) {
        const stored = liveStep()?.maxResponse;
        if (stored !== undefined && event.currentTarget.valueAsNumber !== stored) {
            event.currentTarget.value = String(stored);
        }
    }

    const modelValue = $derived(
        !step ? "" : step.model.mode === "profile" ? `profile:${step.model.profileId}` : "inherit",
    );
    const missingProfileId = $derived.by(() => {
        const model = step?.model;
        return model?.mode === "profile" && !profiles.some((profile) => profile.id === model.profileId)
            ? model.profileId
            : null;
    });

    function setModel(value: string | number) {
        const live = liveStep();
        if (!live || typeof value !== "string") return;
        if (value === "inherit") {
            live.model = { mode: "inherit" };
        } else if (value.startsWith("profile:")) {
            live.model = { mode: "profile", profileId: value.slice("profile:".length) };
        }
    }

    function move(offset: -1 | 1) {
        const steps = livePreset()?.steps;
        if (!steps) return;
        const from = steps.findIndex((entry) => entry.id === stepId);
        const to = from + offset;
        if (from === -1 || to < 0 || to >= steps.length) return;
        const [moved] = steps.splice(from, 1);
        steps.splice(to, 0, moved);
    }

    async function remove() {
        const name = liveStep()?.name;
        if (name === undefined) return;
        // The ids are read now: the props read the parent's list items, which throw once a reload
        // during the dialog removed them.
        const targetPresetId = presetId;
        const targetStepId = stepId;
        if (!(await alertConfirm(language.translatorSteps.removeConfirm(name)))) return;
        // Resolved again after the dialog: a conflict reload may have replaced the list.
        const steps = settings.translatorPresets.items.find((entry) => entry.id === targetPresetId)?.steps;
        const position = steps?.findIndex((entry) => entry.id === targetStepId) ?? -1;
        if (!steps || position === -1 || steps.length <= 1) return;
        steps.splice(position, 1);
    }
</script>

{#if step}
    <div class="flex flex-col p-3 mt-2 rounded-md border border-darkborderc" data-translator-step={stepId}>
        <div class="flex items-center gap-2">
            <span class="text-textcolor2 text-sm">{index + 1}.</span>
            <TextInput
                size="sm"
                className="flex-1 min-w-0"
                placeholder={language.translatorSteps.name}
                bind:value={() => shownName, setName}
            />
            <CheckInput
                name={language.translatorSteps.enabled}
                bind:check={
                    () => step.enabled,
                    (value) => {
                        const live = liveStep();
                        if (live) live.enabled = value;
                    }
                }
            />
            <button
                class="text-textcolor2 hover:text-green-500 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                title={language.translatorSteps.moveUp}
                aria-label={language.translatorSteps.moveUp}
                disabled={index === 0}
                onclick={() => move(-1)}
            >
                <ArrowUpIcon size={18} />
            </button>
            <button
                class="text-textcolor2 hover:text-green-500 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                title={language.translatorSteps.moveDown}
                aria-label={language.translatorSteps.moveDown}
                disabled={index === count - 1}
                onclick={() => move(1)}
            >
                <ArrowDownIcon size={18} />
            </button>
            {#if count > 1}
                <button
                    class="text-textcolor2 hover:text-green-500 cursor-pointer"
                    title={language.translatorSteps.remove}
                    aria-label={language.translatorSteps.remove}
                    onclick={remove}
                >
                    <TrashIcon size={18} />
                </button>
            {/if}
        </div>
        {#if shownName.trim().length === 0}
            <p class="text-draculared text-xs mt-1">{language.translatorSteps.nameBlank}</p>
        {/if}

        <span class="text-textcolor mt-4">{language.translatorSteps.model}</span>
        <SelectInput className="w-full min-w-0" bind:value={() => modelValue, setModel}>
            <OptionInput value="inherit">{language.translatorSteps.inheritModel}</OptionInput>
            {#if missingProfileId !== null}
                <OptionInput value={modelValue} disabled selected
                    >{language.modelProfiles.missingProfile(missingProfileId)}</OptionInput
                >
            {/if}
            {#each profiles as profile (profile.id)}
                <OptionInput value={`profile:${profile.id}`}
                    >{language.modelProfiles.profileLabel(
                        profile.name,
                        getModelInfo(profile.modelId, undefined, profile).name,
                    )}</OptionInput
                >
            {/each}
        </SelectInput>
        {#if missingProfileId !== null}
            <p class="text-draculared text-xs mt-1">{language.translatorSteps.missingProfile}</p>
        {/if}

        <span class="text-textcolor mt-4">{language.translationResponseSize}</span>
        <NumberInput
            min={0}
            max={2048}
            bind:value={() => step.maxResponse, setMaxResponse}
            onChange={restoreMaxResponse}
        />

        <span class="text-textcolor mt-4">{language.translatorSteps.outputKey}</span>
        <TextInput size="sm" bind:value={() => shownOutputKey, setOutputKey} />
        {#if outputKeyHint !== null}
            <p class="text-draculared text-xs mt-1">{outputKeyHint}</p>
        {/if}

        <span class="text-textcolor mt-4">{language.translatorPrompt} <Help key="translatorPrompt" /></span>
        <TextAreaInput
            bind:value={
                () => step.prompt,
                (value) => {
                    const live = liveStep();
                    if (live) live.prompt = value;
                }
            }
            placeholder={defaultTranslatorPrompt}
        />
    </div>
{/if}
