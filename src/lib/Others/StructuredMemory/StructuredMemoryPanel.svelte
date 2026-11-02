<script lang="ts">
    import { RefreshCcwIcon, XIcon } from "@lucide/svelte";
    import { untrack, type Component } from "svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertError, alertToast } from "src/ts/alert";
    import { requestMessageJump } from "src/ts/messageSearch.svelte";
    import { chatStatusKey, generatingChatKeys } from "src/ts/process/chatStatus.svelte";
    import { isLocalSend, localSends } from "src/ts/process/localSends";
    import { memoryTaskAwaitingSync, memoryTaskFenced, memoryTaskStatus } from "src/ts/process/memoryTasks.svelte";
    import {
        adoptStructuredMemory,
        declineStructuredMemory,
        memoryWriterNotice,
        newestAssistantMessageId,
        newestMemoryReceipt,
        readStructuredMemoryContents,
        resetStructuredMemorySummaries,
        type MemoryPanelTabProps,
        type MemoryPanelTarget,
        type StructuredMemoryResult,
    } from "src/ts/process/structuredMemory.svelte";
    import { characterList, findCharacter } from "src/ts/storage/characterStore.svelte";
    import { currentChatRef, findChat, markChatStale, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { refreshStaleChat } from "src/ts/storage/resourceSync.svelte";
    import { setChatOpen } from "src/ts/storage/selection.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { hypaV3ModalOpen } from "src/ts/stores.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
    import { normalizeStructuredMemorySettings, writerPaused } from "../../../../shared/structuredMemory.ts";
    import { memoryTaskStatusLine } from "../HypaV3Modal/taskStatusLine";
    import CoverageTab from "./CoverageTab.svelte";
    import LogTab from "./LogTab.svelte";
    import { pressMemoryRecord } from "./memoryRecordPress";
    import { memoryReadFailureText, memoryReasonText } from "./memoryText";
    import PagesTab from "./PagesTab.svelte";
    import PreviewTab from "./PreviewTab.svelte";
    import ThreadsTab from "./ThreadsTab.svelte";
    import TimelineTab from "./TimelineTab.svelte";

    // The memory panel of a Structured Memory chat: `App.svelte` mounts it in place of the HypaV3 modal,
    // under the same `hypaV3ModalOpen` store. A tab is one component taking `MemoryPanelTabProps`, mounted
    // while it shows, so opening it is its first read and a new entry here adds one. `open` takes the
    // panel to a record in another tab, and `jump` out of the panel to a message.
    //
    // A tab reads again each time `refresh` moves: on the button, and when the panel stops being
    // read-only, which is when a memory task or a record-now job has finished writing. It joins held
    // data itself, so a change of the held messages needs no request. Preview is the exception: a
    // preview makes the panel read-only itself, so it runs only on its own button.
    //
    // Pages, Timeline, and Threads write, each edit checked against the revision it was made on and fenced
    // on the server; read-only here only turns their controls off first. The writer line says when recording
    // is not automatic and why, from the current state, and holds the buttons that start it. Above it, a
    // chat with HypaV3 summaries and no records, which the server holds until a person chooses, offers
    // adopting or declining them. Under it, an adopted chat that still stores them offers their reset. What
    // these offer comes from the contents route, and the server checks it again on each press.

    const text = language.structuredMemory.panel;
    const receiptText = language.structuredMemory.receipt;
    const adoptText = language.structuredMemory.adopt;
    const TABS: { value: string; label: string; component: Component<MemoryPanelTabProps> }[] = [
        { value: "coverage", label: text.coverage, component: CoverageTab },
        { value: "preview", label: text.preview, component: PreviewTab },
        { value: "pages", label: text.pages, component: PagesTab },
        { value: "timeline", label: text.timeline, component: TimelineTab },
        { value: "threads", label: text.threads, component: ThreadsTab },
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
    const taskStatus = $derived(chatRef ? memoryTaskStatus(chatRef) : null);
    const taskLine = $derived(memoryTaskStatusLine(taskStatus));
    const taskLive = $derived(taskStatus?.state === "queued" || taskStatus?.state === "running");

    // The chat the last check saw: another chat's tab reads on its own, as it mounts.
    let seen: { chatKey: string | null; readOnly: boolean } | null = null;
    $effect(() => {
        const now = { chatKey, readOnly };
        if (seen?.chatKey === now.chatKey && seen.readOnly && !now.readOnly) {
            untrack(() => (refresh += 1));
        }
        seen = now;
    });

    /** What the chat's contents say and which chat they were read for; a read that failed says nothing. */
    let contentsFacts = $state.raw<{
        chatKey: string | null;
        paused: boolean;
        adoptable: number;
        resettable: boolean;
    } | null>(null);
    let contentsRead = 0;
    const heldFacts = $derived(contentsFacts?.chatKey === chatKey ? contentsFacts : null);

    async function readContents() {
        const ref = chatRef;
        const key = chatKey;
        const number = ++contentsRead;
        const result = ref ? await readStructuredMemoryContents(ref) : null;
        if (number === contentsRead) {
            contentsFacts =
                result?.outcome === "ok"
                    ? {
                          chatKey: key,
                          paused: writerPaused(result.value.runs),
                          adoptable: result.value.adoption.adoptable,
                          resettable: result.value.adoption.resettable,
                      }
                    : null;
        }
    }

    $effect(() => {
        refresh;
        chatKey;
        untrack(() => void readContents());
    });

    const messages = $derived(chatRef ? (findChat(chatRef)?.message ?? []) : []);
    const newestReply = $derived(newestAssistantMessageId(messages));
    const cadence = $derived(
        normalizeStructuredMemorySettings(
            selectedHypaV3Preset({
                hypaV3Presets: settings.hypaV3Presets.items,
                hypaV3PresetId: settings.hypaV3Presets.selectedId,
            })?.settings.structured,
        ).cadence,
    );
    /** The events the held chat's summaries would adopt, 0 for a chat the server does not hold. */
    const adoptable = $derived(heldFacts?.adoptable ?? 0);
    const notice = $derived(
        memoryWriterNotice({
            memoryOn: chatRef !== null && !!findCharacter(chatRef.chaId)?.supaMemory,
            cadence,
            paused: heldFacts?.paused ?? false,
            adoptionHeld: adoptable > 0,
            receipt: newestMemoryReceipt(messages),
            taskLive,
        }),
    );
    /** Record names the newest reply, so a chat without one has nothing to press. */
    const writerAction = $derived(notice.action === "record" && newestReply === undefined ? null : notice.action);
    const writerText = $derived.by(() => {
        switch (notice.kind) {
            case "memoryOff":
                return text.memoryOff;
            case "paused":
                return receiptText.paused;
            case "notAutomatic":
                return receiptText.notAutomatic(memoryReasonText(notice.reason));
            default:
                return null;
        }
    });

    let pressing = $state(false);

    async function pressWriter() {
        const ref = chatRef;
        const owner = characterList().find((entry) => entry?.chaId === ref?.chaId);
        if (!ref || !owner || pressing) {
            return;
        }
        pressing = true;
        try {
            await pressMemoryRecord(owner, ref, writerAction === "resume" ? undefined : newestReply);
        } finally {
            pressing = false;
        }
    }

    /**
     * One press of the adoption choice or the reset: asks `question` first when it has one, because those
     * cannot be taken back, then sends, shows what came of it, and reads the contents again. An `epoch`
     * refusal already raised its own notice, so it adds none, as in Timeline's repairs.
     */
    async function pressChoice<T>(
        send: (ref: ChatRef) => Promise<StructuredMemoryResult<T>>,
        answered: (value: T, ref: ChatRef) => void | Promise<void>,
        question?: string,
    ) {
        const ref = chatRef;
        if (!ref || pressing) {
            return;
        }
        pressing = true;
        try {
            if (question !== undefined && !(await alertConfirm(question))) {
                return;
            }
            const result = await send(ref);
            if (result.outcome === "ok") {
                await answered(result.value, ref);
                refresh += 1;
            } else if (result.outcome === "failed" || result.reason !== "epoch") {
                alertError(memoryReadFailureText(result));
            }
        } finally {
            pressing = false;
        }
    }

    function pressAdopt() {
        return pressChoice(adoptStructuredMemory, ({ adopted, stale }) => {
            alertToast(adopted > 0 ? adoptText.done(adopted, stale) : adoptText.nothing);
        });
    }

    function pressDecline() {
        return pressChoice(
            declineStructuredMemory,
            ({ declined }) => {
                alertToast(declined ? adoptText.declined : adoptText.declineNothing);
            },
            adoptText.declineConfirm,
        );
    }

    /**
     * The reset is a write of the server's, so the tab's held summaries go with a read and it writes nothing
     * back. The chat is marked first: the idle refresh then reads it once local work is done, or after a
     * read that failed, and a whole read brings the projection in their place.
     */
    async function readResetChat(ref: ChatRef) {
        try {
            if (markChatStale(ref)) {
                await refreshStaleChat(ref);
            }
        } catch (error) {
            console.error("[Memory]", error);
        }
    }

    function pressReset() {
        return pressChoice(
            resetStructuredMemorySummaries,
            async ({ reset }, ref) => {
                alertToast(reset ? adoptText.resetDone : adoptText.resetNothing);
                if (reset) {
                    await readResetChat(ref);
                }
            },
            adoptText.resetConfirm,
        );
    }

    function close() {
        $hypaV3ModalOpen = false;
    }

    /** What a jump between tabs asked the tab to show, in the chat it was asked in. */
    let asked = $state.raw<(MemoryPanelTarget & { chatKey: string | null }) | null>(null);
    const focus = $derived(asked?.chatKey === chatKey ? asked : null);

    function open(target: MemoryPanelTarget) {
        tab = target.tab;
        asked = { ...target, chatKey };
    }

    /** A person's choice of tab: nothing a jump asked for carries over. */
    function chooseTab(value: string | number) {
        tab = value;
        asked = null;
    }

    /** Leaves for the message. The panel can sit over a closed chat, so the jump opens it. */
    function jump(messageId: string) {
        if (chatRef) {
            setChatOpen(true);
            requestMessageJump(chatRef, messageId);
            close();
        }
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

            <div class="max-w-full overflow-x-auto shrink-0">
                <SegmentedControl
                    bind:value={() => tab, chooseTab}
                    options={TABS}
                    size="sm"
                    margin={false}
                    label={text.sections}
                />
            </div>

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

            {#if chatRef && adoptable > 0}
                <div
                    class="flex flex-wrap items-center justify-between gap-2 text-sm text-textcolor2"
                    data-memory-adopt
                >
                    <span class="min-w-0">{adoptText.offer(adoptable)}</span>
                    <div class="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            styled="outlined"
                            disabled={pressing || readOnly || taskLive}
                            onclick={pressAdopt}
                        >
                            <span data-memory-adopt-action>{adoptText.button}</span>
                        </Button>
                        <Button
                            size="sm"
                            styled="outlined"
                            disabled={pressing || readOnly || taskLive}
                            onclick={pressDecline}
                        >
                            <span data-memory-decline-action>{adoptText.decline}</span>
                        </Button>
                    </div>
                </div>
            {/if}

            {#if chatRef && (writerText !== null || writerAction !== null)}
                <div
                    class="flex flex-wrap items-center justify-between gap-2 text-sm text-textcolor2"
                    data-memory-writer-line={notice.kind ?? "none"}
                >
                    {#if writerText !== null}
                        <span role="status" class="min-w-0">{writerText}</span>
                    {/if}
                    {#if writerAction !== null}
                        <Button
                            size="sm"
                            styled="outlined"
                            disabled={pressing || readOnly || taskLive}
                            onclick={pressWriter}
                        >
                            <span data-memory-writer-action={writerAction}>
                                {writerAction === "resume" ? receiptText.resume : receiptText.recordNow}
                            </span>
                        </Button>
                    {/if}
                </div>
            {/if}

            {#if chatRef && heldFacts?.resettable}
                <div
                    class="flex flex-wrap items-center justify-between gap-2 text-sm text-textcolor2"
                    data-memory-reset
                >
                    <span class="min-w-0">{adoptText.resetOffer}</span>
                    <Button
                        size="sm"
                        styled="outlined"
                        disabled={pressing || readOnly || taskLive}
                        onclick={pressReset}
                    >
                        <span data-memory-reset-action>{adoptText.reset}</span>
                    </Button>
                </div>
            {/if}

            <div class="flex flex-col flex-1 min-h-0 overflow-y-auto" tabindex="-1">
                {#if chatRef}
                    {#key chatKey}
                        <activeTab.component {chatRef} {readOnly} {refresh} {focus} {open} {jump} />
                    {/key}
                {/if}
            </div>
        </div>
    </div>
</div>
