<script lang="ts">
    import { RefreshCcwIcon, XIcon } from "@lucide/svelte";
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import { chatStatusKey, generatingChatKeys } from "src/ts/process/chatStatus.svelte";
    import { isLocalSend, localSends } from "src/ts/process/localSends";
    import { memoryTaskAwaitingSync, memoryTaskFenced, memoryTaskStatus } from "src/ts/process/memoryTasks.svelte";
    import { currentChatRef } from "src/ts/storage/chatStore.svelte";
    import { hypaV3ModalOpen } from "src/ts/stores.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { memoryTaskStatusLine } from "../HypaV3Modal/taskStatusLine";
    import CoverageTab from "./CoverageTab.svelte";
    import LogTab from "./LogTab.svelte";

    // The memory panel of a Structured Memory chat: `App.svelte` mounts it in place of the HypaV3 modal,
    // under the same `hypaV3ModalOpen` store. A tab is one component taking `chatRef`, `readOnly`, and
    // `refresh`, mounted while it shows, so opening it is its first read and a new entry here adds one.
    //
    // A tab reads again each time `refresh` moves: on the button, and when the panel stops being
    // read-only, which is when a memory task or a record-now job has finished writing. It joins held
    // data itself, so a change of the held messages needs no request.

    const text = language.structuredMemory.panel;
    const TABS = [
        { value: "coverage", label: text.coverage, component: CoverageTab },
        { value: "log", label: text.log, component: LogTab },
    ];

    let tab = $state<string | number>(TABS[0].value);
    let refresh = $state(0);

    const activeTab = $derived(TABS.find(({ value }) => value === tab) ?? TABS[0]);
    const chatRef = $derived(currentChatRef());
    const chatKey = $derived(chatRef ? chatStatusKey(chatRef) : null);

    // A held revision catching up notifies nothing: while the fence only waits for it, check again
    // every second so the read-only state follows.
    let syncCheck = $state(0);
    $effect(() => {
        syncCheck;
        if (!chatRef || !memoryTaskAwaitingSync(chatRef)) {
            return;
        }
        const timer = setTimeout(() => (syncCheck += 1), 1000);
        return () => clearTimeout(timer);
    });
    const awaitingSync = $derived.by(() => {
        syncCheck;
        return chatRef !== null && memoryTaskAwaitingSync(chatRef);
    });

    /** A send of this tab, a job this tab knows of, or the chat's memory task fence (`memoryWriteFence` in the modal). */
    const readOnly = $derived.by(() => {
        syncCheck;
        return (
            chatRef !== null &&
            (isLocalSend(chatRef, $localSends) ||
                generatingChatKeys().has(chatStatusKey(chatRef)) ||
                memoryTaskFenced(chatRef))
        );
    });
    const taskLine = $derived(memoryTaskStatusLine(chatRef ? memoryTaskStatus(chatRef) : null));

    // The chat the last check saw: another chat's tab reads on its own, as it mounts.
    let seen: { chatKey: string | null; readOnly: boolean } | null = null;
    $effect(() => {
        const now = { chatKey, readOnly };
        if (seen?.chatKey === now.chatKey && seen.readOnly && !now.readOnly) {
            untrack(() => (refresh += 1));
        }
        seen = now;
    });

    function close() {
        $hypaV3ModalOpen = false;
    }
</script>

<div class="fixed inset-0 z-40 p-1 sm:p-2 bg-black/50">
    <div class="flex justify-center w-full h-full">
        <div
            class="flex flex-col w-full h-full max-w-3xl gap-2 p-3 rounded-lg sm:p-6 bg-darkbg text-textcolor"
            role="dialog"
            aria-modal="true"
            aria-label={text.title}
            data-memory-panel={activeTab.value}
        >
            <div class="flex items-center justify-between">
                <h1 class="text-lg font-semibold sm:text-2xl">{text.title}</h1>
                <div class="flex items-center gap-2">
                    <button
                        type="button"
                        class="p-2 transition-colors text-textcolor2 hover:text-textcolor"
                        aria-label={text.refresh}
                        title={text.refresh}
                        onclick={() => (refresh += 1)}
                        data-memory-panel-refresh
                    >
                        <RefreshCcwIcon class="w-6 h-6" />
                    </button>
                    <button
                        type="button"
                        class="p-2 transition-colors text-textcolor2 hover:text-textcolor"
                        aria-label={text.close}
                        title={text.close}
                        onclick={close}
                        data-memory-panel-close
                    >
                        <XIcon class="w-6 h-6" />
                    </button>
                </div>
            </div>

            <SegmentedControl bind:value={tab} options={TABS} size="sm" margin={false} label={text.sections} />

            {#if readOnly || taskLine || awaitingSync}
                <div class="flex flex-col gap-1 text-sm text-textcolor2">
                    {#if readOnly}
                        <span role="status" data-memory-panel-read-only>{text.readOnly}</span>
                    {/if}
                    {#if taskLine}
                        <span role="status">{taskLine}</span>
                    {/if}
                    {#if awaitingSync}
                        <span role="status">{language.memoryTasks.awaitingSync}</span>
                    {/if}
                </div>
            {/if}

            <div class="flex flex-col flex-1 min-h-0 overflow-y-auto" tabindex="-1">
                {#if chatRef}
                    {#key chatKey}
                        <activeTab.component {chatRef} {readOnly} {refresh} />
                    {/key}
                {/if}
            </div>
        </div>
    </div>
</div>
