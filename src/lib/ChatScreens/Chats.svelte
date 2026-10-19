<script lang="ts">
    import type { AnyClientCharacter, ClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import type { DeepReadonly, Message, StreamingDisplayOptimizationMode } from "src/ts/storage/database.svelte";
    import { getAllContexts, mount, onDestroy, tick, unmount, untrack } from "svelte";
    import Chat from "./Chat.svelte";
    import { getCharImage } from "src/ts/characters";
    import { createSimpleCharacter, ReloadChatPointer, reloadChatKey } from "src/ts/stores.svelte";
    import { currentChatRef, selectedChatId, streamingState } from "src/ts/storage/chatStore.svelte";
    import { chatFoldedStateMessageIndex } from "src/ts/globalApi.svelte";
    import { CHAT_ROW_CAP, getAdditionalChatLoadPages } from "src/ts/chatLoadPages";

    const getCurrentChatRoomId = () => {
        const ref = currentChatRef();
        return ref ? `${ref.chaId}\u0000${ref.chatId}` : null;
    };

    let {
        messages,
        currentCharacter,
        onReroll,
        unReroll,
        currentUsername,
        userIcon,
        loadPages,
        userIconPortrait,
        onTrim,
        suspendTrim = false,
        hasNewUnreadMessage = $bindable(false),
        revealing = $bindable(false),
    }: {
        messages: readonly DeepReadonly<Message>[];
        currentCharacter: AnyClientCharacter;
        onReroll: () => void;
        unReroll: () => void;
        currentUsername: string;
        userIcon: string;
        loadPages: number;
        userIconPortrait?: boolean;
        onTrim?: (keep: number) => number | undefined;
        suspendTrim?: boolean;
        hasNewUnreadMessage?: boolean;
        revealing?: boolean;
    } = $props();

    let chatBody: HTMLDivElement = $state();
    type RowUpdate = {
        message: string;
        idx: number;
        isOptimizedStreamingMessage: boolean;
        streamingOptimizationMode: StreamingDisplayOptimizationMode;
        rawStreamingText: string;
        name: string;
        img: string | Promise<string>;
    };
    type MountKey = { text: string | null; rest: string };
    type RowInput = {
        message: DeepReadonly<Message>;
        idx: number;
        streaming: boolean;
        optimized: boolean;
        mode: StreamingDisplayOptimizationMode;
    };
    type Row = {
        instance: {
            updateRow?: (update: Partial<RowUpdate>) => void;
            isEditing?: () => boolean;
            whenRendered?: () => Promise<void>;
        };
        element: HTMLDivElement;
        input: RowInput;
        armed: boolean;
        dispose: () => void;
    };
    const rows = new Map<string, Row>();
    const rowElements = new WeakMap<Element, Row>();
    // The rows are mounted by hand; they get this component's contexts (the chat screen's shared
    // stylesheets among them) explicitly rather than from whichever effect mounts them.
    const rowContexts = getAllContexts();
    const capturing = $derived(loadPages === Infinity);

    // Mounting outlives the visibility batch: neither images nor its 1200 ms deadline arm rows.
    type MountBatch = { pending: Map<Row, Row["instance"]>; deferred: Row[] };
    let mountBatch: MountBatch | undefined;
    let mountTimer: ReturnType<typeof setTimeout>;

    function armDeferredRows() {
        clearTimeout(mountTimer);
        const batch = mountBatch;
        mountBatch = undefined;
        for (const row of batch?.deferred ?? []) {
            if (rowElements.has(row.element)) row.armed = true;
        }
    }

    async function settleFirstStageRow(batch: MountBatch, row: Row) {
        const instance = row.instance;
        batch.pending.set(row, instance);
        try {
            await tick();
            if (mountBatch !== batch || batch.pending.get(row) !== instance) return;
            await instance.whenRendered?.();
        } catch {
            // Failed renders must not strand the older rows either.
        }
        if (mountBatch !== batch || batch.pending.get(row) !== instance) return;
        batch.pending.delete(row);
        if (batch.pending.size === 0) armDeferredRows();
    }

    $effect(() => {
        const scroller = chatBody?.parentElement;
        if (!scroller) return;
        const events = ["wheel", "touchmove", "pointerdown"] as const;
        for (const event of events) scroller.addEventListener(event, armDeferredRows, { passive: true });
        return () => {
            for (const event of events) scroller.removeEventListener(event, armDeferredRows);
        };
    });

    type RevealRow = { row: Row; settled: boolean; wait?: AbortController };
    type RevealBatch = { rows: RevealRow[]; next: number };
    let revealBatch: RevealBatch | undefined;
    let revealTimer: ReturnType<typeof setTimeout>;
    let revealFrame: number | undefined;

    function finishReveal() {
        clearTimeout(revealTimer);
        cancelAnimationFrame(revealFrame);
        revealFrame = undefined;
        const batch = revealBatch;
        revealBatch = undefined;
        for (const entry of batch?.rows ?? []) {
            entry.wait?.abort();
            entry.row.element.classList.remove("chat-row-pending");
        }
        revealing = false;
    }

    function advanceReveal() {
        if (!revealBatch || revealFrame !== undefined) return;
        revealFrame = requestAnimationFrame(() => {
            revealFrame = undefined;
            const batch = revealBatch;
            if (!batch) return;
            const scroller = chatBody.parentElement;
            while (batch.next < batch.rows.length) {
                const entry = batch.rows[batch.next];
                // Removed rows no longer hold up the newest-to-oldest prefix.
                if (!rowElements.has(entry.row.element)) {
                    batch.next++;
                    continue;
                }
                if (!entry.settled) return;
                entry.row.element.classList.remove("chat-row-pending");
                batch.next++;
                if (scroller && entry.row.element.getBoundingClientRect().top <= scroller.getBoundingClientRect().top) {
                    finishReveal();
                    return;
                }
            }
            finishReveal();
        });
    }

    function waitForImage(image: HTMLImageElement, signal: AbortSignal) {
        return new Promise<void>((resolve) => {
            const done = () => {
                image.removeEventListener("load", done);
                image.removeEventListener("error", done);
                signal.removeEventListener("abort", done);
                resolve();
            };
            image.addEventListener("load", done);
            image.addEventListener("error", done);
            signal.addEventListener("abort", done, { once: true });
            if (image.complete || signal.aborted) done();
        });
    }

    async function settleRevealRow(entry: RevealRow) {
        if (!entry.row.armed) return;
        entry.wait?.abort();
        const wait = new AbortController();
        entry.wait = wait;
        entry.settled = false;
        try {
            // createRow's effect mounts the instance on the next Svelte flush.
            await tick();
            if (wait.signal.aborted || !entry.row.instance) return;
            try {
                await entry.row.instance?.whenRendered?.();
            } catch {
                // A failed parse must not strand the reveal queue.
            }
            if (wait.signal.aborted) return;
            await Promise.all(
                [...entry.row.element.querySelectorAll("img")].map((image) => waitForImage(image, wait.signal)),
            );
        } catch {
            // Failed settle waits count as settled, just like an image error.
        }
        if (wait.signal.aborted) return;
        entry.settled = true;
        advanceReveal();
    }

    function startReveal(shown: Row[]) {
        finishReveal();
        if (capturing || suspendTrim) return;
        const batch: RevealBatch = { rows: shown.map((row) => ({ row, settled: false })), next: 0 };
        revealBatch = batch;
        revealing = true;
        for (const entry of batch.rows) entry.row.element.classList.add("chat-row-pending");
        if (chatBody.parentElement) chatBody.parentElement.scrollTop = 0;
        revealTimer = setTimeout(finishReveal, 1200);
        for (const entry of batch.rows) void settleRevealRow(entry);
    }

    $effect(() => {
        if (capturing || suspendTrim) {
            armDeferredRows();
            finishReveal();
        }
    });
    // Names and images update in place; only character identity and portrait affect mounting.
    // Callbacks and the simple character are captured at mount.
    const context = $derived({
        character: currentCharacter,
        image: currentCharacter.image,
        name: currentCharacter.name,
        portrait: (currentCharacter as ClientCharacter).largePortrait ?? false,
        userIcon,
        currentUsername,
        userIconPortrait: userIconPortrait ?? false,
    });

    function isEditing(row: Row) {
        return !!(
            row.instance?.isEditing?.() || row.element.querySelector(".message-edit-area, .partial-edit-overlay")
        );
    }

    let observer: IntersectionObserver | undefined;
    // The first observation follows layout. Use that measured block size as the fallback too:
    // browsers need not remember a size rendered before content-visibility became auto.
    $effect(() => {
        const body = chatBody;
        const capture = capturing;
        if (!body || typeof IntersectionObserver === "undefined") return;
        const root = body.parentElement;
        const observe = () => {
            observer?.disconnect();
            observer = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        const element = entry.target as HTMLDivElement;
                        const row = rowElements.get(element);
                        if (!row) continue;
                        if (!element.classList.contains("far")) {
                            const style = getComputedStyle(element);
                            const blockSize =
                                entry.boundingClientRect.height -
                                parseFloat(style.borderTopWidth) -
                                parseFloat(style.borderBottomWidth) -
                                parseFloat(style.paddingTop) -
                                parseFloat(style.paddingBottom);
                            element.style.containIntrinsicBlockSize = `auto ${Math.max(0, blockSize)}px`;
                        }
                        element.classList.toggle("far", !capture && !entry.isIntersecting && !isEditing(row));
                    }
                },
                { root, rootMargin: `${2 * (root?.clientHeight ?? 0)}px 0px` },
            );
            for (const row of rows.values()) {
                if (capture) row.element.classList.remove("far");
                if (row.instance) observer.observe(row.element);
            }
        };
        observe();
        const refresh = (element: Element) => {
            const row = rowElements.get(element);
            if (!row?.instance) return;
            row.element.classList.remove("far");
            observer?.unobserve(element);
            observer?.observe(element);
        };
        // The first layout may precede async markdown. Re-observe just the rows whose content
        // changed, after they have laid out uncontained. Otherwise a far row remembers the empty
        // body height and jumps when its parsed text first enters the viewport. Stream chunks
        // produce records only for their own row; this never walks all mounted rows per chunk.
        const mutations = new MutationObserver((records) => {
            const changed = new Set<Element>();
            for (const record of records) {
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                if (record.type === "attributes" && rowElements.has(target)) continue;
                const element = target?.closest(".chat-message-container");
                if (element) changed.add(element);
            }
            for (const element of changed) refresh(element);
        });
        mutations.observe(body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["class", "style", "src"],
        });
        const loaded = (event: Event) => {
            const element = (event.target as Element)?.closest?.(".chat-message-container");
            if (element) refresh(element);
        };
        body.addEventListener("load", loaded, true);
        const resize =
            typeof ResizeObserver === "undefined"
                ? undefined
                : new ResizeObserver(() => {
                      for (const row of rows.values()) row.element.classList.remove("far");
                      observe();
                  });
        if (root) resize?.observe(root);
        return () => {
            resize?.disconnect();
            mutations.disconnect();
            body.removeEventListener("load", loaded, true);
            observer?.disconnect();
            observer = undefined;
        };
    });

    function createRow(input: RowInput, initiallyArmed: boolean): Row {
        const element = document.createElement("div");
        element.classList.add("chat-message-container");
        let currentInput = $state.raw(input);
        let armed = $state(initiallyArmed);
        const row: Row = {
            element,
            get input() {
                return currentInput;
            },
            set input(value) {
                currentInput = value;
            },
            get armed() {
                return armed;
            },
            set armed(value) {
                armed = value;
            },
            instance: undefined,
            dispose: () => {},
        };
        rowElements.set(element, row);
        row.dispose = $effect.root(() => {
            let mountKey: MountKey | undefined;
            let mountedCharacter: AnyClientCharacter;
            let imageSource: string | undefined;
            let sent: RowUpdate | undefined;
            $effect(() => {
                if (!row.armed) return;
                const { message, idx, streaming, optimized, mode } = row.input;
                const ctx = context;
                const data = message.data;
                const portrait = message.role === "user" ? ctx.userIconPortrait : ctx.portrait;
                const key: MountKey = {
                    text: streaming ? null : data,
                    // Keep disabled's historical by-content comparison, even for legacy object values.
                    rest: JSON.stringify([
                        portrait,
                        message.disabled ?? false,
                        $ReloadChatPointer[reloadChatKey(message.chatId, idx)] ?? 0,
                        message.role,
                    ]),
                };
                const nextImageSource = message.role === "user" ? ctx.userIcon : ctx.image;
                const next: RowUpdate = {
                    message: data,
                    idx,
                    isOptimizedStreamingMessage: optimized,
                    streamingOptimizationMode: mode,
                    rawStreamingText: data,
                    name: message.role === "user" ? ctx.currentUsername : ctx.name,
                    // Reuse the resolved/pending image on text and name updates, including every
                    // stream chunk. A changed source updates the portrait without remounting Chat.
                    img: untrack(() =>
                        sent && imageSource === nextImageSource ? sent.img : getCharImage(nextImageSource, "css"),
                    ),
                };
                untrack(() => {
                    if (
                        mountKey &&
                        mountKey.text === key.text &&
                        mountKey.rest === key.rest &&
                        mountedCharacter === ctx.character
                    ) {
                        const update: Partial<RowUpdate> = {};
                        for (const field of Object.keys(next) as (keyof RowUpdate)[]) {
                            if (sent[field] !== next[field]) (update as Record<string, unknown>)[field] = next[field];
                        }
                        if (Object.keys(update).length) row.instance.updateRow?.(update);
                    } else {
                        if (row.instance) unmount(row.instance);
                        element.classList.remove("far");
                        row.instance = mount(Chat, {
                            target: element,
                            context: rowContexts,
                            props: {
                                ...next,
                                isLastMemory: false,
                                messageId: message.chatId,
                                onReroll,
                                unReroll,
                                rerollIcon: "dynamic",
                                character: createSimpleCharacter(ctx.character),
                                largePortrait: portrait,
                                messageGenerationInfo: message.generationInfo,
                                role: message.role,
                                isComment: message.isComment ?? false,
                                disabled: message.disabled ?? false,
                            },
                        });
                        if (mountBatch?.pending.has(row)) void settleFirstStageRow(mountBatch, row);
                        // A replacement instance must settle again while its row is still hidden.
                        const pending = revealBatch?.rows.slice(revealBatch.next).find((entry) => entry.row === row);
                        if (pending) void settleRevealRow(pending);
                        observer?.unobserve(element);
                        observer?.observe(element);
                    }
                    // Keep the latest equal string after a reload on the same-string comparison path.
                    mountKey = key;
                    mountedCharacter = ctx.character;
                    imageSource = nextImageSource;
                    sent = next;
                });
            });
        });
        return row;
    }

    // Detach the offscreen tail in one structural update, then dispose its component instances in
    // small frame budgets. They cannot be interacted with once detached; editor guards run before
    // detachment. Keeping teardown separate avoids repeating the full diff on every removal frame.
    const retired = new Set<Row["instance"]>();
    let retireFrame: number;
    function disposeRetired() {
        const deadline = performance.now() + 4;
        for (const instance of retired) {
            retired.delete(instance);
            unmount(instance);
            if (performance.now() >= deadline) break;
        }
        retireFrame = retired.size ? requestAnimationFrame(disposeRetired) : undefined;
    }

    function removeRow(row: Row, defer = false) {
        row.dispose();
        observer?.unobserve(row.element);
        rowElements.delete(row.element);
        row.element.remove();
        if (mountBatch?.pending.delete(row) && mountBatch.pending.size === 0) armDeferredRows();
        const pending = revealBatch?.rows.find((entry) => entry.row === row);
        if (pending) {
            pending.wait?.abort();
            pending.settled = true;
            row.element.classList.remove("chat-row-pending");
            advanceReveal();
        }
        if (!row.instance) return;
        if (defer) {
            retired.add(row.instance);
            retireFrame ??= requestAnimationFrame(disposeRetired);
        } else {
            unmount(row.instance);
        }
    }

    // Cache the id scan independently of the window/reload/context diff. Text is never an input.
    const activeStreamingIndex = $derived.by(() => {
        const id = streamingState.messageId;
        if (
            id === null ||
            streamingState.mode === "off" ||
            streamingState.chaId !== currentCharacter.chaId ||
            streamingState.chatId !== selectedChatId(currentCharacter.chaId)
        )
            return -1;
        return messages.findIndex((message) => message.chatId === id);
    });

    function updateChatBody(
        structure: readonly DeepReadonly<Message>[],
        chatKey: string,
        streamingId: string | null,
        mode: StreamingDisplayOptimizationMode,
        streamingIndex: number,
        window: number,
        folded: number,
        deferRemoval: boolean,
    ) {
        let loadStart = structure.length - 1;
        let loadEnd = structure.length - window;
        if (folded !== -1) {
            loadStart = folded;
            loadEnd = Math.max(0, folded - window);
        }
        const inputs: { key: string; input: RowInput }[] = [];
        const shownKeys = new Set<string>();
        for (let i = loadStart; i >= Math.max(0, loadEnd); i--) {
            const message = structure[i];
            if (!message) continue;
            let key = `${chatKey}\u0000${message.chatId ?? `#${i}`}`;
            if (shownKeys.has(key)) key = `${key}\u0000#${i}`;
            shownKeys.add(key);
            const streaming = streamingId !== null && message.role === "char" && message.chatId === streamingId;
            const input: RowInput = {
                message,
                idx: i,
                streaming,
                optimized: streaming && i === streamingIndex,
                mode,
            };
            inputs.push({ key, input });
        }
        // Decide deferral before creating effects, including duplicate-id fallback keys.
        const opening = inputs.length > 0 && inputs.every(({ key }) => !rows.has(key));
        armDeferredRows();
        if (opening) finishReveal();
        let firstStage = inputs.length;
        if (opening && !capturing && !suspendTrim) {
            const height = chatBody.parentElement?.clientHeight ?? 0;
            firstStage = 0;
            let estimated = 0;
            while (firstStage < inputs.length && firstStage < 8 && (firstStage < 3 || !height || estimated < height)) {
                // Cheap opening-only estimate: 48px shell plus text, capped at 480px per row.
                estimated += Math.min(480, 48 + inputs[firstStage].input.message.data.length * 0.2);
                firstStage++;
            }
        }
        const shown: Row[] = [];
        for (const { key, input } of inputs) {
            let row = rows.get(key);
            if (!row) {
                row = createRow(input, shown.length < firstStage);
                rows.set(key, row);
            } else if (Object.keys(input).some((field) => input[field] !== row.input[field])) {
                row.input = input;
            }
            shown.push(row);
        }
        for (const [key, row] of rows) {
            if (!shownKeys.has(key)) {
                removeRow(row, deferRemoval);
                rows.delete(key);
            }
        }
        let previous: Element | null = null;
        for (const row of shown) {
            const expected = previous ? previous.nextElementSibling : chatBody.firstElementChild;
            if (expected !== row.element) chatBody.insertBefore(row.element, expected);
            previous = row.element;
        }
        // Only a wholly new window (opening/switching chats) gets a reveal batch.
        if (opening) {
            if (firstStage < shown.length) {
                mountBatch = {
                    pending: new Map(shown.slice(0, firstStage).map((row) => [row, undefined])),
                    deferred: shown.slice(firstStage),
                };
                mountTimer = setTimeout(armDeferredRows, 3000);
            }
            startReveal(shown);
        }
    }

    // Called before changing the DOM, only on an append at the bottom of this same open chat.
    function trimWindow(length: number): number | undefined {
        if (
            !onTrim ||
            suspendTrim ||
            !Number.isFinite(loadPages) ||
            Math.min(loadPages, length) <= CHAT_ROW_CAP ||
            chatFoldedStateMessageIndex.index !== -1 ||
            !chatBody.parentElement ||
            chatBody.parentElement.scrollTop <= -4
        )
            return;
        const top = chatBody.parentElement.getBoundingClientRect().top;
        let keep = CHAT_ROW_CAP;
        // Newest first: once a row is entirely above the viewport, the older rows are too.
        for (const element of chatBody.children) {
            const row = rowElements.get(element);
            if (!row) continue;
            if (element.getBoundingClientRect().bottom < top) break;
            keep = Math.max(keep, length - row.input.idx + getAdditionalChatLoadPages(settings.ui));
        }
        if (keep >= loadPages) return;
        for (const row of rows.values()) {
            if (row.input.idx < length - keep && isEditing(row)) return;
        }
        return onTrim(keep);
    }

    let scrollTimer: ReturnType<typeof setTimeout>;
    onDestroy(() => {
        armDeferredRows();
        finishReveal();
        clearTimeout(scrollTimer);
        cancelAnimationFrame(retireFrame);
        for (const instance of retired) unmount(instance);
        retired.clear();
        for (const row of rows.values()) removeRow(row);
        rows.clear();
    });

    function checkIfAtBottom() {
        return !chatBody?.parentElement || chatBody.parentElement.scrollTop > -4;
    }

    export async function whenRendered() {
        do {
            armDeferredRows();
            finishReveal();
            await tick();
            // A pending opening diff can create a batch during this flush.
        } while (mountBatch);
        await Promise.all([...rows.values()].map((row) => row.instance?.whenRendered?.()));
    }

    export const scrollToLatestMessage = () => {
        if (!chatBody) return;
        hasNewUnreadMessage = false;
        const element = chatBody.firstElementChild;
        if (element) {
            element.scrollIntoView({ behavior: "instant", block: "start" });
        }
    };

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        if (!chatBody) return;
        // Track array identity, length, order, message identity and ids, but never message.data.
        const structure = messages.map((message) => {
            void message.chatId;
            void message.role;
            return message;
        });
        const ctx = context;
        const currentChatId = selectedChatId(ctx.character.chaId);
        const streaming = streamingState.chaId === ctx.character.chaId && streamingState.chatId === currentChatId;
        const streamingId = streaming ? streamingState.messageId : null;
        const mode =
            streamingId !== null ? streamingState.mode : (settings.ui.streamingDisplayOptimizationMode ?? "off");
        const streamingIndex = activeStreamingIndex;
        const window = loadPages;
        const folded = chatFoldedStateMessageIndex.index;
        void $ReloadChatPointer;
        const room = getCurrentChatRoomId();
        const append = room === previousChatRoomId && structure.length > previousLength;
        const autoScroll = append && structure.at(-1)?.role === "char" && settings.ui.autoScrollToNewMessage;
        untrack(() => {
            // Both geometry decisions precede the DOM update. The at-bottom read for auto-scroll
            // is gated first; a text chunk reaches neither this effect nor the row diff.
            const wasAtBottom = autoScroll && checkIfAtBottom();
            const keep = append ? trimWindow(structure.length) : undefined;
            updateChatBody(
                structure,
                `${ctx.character.chaId}\u0000${currentChatId}`,
                streamingId,
                mode,
                streamingIndex,
                keep ?? window,
                folded,
                keep !== undefined,
            );
            if (autoScroll) {
                if (wasAtBottom || settings.ui.alwaysScrollToNewMessage) {
                    clearTimeout(scrollTimer);
                    const element = chatBody.firstElementChild;
                    scrollTimer = setTimeout(() => {
                        if (element?.isConnected) element.scrollIntoView({ behavior: "instant", block: "start" });
                    }, 700);
                } else {
                    hasNewUnreadMessage = true;
                }
            }
            previousLength = structure.length;
            previousChatRoomId = room;
        });
    });
</script>

<div class="chat-screen-content-width flex flex-col-reverse" bind:this={chatBody}></div>
