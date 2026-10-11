<script lang="ts">
    import { settings, activePersona, currentPersonaRecord } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import BaseRoundedButton from "src/lib/UI/BaseRoundedButton.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertSelect } from "src/ts/alert";
    import { getCharImage } from "src/ts/characters";
    import { changeUserPersona, exportUserPersona, importUserPersona, selectUserImg } from "src/ts/persona";
    import Sortable from "sortablejs/modular/sortable.core.esm.js";
    import { onDestroy, onMount } from "svelte";
    import { sleep, sortableOptions } from "src/ts/util";
    import { newPersonaId } from "../../../../shared/presets.ts";
    import { currentChatRef } from "src/ts/storage/chatStore.svelte";
    import { chatsBoundTo, pickedId } from "src/ts/storage/chatBinding.svelte";
    import { selectPersona, selection } from "src/ts/storage/selection.svelte";
    import BindingScopeNote from "../BindingScopeNote.svelte";
    import { CircleCheckIcon } from "@lucide/svelte";
    import { normalizePersonaModules } from "../../../../shared/personas.ts";

    let stb: Sortable = null;
    let ele: HTMLDivElement = $state();
    let sorted = $state(0);
    // Read once per render, not once per row. The ring marks the open chat's bound persona (none
    // when unset or deleted), else at home the tab's; the editor below edits `activePersona`.
    const selectedPersonaId = $derived(pickedId("personaId", currentChatRef(), activePersona.id));
    let moduleSearch = $state("");
    // The modules a persona can link: not MCP, with a non-blank id (`normalizePersonaModules` keeps
    // no other), each id once (the first, as the resolvers pick), shown by name, else by id.
    const linkableModules = $derived.by(() => {
        const seen = new Set<string>();
        const out: { id: string; name: string }[] = [];
        for (const module of settings.modules ?? []) {
            const id = module?.id;
            if (module.mcp || typeof id !== "string" || id.trim() === "" || seen.has(id)) {
                continue;
            }
            seen.add(id);
            out.push({ id, name: typeof module.name === "string" && module.name.trim() !== "" ? module.name : id });
        }
        return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    });
    const shownModules = $derived.by(() => {
        const query = moduleSearch.trim().toLowerCase();
        return query === ""
            ? linkableModules
            : linkableModules.filter((module) => module.name.toLowerCase().includes(query));
    });
    const linkedModuleIds = $derived(new Set(normalizePersonaModules(currentPersonaRecord()?.modules)));

    // Written to the persona the editor shows (`currentPersonaRecord`, read at the click), adding or
    // removing only this id (ids of modules not installed stay), in canonical form as the server
    // stores it.
    function togglePersonaModule(moduleId: string) {
        const persona = currentPersonaRecord();
        if (!persona) {
            return;
        }
        const current = normalizePersonaModules(persona.modules);
        persona.modules = normalizePersonaModules(
            current.includes(moduleId) ? current.filter((id) => id !== moduleId) : [...current, moduleId],
        );
    }

    const createStb = () => {
        stb = Sortable.create(ele, {
            // The selection is by id, so a reorder leaves it on the same persona.
            onEnd: async () => {
                let idx: number[] = [];
                ele.querySelectorAll("[data-risu-idx]").forEach((e, i) => {
                    idx.push(parseInt(e.getAttribute("data-risu-idx")));
                });
                let newValue: typeof settings.personas = [];
                idx.forEach((i) => {
                    newValue.push(settings.personas[i]);
                });
                settings.personas = newValue;
                try {
                    stb.destroy();
                } catch (error) {}
                sorted += 1;
                await sleep(1);
                createStb();
            },
            ...sortableOptions,
        });
    };

    onMount(createStb);

    onDestroy(() => {
        if (stb) {
            try {
                stb.destroy();
            } catch (error) {}
        }
    });
</script>

<div class="flex items-center gap-2 mb-2 mt-2">
    <h2 class="text-2xl font-bold">{language.persona}</h2>
    <BindingScopeNote field="personaId" />
</div>

