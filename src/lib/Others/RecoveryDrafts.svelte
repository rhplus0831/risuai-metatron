<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { onMount } from "svelte";
    import { get } from "svelte/store";
    import { language } from "src/lang";
    import { alertConfirm, alertError, alertNormal, terminalNotice } from "src/ts/alert";
    import { alertStore } from "src/ts/stores.svelte";
    import { JOURNAL_ENTRY_TTL_MS, type DraftEntry } from "src/ts/storage/draftJournal";
    import { applyRecoveryDraft, recoveryDraftDetails } from "src/ts/storage/journalRecovery";
    import { exportDrafts, recoveryDrafts } from "src/ts/storage/recoveryDrafts.svelte";

    let busy = $state(false);
    const disabled = $derived(busy || recoveryDrafts.refreshing);
    let panel: HTMLDivElement;
    let closeButton: HTMLButtonElement;

    onMount(() => {
        const previous = document.activeElement;
        if (disabled) panel.focus();
        else closeButton.focus();
        // Also contain keys if focus was moved outside this modal, leaving alerts above it alone.
        const outsideKey = (event: KeyboardEvent) => {
            if (alertStore.hasDialogs() || get(terminalNotice) !== null || panel.contains(event.target as Node)) return;
            if (event.type === "keydown") keydown(event);
            event.stopPropagation();
        };
        document.addEventListener("keydown", outsideKey, true);
        document.addEventListener("keyup", outsideKey, true);
        document.addEventListener("keypress", outsideKey, true);
        return () => {
            document.removeEventListener("keydown", outsideKey, true);
            document.removeEventListener("keyup", outsideKey, true);
            document.removeEventListener("keypress", outsideKey, true);
            if (previous instanceof HTMLElement && previous.isConnected && !alertStore.hasDialogs()) previous.focus();
        };
    });

    function keydown(event: KeyboardEvent) {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            if (!disabled && !event.isComposing) recoveryDrafts.close();
        } else if (event.key === "Tab") {
            const buttons = [...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const first = buttons[0];
            const last = buttons.at(-1);
            if (!first) {
                event.preventDefault();
                panel.focus();
            } else if (
                !panel.contains(document.activeElement) ||
                (event.shiftKey && document.activeElement === first)
            ) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    async function act(action: () => Promise<unknown>) {
        if (disabled) return;
        busy = true;
        try {
            await action();
        } catch (error) {
            alertError(`${language.recoveryDrafts.failed}\n${String(error)}`);
        } finally {
            busy = false;
        }
    }

    function apply(entry: DraftEntry, name: string) {
        void act(async () => {
            if (!(await alertConfirm(language.recoveryDrafts.applyConfirm(name)))) return;
            const { skipped } = await applyRecoveryDraft(entry);
            alertNormal(
                skipped.length > 0
                    ? `${language.recoveryDrafts.applied}\n\n${language.recoveryDrafts.skipped}\n${skipped.join("\n")}`
                    : language.recoveryDrafts.applied,
            );
        });
    }

    function expiry(entry: DraftEntry) {
        const minutes = Math.floor((entry.createdAt + JOURNAL_ENTRY_TTL_MS - recoveryDrafts.now) / 60_000);
        return minutes < 1
            ? language.recoveryDrafts.underMinute
            : language.recoveryDrafts.expiresIn(Math.floor(minutes / 60), minutes % 60);
    }
</script>

<!-- The modal stays below alertConfirm and contains keys before app shortcuts can see them. -->
<div class="fixed inset-0 z-[45] bg-bgcolor/70 flex justify-center items-center p-3">
    <div
        bind:this={panel}
        class="bg-darkbg text-textcolor p-4 rounded-md flex flex-col gap-3 max-w-3xl w-full max-h-full overflow-y-auto break-words"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-drafts-title"
        aria-busy={disabled}
        tabindex="-1"
        onkeydown={keydown}
        onkeyup={(event) => event.stopPropagation()}
        onkeypress={(event) => event.stopPropagation()}
    >
        <div class="flex items-start gap-3">
            <h2 id="recovery-drafts-title" class="font-bold text-lg grow">{language.recoveredChanges}</h2>
            <button
                bind:this={closeButton}
                class="text-textcolor2 hover:text-textcolor disabled:opacity-50"
                aria-label={language.recoveryDrafts.close}
                {disabled}
                onclick={() => recoveryDrafts.close()}><XIcon size={24} /></button
            >
        </div>
        <p class="text-textcolor2">{language.resourceRecoveryDrafts}</p>
        <button
            class="bg-darkbutton hover:bg-selected rounded px-3 py-2 self-start disabled:opacity-50"
            disabled={disabled || recoveryDrafts.entries.length === 0}
            onclick={() => act(exportDrafts)}>{language.recoveryDrafts.exportAll}</button
        >
        {#if disabled}<p role="status" class="text-textcolor2">{language.recoveryDrafts.working}</p>{/if}
        {#if recoveryDrafts.entries.length === 0 && !disabled}
            <p class="text-textcolor2">{language.recoveryDrafts.empty}</p>
        {/if}
        <ul class="flex flex-col gap-3">
            {#each recoveryDrafts.entries as entry (entry.id)}
                {@const details = recoveryDraftDetails(entry)}
                <li class="border border-borderc rounded p-3 flex flex-col gap-2">
                    <h3 class="font-semibold">{details.name}</h3>
                    <time class="text-sm text-textcolor2" datetime={new Date(entry.createdAt).toISOString()}
                        >{new Date(entry.createdAt).toLocaleString()}</time
                    >
                    <p class="text-sm text-textcolor2">{expiry(entry)}</p>
                    {#if details.reason}<p class="text-sm text-textcolor2">{details.reason}</p>{/if}
                    <div class="flex flex-wrap gap-2">
                        {#if !entry.otherEpoch && (details.canApply || details.blocked)}
                            <button
                                class="bg-darkbutton hover:bg-selected rounded px-3 py-2 disabled:opacity-50"
                                disabled={disabled || details.blocked}
                                onclick={() => apply(entry, details.name)}>{language.apply}</button
                            >
                        {/if}
                        <button
                            class="bg-darkbutton hover:bg-selected rounded px-3 py-2 disabled:opacity-50"
                            {disabled}
                            onclick={() => act(() => recoveryDrafts.export(entry))}>{language.export}</button
                        >
                        <button
                            class="bg-darkbutton hover:bg-selected text-draculared rounded px-3 py-2 disabled:opacity-50"
                            {disabled}
                            onclick={() => act(() => recoveryDrafts.discard(entry, details.name))}
                            >{language.recoveryDrafts.discard}</button
                        >
                    </div>
                </li>
            {/each}
        </ul>
    </div>
</div>
