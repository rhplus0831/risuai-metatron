<script lang="ts">
    import { ChevronDownIcon, ChevronUpIcon, XIcon } from "@lucide/svelte";
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import { languageEnglish } from "src/lang/en";
    import { alertConfirm, alertError, alertRequestLogs } from "src/ts/alert";
    import {
        deleteRequestHistory,
        listRequestHistory,
        listRequestHistoryShares,
        readRequestHistory,
        shareRequestHistory,
    } from "src/ts/network/requestHistory";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatEntry, currentChatRef } from "src/ts/storage/chatStore.svelte";
    import type {
        RequestHistoryRecord,
        RequestHistoryShareBody,
        RequestHistoryShareEntry,
        RequestHistoryStatus,
        RequestHistorySummary,
    } from "../../../../shared/requestHistory.ts";
    import Button from "../../UI/GUI/Button.svelte";
    import CheckInput from "../../UI/GUI/CheckInput.svelte";
    import LogField from "./LogField.svelte";
    import { formatBytes } from "./requestLogView";

    /**
     * The server's request history: every LLM request the server made, newest first, a page at a
     * time. "This chat only" filters by the chat open when the viewer opened; a row's job filter
     * shows a retried request's attempts together. A row loads its content when it is expanded.
     *
     * Sharing for support: an expanded row shares its job (every request of it the history
     * still holds, as a snapshot) to the server's diagnostics folder, updates that copy, or withdraws
     * it; a shared row is marked. "Shared copies" lists the folder's shares, also those whose rows
     * are gone, so each can still be withdrawn.
     */

    type Detail =
        { state: "loading" } | { state: "ok"; record: RequestHistoryRecord | null } | { state: "error"; error: string };

    const openChat = untrack(() => currentChatRef());

    let items: RequestHistorySummary[] = $state([]);
    let next: string | null = $state(null);
    let loading = $state(false);
    let loadError: string | null = $state(null);
    let thisChat = $state(false);
    /** The job filter, owned by the popup (it opens filtered to a failed job, and keeps it across tabs). */
    /**
     * `closePopup` closes the popup's own dialog (nothing once another shows): an alert opened from here
     * would otherwise queue behind the popup, unseen until it closes.
     */
    let { jobId = $bindable(null), closePopup = () => {} }: { jobId?: string | null; closePopup?: () => void } =
        $props();
    let expanded: Set<string> = $state(new Set());
    /**
     * The detail of each expanded row only: a row's detail is read again each time it is expanded
     * (a pending request may have ended since) and dropped when it is collapsed, so the content held
     * here is what is open.
     */
    let details: Record<string, Detail> = $state({});
    /** Drops the answer of a load a newer one replaced. */
    let loadToken = 0;
    /** The latest detail read of each row; an older or abandoned read's answer is dropped. */
    let detailToken = 0;
    const detailReads = new Map<string, number>();

    const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

    /** The folder's last loaded shares; null until a read succeeds. */
    let shares: RequestHistoryShareEntry[] | null = $state(null);
    let sharesLoadError: string | null = $state(null);
    /** A share's key (`job:<id>` or `request:<id>`) while a share or withdrawal of it runs. */
    let pendingShares: Set<string> = $state(new Set());
    /**
     * `sharedAt` of each row a share or withdrawal of this viewer answered for. It wins over the row's
     * listed value, which a list read that was under way at the time can bring back stale.
     */
    let sharedRows: Record<string, number | null> = $state({});

    const shareKey = (target: { jobId: string | null; requestId: string | null }) =>
        target.jobId !== null ? `job:${target.jobId}` : `request:${target.requestId}`;
    const rowShareKey = (item: RequestHistorySummary) =>
        item.jobId !== null ? `job:${item.jobId}` : `request:${item.id}`;
    const sharedAt = (item: RequestHistorySummary) =>
        Object.hasOwn(sharedRows, item.id) ? sharedRows[item.id] : item.sharedAt;

    let sharesToken = 0;
    async function loadShares() {
        const token = ++sharesToken;
        try {
            const list = await listRequestHistoryShares();
            if (token === sharesToken) {
                shares = list.items;
                sharesLoadError = null;
            }
        } catch (error) {
            if (token === sharesToken) {
                sharesLoadError = errorText(error);
            }
        }
    }

    async function setShare(body: RequestHistoryShareBody, key: string) {
        if (pendingShares.has(key)) {
            return;
        }
        pendingShares = new Set(pendingShares).add(key);
        try {
            const result = await shareRequestHistory(body);
            const next = { ...sharedRows };
            for (const id of result.ids) {
                next[id] = result.sharedAt;
            }
            sharedRows = next;
        } catch (error) {
            const message = errorText(error);
            // The error replaces the popup (when it is still the one shown), as it did before alerts queued.
            closePopup();
            alertError(
                message === languageEnglish.requestHistoryShareOlderCopiesRemain
                    ? language.requestHistoryShareOlderCopiesRemain
                    : language.requestHistoryShareFailed.replace("{{error}}", message),
            );
        } finally {
            const left = new Set(pendingShares);
            left.delete(key);
            pendingShares = left;
            void loadShares();
        }
    }

    function shareRow(record: RequestHistorySummary, shared: boolean) {
        void setShare(
            record.jobId !== null ? { jobId: record.jobId, shared } : { requestId: record.id, shared },
            rowShareKey(record),
        );
    }

    function withdrawShare(entry: RequestHistoryShareEntry) {
        void setShare(
            entry.jobId !== null
                ? { jobId: entry.jobId, shared: false }
                : { requestId: entry.requestId, shared: false },
            shareKey(entry),
        );
    }

    async function load(reset: boolean) {
        const token = ++loadToken;
        loading = true;
        loadError = null;
        if (reset) {
            items = [];
            next = null;
            expanded = new Set();
            details = {};
            detailReads.clear();
            sharedRows = {};
            void loadShares();
        }
        try {
            const page = await listRequestHistory({
                cursor: reset ? null : next,
                chaId: thisChat ? openChat?.chaId : null,
                chatId: thisChat ? openChat?.chatId : null,
                jobId,
            });
            if (token !== loadToken) {
                return;
            }
            items = [...items, ...page.items];
            next = page.next;
        } catch (error) {
            if (token === loadToken) {
                loadError = errorText(error);
            }
        } finally {
            if (token === loadToken) {
                loading = false;
            }
        }
    }

    // The first page, and again whenever a filter changes.
    $effect(() => {
        void thisChat;
        void jobId;
        untrack(() => void load(true));
    });

    async function loadDetail(id: string) {
        const token = ++detailToken;
        detailReads.set(id, token);
        details[id] = { state: "loading" };
        let detail: Detail;
        try {
            detail = { state: "ok", record: await readRequestHistory(id) };
        } catch (error) {
            detail = { state: "error", error: errorText(error) };
        }
        if (detailReads.get(id) === token) {
            detailReads.delete(id);
            details[id] = detail;
        }
    }

    function toggle(id: string) {
        const nextSet = new Set(expanded);
        if (nextSet.has(id)) {
            nextSet.delete(id);
            detailReads.delete(id);
            delete details[id];
        } else {
            nextSet.add(id);
            void loadDetail(id);
        }
        expanded = nextSet;
    }

    async function deleteAll() {
        // The confirmation replaces this popup; it opens again afterwards (with the filter read now).
        const reopenJobId = jobId;
        closePopup();
        if (await alertConfirm(language.requestHistoryDeleteConfirm)) {
            try {
                await deleteRequestHistory();
            } catch (error) {
                alertError(errorText(error));
                return;
            }
        }
        alertRequestLogs({ jobId: reopenJobId });
    }

    function chatLabel(item: RequestHistorySummary): string {
        if (!item.chaId) {
            return "";
        }
        const character = findCharacter(item.chaId)?.name;
        const chat = item.chatId ? chatEntry({ chaId: item.chaId, chatId: item.chatId })?.name : undefined;
        return [character, chat].filter((part) => !!part).join(" · ");
    }

    function sourceLabel(source: string): string {
        return (language.requestHistorySource as Record<string, string>)[source] ?? source;
    }

    function duration(item: RequestHistorySummary): string {
        if (item.completedAt === null) {
            return item.status === "pending" ? "…" : "-";
        }
        return `${((item.completedAt - item.startedAt) / 1000).toFixed(1)} s`;
    }

    const STATUS_CLASS: Record<RequestHistoryStatus, string> = {
        pending: "bg-primary-600",
        success: "bg-success-600",
        error: "bg-danger-600",
        aborted: "bg-secondary-600",
        interrupted: "bg-neutral-600",
    };

    function meta(record: RequestHistoryRecord): [string, string][] {
        const rows: [string, string | null][] = [
            [language.requestHistoryLabels.request, record.id],
            [language.requestHistoryLabels.job, record.jobId],
            [language.requestHistoryLabels.message, record.messageId],
            [language.requestHistoryLabels.source, `${sourceLabel(record.source)} (${record.mode})`],
            [language.requestHistoryLabels.provider, record.provider],
            [language.requestHistoryLabels.profile, record.profileName ?? record.profileId],
            [language.requestHistoryLabels.httpStatus, record.httpStatus === null ? null : String(record.httpStatus)],
            [language.requestHistoryLabels.providerCode, record.providerCode],
            [
                language.requestHistoryLabels.firstByte,
                record.firstByteAt === null ? null : `${record.firstByteAt - record.startedAt} ms`,
            ],
            [
                language.requestHistoryLabels.sent,
                record.requestBytes === null ? null : formatBytes(record.requestBytes),
            ],
            [
                language.requestHistoryLabels.received,
                record.responseBytes === null ? null : formatBytes(record.responseBytes),
            ],
        ];
        return rows.filter((row): row is [string, string] => row[1] !== null && row[1] !== "");
    }
