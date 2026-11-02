<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import type { OpenAIChat } from "src/ts/process/index.svelte";
    import {
        groupMemoryCoverage,
        joinMemoryCoverage,
        MEMORY_COVERAGE_STATES,
        memoryItemsUsed,
        memoryMessageExcerpt,
        memoryMessageHasher,
        readStructuredMemoryCoverage,
        reconcileMemoryCoverage,
        usedMemoryCoverageGroups,
        type MemoryCoverageRow,
        type StructuredMemoryCoverage,
    } from "src/ts/process/structuredMemory.svelte";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { ChatTokenizer } from "src/ts/tokenizer";
    import { selectedHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
    import { normalizeStructuredMemorySettings } from "../../../../shared/structuredMemory.ts";
    import { codeText, memoryReadFailureText, memoryReasonText } from "./memoryText";

    // The Coverage tab: what memory did with each message. The record facts come from the server, and
    // the join with the chat's messages happens here, over what the tab holds and after reconciling the
    // facts with it, so a message that changes moves its row without a request. Everything shown of a
    // message is plain text.

    interface Props {
        chatRef: ChatRef;
        readOnly: boolean;
        refresh: number;
    }

    let { chatRef, readOnly, refresh }: Props = $props();

    /** The rows a list renders at once; a long chat stays cheap behind "show more". */
    const ROWS_AT_ONCE = 200;

    const text = language.structuredMemory.coverage;
    const panelText = language.structuredMemory.panel;

    let facts = $state.raw<StructuredMemoryCoverage | null>(null);
    let failure = $state<string | null>(null);
    let readNumber = 0;

    /** Reads the facts. An answer for another chat, or one a newer read replaced, changes nothing. */
    async function read() {
        const ref = chatRef;
        const number = ++readNumber;
        const result = await readStructuredMemoryCoverage(ref);
        if (number !== readNumber || ref.chaId !== chatRef.chaId || ref.chatId !== chatRef.chatId) {
            return;
        }
        if (result.outcome === "ok") {
            facts = result.value;
            failure = null;
        } else {
            failure = memoryReadFailureText(result);
        }
    }

    $effect(() => {
        refresh;
        untrack(() => void read());
    });

    const heldChat = $derived(findChat(chatRef));
    const messages = $derived(heldChat?.message ?? []);
    const hashOf = memoryMessageHasher();
    // With no chat held there is nothing to compare, which says nothing of its events.
    const reconciled = $derived(facts && heldChat ? reconcileMemoryCoverage(facts, messages, hashOf) : facts);
    const writerSettings = $derived(
        normalizeStructuredMemorySettings(
            selectedHypaV3Preset({
                hypaV3Presets: settings.hypaV3Presets.items,
                hypaV3PresetId: settings.hypaV3Presets.selectedId,
            })?.settings.structured,
        ),
    );
    const windowTurns = $derived(writerSettings.windowTurns);
    const memoryOn = $derived(!!findCharacter(chatRef.chaId)?.supaMemory);
    const coverage = $derived(
        reconciled
            ? joinMemoryCoverage(messages, reconciled, { windowTurns, memoryOn, screening: writerSettings.screening })
            : null,
    );
    const groups = $derived(coverage ? groupMemoryCoverage(coverage.rows) : []);
    const eventTitles = $derived(new Map<string, string>(reconciled?.events.map(({ id, title }) => [id, title])));
    const usedEvents = $derived(memoryItemsUsed(messages, "event"));
    const usedGroups = $derived(usedMemoryCoverageGroups(coverage?.rows ?? [], groups, usedEvents));

    let shownGroups = $state(ROWS_AT_ONCE);
    /** The expanded group, by its first row; one at a time keeps the rendered rows bounded. */
    let openGroup = $state<number | null>(null);
    let shownInGroup = $state(ROWS_AT_ONCE);

    function toggleGroup(start: number) {
        openGroup = openGroup === start ? null : start;
        shownInGroup = ROWS_AT_ONCE;
    }

    type CountedChats = { gap: OpenAIChat[]; leaving: OpenAIChat[] };

    /** The rows at `indices` as `getChatToken` counts a message. */
    const chatsAt = (indices: readonly number[]) =>
        indices.map((index): OpenAIChat => {
            const { role, data } = messages[index];
            return { role: role === "user" ? "user" : "assistant", content: data };
        });

    const sameChats = (a: readonly OpenAIChat[], b: readonly OpenAIChat[]) =>
        a.length === b.length && a.every(({ role, content }, i) => role === b[i].role && content === b[i].content);

    // The same object while the texts are the same: a reply streaming into the window moves the join
    // on every chunk, and only what the counts read may start a count.
    let counted: CountedChats | null = null;
    const countedChats = $derived.by(() => {
        if (!coverage) {
            return null;
        }
        const next = { gap: chatsAt(coverage.gap), leaving: chatsAt(coverage.leaving) };
        if (!counted || !sameChats(counted.gap, next.gap) || !sameChats(counted.leaving, next.leaving)) {
            counted = next;
        }
        return counted;
    });

    async function countTokens(chats: readonly OpenAIChat[]): Promise<number> {
        const tokenizer = new ChatTokenizer(0, "name");
        const counts = await Promise.all(chats.map((chat) => tokenizer.tokenizeChat(chat)));
        return counts.reduce((sum, count) => sum + count, 0);
    }

    type TokenCounts = { gap: number; leaving: number };

    let tokens = $state.raw<TokenCounts | "counting" | "unavailable">("counting");
    let countNumber = 0;

    // The rows never wait for this. A newer join's count replaces an older one's answer.
    $effect(() => {
        const chats = countedChats;
        if (!chats) {
            return;
        }
        const number = ++countNumber;
        tokens = "counting";
        untrack(() =>
            Promise.all([countTokens(chats.gap), countTokens(chats.leaving)]).then(
                ([gap, leaving]) => {
                    if (number === countNumber) {
                        tokens = { gap, leaving };
                    }
                },
                () => {
                    if (number === countNumber) {
                        tokens = "unavailable";
                    }
                },
            ),
        );
    });

    function tokenText(side: keyof TokenCounts): string {
        if (tokens === "counting") {
            return text.countingTokens;
        }
        return tokens === "unavailable" ? text.tokensUnavailable : text.aboutTokens(tokens[side]);
    }

    function stateClass(state: MemoryCoverageRow["state"]): string {
        return state === "failed" ? "text-draculared" : "text-textcolor";
    }
</script>

{#snippet usedBadge()}
    <span class="px-1.5 rounded-sm bg-darkbutton text-secondary-500" data-memory-used>{panelText.usedInLastSend}</span>
{/snippet}

{#snippet messageRow(row: MemoryCoverageRow)}
    {@const title = row.eventId === undefined ? undefined : eventTitles.get(row.eventId)}
    <li class="flex flex-col min-w-0 py-1 break-words" data-memory-coverage-row={row.state}>
        <div class="flex flex-wrap items-baseline min-w-0 gap-x-2">
            <span class="text-textcolor2">#{row.index}</span>
            <span class="text-textcolor2">{codeText(text.roles, row.role)}</span>
            <span class={stateClass(row.state)}>{text.states[row.state]}</span>
            {#if row.reason !== undefined}
                <span class="min-w-0 text-textcolor2">{memoryReasonText(row.reason)}</span>
            {/if}
            {#if row.eventId !== undefined && usedEvents.has(row.eventId)}
                {@render usedBadge()}
            {/if}
        </div>
        <span class="truncate text-textcolor2">{memoryMessageExcerpt(messages[row.index]?.data ?? "")}</span>
        {#if title !== undefined && (row.state === "covered" || row.state === "stale")}
            <span class="min-w-0">{title}</span>
        {/if}
    </li>
{/snippet}

{#snippet showMore(left: number, more: () => void)}
    <button
        type="button"
        class="self-start px-2 py-1 my-1 transition-colors border rounded-md border-darkborderc text-textcolor2 hover:text-textcolor"
        onclick={more}
    >
        {panelText.showMore(left)}
    </button>
{/snippet}

<div class="flex flex-col min-w-0 gap-2 text-sm" data-memory-coverage data-read-only={readOnly}>
    {#if failure !== null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{failure}</p>
    {:else if !coverage}
        <p class="text-textcolor2">{panelText.loading}</p>
    {:else if coverage.rows.length === 0}
        <p class="text-textcolor2">{text.empty}</p>
    {:else}
        <ul class="flex flex-wrap gap-2">
            {#each MEMORY_COVERAGE_STATES as state (state)}
                <li class="px-2 py-0.5 border rounded-md border-darkborderc" data-memory-coverage-count={state}>
                    {text.states[state]}: {coverage.counts[state]}
                </li>
            {/each}
        </ul>

        {#if !memoryOn}
            <p role="status" data-memory-coverage-off>{text.memoryOff}</p>
        {/if}
        <p data-memory-coverage-gap>{text.gap(windowTurns, coverage.gap.length, tokenText("gap"))}</p>
        <p data-memory-coverage-leaving>{text.leaving(windowTurns, coverage.leaving.length, tokenText("leaving"))}</p>
        <p class="text-textcolor2">{text.estimate}</p>

        <ul class="flex flex-col min-w-0 border-t divide-y divide-darkborderc border-darkborderc">
            {#each groups.slice(0, shownGroups) as group (group.start)}
                {#if group.end - group.start === 1}
                    {@render messageRow(coverage.rows[group.start])}
                {:else}
                    {@const open = openGroup === group.start}
                    <li class="flex flex-col min-w-0 py-1">
                        <button
                            type="button"
                            class="flex items-center min-w-0 gap-2 text-left transition-colors hover:text-textcolor"
                            aria-expanded={open}
                            onclick={() => toggleGroup(group.start)}
                            data-memory-coverage-group={group.state}
                        >
                            {#if open}
                                <ChevronDownIcon size={16} class="shrink-0" />
                            {:else}
                                <ChevronRightIcon size={16} class="shrink-0" />
                            {/if}
                            <span class="text-textcolor2">
                                {text.range(group.start, group.end - 1, group.end - group.start)}
                            </span>
                            <span class={stateClass(group.state)}>{text.states[group.state]}</span>
                            {#if !open && usedGroups.has(group.start)}
                                {@render usedBadge()}
                            {/if}
                        </button>
                        {#if open}
                            {@const shown = Math.min(shownInGroup, group.end - group.start)}
                            <ul class="flex flex-col min-w-0 pl-6 divide-y divide-darkborderc">
                                {#each coverage.rows.slice(group.start, group.start + shown) as row (row.index)}
                                    {@render messageRow(row)}
                                {/each}
                            </ul>
                            {#if group.end - group.start > shown}
                                {@render showMore(
                                    group.end - group.start - shown,
                                    () => (shownInGroup += ROWS_AT_ONCE),
                                )}
                            {/if}
                        {/if}
                    </li>
                {/if}
            {/each}
        </ul>
        {#if groups.length > shownGroups}
            {@render showMore(groups.length - shownGroups, () => (shownGroups += ROWS_AT_ONCE))}
        {/if}
    {/if}
</div>
