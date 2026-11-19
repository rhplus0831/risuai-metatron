<script lang="ts">
    import {
        BookAlertIcon,
        ChevronUpIcon,
        CircleAlertIcon,
        GaugeIcon,
        LoaderCircleIcon,
        SettingsIcon,
    } from "@lucide/svelte";
    import { onDestroy, tick, untrack } from "svelte";
    import { language } from "src/lang";
    import { doingAlert, terminalNotice } from "src/ts/alert";
    import { topBindingLayer } from "src/ts/gui/dialogLayers";
    import type { SettingHit } from "src/ts/setting/searchIndex";
    import { memoryHealthFacts } from "src/ts/process/chatStatus.svelte";
    import { memoryTaskStatus } from "src/ts/process/memoryTasks.svelte";
    import {
        memoryItemTitles,
        memoryStatusWord,
        newestMemoryReceipt,
        readStructuredMemoryContents,
        standingMemoryReport,
    } from "src/ts/process/structuredMemory.svelte";
    import { openSetting } from "src/ts/setting/settingJump.svelte";
    import { INTERACTION_SETTINGS_MENU } from "src/ts/settingsMenu";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatBinding } from "src/ts/storage/chatBinding.svelte";
    import { chatEntry, findChat, setChatMeta, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { readSettingsRoot, settings } from "src/ts/storage/settingsViews.svelte";
    import { hypaV3ModalOpen, settingsOpen, SettingsMenuIndex, MEMORY_SETTINGS_MENU } from "src/ts/stores.svelte";
    import { createTokenCountField } from "src/ts/tokenCountField";
    import { countTokensInScope, jobTokenScope, tokenScopeKey } from "src/ts/tokenizer";
    import { get } from "svelte/store";
    import {
        displacement,
        fixedShare,
        historyDigest,
        parseContextReport,
        turnCount,
        type ContextReport,
        type ContextSectionKind,
    } from "../../../shared/contextReport.ts";
    import { maxContextOverrideOf } from "../../../shared/sections.ts";
    import { supaMemoryOnCount } from "../../../shared/characters.ts";
    import { chatMemoryAlgorithm, chatMemoryEnabled } from "../../../shared/chatMemory.ts";
    import { chatMemorySettings, setChatMemoryEnabled } from "src/ts/storage/chatMemory.svelte";
    import type { TabTokenScope } from "../../../shared/tokenizerChoice.ts";
    import MemoryManifest from "../Others/StructuredMemory/MemoryManifest.svelte";
    import Portal from "../UI/GUI/Portal.svelte";

    /**
     * The composer's context line: how the last request spent the model's context, read from the open chat's
     * latest `generationInfo.context` (`shared/contextReport.ts`). The prompt is rebuilt and trimmed every send,
     * so the line shows the history window kept and the share of the prompt budget (`maxContext - maxResponse`)
     * used; the popover breaks the last request down. While the user types, the line estimates how many older
     * messages the send would push out (`displacement`).
     *
     * The memory word is the chat's memory as the next send resolves it (`memoryNow`), not the last reply's:
     * a chat with memory set up shows the line before its first reply, and the last reply's coverage is the
     * word only while the same memory is still on. The popover's memory block states it, says how the last
     * reply differed, and holds the chat's switch and the ways to the memory panel and settings.
     *
     * `DefaultChatScreen.svelte` mounts it above the composer row, keyed by the open chat; it is hidden in group
     * chats and with `settings.ui.contextMeter` off. A lore budget rejection replaces the gauge icon (unless the
     * chat set `loreBudgetWarnOff`), and the memory and task marks sit outside the truncated part of the line.
     * The popover is portaled and follows its line on resize, scroll, and composer growth. The estimate is counted
     * asynchronously; a failed count clears it.
     */

    interface Props {
        /** The displayed chat; the mount is keyed by it, so a chat switch starts closed. */
        chatRef: ChatRef;
        /** The selected character is a group: the meter is not shown. */
        group: boolean;
        /** The composer row's height: the line above it moves as it grows, so an open popover follows. */
        height: string;
        /** The composer text (shared across chats), for the displacement estimate. */
        draft?: string;
        /** A send or job runs in the chat: no estimate. */
        generating?: boolean;
    }

    const { chatRef, group, height, draft = "", generating = false }: Props = $props();

    type Source =
        | { kind: "report"; messageId: string | undefined; report: ContextReport }
        | { kind: "legacy"; messageId: string | undefined; input: number; maxContext: number };

    const PANEL_WIDTH = 352;
    const EDGE = 8;
    const memoryColor = "bg-secondary-500";
    /**
     * The fixed sections whose size follows the bot rather than the preset, grouped by where the user would cut
     * them down. A group at or above `SPLIT_FROM` percent of the prompt budget leaves the fixed group's neutral
     * color for its own in the bar, the legend, and its rows' dots; a smaller one stays neutral, so a bot with
     * little lore or description reads as one fixed block. The two colors are told apart from each other, the
     * neutral, the memory, and the history colors under simulated color blindness too.
     */
    const SPLIT_GROUPS = [
        { kind: "lore", color: "bg-meter-lore", sections: ["lorebook"] },
        { kind: "character", color: "bg-meter-character", sections: ["description", "examples", "persona"] },
    ] as const satisfies readonly { kind: string; color: string; sections: readonly ContextSectionKind[] }[];
    const SPLIT_FROM = 5;

    const visible = $derived(settings.ui.contextMeter && !group);

    // The newest valid report wins; a reply without one (older, or unreadable) falls back to the
    // newest legacy token counts only when no message has a report. Reads only the message list and
    // each scanned message's `generationInfo`, never `data`, so streaming text does not rerun it.
    const source: Source | null = $derived.by(() => {
        if (!visible) {
            return null;
        }
        const messages = findChat(chatRef)?.message;
        if (!messages) {
            return null;
        }
        let legacy: Source | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const info = messages[i].generationInfo;
            if (!info) {
                continue;
            }
            const report = parseContextReport(info.context);
            if (report) {
                return { kind: "report", messageId: messages[i].chatId, report };
            }
            const { inputTokens, maxContext } = info;
            if (
                legacy === null &&
                typeof inputTokens === "number" &&
                Number.isFinite(inputTokens) &&
                inputTokens >= 0 &&
                typeof maxContext === "number" &&
                Number.isFinite(maxContext) &&
                maxContext > 0
            ) {
                legacy = { kind: "legacy", messageId: messages[i].chatId, input: inputTokens, maxContext };
            }
        }
        return legacy;
    });

    const report = $derived(source?.kind === "report" ? source.report : null);
    const unit = $derived(settings.ui.contextMeterTurnUnit === "message" ? "message" : "user");
    const warn = $derived(settings.ui.contextMeterFixedWarn);
    const settingsLabel = $derived(
        language.contextUsage.basis(
            unit === "user" ? language.contextUsage.basisTurns : language.contextUsage.basisMessages,
            warn,
        ),
    );

    const fmt = (value: number) => value.toLocaleString();
    /** `part` of `whole` in whole percent; 100 without a whole. */
    const percentOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 100);
    /** A bar width in percent, clamped to the bar. */
    const widthOf = (part: number, whole: number) =>
        whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : part > 0 ? 100 : 0;

    const promptBudget = $derived(report ? report.maxContext - report.maxResponse : 0);
    // What the reply request holds: the counted messages, the offered tool schemas, and the
    // messages Request Interception inserts (the report keeps the last two apart from `input`).
    const occupied = $derived(report ? report.input + (report.toolSchemas ?? 0) + (report.interceptions ?? 0) : 0);
    const fixed = $derived(report ? fixedShare(report) * 100 : 0);
    const fixedOver = $derived(report !== null && fixed > warn);
    const memoryName = $derived(report?.memory ? language.contextUsage.memoryKinds[report.memory.kind] : "");
    // The lore budget left entries out of the last request: the chip warns unless this chat turned
    // the warning off (the popover lists them either way).
    const loreWarnOff = $derived(findChat(chatRef)?.loreBudgetWarnOff === true);
    const loreWarn = $derived(report !== null && report.lore.rejectedCount > 0 && !loreWarnOff);
    // The memory's token budget was reduced to fit the last request's max context, as the server reported it.
    const budgetReduced = $derived(report?.memory?.budgetReduced ?? []);

    type MemoryKind = NonNullable<ContextReport["memory"]>["kind"];

    /** The report's name for a memory algorithm; null for none. */
    function memoryKindOf(algorithm: ReturnType<typeof chatMemoryAlgorithm>): MemoryKind | null {
        switch (algorithm) {
            case "structuredMemory":
                return "structuredMemory";
            case "hypaMemoryV3":
                return "hypaV3";
            case "hypaMemoryV2":
                return "hypaV2";
            case "hanuraiMemory":
                return "hanurai";
            case "supaMemory":
                return "supa";
            default:
                return null;
        }
    }

    // The chat's memory as the next send resolves it (`assemblePrompt`'s `memoryConfigured` and
    // `chatMemoryEnabled`), from the chat's list entry and the settings: null with no memory set up.
    // Unlike the report it follows the chat's switch and mode at once.
    const memoryNow: { on: boolean; kind: MemoryKind } | null = $derived.by(() => {
        const entry = visible ? chatEntry(chatRef) : undefined;
        if (!entry) {
            return null;
        }
        const memorySettings = chatMemorySettings();
        const kind = memoryKindOf(chatMemoryAlgorithm(memorySettings, entry));
        return kind ? { on: chatMemoryEnabled(entry, findCharacter(chatRef.chaId), memorySettings), kind } : null;
    });
    const memoryNowName = $derived(memoryNow ? language.contextUsage.memoryKinds[memoryNow.kind] : "");
    /**
     * The report's memory, a Structured Memory one with its writer as the chat's runs leave it now
     * (`standingMemoryReport`): a failure a later run made good is not repeated until the next send.
     */
    const reportMemory = $derived.by(() => {
        const memory = report?.memory ?? null;
        return memory?.kind === "structuredMemory"
            ? standingMemoryReport(
                  memory,
                  memoryHealthFacts(chatRef),
                  newestMemoryReceipt(findChat(chatRef)?.message ?? []),
              )
            : memory;
    });
    /** The last reply's memory is the one that is on now: its coverage still describes the chat. */
    const reportedNow = $derived(memoryNow?.on === true && reportMemory?.kind === memoryNow.kind ? reportMemory : null);
    const leftOut = $derived(report ? Math.max(0, report.history.total - report.history.kept) : 0);
    // Memory is off and the last request left history out: nothing summarizes it. The server asks about
    // that trim once per send unless the chat answered "don't ask again" (`memoryTrimAck`, valid while it
    // equals the owner's count), and the line keeps quiet then too.
    const memoryOffWarn = $derived(
        memoryNow?.on === false &&
            leftOut > 0 &&
            chatEntry(chatRef)?.memoryTrimAck !== supaMemoryOnCount(findCharacter(chatRef.chaId)),
    );

    // The chat's background memory task (`memoryTasks.svelte.ts`): HypaV3 summaries or the Structured
    // Memory writer. Unlike the report it is live: the line shows queued or running tasks, and the
    // popover says how they ended.
    const task = $derived(visible ? memoryTaskStatus(chatRef) : null);
    /** The meter's source as content: a new reply, or a continue that rewrote the report, changes it. */
    const sourceKey = (value: Source | null) =>
        value ? JSON.stringify([value.messageId, value.kind === "report" ? value.report : value.input]) : null;
    // A memory task this mount saw run and then commit, with the source it followed: the notice
    // holds until the source changes, and ends for good then (deleting the newer reply does not bring
    // it back).
    let landed: { taskId: string; source: string | null } | null = $state(null);
    let liveTaskId: string | null = null;
    $effect(() => {
        const current = task;
        untrack(() => {
            if (current?.state === "queued" || current?.state === "running") {
                liveTaskId = current.taskId;
                return;
            }
            if (current?.state === "done" && current.taskId === liveTaskId && current.lastCommittedRevision) {
                landed = { taskId: current.taskId, source: sourceKey(source) };
            }
            liveTaskId = null;
        });
    });
    $effect(() => {
        if (landed && sourceKey(source) !== landed.source) {
            landed = null;
        }
    });
    const taskStrings = $derived.by(() => {
        const s = language.contextUsage;
        return task?.kind === "structuredMemory"
            ? s.writerTask
            : {
                  title: s.taskTitle,
                  queued: s.taskQueued,
                  running: s.taskRunning,
                  runningUnknown: s.taskRunningUnknown,
                  liveNote: s.taskLiveNote,
                  done: s.taskDone,
                  failed: s.taskFailed,
                  failedMark: s.taskFailedMark,
              };
    });
    const taskView: { tone: "live" | "done" | "failed"; text?: string; error?: string } | null = $derived.by(() => {
        const s = taskStrings;
        if (task?.state === "queued") {
            return { tone: "live", text: s.queued };
        }
        if (task?.state === "running") {
            return { tone: "live", text: task.total > 0 ? s.running(task.done, task.total) : s.runningUnknown };
        }
        if (task?.state === "done" && landed?.taskId === task.taskId && landed.source === sourceKey(source)) {
            return { tone: "done" };
        }
        if (task?.state === "failed") {
            return { tone: "failed", error: task.error };
        }
        return null;
    });

    type Basis = {
        report: ContextReport;
        trim: NonNullable<ContextReport["trim"]>;
        /** The report is a continue of the last reply: its prefix is already in the ledger. */
        continued: boolean;
        prefix: number;
        /** The last reply as assembly counts it. */
        reply: string;
        scope: TabTokenScope;
        /** Identifies the basis: a result for another reply, scope, or ledger is never shown. */
        key: string;
    };

    /** Assembly counts a message without its `<Thoughts>` block (`server/src/prompt/thoughts.ts`). */
    function stripThoughts(text: string): string {
        const start = text.indexOf("<Thoughts>");
        if (start < 0) {
            return text;
        }
        const close = text.lastIndexOf("</Thoughts>");
        return close <= start + "<Thoughts>".length
            ? text
            : text.slice(0, start) + text.slice(close + "</Thoughts>".length);
    }

    /** The main model's context size as the job's database has it (the prompt preset's override applied). */
    const effectiveMaxContext = () =>
        maxContextOverrideOf({
            maxContextOverride: readSettingsRoot("maxContextOverride"),
            maxContextOverrideSize: readSettingsRoot("maxContextOverrideSize"),
        }) ?? readSettingsRoot("maxContext");

    /**
     * The report's trim ledger while it still describes the next send: no memory that could run instead
     * of the trim loop (the server asks first when the character has it off), no preset chain picking
     * another prompt preset, a complete binding, the report's message the chat's last and enabled, the
     * history before it unchanged, and the same token scope and sizes.
     */
    function estimateBasis(r: ContextReport, trim: Basis["trim"], messageId: string): Basis | null {
        const memoryConfigured = chatMemoryAlgorithm(chatMemorySettings(), chatEntry(chatRef)) !== "none";
        if (memoryConfigured || readSettingsRoot("presetChain") || chatBinding(chatRef)?.ok === false) {
            return null;
        }
        const messages = findChat(chatRef)?.message;
        const last = messages?.at(-1);
        if (!messages || !last || last.chatId !== messageId || last.disabled) {
            return null;
        }
        const prefix = trim.replyPrefix;
        if (prefix !== undefined && prefix.messageId !== messageId) {
            return null;
        }
        const scope = jobTokenScope();
        const scopeKey = tokenScopeKey(scope);
        if (
            r.tokenScope !== scopeKey ||
            r.maxContext !== effectiveMaxContext() ||
            r.maxResponse !== readSettingsRoot("maxResponse")
        ) {
            return null;
        }
        if (historyDigest(messages.slice(0, -1)) !== r.historyDigest) {
            return null;
        }
        const reply = stripThoughts(last.data);
        return {
            report: r,
            trim,
            continued: prefix !== undefined,
            prefix: prefix?.tokens ?? 0,
            reply,
            scope,
            key: JSON.stringify([messageId, scopeKey, prefix?.tokens ?? null, trim.perMessage, reply]),
        };
    }

    // `generating` is read first, so a streaming reply never reruns the message reads.
    const basis: Basis | null = $derived.by(() => {
        if (generating || !report?.trim || source?.messageId === undefined) {
            return null;
        }
        try {
            return estimateBasis(report, report.trim, source.messageId);
        } catch {
            // No model preset resolves: the scope cannot be prepared.
            return null;
        }
    });

    type CountInput = Pick<Basis, "key" | "scope" | "reply" | "prefix"> & { perMessage: number; draft: string };
    type CountResult = { key: string; added: number };

    let counted: CountResult | null = $state(null);
    // The last reply's count by basis key, so typing recounts only the draft. Set only by a run that
    // was not superseded.
    let replyCount: { key: string; tokens: number } | undefined;
    // The basis key the field counts for: a new one resets it, so it counts at once.
    let fieldKey: string | null = null;

    const field = createTokenCountField<CountInput, CountResult>({
        count: async (input, signal) => {
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            if (signal.aborted) {
                abort();
            } else {
                signal.addEventListener("abort", abort, { once: true });
            }
            try {
                const known = replyCount?.key === input.key ? replyCount.tokens : undefined;
                const [reply, draftTokens] = await Promise.all([
                    known ?? countTokensInScope(input.reply, input.scope, controller.signal),
                    countTokensInScope(input.draft, input.scope, controller.signal),
                ]);
                if (!signal.aborted) {
                    replyCount = { key: input.key, tokens: reply };
                }
                // The ledger adds each new message's count plus the per-message overhead; a continue's
                // prefix (overhead included) is already in it.
                return {
                    key: input.key,
                    added: reply + input.perMessage - input.prefix + draftTokens + input.perMessage,
                };
            } catch (error) {
                controller.abort(error);
                throw error;
            } finally {
                signal.removeEventListener("abort", abort);
            }
        },
        apply: (result) => (counted = result),
        onError: () => {
            counted = null;
            field.reset();
        },
        same: (a, b) => a.key === b.key && a.draft === b.draft,
    });
    onDestroy(() => field.dispose());

    $effect(() => {
        const current = basis;
        const text = draft;
        untrack(() => {
            if (!current || text === "") {
                field.reset();
                fieldKey = null;
                counted = null;
                return;
            }
            if (fieldKey !== current.key) {
                field.reset();
                fieldKey = current.key;
                counted = null;
            }
            field.update({
                key: current.key,
                scope: current.scope,
                reply: current.reply,
                prefix: current.prefix,
                perMessage: current.trim.perMessage,
                draft: stripThoughts(text),
            });
        });
    });

    // A count for an earlier draft of the same basis stays until the debounced recount lands, as
    // editor token counts do.
    const estimate = $derived.by(() => {
        if (!basis || !counted || counted.key !== basis.key || draft === "") {
            return null;
        }
        const { trim } = basis;
        const outcome = displacement(basis.report, counted.added);
        if (outcome === "unavailable") {
            return null;
        }
        // A continue's reply can be the queue's last entry, saved with its prefix's count: an overflow
        // reaching that entry cannot be estimated.
        if (basis.continued) {
            const beforeLast = trim.queue.slice(0, -1).reduce((sum, entry) => sum + entry.tokens, 0);
            if (counted.added - trim.headroom > beforeLast) {
                return null;
            }
        }
        const s = language.contextUsage;
        const unitText = (count: number) => (unit === "user" ? s.turns(count) : s.messages(count));
        if (outcome === "beyondQueue") {
            const atLeast = trim.queue.filter(
                (entry) => entry.kind === "message" && (unit === "message" || entry.user),
            ).length;
            return {
                suffix: s.estimateBeyondSuffix(atLeast),
                line: atLeast > 0 ? s.estimateBeyond(unitText(atLeast)) : s.estimateBeyondUnknown,
            };
        }
        const count = unit === "user" ? outcome.userMessages : outcome.messages;
        const kept = turnCount(basis.report, unit).kept;
        if (count > 0) {
            return {
                suffix: s.estimateSuffix(count),
                line: s.estimateDrops(unitText(count), unitText(kept), Math.max(0, kept - count)),
            };
        }
        return {
            suffix: "",
            line: outcome.messages > 0 ? s.estimateNoTurns(s.messages(outcome.messages)) : s.estimateFits,
        };
    });

    /** The line's word for a Structured Memory report. */
    function memoryStatusText(memory: NonNullable<ContextReport["memory"]>): string {
        const word = memoryStatusWord(memory);
        if (word === "gap" || word === "memoryOn") {
            return language.contextUsage[word];
        }
        return language.structuredMemory.meter.status[word];
    }

    /**
     * The line: what the last reply kept, the memory word, then the percentage and a fixed share over its
     * warning. `word` is a Structured Memory writer word a task mark can stand in for: a live task says
     * more than "pending" or "recorded", and a failed one repeats "failed".
     */
    type Chip = {
        lead: string[];
        memory: { text: string; warn: boolean; word?: string } | null;
        tail: string[];
        summary: string;
    };

    const chip: Chip | null = $derived.by(() => {
        const s = language.contextUsage;
        // The switch's state, for a line whose last reply does not describe it.
        const stated = memoryNow ? { text: memoryNow.on ? s.memoryOn : s.memoryOff, warn: memoryOffWarn } : null;
        const statedSummary = memoryNow
            ? (memoryNow.on ? s.memoryNowOnSummary : s.memoryNowOffSummary)(memoryNowName)
            : null;
        const withStated = (summary: string) => (statedSummary ? `${summary}; ${statedSummary}` : summary);
        if (!source) {
            return stated && statedSummary ? { lead: [], memory: stated, tail: [], summary: statedSummary } : null;
        }
        if (source.kind === "legacy") {
            const percent = percentOf(source.input, source.maxContext);
            return {
                lead: [],
                memory: stated,
                tail: [`${percent}%`],
                summary: withStated(s.legacySummary(percent)),
            };
        }
        const r = source.report;
        const kept = turnCount(r, unit).kept;
        const keptText = unit === "user" ? s.turns(kept) : s.messages(kept);
        const percent = percentOf(occupied, promptBudget);
        const result: Chip = { lead: [keptText], memory: stated, tail: [`${percent}%`], summary: "" };
        if (reportedNow?.kind === "structuredMemory") {
            const tokens = s.tokens(fmt(reportedNow.tokens));
            const status = memoryStatusText(reportedNow);
            const word = memoryStatusWord(reportedNow);
            result.lead.push(tokens);
            result.memory = { text: status, warn: word === "gap", word };
            result.summary = s.memorySummary(keptText, memoryNowName, `${tokens}, ${status}`);
        } else if (reportedNow) {
            // "covered" only says nothing left out is unsummarized: with nothing left out, no summary is behind it.
            const coverage =
                reportedNow.coverage === "covered" && leftOut > 0
                    ? s.summarized
                    : reportedNow.coverage === "gap"
                      ? s.gap
                      : s.memoryOn;
            result.memory = { text: coverage, warn: reportedNow.coverage === "gap" };
            result.summary = s.memorySummary(keptText, memoryNowName, coverage);
        } else {
            result.summary = withStated(leftOut > 0 ? s.trimmedSummary(keptText) : s.fullSummary(percent));
        }
        if (fixedOver) {
            result.tail.push(s.fixedPart(Math.round(fixed)));
            result.summary += `; ${s.fixedWarnSummary}`;
        }
        if (loreWarn) {
            result.summary += `; ${s.loreWarnSummary(r.lore.rejectedCount)}`;
        }
        if (budgetReduced.length > 0) {
            result.summary += `; ${s.memoryReducedSummary}`;
        }
        return result;
    });

    /**
     * The line with a task's mark, which sits where the memory word ends: in place of a word it stands in
     * for, else after it, so the line still opens with what the last reply kept. A failed task marks the
     * line too, since nothing else on it says the summaries or records stopped.
     */
    const chipLine = $derived.by(() => {
        if (!chip) {
            return null;
        }
        const mark =
            taskView?.tone === "live" && taskView.text
                ? { tone: "live" as const, text: taskView.text }
                : taskView?.tone === "failed"
                  ? { tone: "failed" as const, text: taskStrings.failedMark }
                  : null;
        const word = chip.memory?.word;
        const replaced =
            mark?.tone === "live"
                ? word === "pending" || word === "recorded"
                : mark?.tone === "failed" && word === "failed";
        return {
            lead: chip.lead.join(" · "),
            memory: replaced ? null : chip.memory,
            mark,
            tail: chip.tail.join(" · "),
        };
    });

    const chipTitle = $derived.by(() => {
        if (!chip) {
            return "";
        }
        const s = language.contextUsage;
        const summary = chip.summary + (chipLine?.mark ? `; ${s.taskSummary(chipLine.mark.text)}` : "");
        return (
            (source ? s.chipLabel(summary) : s.chipLabelNoReply(summary)) +
            (estimate ? ` ${s.estimateTitle}: ${estimate.line}` : "")
        );
    });

    // What the popover's memory block says of the last reply: that nothing summarizes the history it left
    // out, and that its memory is not the one stated above the breakdown.
    const memoryNotes = $derived.by(() => {
        const s = language.contextUsage;
        const notes: { key: "leftOut" | "last"; text: string; warn: boolean }[] = [];
        if (!memoryNow?.on && leftOut > 0) {
            notes.push({
                key: "leftOut",
                text: (memoryNow ? s.memoryOffLeftOut : s.memoryNoneLeftOut)(leftOut),
                warn: memoryOffWarn,
            });
        }
        if (report && !reportedNow && (report.memory || memoryNow?.on)) {
            notes.push({
                key: "last",
                text: report.memory ? s.memoryLastUsed(memoryName) : s.memoryLastWithout,
                warn: false,
            });
        }
        return notes;
    });
    // The memory panel the chat menu's row opens; HypaV2's editor is an alert and stays in the menu.
    const memoryPanelLabel = $derived(
        memoryNow?.kind === "structuredMemory"
            ? language.structuredMemory.panel.title
            : memoryNow?.kind === "hypaV3"
              ? language.hypaMemoryV3Modal
              : null,
    );

    // The split groups large enough to show apart from the rest of the fixed group, in `SPLIT_GROUPS` order.
    const splits = $derived(
        SPLIT_GROUPS.map((split) => {
            const sections: readonly ContextSectionKind[] = split.sections;
            const tokens = (report?.sections ?? []).reduce(
                (sum, section) => sum + (sections.includes(section.kind) ? section.tokens : 0),
                0,
            );
            return { kind: split.kind, color: split.color, sections, tokens };
        }).filter((split) => promptBudget > 0 && split.tokens * 100 >= promptBudget * SPLIT_FROM),
    );
    // Sections with tokens, largest first; ties keep the report's order. The tool schemas and the
    // inserted Request Interception messages are rows of their own among them. Dots identify their group.
    const rows = $derived.by(() => {
        if (!report) {
            return [];
        }
        const splitColor = (kind: ContextSectionKind | "toolSchemas" | "interceptions") =>
            splits.find((split) => kind !== "toolSchemas" && kind !== "interceptions" && split.sections.includes(kind))
                ?.color;
        return [
            ...report.sections,
            { kind: "toolSchemas" as const, tokens: report.toolSchemas ?? 0 },
            { kind: "interceptions" as const, tokens: report.interceptions ?? 0 },
        ]
            .filter((section) => section.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens)
            .map((section) => ({
                kind: section.kind,
                tokens: section.tokens,
                color:
                    section.kind === "memory"
                        ? memoryColor
                        : section.kind === "history"
                          ? "bg-primary-500"
                          : (splitColor(section.kind) ?? "bg-neutral-400"),
            }));
    });
    // The reserve belongs to the prompt budget; growth thresholds use the summarizer's history count.
    const hypa = $derived.by(() => {
        const memory = report?.memory;
        if (!report || memory?.kind !== "hypaV3" || memory.reserved === undefined || memory.summarizeIn === undefined) {
            return null;
        }
        return {
            tokens: memory.tokens,
            reserved: memory.reserved,
            summarizeIn: memory.summarizeIn,
            prepared: memory.prepared ?? 0,
            lookaheadIn: settings.ui.contextMeterLookahead ? memory.lookaheadIn : undefined,
        };
    });
    const historyTokens = $derived(rows.find((row) => row.kind === "history")?.tokens ?? 0);
    // The fixed group, less the groups split out of it, then those groups, the memory, and the history. A
    // fixed share over its warning shows on the tick and the line under the bar: the segments keep their colors.
    const barRows = $derived(
        [
            {
                kind: splits.length > 0 ? ("fixedRest" as const) : ("fixed" as const),
                tokens:
                    rows.reduce(
                        (sum, row) => sum + (row.kind !== "memory" && row.kind !== "history" ? row.tokens : 0),
                        0,
                    ) - splits.reduce((sum, split) => sum + split.tokens, 0),
                color: "bg-neutral-400",
            },
            ...splits.map((split) => ({ kind: split.kind, tokens: split.tokens, color: split.color })),
            {
                kind: "memory" as const,
                tokens: rows.find((row) => row.kind === "memory")?.tokens ?? 0,
                color: memoryColor,
            },
            { kind: "history" as const, tokens: historyTokens, color: "bg-primary-500" },
        ].filter((row) => row.tokens > 0),
    );
    const barEntries = $derived(rows.reduce((sum, row) => sum + (hypa && row.kind === "memory" ? 0 : row.tokens), 0));
    const unusedReserve = $derived(hypa ? Math.max(0, hypa.reserved - hypa.tokens) : 0);
    const barScale = $derived(Math.max(promptBudget, barEntries + (hypa ? Math.max(hypa.reserved, hypa.tokens) : 0)));
    const runwayScale = $derived(historyTokens + (hypa ? Math.max(hypa.summarizeIn, hypa.lookaheadIn ?? 0) : 0));
    /** A threshold of history growth, positioned on the runway. An empty runway has no room left. */
    const pointAt = (tokens: number) => (runwayScale > 0 ? widthOf(historyTokens + tokens, runwayScale) : 100);
    /** The history and memory block's lines for the left-out history. */
    const omitted = $derived.by(() => {
        if (!report || leftOut === 0) {
            return null;
        }
        const count = leftOut;
        // Without a split the report does not say why each one is left out (a trim, a chat range,
        // formatting): no tag, except that a send without memory summarized none of them.
        const tags: { text: string; tone: "memory" | "warn" }[] = [];
        if (!report.memory) {
            tags.push({ text: language.contextUsage.omittedNoMemory, tone: "warn" });
        }
        const summarized = report.memory?.summarized;
        if (summarized !== undefined) {
            if (summarized > 0) {
                tags.push({ text: language.contextUsage.omittedSummarized(summarized), tone: "memory" });
            }
            if (count > summarized) {
                tags.push({ text: language.contextUsage.omittedUnsummarized(count - summarized), tone: "warn" });
            }
        }
        return { count, tags };
    });

    let open = $state(false);
    let trigger: HTMLButtonElement | undefined = $state();
    let panel: HTMLElement | undefined = $state();
    let place = $state({ right: EDGE, top: "auto", bottom: `${EDGE}px`, maxHeight: 240, width: PANEL_WIDTH });
    const panelId = $props.id();

    // A Structured Memory report names records by id, so the popover reads their titles as it opens:
    // the boolean keeps a new report from reading again, and a closed popover reads nothing. A failed
    // read leaves the rows without titles.
    const listsMemory = $derived(open && report?.memory?.kind === "structuredMemory");
    let memoryTitles: ReadonlyMap<string, string> = $state.raw(new Map());
    let titleRead = 0;
    $effect(() => {
        if (!listsMemory) {
            return;
        }
        const number = ++titleRead;
        untrack(() =>
            readStructuredMemoryContents(chatRef).then((result) => {
                if (number === titleRead) {
                    memoryTitles = result.outcome === "ok" ? memoryItemTitles(result.value) : new Map();
                }
            }),
        );
    });

    /**
     * Prefer above the chip, then below; use the viewport when neither side has enough room. A chip scrolled out
     * of the viewport vertically, or a viewport too short for the popover, closes it instead.
     */
    function position() {
        if (!trigger) {
            return false;
        }
        const rect = trigger.getBoundingClientRect();
        const viewWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewHeight = window.innerHeight;
        if (rect.bottom <= 0 || rect.top >= viewHeight || viewHeight - 2 * EDGE < 120) {
            close(false);
            return false;
        }
        const width = Math.min(PANEL_WIDTH, viewWidth - 2 * EDGE);
        const right = Math.min(Math.max(EDGE, viewWidth - rect.right), viewWidth - EDGE - width);
        const above = rect.top - 2 * EDGE;
        const below = viewHeight - rect.bottom - 2 * EDGE;
        const useAbove = above >= 120;
        const useBelow = !useAbove && below >= 120;
        place = {
            right: Math.max(EDGE, right),
            top: useBelow ? `${rect.bottom + EDGE}px` : "auto",
            bottom: useAbove ? `${viewHeight - rect.top + EDGE}px` : useBelow ? "auto" : `${EDGE}px`,
            maxHeight: useAbove ? above : useBelow ? below : viewHeight - 2 * EDGE,
            width,
        };
        return true;
    }

    async function show() {
        if (!position()) {
            return;
        }
        open = true;
        await tick();
        panel?.focus();
    }

    function close(restoreFocus: boolean) {
        open = false;
        if (restoreFocus) {
            trigger?.focus();
        }
    }

    // A meter turned off, a group, or a chat whose line is gone (no report and no memory set up) closes
    // it, so it never reopens on its own when they come back.
    $effect(() => {
        if (!chip) {
            untrack(() => (open = false));
        }
    });

    // The composer grows with its text, moving the line above it.
    $effect(() => {
        void height;
        if (untrack(() => open)) {
            position();
        }
    });

    function onPointerDown(event: PointerEvent) {
        const target = event.target as Node | null;
        if (!open || !target || trigger?.contains(target) || panel?.contains(target)) {
            return;
        }
        close(false);
    }

    function onKeyDown(event: KeyboardEvent) {
        if (!open || event.key !== "Escape" || event.isComposing || event.keyCode === 229) {
            return;
        }
        if (doingAlert() || get(terminalNotice) !== null || topBindingLayer() !== null) {
            return;
        }
        event.stopPropagation();
        event.preventDefault();
        close(true);
    }

    function onFocusOut(event: FocusEvent) {
        if (!open) {
            return;
        }
        const next = event.relatedTarget as Node | null;
        if (next === null) {
            setTimeout(() => {
                const active = document.activeElement;
                if (open && (!document.hasFocus() || (!panel?.contains(active) && !trigger?.contains(active)))) {
                    close(false);
                }
            }, 0);
        } else if (!panel?.contains(next) && !trigger?.contains(next)) {
            close(false);
        }
    }

    function setLoreWarnOff(off: boolean) {
        if (!findChat(chatRef)) {
            return;
        }
        if (off) {
            setChatMeta(chatRef, { loreBudgetWarnOff: true });
        } else {
            setChatMeta(chatRef, {}, ["loreBudgetWarnOff"]);
        }
    }

    function openSettings() {
        close(false);
        openSetting({
            kind: "section",
            id: "interaction.contextMeter",
            label: language.settingsSectionContextMeter,
            breadcrumb: [language.interactionSettings],
            target: { menu: INTERACTION_SETTINGS_MENU, sectionId: "interaction.contextMeter" },
            // The section's first item (the on/off switch) has no condition.
            available: true,
            score: 0,
        } satisfies SettingHit);
    }

    function openMemorySettings() {
        close(false);
        $settingsOpen = true;
        $SettingsMenuIndex = MEMORY_SETTINGS_MENU;
    }

    function openMemoryPanel() {
        close(false);
        $hypaV3ModalOpen = true;
    }

    /** The sidebar's memory switch: turning it on also drops the chat's trim acknowledgement. */
    function setMemoryOn(on: boolean) {
        if (chatEntry(chatRef)) {
            setChatMemoryEnabled(chatRef, on);
        }
    }