</script>

<div class="flex flex-wrap items-center gap-3 mb-3">
    {#if openChat}
        <CheckInput bind:check={thisChat} name={language.requestHistoryThisChat} />
    {/if}
    {#if jobId}
        <span class="flex items-center gap-1 px-2 py-1 rounded bg-darkbutton text-textcolor text-xs font-mono">
            {language.requestHistorySameJob}: {jobId.slice(0, 8)}
            <button
                class="text-textcolor2 hover:text-textcolor"
                onclick={() => (jobId = null)}
                title={language.requestHistoryLabels.clearFilter}
            >
                <XIcon size={14} />
            </button>
        </span>
    {/if}
    <div class="flex-1"></div>
    <Button size="sm" styled="danger" onclick={deleteAll}>{language.requestHistoryDeleteAll}</Button>
</div>

{#if sharesLoadError || (shares && shares.length > 0)}
    <div class="border border-darkborderc rounded-lg p-3 mb-3 flex flex-col gap-2">
        <span class="text-textcolor text-sm font-semibold">{language.requestHistoryShares}</span>
        {#if sharesLoadError}
            <div class="text-draculared text-sm flex items-center gap-3">
                <span class="break-all"
                    >{language.requestHistorySharesLoadFailed.replace("{{error}}", sharesLoadError)}</span
                >
                <Button size="sm" onclick={loadShares}>{language.requestHistoryRetry}</Button>
            </div>
        {/if}
        {#each shares ?? [] as entry (shareKey(entry))}
            {@const key = shareKey(entry)}
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span class="text-textcolor font-mono">
                    {entry.jobId !== null ? language.requestHistorySameJob : language.requestHistoryLabels.request}:
                    {(entry.jobId ?? entry.requestId ?? "").slice(0, 8)}
                </span>
                <span class="text-textcolor2">{new Date(entry.sharedAt).toLocaleString()}</span>
                <div class="flex-1"></div>
                {#if entry.jobId !== null && entry.jobId !== jobId}
                    <Button size="sm" onclick={() => (jobId = entry.jobId)}>{language.requestHistoryShowJob}</Button>
                {/if}
                <Button size="sm" disabled={pendingShares.has(key)} onclick={() => withdrawShare(entry)}>
                    {language.requestHistoryShareWithdraw}
                </Button>
            </div>
        {/each}
    </div>
{/if}

{#if loadError}
    <div class="text-draculared text-sm mb-3 flex items-center gap-3">
        <span class="break-all">{language.requestHistoryLoadFailed.replace("{{error}}", loadError)}</span>
        <Button size="sm" onclick={() => load(items.length === 0)}>{language.requestHistoryRetry}</Button>
    </div>
{/if}

{#if items.length === 0 && !loading && !loadError}
    <div class="text-textcolor2 text-center py-8">{language.requestHistoryEmpty}</div>
{:else}
    <div class="flex flex-col gap-2">
        {#each items as item (item.id)}
            {@const isExpanded = expanded.has(item.id)}
            {@const detail = details[item.id]}
            <div class="border border-darkborderc rounded-lg overflow-hidden">
                <button
                    class="w-full flex items-center justify-between p-3 hover:bg-bgcolor/50 transition-colors text-left"
                    onclick={() => toggle(item.id)}
                >
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 flex-1">
                        <span class="px-2 py-1 rounded text-xs font-bold text-neutral-50 {STATUS_CLASS[item.status]}">
                            {language.requestHistoryStatus[item.status] ?? item.status}{item.httpStatus !== null
                                ? ` ${item.httpStatus}`
                                : ""}
                        </span>
                        <span class="text-textcolor text-xs whitespace-nowrap opacity-70">
                            {new Date(item.startedAt).toLocaleString()}
                        </span>
                        <span class="text-textcolor text-xs">{sourceLabel(item.source)}</span>
                        <span class="text-textcolor text-sm truncate font-mono" title={item.modelId ?? ""}>
                            {item.modelId ?? "-"}
                        </span>
                        <span class="text-textcolor text-xs whitespace-nowrap opacity-70">{duration(item)}</span>
                        {#if chatLabel(item)}
                            <span class="text-textcolor2 text-xs truncate">{chatLabel(item)}</span>
                        {/if}
                        {#if item.truncated}
                            <span class="px-1.5 py-0.5 rounded text-xs bg-secondary-700 text-neutral-50"
                                >{language.requestHistoryLabels.cut}</span
                            >
                        {/if}
                        {#if sharedAt(item) !== null}
                            <span class="px-1.5 py-0.5 rounded text-xs bg-primary-700 text-neutral-50"
                                >{language.requestHistoryShared}</span
                            >
                        {/if}
                    </div>
                    <div class="ml-2 text-textcolor">
                        {#if isExpanded}
                            <ChevronUpIcon size={20} />
                        {:else}
                            <ChevronDownIcon size={20} />
                        {/if}
                    </div>
                </button>
                {#if isExpanded}
                    <div class="border-t border-darkborderc p-4 bg-bgcolor/30">
                        {#if !detail || detail.state === "loading"}
                            <div class="text-textcolor2 text-sm">…</div>
                        {:else if detail.state === "error"}
                            <div class="text-draculared text-sm break-all">
                                {language.requestHistoryLoadFailed.replace("{{error}}", detail.error)}
                            </div>
                        {:else if detail.record === null}
                            <div class="text-textcolor2 text-sm">{language.requestHistoryGone}</div>
                        {:else}
                            {@const record = detail.record}
                            {@const shareTime = sharedAt(item)}
                            {@const sharePending = pendingShares.has(rowShareKey(item))}
                            <div class="space-y-4">
                                <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                                    {#each meta(record) as [label, value]}
                                        <span class="text-textcolor2">{label}</span>
                                        <span class="text-textcolor font-mono break-all">{value}</span>
                                    {/each}
                                </div>
                                {#if record.jobId && record.jobId !== jobId}
                                    <Button size="sm" onclick={() => (jobId = record.jobId)}>
                                        {language.requestHistoryShowJob}
                                    </Button>
                                {/if}
                                <div class="flex flex-col gap-2 border border-darkborderc rounded p-3">
                                    {#if shareTime !== null}
                                        <span class="text-textcolor text-sm">
                                            {language.requestHistorySharedAt.replace(
                                                "{{time}}",
                                                new Date(shareTime).toLocaleString(),
                                            )}
                                        </span>
                                        <div class="flex flex-wrap gap-2">
                                            <Button
                                                size="sm"
                                                disabled={sharePending}
                                                onclick={() => shareRow(item, true)}
                                            >
                                                {language.requestHistoryShareUpdate}
                                            </Button>
                                            <Button
                                                size="sm"
                                                disabled={sharePending}
                                                onclick={() => shareRow(item, false)}
                                            >
                                                {language.requestHistoryShareWithdraw}
                                            </Button>
                                        </div>
                                    {:else}
                                        <div>
                                            <Button
                                                size="sm"
                                                disabled={sharePending}
                                                onclick={() => shareRow(item, true)}
                                            >
                                                {language.requestHistoryShare}
                                            </Button>
                                        </div>
                                    {/if}
                                    <span class="text-textcolor2 text-xs">{language.requestHistoryShareHelp}</span>
                                </div>
                                {#if record.error !== null}
                                    <LogField
                                        label={language.requestHistoryLabels.error}
                                        text={record.error}
                                        highlight={false}
                                        cut={record.truncation.error}
                                    />
                                {/if}
                                {#if !record.content}
                                    <div class="text-textcolor2 text-sm">{language.requestHistoryNoContent}</div>
                                {:else}
                                    {#if record.prompt !== null}
                                        <LogField
                                            label={language.requestHistoryLabels.prompt}
                                            text={record.prompt}
                                            sizeClass="max-h-64"
                                            cut={record.truncation.prompt}
                                        />
                                    {/if}
                                    {#each record.exchanges ?? [] as exchange, index}
                                        <div class="border-l-2 border-darkborderc pl-3 space-y-3">
                                            <div class="text-textcolor text-sm font-semibold">
                                                #{index + 1}
                                                <span
                                                    class="ml-2 px-1.5 py-0.5 rounded text-xs font-mono text-neutral-50 {exchange.success
                                                        ? 'bg-success-600'
                                                        : 'bg-danger-600'}"
                                                >
                                                    {exchange.status ??
                                                        (exchange.success
                                                            ? language.requestHistoryLabels.ok
                                                            : language.requestHistoryLabels.failed)}
                                                </span>
                                                <span class="ml-2 text-xs font-normal opacity-70">{exchange.date}</span>
                                            </div>
                                            <LogField
                                                label={language.requestHistoryLabels.url}
                                                text={exchange.url}
                                                highlight={false}
                                                cut={record.truncation[`exchange.${index}.url`]}
                                            />
                                            <LogField
                                                label={language.requestHistoryLabels.requestBody}
                                                text={exchange.body}
                                                cut={record.truncation[`exchange.${index}.body`]}
                                            />
                                            <LogField
                                                label={language.requestHistoryLabels.requestHeader}
                                                text={exchange.header}
                                                sizeClass="max-h-32"
                                                cut={record.truncation[`exchange.${index}.header`]}
                                            />
                                            <LogField
                                                label={language.requestHistoryLabels.response}
                                                text={exchange.response}
                                                sizeClass="max-h-64"
                                                cut={record.truncation[`exchange.${index}.response`]}
                                            />
                                        </div>
                                    {/each}
                                    {#if record.exchangeCount > record.storedExchanges}
                                        <div class="text-textcolor2 text-sm">
                                            {language.requestHistoryDropped.replace(
                                                "{{count}}",
                                                String(record.exchangeCount - record.storedExchanges),
                                            )}
                                        </div>
                                    {/if}
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>
        {/each}
    </div>
    {#if loading}
        <div class="text-textcolor2 text-center py-4">…</div>
    {:else if next}
        <div class="flex justify-center mt-3">
            <Button size="sm" onclick={() => load(false)}>{language.requestHistoryLoadMore}</Button>
        </div>
    {/if}
{/if}
