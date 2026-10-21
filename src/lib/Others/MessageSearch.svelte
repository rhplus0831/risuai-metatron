<script lang="ts">
    import { tick, untrack } from "svelte";
    import { get } from "svelte/store";
    import { XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertNormal, doingAlert, terminalNotice } from "src/ts/alert";
    import { openPinnedChat } from "src/ts/globalApi.svelte";
    import {
        chatBindingDialog,
        gridOpenStore,
        openModelPresetList,
        openPersonaList,
        openPresetList,
    } from "src/ts/stores.svelte";
    import { currentChatRef } from "src/ts/storage/chatStore.svelte";
    import { selection } from "src/ts/storage/selection.svelte";
    import {
        closeMessageSearch,
        messageSearchPanel,
        messageSearchScopeKey,
        requestMessageJump,
        searchMessages,
        type MessageSearchScope,
    } from "src/ts/messageSearch.svelte";
    import {
        MESSAGE_SEARCH_MAX_QUERY,
        MESSAGE_SEARCH_MIN_QUERY,
        type MessageSearchHit,
    } from "../../../shared/messageSearch.ts";
    import { makeCharacterAgoText } from "../UI/mainMenuProjection";

    /** Typing stops for this long before a query runs (Enter runs it at once). */
    const DEBOUNCE_MS = 300;
    /** Automatic re-asks after a page that brought no new hit while `next` is set. */
    const MAX_REASKS = 5;

    let query = $state("");
    let hits: MessageSearchHit[] = $state([]);
    let next: string | null = $state(null);
    let status: "idle" | "loading" | "done" | "error" = $state("idle");
    let errorText = $state("");
    let input: HTMLInputElement | undefined = $state();

    /** Hits shown, by chat ref and message id: a later page's repeats are dropped (paging is best effort). */
    let seen = new Set<string>();
    /** The query and scope the shown results belong to (every continuation uses them), or null. */
    let shown: { query: string; scope: MessageSearchScope; key: string } | null = $state.raw(null);
    /** Bumped by every new search, continuation, edit and close: an older request's answer is ignored. */
    let generation = 0;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const agoFormatter = new Intl.RelativeTimeFormat(navigator.languages, { style: "short" });

    function normalize(text: string) {
        return text.normalize("NFC").trim();
    }

    /** "short", "long", or null for a query the server accepts. */
    function queryProblem(text: string): "short" | "long" | null {
        const length = [...text].length;
        return length < MESSAGE_SEARCH_MIN_QUERY ? "short" : length > MESSAGE_SEARCH_MAX_QUERY ? "long" : null;
    }

    const problem = $derived(queryProblem(normalize(query)));
    const matchesShown = $derived(
        shown !== null &&
            shown.query === normalize(query) &&
            shown.key === messageSearchScopeKey(messageSearchPanel.scope),
    );

    function hitKey(hit: MessageSearchHit) {
        return `${hit.characterId}\u0000${hit.chatId}\u0000${hit.messageId}`;
    }

    /** Ends the running request and the pending debounce; their answers are ignored from now on. */
    function invalidate() {
        generation += 1;
        clearTimeout(debounce);
        debounce = undefined;
        controller?.abort();
        controller = null;
        if (status === "loading") {
            status = "idle";
            shown = null;
        }
    }

    function clearResults() {
        hits = [];
        next = null;
        seen = new Set();
        shown = null;
        status = "idle";
        errorText = "";
    }

    /** Starts the search for the field's text in the panel's scope from its first page. */
    function startSearch() {
        invalidate();
        const text = normalize(query);
        if (queryProblem(text) !== null) {
            clearResults();
            return;
        }
        const scope = $state.snapshot(messageSearchPanel.scope) as MessageSearchScope;
        clearResults();
        shown = { query: text, scope, key: messageSearchScopeKey(scope) };
        void fetchPages(shown.query, shown.scope, undefined);
    }

    function loadMore() {
        if (!shown || !matchesShown || next === null || status === "loading") return;
        invalidate();
        void fetchPages(shown.query, shown.scope, next);
    }

    /**
     * Asks for pages until one brings a new hit, `next` runs out, or the re-asks are spent; a 409 (the
     * data was replaced during the scan) restarts the search once from its first page.
     */
    async function fetchPages(text: string, scope: MessageSearchScope, cursor: string | undefined) {
        const run = generation;
        const abort = new AbortController();
        controller = abort;
        status = "loading";
        errorText = "";
        let reasks = MAX_REASKS;
        let restarts = 1;
        while (true) {
            const result = await searchMessages(text, scope, cursor, abort.signal);
            if (run !== generation) {
                return;
            }
            if (result.kind === "aborted") {
                status = "idle";
                return;
            }
            if (result.kind === "error") {
                status = "error";
                errorText = result.message;
                return;
            }
            if (result.kind === "epoch") {
                if (restarts > 0) {
                    restarts -= 1;
                    hits = [];
                    next = null;
                    seen = new Set();
                    cursor = undefined;
                    continue;
                }
                status = "error";
                errorText = language.messageSearch.dataChanged;
                return;
            }
            const fresh: MessageSearchHit[] = [];
            for (const hit of result.page.hits) {
                const key = hitKey(hit);
                if (!seen.has(key)) {
                    seen.add(key);
                    fresh.push(hit);
                }
            }
            if (fresh.length > 0) {
                hits = [...hits, ...fresh];
            }
            next = result.page.next;
            if (fresh.length === 0 && next !== null && reasks > 0) {
                reasks -= 1;
                cursor = next;
                continue;
            }
            status = "done";
            controller = null;
            return;
        }
    }

    function onQueryInput() {
        invalidate();
        if (queryProblem(normalize(query)) !== null) {
            clearResults();
            return;
        }
        debounce = setTimeout(() => {
            debounce = undefined;
            startSearch();
        }, DEBOUNCE_MS);
    }

    function onQueryKeydown(event: KeyboardEvent) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
            event.preventDefault();
            startSearch();
        }
    }

    function chooseScope(scope: MessageSearchScope) {
        messageSearchPanel.scope = scope;
    }

    // Opening the panel (or switching its scope) searches again when the shown results belong to
    // another query or scope; the results stay across a close otherwise.
    $effect(() => {
        const open = messageSearchPanel.open;
        const key = messageSearchScopeKey(messageSearchPanel.scope);
        if (!open) return;
        untrack(() => {
            const text = normalize(query);
            if (queryProblem(text) !== null) return;
            if (shown === null || shown.key !== key || shown.query !== text) {
                startSearch();
            }
        });
    });

    /** The element focused before the panel opened, focused again when it closes. */
    let returnFocus: Element | null = null;
    $effect(() => {
        if (!messageSearchPanel.open) return;
        untrack(() => {
            returnFocus = document.activeElement;
            void tick().then(() => input?.focus());
        });
        return () => {
            // A request still running is dropped; its partial results are not kept as finished.
            invalidate();
            const target = returnFocus;
            returnFocus = null;
            if (target instanceof HTMLElement && target.isConnected) {
                target.focus();
            }
        };
    });

    function close() {
        closeMessageSearch();
    }

    /**
     * Escape closes the panel, not the character grid under it: caught before the global hotkey
     * listener. An alert, the terminal notice, a picker list or the binding dialog above it closes first.
     */
    function closeOnEscape(event: KeyboardEvent) {
        if (!messageSearchPanel.open || event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
        if (doingAlert() || get(terminalNotice) !== null) return;
        if (get(openPresetList) || get(openModelPresetList) || get(openPersonaList) || get(chatBindingDialog)) return;
        event.stopPropagation();
        event.preventDefault();
        close();
    }

    function openHit(hit: MessageSearchHit) {
        const ref = { chaId: hit.characterId, chatId: hit.chatId };
        close();
        // The catalog shows instead of the chat screen while it is open; `openPinnedChat` leaves it.
        gridOpenStore.set(false);
        openPinnedChat(ref);
        const now = currentChatRef();
        if (now?.chaId === ref.chaId && now.chatId === ref.chatId) {
            requestMessageJump(ref, hit.messageId);
        } else {
            alertNormal(language.messageSearch.chatGone);
        }
    }

    /** The snippet in three plain-text parts around the match (UTF-16 offsets, clamped). */
    function snippetParts(hit: MessageSearchHit): [string, string, string] {
        const text = hit.snippet;
        const start = Math.min(Math.max(0, hit.matchStart), text.length);
        const end = Math.min(Math.max(start, start + hit.matchLength), text.length);
        return [text.slice(0, start), text.slice(start, end), text.slice(end)];
    }

    function timeText(time: number | undefined) {
        return typeof time === "number" && time > 0
            ? makeCharacterAgoText(time, { agoFormatter, unknownText: "" })
            : "";
    }

    const currentRef = $derived(currentChatRef());
    const currentCharacterId = $derived(selection.characterId);
    const scopeKey = $derived(messageSearchScopeKey(messageSearchPanel.scope));
    const scopes = $derived([
        {
            label: language.messageSearch.scopeChat,
            scope: currentRef ? ({ kind: "chat", ref: { ...currentRef } } as MessageSearchScope) : null,
        },
        {
            label: language.messageSearch.scopeCharacter,
            scope: currentCharacterId ? ({ kind: "character", chaId: currentCharacterId } as MessageSearchScope) : null,
        },
        { label: language.messageSearch.scopeAll, scope: { kind: "all" } as MessageSearchScope },
    ]);
</script>

<svelte:document onkeydowncapture={closeOnEscape} />

{#if messageSearchPanel.open}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div
        class="fixed top-0 left-0 w-full h-full z-30 bg-bgcolor/80 flex justify-center items-center"
        onclick={(event) => {
            if (event.target === event.currentTarget) {
                close();
            }
        }}
    >
        <div
            class="bg-darkbg p-3 rounded-md flex flex-col max-w-4xl w-full max-h-[90%] text-textcolor border border-darkborderc"
            role="dialog"
            aria-modal="true"
            aria-labelledby="message-search-title"
            data-message-search
        >
            <div class="flex items-center mb-3">
                <h2 id="message-search-title" class="text-xl font-bold">{language.messageSearch.title}</h2>
                <button
                    class="ml-auto text-textcolor2 hover:text-textcolor"
                    title={language.messageSearch.close}
                    aria-label={language.messageSearch.close}
                    onclick={close}
                >
                    <XIcon size={24} />
                </button>
            </div>
            <input
                bind:this={input}
                type="search"
                class="w-full rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                placeholder={language.messageSearch.placeholder}
                aria-label={language.messageSearch.placeholder}
                autocomplete="off"
                bind:value={query}
                oninput={onQueryInput}
                onkeydown={onQueryKeydown}
            />
            <div class="flex flex-wrap gap-2 mt-2" role="group" aria-label={language.messageSearch.scope}>
                {#each scopes as option (option.label)}
                    {@const active = option.scope !== null && messageSearchScopeKey(option.scope) === scopeKey}
                    <button
                        class="rounded-md border px-2 py-1 text-sm transition-colors"
                        class:border-borderc={active}
                        class:bg-selected={active}
                        class:text-textcolor={active}
                        class:border-darkborderc={!active}
                        class:text-textcolor2={!active}
                        class:opacity-50={option.scope === null}
                        aria-pressed={active}
                        disabled={option.scope === null}
                        onclick={() => {
                            if (option.scope) chooseScope(option.scope);
                        }}
                    >
                        {option.label}
                    </button>
                {/each}
            </div>

            <div class="flex flex-col gap-2 mt-3 overflow-y-auto min-h-0" aria-live="polite">
                {#if problem === "long"}
                    <p class="text-sm text-draculared">{language.messageSearch.tooLong(MESSAGE_SEARCH_MAX_QUERY)}</p>
                {:else if problem === "short" && normalize(query) !== ""}
                    <p class="text-sm text-textcolor2">{language.messageSearch.tooShort(MESSAGE_SEARCH_MIN_QUERY)}</p>
                {/if}
                {#each hits as hit (hitKey(hit))}
                    {@const [before, match, after] = snippetParts(hit)}
                    <button
                        class="flex flex-col items-start gap-1 rounded-md border border-darkborderc p-2 text-left hover:bg-selected"
                        data-message-search-hit
                        onclick={() => openHit(hit)}
                    >
                        <span class="flex w-full flex-wrap items-baseline gap-x-2 text-sm text-textcolor2">
                            <span class="font-semibold text-textcolor"
                                >{hit.characterName || language.messageSearch.unnamed}</span
                            >
                            <span class="truncate">{hit.chatName}</span>
                            <span>
                                {hit.role === "user"
                                    ? language.messageSearch.roleUser
                                    : language.messageSearch.roleChar}
                            </span>
                            {#if timeText(hit.time)}
                                <span class="ml-auto">{timeText(hit.time)}</span>
                            {/if}
                        </span>
                        <span class="break-words whitespace-pre-wrap text-sm" data-message-search-snippet
                            >{before}<mark class="rounded-sm bg-primary-500/30 text-textcolor">{match}</mark
                            >{after}</span
                        >
                    </button>
                {/each}
                {#if status === "loading"}
                    <p class="text-sm text-textcolor2" role="status">{language.messageSearch.searching}</p>
                {:else if status === "error"}
                    <p class="text-sm text-draculared" role="alert">{language.messageSearch.error(errorText)}</p>
                {:else if status === "done" && hits.length === 0 && next === null}
                    <p class="text-sm text-textcolor2">{language.messageSearch.empty}</p>
                {/if}
                {#if status !== "loading" && matchesShown && next !== null}
                    <button
                        class="self-center rounded-md border border-darkborderc px-3 py-1 text-sm hover:bg-selected"
                        data-message-search-more
                        onclick={loadMore}
                    >
                        {language.messageSearch.loadMore}
                    </button>
                {/if}
            </div>
        </div>
    </div>
{/if}