</script>

<svelte:window
    onresize={() => {
        if (open) position();
    }}
/>
<svelte:document
    onpointerdowncapture={onPointerDown}
    onkeydowncapture={onKeyDown}
    onscrollcapture={() => {
        if (open) position();
    }}
/>

{#snippet dot()}
    <span class="shrink-0" aria-hidden="true">·</span>
{/snippet}

{#if chip}
    <!-- Right-aligned with the menu button, on the line above the composer row it shares with the health badge. -->
    <div class="mr-2 mb-1 ml-4 flex min-w-0 grow justify-end context-meter">
        <button
            type="button"
            bind:this={trigger}
            class="flex max-w-full min-w-0 items-center gap-1 rounded-sm px-1 text-xs leading-5 whitespace-nowrap hover:underline context-meter-chip"
            class:text-textcolor2={!fixedOver}
            class:text-danger-500={fixedOver}
            aria-label={chipTitle}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            title={chipTitle}
            onfocusout={onFocusOut}
            onclick={() => {
                if (open) {
                    close(false);
                } else {
                    void show();
                }
            }}
        >
            {#if loreWarn}
                <span class="shrink-0 text-danger-500" data-context-meter-lore-warn>
                    <BookAlertIcon size={13} aria-hidden="true" />
                </span>
            {:else}
                <span class="shrink-0" aria-hidden="true"><GaugeIcon size={13} /></span>
            {/if}
            {#if budgetReduced.length > 0}
                <span class="shrink-0 text-danger-500" data-context-meter-memory-reduced
                    >{language.contextUsage.memoryReduced}</span
                >
                <span class="shrink-0" aria-hidden="true">·</span>
            {/if}
            {#if chipLine?.lead}
                <span class="min-w-0 truncate">{chipLine.lead}</span>
            {/if}
            {#if chipLine?.memory}
                {#if chipLine.lead}
                    {@render dot()}
                {/if}
                <span
                    class="shrink-0"
                    class:text-danger-500={chipLine.memory.warn}
                    data-context-meter-memory-word
                    data-tone={chipLine.memory.warn ? "warn" : "plain"}>{chipLine.memory.text}</span
                >
            {/if}
            {#if chipLine?.mark}
                {#if chipLine.lead || chipLine.memory}
                    {@render dot()}
                {/if}
                {#if chipLine.mark.tone === "live"}
                    <span class="flex shrink-0 items-center gap-0.5 text-secondary-500" data-context-meter-task-mark>
                        <LoaderCircleIcon
                            size={11}
                            class="animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                        />
                        <span class="tabular-nums">{chipLine.mark.text}</span>
                    </span>
                {:else}
                    <span class="flex shrink-0 items-center gap-0.5 text-danger-500" data-context-meter-task-failed>
                        <CircleAlertIcon size={11} aria-hidden="true" />
                        <span>{chipLine.mark.text}</span>
                    </span>
                {/if}
            {/if}
            {#if chipLine?.tail}
                {#if chipLine.lead || chipLine.memory || chipLine.mark}
                    {@render dot()}
                {/if}
                <span class="shrink-0">{chipLine.tail}</span>
            {/if}
            {#if estimate?.suffix}
                <span class="shrink-0">· {language.contextUsage.estimateLead}</span>
                <span class="shrink-0 tabular-nums" data-context-meter-estimate>{estimate.suffix}</span>
            {/if}
            <span class="shrink-0 transition-transform" class:rotate-180={open} aria-hidden="true">
                <ChevronUpIcon size={12} />
            </span>
        </button>
    </div>
{/if}

{#if open && chip}
    <Portal>
        <div
            bind:this={panel}
            id={panelId}
            role="dialog"
            aria-labelledby="{panelId}-title"
            tabindex="-1"
            class="fixed z-30 flex flex-col gap-3 overflow-y-auto rounded-md border border-darkborderc bg-darkbg p-4 text-sm text-textcolor shadow-lg outline-hidden context-meter-panel"
            style:right="{place.right}px"
            style:top={place.top}
            style:bottom={place.bottom}
            style:width="{place.width}px"
            style:max-height="{place.maxHeight}px"
            onfocusout={onFocusOut}
        >
            <div class="flex items-start justify-between gap-2">
                <div class="flex flex-col">
                    <h2 id="{panelId}-title" class="text-base font-semibold">{language.contextUsage.title}</h2>
                    <span class="text-xs text-textcolor2"
                        >{source ? language.contextUsage.asOfLastReply : language.contextUsage.noReplyYet}</span
                    >
                </div>
                <div class="flex items-center gap-1">
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 text-textcolor2 hover:bg-selected hover:text-textcolor"
                        data-context-meter-settings
                        aria-label={settingsLabel}
                        title={settingsLabel}
                        onclick={openSettings}
                    >
                        <SettingsIcon size={16} aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 text-textcolor2 hover:bg-selected hover:text-textcolor"
                        onclick={() => close(true)}
                    >
                        {language.contextUsage.close}
                    </button>
                </div>
            </div>

            {#if estimate}
                <div class="flex flex-col gap-1 rounded-md bg-darkbutton p-2" data-context-meter-estimate-block>
                    <span class="font-semibold">{language.contextUsage.estimateTitle}</span>
                    <span>{estimate.line}</span>
                    <span class="text-xs text-textcolor2">{language.contextUsage.estimateNote}</span>
                </div>
            {/if}

            {#if taskView}
                <div
                    class="flex flex-col gap-1 rounded-md bg-darkbutton p-2 text-xs"
                    data-context-meter-task
                    data-tone={taskView.tone}
                >
                    <div class="flex justify-between gap-2">
                        <span class="font-semibold">{taskStrings.title}</span>
                        {#if taskView.text}
                            <span class="text-right text-secondary-500 tabular-nums">{taskView.text}</span>
                        {/if}
                    </div>
                    {#if taskView.tone === "live"}
                        <span class="text-textcolor2">{taskStrings.liveNote}</span>
                    {:else if taskView.tone === "done"}
                        <span class="text-secondary-500">{taskStrings.done}</span>
                    {:else}
                        <span class="text-danger-500">{taskStrings.failed}</span>
                        {#if taskView.error}
                            <span class="break-words text-textcolor2" data-context-meter-task-error
                                >{taskView.error}</span
                            >
                        {/if}
                        <button
                            type="button"
                            class="self-start text-textcolor underline hover:text-primary-500"
                            data-context-meter-task-settings
                            onclick={openMemorySettings}>{language.contextUsage.memorySettings}</button
                        >
                    {/if}
                </div>
            {/if}

            <div
                class="flex flex-col gap-1 rounded-md bg-darkbutton p-2 text-xs"
                data-context-meter-memory-now={memoryNow ? (memoryNow.on ? "on" : "off") : "none"}
            >
                <div class="flex justify-between gap-2">
                    <span class="font-semibold">{language.contextUsage.memoryNowTitle}</span>
                    <span class="text-right" class:text-secondary-500={memoryNow?.on === true}>
                        {memoryNow
                            ? (memoryNow.on ? language.contextUsage.memoryNowOn : language.contextUsage.memoryNowOff)(
                                  memoryNowName,
                              )
                            : language.contextUsage.memoryNowNone}
                    </span>
                </div>
                {#each memoryNotes as note (note.key)}
                    <span
                        class:text-textcolor2={!note.warn}
                        class:text-danger-500={note.warn}
                        data-context-meter-memory-note={note.key}>{note.text}</span
                    >
                {/each}
                <div class="flex flex-wrap gap-x-3 gap-y-0.5">
                    {#if memoryNow}
                        <button
                            type="button"
                            class="text-textcolor underline hover:text-primary-500"
                            data-context-meter-memory-toggle
                            onclick={() => setMemoryOn(!memoryNow.on)}
                            >{memoryNow.on
                                ? language.contextUsage.memoryTurnOff
                                : language.contextUsage.memoryTurnOn}</button
                        >
                    {/if}
                    {#if memoryPanelLabel}
                        <button
                            type="button"
                            class="text-textcolor underline hover:text-primary-500"
                            data-context-meter-memory-panel
                            onclick={openMemoryPanel}>{memoryPanelLabel}</button
                        >
                    {/if}
                    <button
                        type="button"
                        class="text-textcolor underline hover:text-primary-500"
                        data-context-meter-memory-now-settings
                        onclick={openMemorySettings}>{language.contextUsage.memorySettings}</button
                    >
                </div>
            </div>

            {#if source?.kind === "legacy"}
                <span>{language.contextUsage.input(fmt(source.input), fmt(source.maxContext))}</span>
                <span class="text-textcolor2">{language.contextUsage.legacyNote}</span>
            {:else if report}
                <div class="flex flex-col gap-1" data-context-meter-headline>
                    {#if promptBudget > 0}
                        <span>
                            <span class="text-lg font-semibold tabular-nums">{fmt(occupied)}</span>
                            <span class="text-textcolor2 tabular-nums">
                                {language.contextUsage.inputOfBudget(
                                    fmt(promptBudget),
                                    percentOf(occupied, promptBudget),
                                )}
                            </span>
                        </span>
                        <span class="text-xs text-textcolor2"
                            >{language.contextUsage.budgetFrom(fmt(report.maxContext), fmt(report.maxResponse))}</span
                        >
                    {:else}
                        <span>{language.contextUsage.input(fmt(occupied), fmt(report.maxContext))}</span>
                        <span class="text-xs text-textcolor2">{language.contextUsage.noBudget}</span>
                    {/if}
                </div>

                {#if barScale > 0}
                    <div class="relative shrink-0" data-context-meter-bar>
                        <div class="flex h-3 w-full overflow-hidden rounded-sm bg-darkbutton" aria-hidden="true">
                            {#each barRows as row, index (row.kind)}
                                <div
                                    class="shrink-0 {row.color}"
                                    class:border-l={index > 0}
                                    class:border-darkbg={index > 0}
                                    style:width="{widthOf(row.tokens, barScale)}%"
                                ></div>
                            {/each}
                            {#if hypa}
                                <div class="min-w-0 grow"></div>
                                <div
                                    class="shrink-0 context-meter-reserve"
                                    data-context-meter-reserve
                                    style:width="{widthOf(unusedReserve, barScale)}%"
                                ></div>
                            {/if}
                        </div>
                        <div
                            class="absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2"
                            class:bg-textcolor={!fixedOver}
                            class:bg-danger-500={fixedOver}
                            data-context-meter-fixed-warn
                            style:left="{widthOf((promptBudget * warn) / 100, barScale)}%"
                            aria-hidden="true"
                        ></div>
                    </div>
                    <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-textcolor2 tabular-nums">
                        {#each barRows as row (row.kind)}
                            <span class="flex items-center gap-1">
                                <span class="h-2.5 w-2.5 shrink-0 rounded-xs {row.color}" aria-hidden="true"></span>
                                {language.contextUsage.groups[row.kind]}
                                {fmt(row.tokens)}
                            </span>
                        {/each}
                        {#if unusedReserve > 0}
                            <span class="flex items-center gap-1">
                                <span class="h-2.5 w-2.5 shrink-0 rounded-xs context-meter-reserve" aria-hidden="true"
                                ></span>
                                {language.contextUsage.legendReserveEmpty}
                                {fmt(unusedReserve)}
                            </span>
                        {/if}
                    </div>
                {/if}
                <span
                    class="text-xs"
                    class:text-danger-500={fixedOver}
                    title={language.contextUsage.fixedShareHelp}
                    data-context-meter-fixed
                >
                    {language.contextUsage.fixedShare(Math.round(fixed))}
                    {#if fixedOver}
                        {language.contextUsage.fixedShareOver(warn)}
                    {/if}
                </span>

                <ul class="flex flex-col gap-1" data-context-meter-sections>
                    {#each rows as row (row.kind)}
                        <li class="flex items-center gap-2" data-section={row.kind}>
                            <span class="h-2.5 w-2.5 shrink-0 rounded-full {row.color}" aria-hidden="true"></span>
                            <span class="grow"
                                >{row.kind === "toolSchemas"
                                    ? language.contextUsage.toolSchemas
                                    : row.kind === "interceptions"
                                      ? language.contextUsage.interceptions
                                      : language.contextUsage.sections[row.kind]}</span
                            >
                            <span class="tabular-nums">{language.contextUsage.tokens(fmt(row.tokens))}</span>
                            {#if promptBudget > 0}
                                <span class="w-10 text-right tabular-nums text-textcolor2"
                                    >{percentOf(row.tokens, promptBudget)}%</span
                                >
                            {/if}
                        </li>
                    {/each}
                </ul>
                {#if report.adjustment !== 0}
                    <span
                        class="text-xs text-textcolor2 tabular-nums"
                        data-context-meter-other
                        title={language.contextUsage.otherHelp}
                    >
                        {language.contextUsage.otherLine(
                            `${report.adjustment > 0 ? "+" : "−"}${fmt(Math.abs(report.adjustment))}`,
                        )}
                    </span>
                {/if}
                {#if !report.attributionExact}
                    <span class="text-xs text-textcolor2">{language.contextUsage.approximate}</span>
                {/if}

                {@const turns = turnCount(report, unit)}
                {@const other = turnCount(report, unit === "user" ? "message" : "user")}
                <div class="flex flex-col gap-1 border-t border-darkborderc pt-3" data-context-meter-history>
                    <div class="flex items-baseline justify-between gap-2">
                        <span class="font-semibold">{language.contextUsage.sections.history}</span>
                        <span class="font-semibold text-textcolor tabular-nums" data-context-meter-kept
                            >{language.contextUsage.historySent(turns.kept, other.kept, unit)}</span
                        >
                    </div>
                    <span class="text-right text-xs text-textcolor2 tabular-nums" data-context-meter-total
                        >{language.contextUsage.historyTotal(turns.total, other.total, unit)}</span
                    >
                    {#if omitted}
                        <span class="text-right text-xs text-textcolor2 tabular-nums" data-context-meter-omitted
                            >{language.contextUsage.historyOmitted(
                                omitted.count,
                                fmt(report.history.droppedTokens),
                            )}</span
                        >
                        {#if omitted.tags.length > 0}
                            <div class="flex flex-wrap gap-1.5 text-xs" data-context-meter-omitted-tags>
                                {#each omitted.tags as tag (tag.tone)}
                                    <span
                                        class="rounded-sm bg-darkbutton px-1.5 py-px"
                                        class:text-secondary-500={tag.tone === "memory"}
                                        class:text-danger-500={tag.tone === "warn"}
                                        data-tone={tag.tone}>{tag.text}</span
                                    >
                                {/each}
                            </div>
                        {/if}
                    {/if}
                    {#if hypa}
                        <div class="mt-1 flex flex-col gap-2 text-xs">
                            <div class="flex justify-between gap-2">
                                <span class="text-textcolor2">{language.contextUsage.runwayCaption}</span>
                                <span class="text-right tabular-nums">
                                    {language.contextUsage.runwayUsage(fmt(historyTokens), fmt(hypa.summarizeIn))}
                                </span>
                            </div>
                            <div
                                class="relative h-2 w-full rounded-sm bg-darkbutton"
                                data-context-meter-runway
                                aria-hidden="true"
                            >
                                <div
                                    class="h-full rounded-sm bg-primary-500"
                                    style:width="{runwayScale > 0 ? widthOf(historyTokens, runwayScale) : 100}%"
                                ></div>
                                <div
                                    class="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 bg-secondary-500"
                                    data-context-meter-summarize
                                    style:left="{pointAt(hypa.summarizeIn)}%"
                                ></div>
                                {#if hypa.lookaheadIn !== undefined}
                                    <div
                                        class="absolute -top-1 -bottom-1 -translate-x-1/2 border-l border-dashed border-textcolor2"
                                        data-context-meter-lookahead
                                        style:left="{pointAt(hypa.lookaheadIn)}%"
                                    ></div>
                                {/if}
                            </div>
                            <div class="flex flex-col gap-0.5">
                                {#if hypa.lookaheadIn !== undefined}
                                    <div
                                        class="flex justify-between gap-2 text-textcolor2"
                                        data-context-meter-next-lookahead
                                    >
                                        <span>{language.contextUsage.lookaheadLabel}</span>
                                        <span class="text-right tabular-nums">
                                            {hypa.lookaheadIn > 0
                                                ? language.contextUsage.tokensAway(fmt(hypa.lookaheadIn))
                                                : language.contextUsage.lookaheadPassed}
                                        </span>
                                    </div>
                                {/if}
                                <div class="flex justify-between gap-2 text-secondary-500" data-context-meter-next>
                                    {#if hypa.prepared > 0}
                                        <span title={language.contextUsage.preparedHelp} data-context-meter-prepared>
                                            {language.contextUsage.preparedInLabel(hypa.prepared)}
                                        </span>
                                    {:else}
                                        <span>{language.contextUsage.summarizeInLabel}</span>
                                    {/if}
                                    <span class="text-right tabular-nums">
                                        {hypa.summarizeIn <= 0
                                            ? language.contextUsage.nextSend
                                            : language.contextUsage.tokensAway(fmt(hypa.summarizeIn))}
                                    </span>
                                </div>
                            </div>
                            {#if unusedReserve > 0}
                                <span class="text-textcolor2">
                                    {language.contextUsage.memoryReserveNote(fmt(hypa.reserved))}
                                    <button
                                        type="button"
                                        class="text-textcolor underline hover:text-primary-500"
                                        data-context-meter-memory-settings
                                        onclick={openMemorySettings}>{language.contextUsage.memorySettings}</button
                                    >
                                </span>
                            {/if}
                        </div>
                    {/if}
                    {#if report.memory}
                        <div class="mt-1 ml-1 flex flex-col gap-1 border-l-2 border-darkborderc pl-2.5">
                            <div class="flex flex-col gap-1" data-context-meter-memory>
                                {#if (report.memory.kind === "hypaV3" || report.memory.kind === "structuredMemory") && report.memory.budget !== undefined}
                                    <div class="flex justify-between gap-2">
                                        <!-- "Structured memory" already says memory, which `memoryBudget` adds. -->
                                        <span
                                            >{report.memory.kind === "hypaV3"
                                                ? language.contextUsage.memoryBudget(memoryName)
                                                : language.contextUsage.budgetReducedFields.memory}</span
                                        >
                                        <span class="tabular-nums"
                                            >{fmt(report.memory.tokens)} / {fmt(report.memory.budget)}</span
                                        >
                                    </div>
                                {:else}
                                    <span
                                        >{report.memory.kind === "structuredMemory"
                                            ? language.structuredMemory.meter.tokensSent(fmt(report.memory.tokens))
                                            : language.contextUsage.memoryLine(
                                                  memoryName,
                                                  fmt(report.memory.tokens),
                                              )}</span
                                    >
                                {/if}
                                {#if budgetReduced.length > 0}
                                    <div
                                        class="flex flex-col gap-0.5 text-xs text-danger-500 tabular-nums"
                                        data-context-meter-budget-reduced
                                    >
                                        <span>{language.contextUsage.budgetReducedNote}</span>
                                        {#each budgetReduced as reduction (reduction.field)}
                                            <span data-field={reduction.field}
                                                >{language.contextUsage.budgetReducedValue(
                                                    language.contextUsage.budgetReducedFields[reduction.field],
                                                    fmt(reduction.configured),
                                                    fmt(reduction.applied),
                                                )}</span
                                            >
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                            {#if report.memory.summarized === undefined && omitted}
                                <!-- No split: the memory card did not reach the prompt, another memory kind, or an older report.
                                     With nothing left out there is nothing for the sentence to cover. -->
                                <span class="text-xs text-textcolor2" data-context-meter-coverage
                                    >{report.memory.coverage === "covered"
                                        ? language.contextUsage.coverageCovered
                                        : report.memory.coverage === "gap"
                                          ? language.contextUsage.coverageGap
                                          : language.contextUsage.coverageUnknown}</span
                                >
                            {/if}
                            {#if reportMemory?.kind === "structuredMemory"}
                                <MemoryManifest memory={reportMemory} titles={memoryTitles} />
                            {/if}
                        </div>
                    {/if}
                </div>

                {#if report.lore.budget > 0 || report.lore.budgetUsed > 0 || report.lore.rejectedCount > 0 || loreWarnOff}
                    {@const rejected = report.lore.rejectedCount > 0}
                    <div class="flex flex-col gap-1" data-context-meter-lore>
                        <div class="flex justify-between gap-2 text-textcolor">
                            <span title={language.contextUsage.loreBudgetHelp}>{language.contextUsage.loreBudget}</span>
                            <span class="tabular-nums">{fmt(report.lore.budgetUsed)} / {fmt(report.lore.budget)}</span>
                        </div>
                        {#if rejected}
                            <div class="h-2 w-full overflow-hidden rounded-sm bg-darkbutton" aria-hidden="true">
                                <div
                                    class="h-full bg-danger-300"
                                    style:width="{widthOf(report.lore.budgetUsed, report.lore.budget)}%"
                                ></div>
                            </div>
                            {@const named = report.lore.rejected ?? []}
                            <span class="text-xs text-textcolor"
                                >{language.contextUsage.loreRejected(
                                    report.lore.rejectedCount,
                                    fmt(report.lore.rejectedTokens),
                                )}</span
                            >
                            {#if named.length > 0}
                                <ul class="flex flex-col gap-0.5 text-xs" data-context-meter-lore-rejected>
                                    {#each named as entry, index (index)}
                                        <li class="flex gap-2">
                                            <span class="min-w-0 grow truncate" title={entry.name}>{entry.name}</span>
                                            <span class="shrink-0 tabular-nums text-textcolor2"
                                                >{language.contextUsage.tokens(fmt(entry.tokens))}</span
                                            >
                                        </li>
                                    {/each}
                                    {#if report.lore.rejectedCount > named.length}
                                        <li class="text-textcolor2">
                                            {language.contextUsage.loreRejectedMore(
                                                report.lore.rejectedCount - named.length,
                                            )}
                                        </li>
                                    {/if}
                                </ul>
                            {/if}
                        {/if}
                        {#if rejected || loreWarnOff}
                            <div class="flex flex-wrap items-center gap-x-2 text-xs text-textcolor2">
                                {#if loreWarnOff}
                                    <span>{language.contextUsage.loreWarnOffNote}</span>
                                {/if}
                                <button
                                    type="button"
                                    class="text-textcolor underline hover:text-primary-500"
                                    data-context-meter-lore-toggle
                                    onclick={() => setLoreWarnOff(!loreWarnOff)}
                                >
                                    {loreWarnOff ? language.contextUsage.loreWarnOn : language.contextUsage.loreWarnOff}
                                </button>
                            </div>
                        {/if}
                    </div>
                {/if}
            {/if}
        </div>
    </Portal>
{/if}

<style>
    /* The memory budget HypaV3's count holds that the memory sent does not fill. */
    .context-meter-reserve {
        background: repeating-linear-gradient(
            135deg,
            color-mix(in srgb, var(--color-secondary-500) 45%, transparent) 0 3px,
            transparent 3px 7px
        );
    }
</style>