{#key sorted}
    <div
        class="p-4 rounded-md border-darkborderc border mb-2 flex-wrap flex gap-2 w-full max-w-full min-w-0"
        bind:this={ele}
    >
        {#each settings.personas as persona, i}
            <button
                data-risu-idx={i}
                onclick={() => {
                    changeUserPersona(persona.id);
                }}
            >
                {#if persona.icon === ""}
                    <div
                        class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                        class:ring-3={persona.id === selectedPersonaId}
                    ></div>
                {:else}
                    {#await getCharImage(persona.icon, "css")}
                        <div
                            class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                            class:ring-3={persona.id === selectedPersonaId}
                        ></div>
                    {:then im}
                        <div
                            class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                            style={im}
                            class:ring-3={persona.id === selectedPersonaId}
                        ></div>
                    {/await}
                {/if}
            </button>
        {/each}
        <div class="flex justify-center items-center ml-2 mr-2">
            <BaseRoundedButton
                onClick={async () => {
                    // The chat a new persona is picked for, read before the dialog (null: the tab's selection).
                    const target = currentChatRef();
                    const sel = parseInt(await alertSelect([language.createfromScratch, language.importCharacter]));
                    if (sel === 0) {
                        const id = newPersonaId();
                        settings.personas.push({
                            id,
                            name: "New Persona",
                            icon: "",
                            personaPrompt: "",
                            note: "",
                        });
                        changeUserPersona(id, target);
                    } else if (sel === 1) {
                        await importUserPersona();
                    }
                }}
                ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
                    ><path
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                    /></svg
                >
            </BaseRoundedButton>
        </div>
    </div>
{/key}

<div class="flex w-full items-starts rounded-md border-darkborderc border p-4 max-w-full flex-wrap">
    <div class="flex flex-col mt-4 mr-4">
        <button
            onclick={() => {
                selectUserImg();
            }}
        >
            {#if activePersona.icon === ""}
                <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"></div>
            {:else}
                {#await getCharImage(activePersona.icon, activePersona.largePortrait ? "lgcss" : "css")}
                    <div class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"></div>
                {:then im}
                    <div
                        class="rounded-md h-28 w-28 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                        style={im}
                    ></div>
                {/await}
            {/if}
        </button>
    </div>
    <div class="flex grow flex-col p-2 max-w-full">
        <span class="text-sm text-textcolor2">{language.name}</span>
        <TextInput marginBottom size="lg" placeholder="User" bind:value={activePersona.name} />
        <span class="text-sm text-textcolor2">{language.note}</span>
        {#if settings.ui.personaNote}
            <TextInput
                marginBottom
                size="lg"
                bind:value={activePersona.note}
                placeholder={`Put a unique identifier for this persona here.\nExample: [Alternate Hunters persona]`}
            />
        {/if}
        <span class="text-sm text-textcolor2">{language.description}</span>
        <TextAreaInput
            autocomplete="off"
            bind:value={activePersona.personaPrompt}
            placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`}
        />
        <div class="mt-4 flex flex-col gap-2">
            <span class="text-sm text-textcolor">{language.personaModuleLink}</span>
            <span class="text-sm text-textcolor2">{language.personaModuleLinkInfo}</span>
            <TextInput placeholder={language.search} bind:value={moduleSearch} />
            <div class="max-h-64 overflow-y-auto rounded-md border border-darkborderc">
                {#if linkableModules.length === 0}
                    <div class="p-3 text-sm text-textcolor2">{language.noLinkableModules}</div>
                {:else if shownModules.length === 0}
                    <div class="p-3 text-sm text-textcolor2">{language.noMatchingModules}</div>
                {:else}
                    {#each shownModules as linkable, index (linkable.id)}
                        <button
                            type="button"
                            class="flex w-full items-center gap-3 p-3 text-left text-textcolor hover:bg-selected cursor-pointer"
                            class:border-t={index !== 0}
                            class:border-darkborderc={index !== 0}
                            aria-pressed={linkedModuleIds.has(linkable.id)}
                            aria-label={`${language.personaModuleLink}: ${linkable.name}`}
                            onclick={() => togglePersonaModule(linkable.id)}
                        >
                            <CircleCheckIcon
                                size={18}
                                class={linkedModuleIds.has(linkable.id) ? "text-primary-500" : "text-textcolor2"}
                            />
                            <span class="min-w-0 grow truncate">{linkable.name}</span>
                        </button>
                    {/each}
                {/if}
            </div>
        </div>
        <div class="flex gap-2 mt-4 max-w-full flex-wrap">
            <Button onclick={exportUserPersona}>{language.export}</Button>
            <Button onclick={importUserPersona}>{language.import}</Button>

            <Button
                styled="danger"
                onclick={async () => {
                    if (settings.personas.length === 1) {
                        return;
                    }
                    // The list can change while the dialog is open: act on this persona by id.
                    const target = currentPersonaRecord();
                    if (!target) {
                        return;
                    }
                    const { id, name } = target;
                    const bound = chatsBoundTo("personaId", id);
                    const d = await alertConfirm(
                        `${language.removeConfirm}${name}` +
                            (bound > 0 ? `\n\n${language.chatBinding.usedByChats(bound)}` : ""),
                    );
                    if (!d) {
                        return;
                    }
                    const personas = settings.personas;
                    const index = personas.findIndex((persona) => persona.id === id);
                    if (index === -1 || personas.length === 1) {
                        return;
                    }
                    // Chats bound to it keep the id and show it as deleted; only the tab's selection moves on.
                    if (selection.personaId === id) {
                        selectPersona(personas.find((persona) => persona.id !== id).id);
                    }
                    personas.splice(index, 1);
                }}>{language.remove}</Button
            >
            <!-- Written to the persona the selection resolves to (the first one when it names none), as the
                 index binding did; `activePersona`'s setter would drop it. -->
            <Check
                bind:check={
                    () => activePersona.largePortrait,
                    (value) => {
                        const persona = currentPersonaRecord();
                        if (persona) {
                            persona.largePortrait = value;
                        }
                    }
                }>{language.largePortrait}</Check
            >
        </div>
    </div>
</div>
