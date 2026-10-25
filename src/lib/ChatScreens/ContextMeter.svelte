<script lang="ts">
    import { tick, untrack } from "svelte";
    import { language } from "src/lang";
    import { doingAlert, terminalNotice } from "src/ts/alert";
    import { topBindingLayer } from "src/ts/gui/dialogLayers";
    import type { SettingHit } from "src/ts/setting/searchIndex";
    import { openSetting } from "src/ts/setting/settingJump.svelte";
    import { INTERACTION_SETTINGS_MENU } from "src/ts/settingsMenu";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { get } from "svelte/store";
    import { fixedShare, parseContextReport, turnCount, type ContextReport } from "../../../shared/contextReport.ts";
    import Portal from "../UI/GUI/Portal.svelte";

    // The composer's context chip: how the last request spent the model's context, read from the open
    // chat's latest `generationInfo.context` (`shared/contextReport.ts`). The prompt is rebuilt and
    // trimmed every send, so the chip shows the history window, or the share of the prompt budget while
    // all eligible history fits; the popover breaks the last request down.

    interface Props {
        /** The displayed chat; the mount is keyed by it, so a chat switch starts closed. */
        chatRef: ChatRef;
        /** The selected character is a group: the meter is not shown. */
        group: boolean;
        /** The composer row's height, matched like the send and menu buttons. */
        height: string;
    }

    const { chatRef, group, height }: Props = $props();

    type Source =
        | { kind: "report"; messageId: string | undefined; report: ContextReport }
        | { kind: "legacy"; messageId: string | undefined; input: number; maxContext: number };

    const PANEL_WIDTH = 352;
    const EDGE = 8;
    // Bar colors by size rank; danger stays for warnings.
    const PALETTE = [
        "bg-primary-500",
        "bg-success-500",
        "bg-secondary-500",
        "bg-primary-300",
        "bg-success-300",
        "bg-secondary-300",
        "bg-primary-700",
        "bg-success-700",
        "bg-secondary-700",
    ];
    const OTHER_COLOR = "bg-neutral-400";

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

    const fmt = (value: number) => value.toLocaleString();
    /** `part` of `whole` in whole percent; 100 without a whole. */
    const percentOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 100);
    /** A bar width in percent, clamped to the bar. */
    const widthOf = (part: number, whole: number) =>
        whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : part > 0 ? 100 : 0;

    const promptBudget = $derived(report ? report.maxContext - report.maxResponse : 0);
    const fixed = $derived(report ? fixedShare(report) * 100 : 0);
    const fixedOver = $derived(report !== null && fixed > warn);
    const memoryName = $derived(report?.memory ? language.contextUsage.memoryKinds[report.memory.kind] : "");

    const chip = $derived.by(() => {
        if (!source) {
            return null;
        }
        if (source.kind === "legacy") {
            const percent = percentOf(source.input, source.maxContext);
            return { text: `${percent}%`, note: "", summary: language.contextUsage.legacySummary(percent) };
        }
        const r = source.report;
        const kept = turnCount(r, unit).kept;
        const keptText = unit === "user" ? language.contextUsage.turns(kept) : language.contextUsage.messages(kept);
        let result: { text: string; note: string; summary: string };
        if (r.memory) {
            const coverage =
                r.memory.coverage === "covered"
                    ? language.contextUsage.summarized
                    : r.memory.coverage === "gap"
                      ? language.contextUsage.gap
                      : language.contextUsage.memoryOn;
            result = {
                text: keptText,
                note: coverage,
                summary: language.contextUsage.memorySummary(keptText, memoryName, coverage),
            };
        } else if (r.history.kept >= r.history.total) {
            const percent = percentOf(r.input, promptBudget);
            result = { text: `${percent}%`, note: "", summary: language.contextUsage.fullSummary(percent) };
        } else {
            result = { text: keptText, note: "", summary: language.contextUsage.trimmedSummary(keptText) };
        }
        if (fixedOver) {
            result.summary += `; ${language.contextUsage.fixedWarnSummary}`;
        }
        return result;
    });

    // Sections with tokens, largest first (the sort is stable, so ties keep the report's order). The
    // bar spans the prompt budget, or the section total when attribution exceeds it.
    const rows = $derived.by(() => {
        if (!report) {
            return [];
        }
        return report.sections
            .filter((section) => section.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens)
            .map((section, index) => ({
                kind: section.kind,
                tokens: section.tokens,
                color: PALETTE[index] ?? OTHER_COLOR,
            }));
    });
    const barScale = $derived(
        Math.max(
            promptBudget,
            rows.reduce((sum, row) => sum + row.tokens, 0),
        ),
    );

    let open = $state(false);
    let trigger: HTMLButtonElement | undefined = $state();
    let panel: HTMLElement | undefined = $state();
    let place = $state({ right: EDGE, top: "auto", bottom: `${EDGE}px`, maxHeight: 240, width: PANEL_WIDTH });
    const panelId = $props.id();

    // Prefer above the chip, then below; use the viewport when neither side has enough room.
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

    // A meter turned off, a group, or a chat whose reports are gone closes it, so it never reopens on
    // its own when they come back.
    $effect(() => {
        if (!source) {
            untrack(() => (open = false));
        }
    });

    // The composer grows with its text, moving the chip.
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

