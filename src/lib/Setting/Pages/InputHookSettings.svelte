<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { tick } from "svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm } from "src/ts/alert";
    import { getModelInfo } from "src/ts/model/modellist";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { newId } from "../../../../shared/ids.ts";
    import { MAX_INPUT_HOOKS, type InputHook } from "../../../../shared/inputHooks.ts";

    /** Every edit resolves its hook by id and replaces the collection, following outside list replacements. */
    const hooks = $derived(settings.inputHooks ?? []);
    const profiles = $derived(settings.modelProfiles ?? []);
    let addType = $state<InputHook["type"]>("draft");
    let expandedIds = $state<string[]>([]);

    const liveHook = (id: string) => settings.inputHooks?.find((hook) => hook.id === id);

    function update(id: string, edit: (hook: InputHook) => InputHook) {
        const current = settings.inputHooks ?? [];
        if (!current.some((hook) => hook.id === id)) return;
        settings.inputHooks = current.map((hook) => (hook.id === id ? edit(hook) : hook));
    }

    function setType(id: string, value: string | number) {
        if (value !== "draft" && value !== "btw") return;
        update(id, (hook) => {
            if (value === "btw") {
                const { translation: _translation, ...rest } = hook;
                return { ...rest, type: value };
            }
            return { ...hook, type: value };
        });
    }

    function modelValue(id: string): string {
        const model = liveHook(id)?.model;
        return model?.mode === "profile" ? `profile:${model.profileId}` : "inherit";
    }

    function setTranslation(id: string, checked: boolean) {
        update(id, (hook) => {
            if (hook.type !== "draft") return hook;
            if (checked) return { ...hook, translation: true };
            const { translation: _translation, ...rest } = hook;
            return rest;
        });
    }

    function missingProfileId(id: string): string | null {
        const model = liveHook(id)?.model;
        return model?.mode === "profile" && !profiles.some((profile) => profile.id === model.profileId)
            ? model.profileId
            : null;
    }

    function setModel(id: string, value: string | number) {
        if (value === "inherit") {
            update(id, (hook) => ({ ...hook, model: { mode: "inherit" } }));
        } else if (typeof value === "string" && value.startsWith("profile:")) {
            update(id, (hook) => ({ ...hook, model: { mode: "profile", profileId: value.slice("profile:".length) } }));
        }
    }

    async function add() {
        const current = settings.inputHooks ?? [];
        if (current.length >= MAX_INPUT_HOOKS) return;
        const id = newId();
        settings.inputHooks = [
            ...current,
            {
                id,
                name: addType === "draft" ? language.inputHooks.draft : language.inputHooks.btw,
                type: addType,
                prompt: "",
                model: { mode: "inherit" },
            },
        ];
        expandedIds = [...expandedIds, id];
        await tick();
        document.getElementById(`input-hook-name-${id}`)?.focus();
    }

    async function remove(id: string) {
        const name = liveHook(id)?.name;
        if (name === undefined || !(await alertConfirm(language.inputHooks.removeConfirm(name)))) return;
        const current = settings.inputHooks ?? [];
        if (!current.some((hook) => hook.id === id)) return;
        settings.inputHooks = current.filter((hook) => hook.id !== id);
        expandedIds = expandedIds.filter((entry) => entry !== id);
    }

    function toggle(id: string) {
        expandedIds = expandedIds.includes(id) ? expandedIds.filter((entry) => entry !== id) : [...expandedIds, id];
    }
</script>

<h2 class="text-lg mb-2">{language.inputHooks.title}</h2>
<div class="flex flex-col gap-2 text-sm text-textcolor2 mb-4 break-words">
    <p>{language.inputHooks.draftDescription}</p>
    <p>{language.inputHooks.btwDescription}</p>
    <p>{language.inputHooks.slotsDescription}</p>
</div>

<div class="flex flex-wrap items-end gap-2 mb-4">
    <div class="flex flex-col gap-1 min-w-0 grow">
        <label for="input-hook-add-type" class="text-sm">{language.inputHooks.type}</label>
        <SelectInput id="input-hook-add-type" className="w-full min-w-0" size="sm" bind:value={addType}>
            <OptionInput value="draft">{language.inputHooks.draft}</OptionInput>
            <OptionInput value="btw">{language.inputHooks.btw}</OptionInput>
        </SelectInput>
    </div>
    <Button size="sm" disabled={hooks.length >= MAX_INPUT_HOOKS} onclick={add}>{language.inputHooks.add}</Button>
</div>

