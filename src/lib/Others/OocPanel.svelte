<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { get } from "svelte/store";
    import { language } from "src/lang";
    import { alertConfirm, doingAlert, terminalNotice } from "src/ts/alert";
    import { topBindingLayer } from "src/ts/gui/dialogLayers";
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme";
    import { messageSearchPanel } from "src/ts/messageSearch.svelte";
    import { closeOocPanel, oocPanel } from "src/ts/ooc/oocPanel.svelte";
    import {
        askOoc,
        clearOocLog,
        deleteOocExchange,
        oocAnchorExists,
        oocMessagesAfterAnchor,
        readOocSegments,
        readOocState,
        refreshOoc,
        retryOoc,
        stopOoc,
        toggleOocAttachment,
    } from "src/ts/ooc/oocSession.svelte";
    import { chatStatusKey, generatingChatKeys } from "src/ts/process/chatStatus.svelte";
    import { isLocalSend, localSends } from "src/ts/process/localSends";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import { currentChatRef, findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { createSimpleCharacter } from "src/ts/stores.svelte";
    import ChatBody from "../ChatScreens/ChatBody.svelte";

    /**
     * The selected chat's OOC metadata thread. App keeps this component mounted after loading so
     * the draft survives a close; the wide panel leaves the chat beside it interactive.
     */
    let draft = $state("");
    let panel: HTMLDivElement | undefined = $state();
    let expanded = $state<Record<string, boolean>>({});

    const ref = $derived(currentChatRef());
    const chat = $derived(ref ? findChat(ref) : undefined);
    const character = $derived(characterList().find((entry) => entry.chaId === ref?.chaId));
    const simpleCharacter = $derived(createSimpleCharacter(character));
    const session = $derived(ref ? readOocState(ref) : null);
    const segments = $derived(ref && chat ? readOocSegments(ref) : []);
    const hasEarlier = $derived(segments.some((segment) => !segment.current));
    // isChatBusy's default local-send read is synchronous; subscribe to that source here.
    const chatBusy = $derived(
        ref !== null && (isLocalSend(ref, $localSends) || generatingChatKeys().has(chatStatusKey(ref))),
    );
    const busyReason = $derived(
        session?.busy
            ? language.oocPanel.asking
            : chatBusy
              ? language.oocPanel.chatBusy
              : !draft.trim()
                ? language.oocPanel.emptyQuestion
                : "",
    );
    const notice = $derived(
        ref && chat && !oocAnchorExists(ref)
            ? language.oocPanel.anchorGone
            : session?.error?.kind === "oocMemoryAhead"
              ? language.oocPanel.memoryAhead
              : "",
    );
    const picks = $derived(
        (session?.picks ?? []).flatMap((id) => {
            const exchange = chat?.oocLog?.[id];
            return exchange ? [exchange] : [];
        }),
    );

    type BodyState = { translated: boolean; translating: boolean; retranslate: boolean };
    // Each keyed row owns separate translation bindings, retained while its text grows.
    const bodyStates = new Map<string, BodyState>();
    function bodyState(key: string): BodyState {
        const value = bodyStates.get(key);
        if (value) return value;
        const created = $state({ translated: false, translating: false, retranslate: false });
        bodyStates.set(key, created);
        return created;
    }

    function chipLabel(question: string) {
        const text = question.replace(/\s+/g, " ").trim();
        return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    }

    async function send() {
        const target = ref;
        const text = draft.trim();
        if (!target || !chat || character?.type === "group" || !text || session?.busy || chatBusy) return;
        const submitted = draft;
        const result = await askOoc(target, text);
        // A late answer must not erase text edited while the question was in flight.
        if (result.status !== "refused" && draft === submitted) draft = "";
    }

    function composerKeydown(event: KeyboardEvent) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
        }
    }

    async function clearEarlier(target: ChatRef) {
        if (await alertConfirm(language.oocPanel.clearConfirm)) await clearOocLog(target);
    }

    function closeOnEscape(event: KeyboardEvent) {
        if (!oocPanel.open || event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
        if (messageSearchPanel.open || doingAlert() || get(terminalNotice) !== null || topBindingLayer() !== null)
            return;
        if (event.target !== document.body && !(event.target instanceof Node && panel?.contains(event.target))) return;
        event.stopPropagation();
        event.preventDefault();
        closeOocPanel();
    }
</script>

{#snippet body(text: string, role: "user" | "char", bindings: BodyState, streaming = false)}
    <div class="chattext prose max-w-none" class:prose-invert={$ColorSchemeTypeStore !== "light"}>
        <ChatBody
            character={simpleCharacter}
            msgDisplay={text}
            {role}
            idx={-1}
            {streaming}
            bind:translated={bindings.translated}
            bind:translating={bindings.translating}
            bind:retranslate={bindings.retranslate}
        />
    </div>
{/snippet}

<svelte:document onkeydowncapture={closeOnEscape} />

{#if oocPanel.open}
    <div
        bind:this={panel}
        class="fixed inset-y-0 right-0 z-30 flex h-full w-full flex-col border-l border-darkborderc bg-darkbg text-textcolor lg:w-[28rem]"
        role="dialog"
        aria-modal="false"
        aria-labelledby="ooc-panel-title"
        data-ooc-panel
    >
        <header class="shrink-0 border-b border-darkborderc p-3">
            <div class="flex items-center gap-2">
                <h2 id="ooc-panel-title" class="text-xl font-bold">{language.oocPanel.title}</h2>
                <button
                    class="ml-auto text-textcolor2 hover:text-textcolor"
                    title={language.oocPanel.close}
                    aria-label={language.oocPanel.close}
                    onclick={closeOocPanel}
                >
                    <XIcon size={24} />
                </button>
            </div>
            {#if ref && chat && character?.type !== "group"}
                {@const target = ref}
                <div class="mt-3 flex flex-wrap gap-2 text-sm">
                    <button
                        class="rounded-md border border-darkborderc px-2 py-1 hover:bg-selected disabled:opacity-50"
                        disabled={session?.busy}
                        data-ooc-refresh
                        onclick={() => refreshOoc(target)}>{language.oocPanel.refresh}</button
                    >
                    <button
                        class="rounded-md border border-darkborderc px-2 py-1 hover:bg-selected disabled:opacity-50"
                        disabled={!hasEarlier}
                        onclick={() => clearEarlier(target)}>{language.oocPanel.clearEarlier}</button
                    >
                </div>
                {#if notice}
                    <p class="mt-2 text-sm text-textcolor2" role="status" data-ooc-notice>{notice}</p>
                {:else if chat.oocSegment}
                    <p class="mt-2 text-sm text-textcolor2" data-ooc-refresh-count>
                        {language.oocPanel.newMessages(oocMessagesAfterAnchor(target))}
                    </p>
                {/if}
            {/if}
        </header>

        {#if !ref || !chat || !character || !session}
            <p class="p-3 text-sm text-textcolor2">{language.oocPanel.noChat}</p>
        {:else if character.type === "group"}
            <p class="p-3 text-sm text-textcolor2">{language.ooc.group}</p>
        {:else}
            {@const target = ref}
            <div class="min-h-0 flex-1 overflow-y-auto p-3">
                {#each segments as segment (`${chatStatusKey(target)}\u0000${segment.id}`)}
                    <section class="mb-4" data-ooc-segment={segment.id} data-ooc-current={segment.current}>
                        {#if segment.current}
                            <h3 class="mb-2 font-semibold">{language.oocPanel.currentSegment}</h3>
                        {:else}
                            <h3>
                                <button
                                    class="mb-2 w-full rounded-md border border-darkborderc p-2 text-left text-sm hover:bg-selected"
                                    aria-expanded={expanded[segment.id] ?? false}
                                    onclick={() => (expanded[segment.id] = !expanded[segment.id])}
                                    >{language.oocPanel.earlierSegment(segment.exchanges.length)}</button
                                >
                            </h3>
                        {/if}
                        {#if segment.current || expanded[segment.id]}
                            {#each segment.exchanges as exchange (exchange.id)}
                                {@const rowKey = `${chatStatusKey(target)}\u0000${exchange.id}`}
                                {@const questionBody = bodyState(`${rowKey}\u0000question`)}
                                {@const answerBody = bodyState(`${rowKey}\u0000answer`)}
                                {@const streaming = session.busy && session.streamingExchangeId === exchange.id}
                                {@const answer =
                                    session.streamingExchangeId === exchange.id && session.streamingText
                                        ? session.streamingText
                                        : exchange.answer}
                                <article
                                    class="mb-3 rounded-md border border-darkborderc p-3"
                                    data-ooc-exchange={exchange.id}
                                >
                                    <div class="min-w-0 break-words" data-ooc-question>
                                        <h4 class="mb-1 text-sm font-semibold text-textcolor2">
                                            {language.oocPanel.question}
                                        </h4>
                                        {@render body(exchange.question, "user", questionBody)}
                                    </div>
                                    <div class="mt-3 min-w-0 break-words" data-ooc-answer>
                                        <h4 class="mb-1 text-sm font-semibold text-textcolor2">
                                            {language.oocPanel.answer}
                                        </h4>
                                        {#if answer !== undefined}
                                            {@render body(answer, "char", answerBody, streaming)}
                                        {/if}
                                        {#if exchange.answer === undefined && !streaming}
                                            <p class="text-sm text-textcolor2">
                                                {segment.current && session.error?.exchangeId === exchange.id
                                                    ? session.error.message
                                                    : language.oocPanel.noAnswer}
                                            </p>
                                            {#if segment.current}
                                                <button
                                                    class="mt-2 rounded-md border border-darkborderc px-2 py-1 text-sm hover:bg-selected disabled:opacity-50"
                                                    disabled={session.busy || chatBusy}
                                                    data-ooc-retry
                                                    onclick={() => retryOoc(target, exchange.id)}
                                                    >{language.oocPanel.retry}</button
                                                >
                                            {/if}
                                        {:else if streaming && answer === undefined}
                                            <p class="text-sm text-textcolor2" role="status">
                                                {language.oocPanel.asking}
                                            </p>
                                        {/if}
                                    </div>
                                    <div class="mt-3 flex flex-wrap gap-2 text-sm">
                                        {#if exchange.answer !== undefined}
                                            <button
                                                class="rounded-md border border-darkborderc px-2 py-1 hover:bg-selected"
                                                onclick={() =>
                                                    navigator.clipboard.writeText(exchange.answer!).catch(() => {})}
                                                >{language.oocPanel.copyAnswer}</button
                                            >
                                        {/if}
                                        <button
                                            class="rounded-md border border-darkborderc px-2 py-1 hover:bg-selected"
                                            onclick={() => deleteOocExchange(target, exchange.id)}
                                            >{language.oocPanel.delete}</button
                                        >
                                        {#if !segment.current && exchange.answer !== undefined}
                                            <button
                                                class="rounded-md border border-darkborderc px-2 py-1 hover:bg-selected"
                                                class:bg-selected={session.picks.includes(exchange.id)}
                                                aria-pressed={session.picks.includes(exchange.id)}
                                                data-ooc-attach
                                                onclick={() => toggleOocAttachment(target, exchange.id)}
                                                >{language.oocPanel.attach}</button
                                            >
                                        {/if}
                                    </div>
                                </article>
                            {/each}
                        {/if}
                    </section>
                {/each}
            </div>

            <form
                class="shrink-0 border-t border-darkborderc p-3"
                onsubmit={(event) => {
                    event.preventDefault();
                    void send();
                }}
            >
                {#if session.error && session.error.exchangeId === undefined}
                    <p class="mb-2 text-sm text-textcolor2" role="alert" data-ooc-notice>{session.error.message}</p>
                {/if}
                {#if picks.length}
                    <div class="mb-2 flex flex-wrap gap-2" data-ooc-chips>
                        {#each picks as exchange (exchange.id)}
                            <span
                                class="inline-flex max-w-full items-center gap-1 rounded-md border border-darkborderc bg-selected px-2 py-1 text-sm"
                                data-ooc-chip={exchange.id}
                            >
                                <span class="truncate">{chipLabel(exchange.question)}</span>
                                <button
                                    type="button"
                                    aria-label={language.oocPanel.removeAttachment(chipLabel(exchange.question))}
                                    title={language.oocPanel.removeAttachment(chipLabel(exchange.question))}
                                    onclick={() => toggleOocAttachment(target, exchange.id)}><XIcon size={16} /></button
                                >
                            </span>
                        {/each}
                    </div>
                {/if}
                <textarea
                    class="w-full resize-y rounded-md border border-darkborderc bg-transparent px-3 py-2 text-textcolor focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
                    rows={3}
                    aria-label={language.oocPanel.placeholder}
                    placeholder={language.oocPanel.placeholder}
                    bind:value={draft}
                    onkeydown={composerKeydown}></textarea>
                <div class="mt-2 flex items-center gap-2">
                    {#if busyReason}
                        <p id="ooc-busy-reason" class="text-sm text-textcolor2" data-ooc-busy-reason>{busyReason}</p>
                    {/if}
                    {#if session.busy}
                        <button
                            type="button"
                            class="ml-auto rounded-md border border-darkborderc px-3 py-1 hover:bg-selected"
                            data-ooc-stop
                            onclick={() => stopOoc(target)}>{language.oocPanel.stop}</button
                        >
                    {:else}
                        <button
                            type="submit"
                            class="ml-auto rounded-md border border-darkborderc px-3 py-1 hover:bg-selected disabled:opacity-50"
                            disabled={!!busyReason}
                            aria-describedby={busyReason ? "ooc-busy-reason" : undefined}
                            data-ooc-send>{language.oocPanel.send}</button
                        >
                    {/if}
                </div>
            </form>
        {/if}
    </div>
{/if}