{#if chip}
    <button
        type="button"
        bind:this={trigger}
        class="peer-focus:border-textcolor flex items-center gap-1 border-y border-darkborderc px-2 text-sm whitespace-nowrap max-w-36 min-w-0 shrink-0 hover:bg-selected transition-colors context-meter-chip"
        class:text-textcolor2={!fixedOver}
        class:text-danger-500={fixedOver}
        style:height
        aria-label={language.contextUsage.chipLabel(chip.summary)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={language.contextUsage.chipLabel(chip.summary)}
        onfocusout={onFocusOut}
        onclick={() => {
            if (open) {
                close(false);
            } else {
                void show();
            }
        }}
    >
        <span class="shrink-0">{chip.text}</span>
        {#if chip.note}
            <span class="hidden sm:inline truncate min-w-0 text-xs">· {chip.note}</span>
        {/if}
    </button>
{/if}

{#if open && source}
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
                    <span class="text-xs text-textcolor2">{language.contextUsage.asOfLastReply}</span>
                </div>
                <button
                    type="button"
                    class="rounded-md px-2 py-1 text-textcolor2 hover:bg-selected hover:text-textcolor"
                    onclick={() => close(true)}
                >
                    {language.contextUsage.close}
                </button>
            </div>

            {#if source.kind === "legacy"}
                <span>{language.contextUsage.input(fmt(source.input), fmt(source.maxContext))}</span>
                <span class="text-textcolor2">{language.contextUsage.legacyNote}</span>
            {:else if report}
                <div class="flex flex-col gap-1">
                    <span>{language.contextUsage.input(fmt(report.input), fmt(report.maxContext))}</span>
                    <span class="text-xs text-textcolor2"
                        >{language.contextUsage.replyBudget(fmt(report.maxResponse))}</span
                    >
                </div>

                {#if barScale > 0}
                    <div class="flex h-3 w-full shrink-0 overflow-hidden rounded-sm bg-darkbutton" aria-hidden="true">
                        {#each rows as row (row.kind)}
                            <div class={row.color} style:width="{widthOf(row.tokens, barScale)}%"></div>
                        {/each}
                    </div>
                {/if}
                {#if promptBudget <= 0}
                    <span class="text-xs text-textcolor2">{language.contextUsage.noBudget}</span>
                {/if}

                <ul class="flex flex-col gap-1" data-context-meter-sections>
                    {#each rows as row (row.kind)}
                        <li class="flex items-center gap-2" data-section={row.kind}>
                            <span class="h-2.5 w-2.5 shrink-0 rounded-full {row.color}" aria-hidden="true"></span>
                            <span class="grow">{language.contextUsage.sections[row.kind]}</span>
                            <span class="tabular-nums">{language.contextUsage.tokens(fmt(row.tokens))}</span>
                            {#if promptBudget > 0}
                                <span class="w-10 text-right tabular-nums text-textcolor2"
                                    >{percentOf(row.tokens, promptBudget)}%</span
                                >
                            {/if}
                        </li>
                    {/each}
                    {#if report.adjustment !== 0}
                        <li
                            class="flex items-center gap-2"
                            data-section="other"
                            title={language.contextUsage.otherHelp}
                        >
                            <span class="h-2.5 w-2.5 shrink-0" aria-hidden="true"></span>
                            <span class="grow">{language.contextUsage.other}</span>
                            <span class="tabular-nums"
                                >{language.contextUsage.tokens(
                                    `${report.adjustment > 0 ? "+" : "−"}${fmt(Math.abs(report.adjustment))}`,
                                )}</span
                            >
                            {#if promptBudget > 0}
                                <span class="w-10"></span>
                            {/if}
                        </li>
                    {/if}
                </ul>
                {#if !report.attributionExact}
                    <span class="text-xs text-textcolor2">{language.contextUsage.approximate}</span>
                {/if}

                <div class="flex flex-col gap-1 border-t border-darkborderc pt-3">
                    <span
                        >{language.contextUsage.historyIncluded(
                            report.history.kept,
                            report.history.total,
                            report.history.keptUser,
                            report.history.totalUser,
                        )}</span
                    >
                    {#if report.history.total > report.history.kept}
                        <span class="text-textcolor2" data-context-meter-omitted
                            >{language.contextUsage.historyOmitted(
                                report.history.total - report.history.kept,
                                fmt(report.history.droppedTokens),
                            )}</span
                        >
                    {/if}
                </div>

                {#if report.lore.budget > 0 || report.lore.budgetUsed > 0 || report.lore.rejectedCount > 0}
                    {@const rejected = report.lore.rejectedCount > 0}
                    <div class="flex flex-col gap-1" data-context-meter-lore>
                        <div class="flex justify-between gap-2 text-textcolor">
                            <span title={language.contextUsage.loreBudgetHelp}>{language.contextUsage.loreBudget}</span>
                            <span class="tabular-nums">{fmt(report.lore.budgetUsed)} / {fmt(report.lore.budget)}</span>
                        </div>
                        <div class="h-2 w-full overflow-hidden rounded-sm bg-darkbutton" aria-hidden="true">
                            <div
                                class="h-full"
                                class:bg-primary-500={!rejected}
                                class:bg-danger-300={rejected}
                                style:width="{widthOf(report.lore.budgetUsed, report.lore.budget)}%"
                            ></div>
                        </div>
                        {#if rejected}
                            <span class="text-xs text-textcolor"
                                >{language.contextUsage.loreRejected(
                                    report.lore.rejectedCount,
                                    fmt(report.lore.rejectedTokens),
                                )}</span
                            >
                        {/if}
                    </div>
                {/if}

                {#if report.memory}
                    <div class="flex flex-col gap-1" data-context-meter-memory>
                        {#if report.memory.kind === "hypaV3" && report.memory.budget !== undefined}
                            <div class="flex justify-between gap-2">
                                <span>{language.contextUsage.memoryBudget(memoryName)}</span>
                                <span class="tabular-nums"
                                    >{fmt(report.memory.tokens)} / {fmt(report.memory.budget)}</span
                                >
                            </div>
                            <div class="h-2 w-full overflow-hidden rounded-sm bg-darkbutton" aria-hidden="true">
                                <div
                                    class="h-full bg-secondary-500"
                                    style:width="{widthOf(report.memory.tokens, report.memory.budget)}%"
                                ></div>
                            </div>
                        {:else}
                            <span>{language.contextUsage.memoryLine(memoryName, fmt(report.memory.tokens))}</span>
                        {/if}
                        <span class="text-xs text-textcolor2"
                            >{report.memory.coverage === "covered"
                                ? language.contextUsage.coverageCovered
                                : report.memory.coverage === "gap"
                                  ? language.contextUsage.coverageGap
                                  : language.contextUsage.coverageUnknown}</span
                        >
                    </div>
                {/if}

                <div class="flex flex-col gap-1" data-context-meter-fixed>
                    <div class="flex justify-between gap-2" class:text-danger-500={fixedOver}>
                        <span title={language.contextUsage.fixedShareHelp}
                            >{language.contextUsage.fixedShare(Math.round(fixed))}</span
                        >
                    </div>
                    <div class="relative h-2 w-full rounded-sm bg-darkbutton" aria-hidden="true">
                        <div
                            class="h-full rounded-sm"
                            class:bg-neutral-400={!fixedOver}
                            class:bg-danger-500={fixedOver}
                            style:width="{Math.min(100, fixed)}%"
                        ></div>
                        <div class="absolute -top-0.5 -bottom-0.5 w-0.5 bg-textcolor" style:left="{warn}%"></div>
                    </div>
                    {#if fixedOver}
                        <span class="text-xs text-danger-500">{language.contextUsage.fixedShareOver(warn)}</span>
                    {/if}
                </div>
            {/if}

            <div class="flex flex-wrap items-center gap-x-2 border-t border-darkborderc pt-3 text-xs text-textcolor2">
                <span
                    >{language.contextUsage.basis(
                        unit === "user" ? language.contextUsage.basisTurns : language.contextUsage.basisMessages,
                        warn,
                    )}</span
                >
                <button type="button" class="text-textcolor underline hover:text-primary-500" onclick={openSettings}>
                    {language.contextUsage.changeSettings}
                </button>
            </div>
        </div>
    </Portal>
{/if}