{#if hooks.length === 0}
    <p class="text-sm text-textcolor2">{language.inputHooks.empty}</p>
{/if}

{#each hooks.map((hook) => hook.id) as hookId (hookId)}
    {@const expanded = expandedIds.includes(hookId)}
    <div class="flex flex-col mb-3 rounded-md border border-darkborderc min-w-0" data-input-hook={hookId}>
        <button
            class="flex items-center gap-2 p-3 text-left rounded-md hover:bg-selected cursor-pointer min-w-0"
            aria-expanded={expanded}
            aria-controls={`input-hook-fields-${hookId}`}
            onclick={() => toggle(hookId)}
        >
            {#if expanded}<ChevronDownIcon size={18} class="shrink-0" />{:else}<ChevronRightIcon
                    size={18}
                    class="shrink-0"
                />{/if}
            <span class="grow min-w-0 break-words">{liveHook(hookId)?.name ?? ""}</span>
            <span class="shrink-0 rounded-sm border border-darkborderc px-2 py-0.5 text-xs text-textcolor2">
                {liveHook(hookId)?.type === "draft" ? language.inputHooks.draft : language.inputHooks.btw}
            </span>
        </button>
        {#if expanded}
            {@const missingId = missingProfileId(hookId)}
            <div id={`input-hook-fields-${hookId}`} class="flex flex-col gap-2 border-t border-darkborderc p-3 min-w-0">
                <label for={`input-hook-name-${hookId}`} class="text-sm">{language.inputHooks.name}</label>
                <TextInput
                    id={`input-hook-name-${hookId}`}
                    fullwidth
                    size="sm"
                    bind:value={
                        () => liveHook(hookId)?.name ?? "",
                        (value) => update(hookId, (live) => ({ ...live, name: value }))
                    }
                />
                <label for={`input-hook-type-${hookId}`} class="text-sm mt-2">{language.inputHooks.type}</label>
                <SelectInput
                    id={`input-hook-type-${hookId}`}
                    className="w-full min-w-0"
                    size="sm"
                    bind:value={() => liveHook(hookId)?.type ?? "draft", (value) => setType(hookId, value)}
                >
                    <OptionInput value="draft">{language.inputHooks.draft}</OptionInput>
                    <OptionInput value="btw">{language.inputHooks.btw}</OptionInput>
                </SelectInput>
                {#if liveHook(hookId)?.type === "draft"}
                    <Check
                        className="mt-2"
                        name={language.inputHooks.translationMode}
                        bind:check={
                            () => liveHook(hookId)?.translation === true, (value) => setTranslation(hookId, value)
                        }
                    />
                    <p class="text-sm text-textcolor2">{language.inputHooks.translationModeDescription}</p>
                {/if}
                <label for={`input-hook-model-${hookId}`} class="text-sm mt-2">{language.inputHooks.model}</label>
                <SelectInput
                    id={`input-hook-model-${hookId}`}
                    className="w-full min-w-0"
                    size="sm"
                    bind:value={() => modelValue(hookId), (value) => setModel(hookId, value)}
                >
                    <OptionInput value="inherit">{language.modelProfiles.auxModes.otherAx}</OptionInput>
                    {#if missingId !== null}
                        <OptionInput value={`profile:${missingId}`} disabled selected>
                            {language.modelProfiles.missingProfile(missingId)}
                        </OptionInput>
                    {/if}
                    {#each profiles as profile (profile.id)}
                        <OptionInput value={`profile:${profile.id}`}>
                            {language.modelProfiles.profileLabel(
                                profile.name,
                                getModelInfo(profile.modelId, undefined, profile).name,
                            )}
                        </OptionInput>
                    {/each}
                </SelectInput>
                {#if missingId !== null}
                    <p class="text-draculared text-xs">{language.inputHooks.missingProfile}</p>
                {/if}
                <label for={`input-hook-prompt-${hookId}`} class="text-sm mt-2">{language.inputHooks.prompt}</label>
                <TextAreaInput
                    id={`input-hook-prompt-${hookId}`}
                    fullwidth
                    popupEditor
                    popupEditorContext={hookId}
                    bind:value={
                        () => liveHook(hookId)?.prompt ?? "",
                        (value) => update(hookId, (live) => ({ ...live, prompt: value }))
                    }
                />
                <div class="mt-2">
                    <Button size="sm" styled="outlined" className="text-draculared" onclick={() => remove(hookId)}>
                        {language.inputHooks.remove}
                    </Button>
                </div>
            </div>
        {/if}
    </div>
{/each}
