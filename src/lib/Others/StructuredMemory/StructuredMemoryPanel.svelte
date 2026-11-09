<script lang="ts">
    import { RefreshCcwIcon, XIcon } from "@lucide/svelte";
    import { untrack, type Component } from "svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertError, alertToast } from "src/ts/alert";
    import { requestMessageJump } from "src/ts/messageSearch.svelte";
    import { chatStatusKey, generatingChatKeys } from "src/ts/process/chatStatus.svelte";
    import { isLocalSend, localSends } from "src/ts/process/localSends";
    import {
        cancelMemoryTask,
        memoryTaskAwaitingSync,
        memoryTaskFenced,
        memoryTaskStatus,
    } from "src/ts/process/memoryTasks.svelte";
    import {
        abandonStructuredMemoryRebuild,
        adoptStructuredMemory,
        declineStructuredMemory,
        memoryWriterNotice,
        newestAssistantMessageId,
        newestMemoryReceipt,
        readStructuredMemoryContents,
        resetStructuredMemorySummaries,
        takeMemoryPanelTarget,
        type MemoryPanelTabProps,
        type MemoryPanelTarget,
        type StructuredMemoryResult,
    } from "src/ts/process/structuredMemory.svelte";
    import { characterList, findCharacter, type AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import {
        chatInstallVersion,
        currentChatRef,
        findChat,
        markChatStale,
        type ChatRef,
    } from "src/ts/storage/chatStore.svelte";
    import { refreshStaleChat } from "src/ts/storage/resourceSync.svelte";
    import { setChatOpen } from "src/ts/storage/selection.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { hypaV3ModalOpen } from "src/ts/stores.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
    import {
        normalizeStructuredMemorySettings,
        structuredMemoryWriterLanguage,
        writerPaused,
        type StructuredMemoryRebuild,
        type StructuredMemoryRebuildMode,
    } from "../../../../shared/structuredMemory.ts";
    import { memoryTaskStatusLine } from "../HypaV3Modal/taskStatusLine";
    import CoverageTab from "./CoverageTab.svelte";
    import LogTab from "./LogTab.svelte";
    import { pressMemoryRebuild, pressMemoryRebuildResume, pressMemoryRecord } from "./memoryRecordPress";
    import { memoryReadFailureText, memoryReasonText } from "./memoryText";
    import PagesTab from "./PagesTab.svelte";
    import PreviewTab from "./PreviewTab.svelte";
    import SettingsTab from "./SettingsTab.svelte";
    import ThreadsTab from "./ThreadsTab.svelte";
    import TimelineTab from "./TimelineTab.svelte";

    /**
     * The memory panel mounted by src/App.svelte under the shared `hypaV3ModalOpen` store. Each `TABS`
     * component takes `MemoryPanelTabProps` and exists only while selected. `open` carries a record target
     * between tabs; `jump` opens the chat before requesting its message and closing the panel. Receipt links
     * arrive before mount through src/ts/process/structuredMemory.svelte.ts's `requestMemoryPanelTarget`.
     *
     * A tab rereads when `refresh` moves: on demand, on an install of the chat (a checkpoint load, another
     * tab's edit), when read-only falls, and when a rebuild's task ends while its run still holds read-only
     * up. This catches record-now work inside a generation job too.
     * Held-message edits need no read. Preview alone runs on its button, since its local send moves refresh.
     * The fence's wait for a held revision notifies nothing, so that wait is checked each second.
     *
     * Pages, Timeline, and Threads write through the memory routes; read-only disables their controls
     * before the server's write fence decides. Settings writes chat fields through
     * src/ts/storage/chatStore.svelte.ts's `setChatMeta`, with read-only disabling its controls locally.
     * The writer line uses current contents and settings, since receipts are copies.
     * Adoption, reset, rebuild, and recorded language come from server/src/routes/structuredMemory.ts's
     * contents answer, never the tab's HypaV3 mirror. Adoption and decline precede the writer line; reset
     * follows it, and decline and reset ask first. The server rechecks every choice.
     *
     * Below those a chat is offered a rebuild and a backfill, each priced and asked first, and a language
     * change is one more reason to take the rebuild. A chat that holds a run shows it instead: the run is
     * the server's and outlives this panel, so it stays read-only until the swap or an abandon, and the
     * writer line's buttons stay off. Pausing, resuming, and above all abandoning are always a press away,
     * and the contents are read again when the run's task ends.
     */

    const text = language.structuredMemory.panel;
    const receiptText = language.structuredMemory.receipt;
    const adoptText = language.structuredMemory.adopt;
    const rebuildText = language.structuredMemory.rebuild;
    const TABS: { value: string; label: string; component: Component<MemoryPanelTabProps> }[] = [
        { value: "coverage", label: text.coverage, component: CoverageTab },
        { value: "preview", label: text.preview, component: PreviewTab },
        { value: "pages", label: text.pages, component: PagesTab },
        { value: "timeline", label: text.timeline, component: TimelineTab },
        { value: "threads", label: text.threads, component: ThreadsTab },
        { value: "log", label: text.log, component: LogTab },
        { value: "settings", label: text.settings, component: SettingsTab },
    ];

    let tab = $state<string | number>(TABS[0].value);
    let refresh = $state(0);

    const activeTab = $derived(TABS.find(({ value }) => value === tab) ?? TABS[0]);
    const chatRef = $derived(currentChatRef());
    const chatKey = $derived(chatRef ? chatStatusKey(chatRef) : null);
    const installVersion = $derived(chatRef ? chatInstallVersion(chatRef) : 0);

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

    /** What the chat's contents say and which chat they were read for; a read that failed says nothing. */
    let contentsFacts = $state.raw<{
        chatKey: string | null;
        paused: boolean;
        pendingRepairs: number;
        adoptable: number;
        resettable: boolean;
        rebuild: StructuredMemoryRebuild | null;
        recordedLanguage: string | null;
        writerBlockingReason?: "pluginModel" | "requestTrigger" | null;
    } | null>(null);
    let contentsRead = 0;
    const heldFacts = $derived(contentsFacts?.chatKey === chatKey ? contentsFacts : null);
    /** The chat's rebuild as the server last said: a run holds the chat whether or not its task is live. */
    const rebuild = $derived(heldFacts?.rebuild ?? null);

    /**
     * A send of this tab, a job this tab knows of, the chat's memory task fence (`memoryWriteFence` in the
     * modal), or the chat's rebuild.
     */
    const readOnly = $derived.by(() => {
        syncCheck;
        return (
            chatRef !== null &&
            (isLocalSend(chatRef, $localSends) ||
                generatingChatKeys().has(chatStatusKey(chatRef)) ||
                memoryTaskFenced(chatRef) ||
                rebuild !== null)
        );
    });
    const taskStatus = $derived(chatRef ? memoryTaskStatus(chatRef) : null);
    const taskLine = $derived(memoryTaskStatusLine(taskStatus));
    const taskLive = $derived(taskStatus?.state === "queued" || taskStatus?.state === "running");

    // The chat the last check saw: another chat's tab reads on its own, as it mounts. A run holds read-only
    // up past its task's end, so that end reads the contents too, which is what lets read-only fall.
    let seen: { chatKey: string | null; installVersion: number; readOnly: boolean; taskLive: boolean } | null = null;
    $effect(() => {
        const now = { chatKey, installVersion, readOnly, taskLive };
        const runTaskEnded = seen?.taskLive === true && !now.taskLive && untrack(() => rebuild !== null);
        if (
            seen?.chatKey === now.chatKey &&
            (seen.installVersion !== now.installVersion || (seen.readOnly && !now.readOnly) || runTaskEnded)
        ) {
            untrack(() => (refresh += 1));
        }
        seen = now;
    });

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
                          paused:
                              result.value.health === "unavailable"
                                  ? writerPaused(result.value.runs)
                                  : result.value.health.paused,
                          pendingRepairs:
                              result.value.health === "unavailable" ? 0 : result.value.health.pendingRepairs,
                          adoptable: result.value.adoption.adoptable,
                          resettable: result.value.adoption.resettable,
                          rebuild: result.value.rebuild,
                          recordedLanguage: result.value.recordedLanguage,
                          writerBlockingReason: result.value.writerBlockingReason,
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
    const writerSettings = $derived(
        normalizeStructuredMemorySettings(
            selectedHypaV3Preset({
                hypaV3Presets: settings.hypaV3Presets.items,
                hypaV3PresetId: settings.hypaV3Presets.selectedId,
            })?.settings.structured,
        ),
    );
    const cadence = $derived(writerSettings.cadence);
    /** The events the held chat's summaries would adopt, 0 for a chat the server does not hold. */
    const adoptable = $derived(heldFacts?.adoptable ?? 0);
    const notice = $derived(
        memoryWriterNotice({
            memoryOn: chatRef !== null && !!findCharacter(chatRef.chaId)?.supaMemory,
            cadence,
            paused: heldFacts?.paused ?? false,
            pendingRepairs: heldFacts?.pendingRepairs ?? 0,
            adoptionHeld: adoptable > 0,
            receipt: newestMemoryReceipt(messages),
            taskLive,
            writerBlockingReason: heldFacts?.writerBlockingReason,
        }),
    );
    /** Record names the newest reply, so a chat without one has nothing to press, and a rebuild's run holds the chat. */
    const writerAction = $derived(
        rebuild !== null || (notice.action === "record" && newestReply === undefined) ? null : notice.action,
    );
    const writerText = $derived.by(() => {
        switch (notice.kind) {
            case "memoryOff":
                return text.memoryOff;
            case "paused":
                return receiptText.paused;
            case "repair":
                return receiptText.repairPending;
            case "notAutomatic":
                return receiptText.notAutomatic(memoryReasonText(notice.reason));
            default:
                return null;
        }
    });

    /** What the chat's records were last written in, when the writer would now write in something else. */
    const languageChange = $derived.by(() => {
        const recorded = heldFacts?.recordedLanguage ?? null;
        const current = chatRef
            ? structuredMemoryWriterLanguage(
                  findChat(chatRef),
                  findCharacter(chatRef.chaId),
                  writerSettings.language,
                  settings.ui.language,
              )
            : recorded;
        return recorded !== null && current !== recorded ? { recorded, current } : null;
    });
    /** A live task's count is newer than the contents, read before it ran. */
    const rebuildProgress = $derived(taskLive && taskStatus && taskStatus.total > 0 ? taskStatus : rebuild);
    const rebuildLine = $derived.by(() => {
        const { done = 0, total = 0 } = rebuildProgress ?? {};
        return rebuild?.mode === "backfill"
            ? rebuildText.backfillProgress(done, total)
            : rebuild?.mode === "fresh"
              ? rebuildText.freshProgress(done, total)
              : rebuildText.progress(done, total);
    });
    /** Why the run is not going on, past what the task line says while its terminal is retained. */
    const rebuildStop = $derived.by(() => {
        if (!rebuild || taskLive) {
            return null;
        }
        if (!rebuild.resumable) {
            return rebuildText.replaced;
        }
        if (rebuild.error !== undefined) {
            return rebuildText.stopped(rebuild.error);
        }
        const { reason } = rebuild;
        if (reason === undefined) {
            return rebuildText.paused;
        }
        const { stopReasons } = rebuildText;
        return rebuildText.stopped(Object.hasOwn(stopReasons, reason) ? stopReasons[reason] : memoryReasonText(reason));
    });

    let pressing = $state(false);

    const findOwner = (ref: ChatRef | null) => characterList().find((entry) => entry?.chaId === ref?.chaId);

    async function pressWriter() {
        const ref = chatRef;
        const owner = findOwner(ref);
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
     * Every successful reset answer reads the chat, including a repeat after a lost answer to a committed
     * reset. The reset is a write of the server's, so the tab's held summaries go with a read and it writes
     * nothing back. The chat is marked first: the idle refresh then reads it once local work is done, or
     * after a read that failed, and a whole read brings the projection in their place.
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
                await readResetChat(ref);
            },
            adoptText.resetConfirm,
        );
    }

    /** One press that starts or resumes a run, whose job ends at once, so the contents then show the run. */
    async function pressRun(run: (owner: AnyClientCharacter, ref: ChatRef) => Promise<void>) {
        const ref = chatRef;
        const owner = findOwner(ref);
        if (!ref || !owner || pressing) {
            return;
        }
        pressing = true;
        try {
            await run(owner, ref);
            refresh += 1;
        } finally {
            pressing = false;
        }
    }

    function pressRebuild(mode: StructuredMemoryRebuildMode) {
        return pressRun((owner, ref) => pressMemoryRebuild(owner, ref, mode));
    }

    /** Ends the run's task: the run stays, stopped, and the task's end reads the contents. */
    async function pressPause() {
        const ref = chatRef;
        if (!ref || pressing) {
            return;
        }
        pressing = true;
        try {
            const result = await cancelMemoryTask(ref);
            if (result.outcome === "failed") {
                alertError(rebuildText.pauseFailed(result.error));
            } else if (result.outcome === "refused" && result.reason !== "epoch") {
                alertError(rebuildText.pauseFailed(result.reason));
            }
        } finally {
            pressing = false;
        }
    }

    function pressAbandon() {
        return pressChoice(
            abandonStructuredMemoryRebuild,
            ({ abandoned }) => {
                alertToast(abandoned ? rebuildText.abandoned : rebuildText.abandonNothing);
            },
            rebuildText.abandonConfirm,
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

    const requested = untrack(() => takeMemoryPanelTarget(chatRef));
    if (requested) {
        open(requested);
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
                        <span role="status" data-memory-panel-read-only>
                            {rebuild ? rebuildText.readOnly : text.readOnly}
                        </span>
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

            {#if chatRef && writerSettings.fineTuning}
                <div class="text-sm text-textcolor2" data-memory-custom-prompt>{receiptText.customPrompt}</div>
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

            {#if chatRef && rebuild}
                <div
                    class="flex flex-wrap items-center justify-between gap-2 text-sm text-textcolor2"
                    data-memory-rebuild={rebuild.mode}
                >
                    <div class="flex flex-col min-w-0 gap-1">
                        <span role="status" data-memory-rebuild-progress>{rebuildLine}</span>
                        {#if rebuildStop !== null}
                            <span role="status" data-memory-rebuild-stop>{rebuildStop}</span>
                        {/if}
                    </div>
                    <div class="flex flex-wrap gap-2">
                        {#if taskLive}
                            <Button size="sm" styled="outlined" disabled={pressing} onclick={pressPause}>
                                <span data-memory-rebuild-pause>{rebuildText.pause}</span>
                            </Button>
                        {:else if rebuild.resumable}
                            <Button
                                size="sm"
                                styled="outlined"
                                disabled={pressing}
                                onclick={() => pressRun(pressMemoryRebuildResume)}
                            >
                                <span data-memory-rebuild-resume>{rebuildText.resume}</span>
                            </Button>
                        {/if}
                        <Button size="sm" styled="outlined" disabled={pressing} onclick={pressAbandon}>
                            <span data-memory-rebuild-abandon>{rebuildText.abandon}</span>
                        </Button>
                    </div>
                </div>
            {:else if chatRef && heldFacts && adoptable === 0}
                <div
                    class="flex flex-wrap items-center justify-between gap-2 text-sm text-textcolor2"
                    data-memory-rebuild-offer
                >
                    <div class="flex flex-col min-w-0 gap-1">
                        <span>{rebuildText.offer}</span>
                        {#if languageChange}
                            <span data-memory-rebuild-language>
                                {rebuildText.languageChanged(languageChange.recorded, languageChange.current)}
                            </span>
                        {/if}
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            styled="outlined"
                            disabled={pressing || readOnly || taskLive}
                            onclick={() => pressRebuild("backfill")}
                        >
                            <span data-memory-rebuild-action="backfill">{rebuildText.fillGaps}</span>
                        </Button>
                        <Button
                            size="sm"
                            styled="outlined"
                            disabled={pressing || readOnly || taskLive}
                            onclick={() => pressRebuild("rebuild")}
                        >
                            <span data-memory-rebuild-action="rebuild">{rebuildText.rebuild}</span>
                        </Button>
                        <Button
                            size="sm"
                            styled="outlined"
                            disabled={pressing || readOnly || taskLive}
                            onclick={() => pressRebuild("fresh")}
                        >
                            <span data-memory-rebuild-action="fresh">{rebuildText.fresh}</span>
                        </Button>
                    </div>
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
