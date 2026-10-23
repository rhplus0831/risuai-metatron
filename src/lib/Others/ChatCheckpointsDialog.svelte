<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { onMount } from "svelte";
    import { language } from "src/lang";
    import NumberInput from "../UI/GUI/NumberInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import { alertConfirm, alertError, alertInput, alertNormal } from "src/ts/alert";
    import { chatEntry, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { ResourceEpochMismatchError } from "src/ts/storage/resourceClient";
    import {
        checkpointLoadBusy,
        deleteCheckpoint,
        listCheckpoints,
        loadCheckpoint,
        readCheckpointPolicy,
        renameCheckpoint,
        saveCheckpoint,
        writeCheckpointPolicy,
        type CheckpointFailure,
        type CheckpointLoadResult,
        type CheckpointResult,
    } from "src/ts/checkpoints/chatCheckpoints.svelte";
    import {
        MAX_AUTO_EVERY,
        MAX_AUTO_KEEP,
        MAX_CHECKPOINT_NAME,
        MIN_AUTO_EVERY,
        MIN_AUTO_KEEP,
        truncateCheckpointText,
        type CheckpointKind,
        type CheckpointSummary,
    } from "../../../shared/chatCheckpoints.ts";

    interface Props {
        chatRef: ChatRef;
        close: () => void;
    }

    let { chatRef, close }: Props = $props();
    const entry = $derived(chatEntry(chatRef));
    const kinds: CheckpointKind[] = ["manual", "auto", "safety"];
    let checkpoints: CheckpointSummary[] = $state([]);
    let selectedId: string | null = $state(null);
    const selected = $derived(checkpoints.find((checkpoint) => checkpoint.id === selectedId));
    let pending = $state(true);
    const disabled = $derived(pending || $checkpointLoadBusy);
    let policyAvailable = $state(false);
    let autoEnabled = $state(false);
    let autoEvery = $state(5);
    let autoKeep = $state(5);
    let closeButton: HTMLButtonElement | undefined = $state();
    let active = true;

    $effect(() => {
        if (!entry && !$checkpointLoadBusy) close();
    });

    onMount(() => {
        closeButton?.focus();
        void refresh().finally(() => (pending = false));
        return () => {
            active = false;
        };
    });

    function reportFailure(result: CheckpointFailure) {
        if (result.reason === "generating") {
            if (!result.noticeShown) alertError(language.chatGenerating);
        } else {
            alertError(language.chatCheckpoints.errors[result.reason]);
        }
    }

    function report(result: CheckpointResult | CheckpointLoadResult) {
        switch (result.status) {
            case "ok":
                return;
            case "loaded":
                alertNormal(language.chatCheckpoints.loaded);
                return;
            case "refresh-pending":
                alertNormal(language.chatCheckpoints.refreshPending);
                return;
            case "unknown":
                alertError(language.chatCheckpoints.loadUnknown);
                return;
            default:
                reportFailure(result);
        }
    }

    function reportException(error: unknown) {
        // The epoch listener already supplies the halt-and-reload notice.
        if (!(error instanceof ResourceEpochMismatchError)) alertError(language.chatCheckpoints.errors.request);
    }

    /** Re-read after every action, including a stale row's rename or delete. */
    async function refresh() {
        const results = await Promise.allSettled([listCheckpoints(chatRef), readCheckpointPolicy(chatRef)]);
        if (!active) return;
        const [listed, policy] = results;
        if (listed.status === "fulfilled") {
            if (listed.value.status === "ok") {
                checkpoints = listed.value.checkpoints;
                if (!checkpoints.some((row) => row.id === selectedId)) selectedId = null;
            } else {
                checkpoints = [];
                selectedId = null;
                reportFailure(listed.value);
            }
        } else {
            reportException(listed.reason);
        }
        if (policy.status === "fulfilled") {
            policyAvailable = policy.value.status === "available";
            if (policy.value.status === "available") {
                autoEnabled = policy.value.policy !== null;
                autoEvery = policy.value.policy?.autoEvery ?? 5;
                autoKeep = policy.value.policy?.autoKeep ?? 5;
            }
        } else {
            policyAvailable = false;
            reportException(policy.reason);
        }
    }

    async function act(action: () => Promise<CheckpointResult | CheckpointLoadResult | void>) {
        if (disabled || !entry) return;
        pending = true;
        try {
            const result = await action();
            if (result) report(result);
        } catch (error) {
            reportException(error);
        } finally {
            if (active) await refresh();
            pending = false;
        }
    }

    function stillHere(ref: ChatRef) {
        return active && !!chatEntry(ref);
    }

    function save() {
        const ref = { ...chatRef };
        const defaultName = truncateCheckpointText(
            `${entry?.name ?? ""} ${new Date().toLocaleDateString()}`,
            MAX_CHECKPOINT_NAME,
        );
        void act(async () => {
            const name = (await alertInput(language.chatCheckpoints.namePrompt, [], defaultName)).trim();
            if (!name || !stillHere(ref)) return;
            return await saveCheckpoint(ref, truncateCheckpointText(name, MAX_CHECKPOINT_NAME));
        });
    }

    function load() {
        const ref = { ...chatRef };
        const row = selected;
        if (!row) return;
        void act(async () => {
            if (!(await alertConfirm(language.chatCheckpoints.loadConfirm(row.name))) || !stillHere(ref)) return;
            return await loadCheckpoint(ref, row.id);
        });
    }

    function rename() {
        const ref = { ...chatRef };
        const row = selected;
        if (!row) return;
        void act(async () => {
            const name = (await alertInput(language.chatCheckpoints.namePrompt, [], row.name)).trim();
            if (!name || !stillHere(ref)) return;
            return await renameCheckpoint(ref, row, truncateCheckpointText(name, MAX_CHECKPOINT_NAME));
        });
    }

    function remove() {
        const ref = { ...chatRef };
        const row = selected;
        if (!row) return;
        void act(async () => {
            if (!(await alertConfirm(language.chatCheckpoints.deleteConfirm(row.name))) || !stillHere(ref)) return;
            return await deleteCheckpoint(ref, row);
        });
    }

    function clamp(value: number, min: number, max: number) {
        return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
    }

    function savePolicy() {
        autoEvery = clamp(autoEvery, MIN_AUTO_EVERY, MAX_AUTO_EVERY);
        autoKeep = clamp(autoKeep, MIN_AUTO_KEEP, MAX_AUTO_KEEP);
        const value = autoEnabled ? { autoEvery, autoKeep } : null;
        const ref = { ...chatRef };
        void act(() => writeCheckpointPolicy(ref, value));
    }
</script>

<div class="absolute inset-0 z-40 bg-bgcolor/70 flex justify-center items-center p-3">
    <div
        class="bg-darkbg text-textcolor p-4 rounded-md flex flex-col gap-3 max-w-3xl w-full max-h-full overflow-y-auto break-words"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-checkpoints-title"
        aria-busy={disabled}
    >
        <div class="flex items-start gap-3">
            <div class="min-w-0 grow">
                <h2 id="chat-checkpoints-title" class="font-bold text-lg">{language.chatCheckpoints.title}</h2>
                <p class="text-textcolor2 truncate">{entry?.name ?? ""}</p>
            </div>
            <button
                bind:this={closeButton}
                class="text-textcolor2 hover:text-textcolor disabled:opacity-50"
                aria-label={language.chatCheckpoints.close}
                disabled={$checkpointLoadBusy}
                onclick={() => {
                    if (!$checkpointLoadBusy) close();
                }}><XIcon size={24} /></button
            >
        </div>
        <div class="flex flex-wrap gap-2">
            <button
                class="bg-darkbutton hover:bg-selected rounded px-3 py-2 disabled:opacity-50"
                {disabled}
                onclick={save}>{language.chatCheckpoints.saveAs}</button
            >
            <button
                class="bg-darkbutton hover:bg-selected rounded px-3 py-2 disabled:opacity-50"
                disabled={disabled || !selected}
                onclick={load}>{language.chatCheckpoints.load}</button
            >
            <button
                class="bg-darkbutton hover:bg-selected rounded px-3 py-2 disabled:opacity-50"
                disabled={disabled || !selected}
                onclick={rename}>{language.chatCheckpoints.rename}</button
            >
            <button
                class="bg-darkbutton hover:bg-selected text-draculared rounded px-3 py-2 disabled:opacity-50"
                disabled={disabled || !selected}
                onclick={remove}>{language.chatCheckpoints.delete}</button
            >
        </div>
        {#if pending}<p role="status" class="text-textcolor2">{language.chatCheckpoints.working}</p>{/if}
        {#if checkpoints.length === 0 && !pending}<p class="text-textcolor2">{language.chatCheckpoints.empty}</p>{/if}
        <div class="grid md:grid-cols-2 gap-4">
            <div class="flex flex-col gap-3">
                {#each kinds as kind}
                    {@const rows = checkpoints.filter((row) => row.kind === kind)}
                    {#if rows.length > 0}
                        <section aria-label={language.chatCheckpoints.kinds[kind]}>
                            <h3 class="font-bold mb-2">{language.chatCheckpoints.kinds[kind]}</h3>
                            <ul class="flex flex-col gap-2">
                                {#each rows as row (row.id)}
                                    <li>
                                        <button
                                            class="w-full text-left border border-borderc rounded p-3 hover:bg-selected disabled:opacity-50"
                                            class:bg-selected={row.id === selectedId}
                                            class:bg-darkbutton={row.id !== selectedId}
                                            aria-pressed={row.id === selectedId}
                                            {disabled}
                                            onclick={() => (selectedId = row.id)}
                                        >
                                            <span class="block font-semibold">{row.name}</span>
                                            <time
                                                class="block text-sm text-textcolor2"
                                                datetime={new Date(row.createdAt).toISOString()}
                                                >{new Date(row.createdAt).toLocaleString()}</time
                                            >
                                            <span class="block text-sm text-textcolor2"
                                                >{language.chatCheckpoints.counts(
                                                    row.userTurns,
                                                    row.messageCount,
                                                )}</span
                                            >
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        </section>
                    {/if}
                {/each}
            </div>
            <section aria-label={language.chatCheckpoints.preview} class="bg-bgcolor rounded p-3 min-w-0">
                <h3 class="font-bold mb-2">{language.chatCheckpoints.preview}</h3>
                {#if selected}
                    <p class="text-textcolor2 text-sm mb-3">
                        {language.chatCheckpoints.previewCounts(
                            selected.preview.summaries,
                            selected.preview.loreEntries,
                            selected.preview.variables,
                        )}
                    </p>
                    {#each selected.preview.messages as message}
                        <div class="mb-3">
                            <p class="font-semibold">{language.chatCheckpoints.roles[message.role]}</p>
                            <p class="whitespace-pre-wrap break-words">{message.text}</p>
                        </div>
                    {/each}
                {:else}
                    <p class="text-textcolor2">{language.chatCheckpoints.selectPreview}</p>
                {/if}
            </section>
        </div>
        {#if policyAvailable}
            <section
                class="border-t border-borderc pt-3 flex flex-col gap-2"
                aria-label={language.chatCheckpoints.autoPolicy}
            >
                <h3 class="font-bold">{language.chatCheckpoints.autoPolicy}</h3>
                <label for="checkpoint-auto-enabled" class="flex items-center gap-2">
                    <span>{language.chatCheckpoints.autoPolicy}</span>
                    <SelectInput
                        id="checkpoint-auto-enabled"
                        value={autoEnabled ? "on" : "off"}
                        onchange={(event) => (autoEnabled = event.currentTarget.value === "on")}
                        {disabled}
                    >
                        <OptionInput value="off">{language.chatCheckpoints.off}</OptionInput>
                        <OptionInput value="on">{language.chatCheckpoints.on}</OptionInput>
                    </SelectInput>
                </label>
                {#if autoEnabled}
                    <div class="flex flex-wrap gap-3">
                        <label for="checkpoint-auto-every" class="flex items-center gap-2"
                            >{language.chatCheckpoints.every}
                            <NumberInput
                                id="checkpoint-auto-every"
                                className="w-20"
                                size="md"
                                min={MIN_AUTO_EVERY}
                                max={MAX_AUTO_EVERY}
                                bind:value={autoEvery}
                                {disabled}
                            />
                        </label>
                        <label for="checkpoint-auto-keep" class="flex items-center gap-2"
                            >{language.chatCheckpoints.keep}
                            <NumberInput
                                id="checkpoint-auto-keep"
                                className="w-20"
                                size="md"
                                min={MIN_AUTO_KEEP}
                                max={MAX_AUTO_KEEP}
                                bind:value={autoKeep}
                                {disabled}
                            />
                        </label>
                    </div>
                {/if}
                <button
                    class="bg-darkbutton hover:bg-selected rounded px-3 py-2 self-start disabled:opacity-50"
                    {disabled}
                    onclick={savePolicy}>{language.chatCheckpoints.applyPolicy}</button
                >
            </section>
        {/if}
    </div>
</div>
