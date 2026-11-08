<script module lang="ts">
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { getModuleAssets } from "src/ts/process/modules";
    import { findAssetPrefix } from "src/ts/parser/assetSearch";

    // This boundary preserves the value on disabled-module edits; every row shares the copies.
    const moduleAssets = $derived(getModuleAssets());
    /** checkImg's normalized assets and per-name results, replaced only when its inputs change. */
    const imageAssets = $derived.by(() => {
        const assets = moduleAssets.concat(selectedCharacter()?.additionalAssets ?? []);
        const list = assets.map((asset) => ({ name: asset[0].toLocaleLowerCase(), path: asset[1] }));
        return {
            list,
            exact: new Map(list.map((asset) => [asset.name, asset.path])),
            results: new Map<string, string>(),
        };
    });
</script>

<script lang="ts">
    import { onDestroy, tick } from "svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import isEqual from "lodash/isEqual";
    import { sleepAbortable } from "src/ts/util";
    import { isTransient } from "src/ts/parser/renderErrors";
    import { alertError } from "../../ts/alert";
    import {
        ParseMarkdown,
        postTranslationParse,
        trimMarkdown,
        trimMarkdownSharingStyles,
        type CbsConditions,
        type simpleCharacterArgument,
    } from "../../ts/parser/parser.svelte";
    import {
        applyEdittransToStoredTranslation,
        getLLMCache,
        llmTranslationCacheKey,
        translateHTML,
    } from "../../ts/translator/translator";
    import {
        bilingualInterleave,
        type BilingualInterleaveOptions,
        pruneEmptyBilingualPairs,
        pruneEmptyBilingualPairsIn,
    } from "../../ts/translator/bilingualInterleave";
    import { type ChatStyle, getChatStyleRegistry } from "../../ts/parser/chatStyles";
    import ChatRowStyles from "./ChatRowStyles.svelte";
    import { type CapturedTransform, captureTransform } from "../../ts/parser/transformClient";
    import { getFileSrc } from "src/ts/globalApi.svelte";

    /**
     * A message row's body (`Chat.svelte`): `markParsing` translates and parses the display text, and the result
     * goes in through `{@html}`. While a render is pending the body shows `lastParsed`: the last finished render,
     * or the loading markup a translation sets with `showTranslationLoading`.
     * `prepareShownBody` reuses the last prepared body while pending only for the same source, `modelShortName`
     * and `hideAllImages`; `:then` always prepares again and refreshes it, so CBS variables read inside a pending
     * body update on the next run.
     *
     * Each render run owns an `AbortController` (`parseController`), aborted when the next run starts in
     * `markParsingResult`, when raw streaming starts, or on destroy. Its signal goes to `ParseMarkdown` and
     * `translateHTML`; `run === parseRun` and `destroyed` remain the correctness guards. Only the run that set
     * `translating` clears it (`translatingRun`). The cached-only auto-translate probe follows the effective
     * translation key and rechecks changes; explicit choices stay separate, and an automatic decision never
     * permits a cache miss. Probe state commits on completion or in its 10 ms `translated` flip; an aborted flip
     * writes nothing and settles `pendingAutoTranslate`, so the next run probes again.
     *
     * Abort resolves quietly: no alert, retry or `lastParsed` write. Errors marked transient in
     * `src/ts/parser/renderErrors.ts` retry after 250 ms, then 1,000 ms, while the run is live. Other errors, or a
     * third failure, alert once with the original stack and show the input text.
     * Raw streaming (`renderRawStreaming`, untranslated) shows the text as it is and needs no parse.
     */

    interface Props {
        character?: simpleCharacterArgument | string | null;
        firstMessage?: boolean;
        idx?: number;
        msgDisplay?: string;
        name?: string;
        role: string | null;
        translated: boolean;
        translating: boolean;
        retranslate: boolean;
        renderRevision?: number;
        /** Reports a completed render whose server display transform may have mixed chat states. */
        onMixedRender?: (capture: CapturedTransform) => void;
        bodyRoot?: HTMLElement | null;
        modelShortName: string;
        /** The row's message is streaming: the rendered path shows the original and translates once it ends. */
        streaming?: boolean;
        renderRawStreaming?: boolean;
        rawStreamingText?: string;
        /**
         * The row is on the stored-translation path: `msgDisplay` is rendered as it is (the
         * original, or the stored translation `Chat` chose), never through the rendered translation,
         * and `translated`/`retranslate` are not read.
         */
        storedPath?: boolean;
        /** On the stored path: `msgDisplay` is the stored translation (the `edittrans` scripts apply). */
        storedTranslationShown?: boolean;
        /** On the stored path: a translation the row shows is being requested (the loading state). */
        storedPending?: boolean;
        /**
         * On the stored path, with the stored translation shown: the chat's bilingual display. The
         * translation (after its `edittrans` scripts) is interleaved with `source` before the display
         * transform. Null: the translation alone.
         */
        bilingual?: { source: string; options: BilingualInterleaveOptions } | null;
        /**
         * The row's chat's `autoTranslate`: on the rendered path, the row starts translated (or with
         * the cached translation only, `autoTranslateCachedOnly`).
         */
        autoTranslate?: boolean;
    }

    let {
        character = null,
        idx = 0,
        firstMessage = false,
        msgDisplay,
        role,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
        renderRevision = 0,
        onMixedRender,
        bodyRoot,
        modelShortName = "",
        streaming = false,
        renderRawStreaming = false,
        rawStreamingText = "",
        storedPath = false,
        storedTranslationShown = false,
        storedPending = false,
        bilingual = null,
        autoTranslate = false,
    }: Props = $props();

    const LOADING_HTML = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`;

    // svelte-ignore non_reactive_update
    let lastParsed = "";
    let lastCharArg: string | simpleCharacterArgument = null;
    let lastChatId = -10;
    /** The chat's `autoTranslate` the row last started from: a change starts it again. */
    let lastAutoTranslate: boolean | null = null;
    let lastAutoDecision: boolean | undefined;
    /** Explicit choices persist until the character, chat index or auto-translate flag changes. */
    let userOwnsTranslation = false;
    let lastCacheProbe: { key?: string; data: string; prefix: string; mode: string } | undefined;
    let lastRenderedRevision: number | null = null;
    /**
     * The newest render's run. Only that render writes `lastParsed` and `lastRenderedRevision`: an
     * older one that settles later would otherwise put its text back as the body shown while the
     * next render is pending.
     */
    let parseRun = 0;
    let parseController: AbortController | undefined;
    let translatingRun: number | undefined;
    let confirmedRevision = $state(0);
    let pendingTransformOutcome: { run: number; outcome: CapturedTransform["provisionalOutcome"] } | undefined;
    let destroyed = false;
    onDestroy(() => {
        destroyed = true;
        parseController?.abort();
    });
    let pendingAutoTranslate: Promise<void> | undefined;

    function getCbsCondition() {
        try {
            const cbsConditions: CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
            };
            return cbsConditions;
        } catch (e) {
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            };
        }
    }

    let shouldRenderRawStreaming = $derived(
        renderRawStreaming && (storedPath ? !storedTranslationShown : !translated && !retranslate),
    );
    let rawStreamingRevision = $state(0);
    let wasRawStreaming = false;
    $effect.pre(() => {
        const rawStreaming = shouldRenderRawStreaming;
        if (rawStreaming && !wasRawStreaming) {
            parseController?.abort();
            ++parseRun;
            // The next rendered body needs a fresh promise even when its text is unchanged.
            rawStreamingRevision += 1;
        }
        wasRawStreaming = rawStreaming;
    });

    const markParsing = async (
        data: string,
        charArg: string | simpleCharacterArgument,
        chatID: number,
        requestedRevision: number,
        /** The render's run (`parseRun` when it began); its retries keep it. */
        run: number,
        tries?: number,
        /** A retry's: the operation's own capture (a retry keeps the chat, preset, and persona it began with). */
        retryTransform?: CapturedTransform | null,
        /** A retry's: the stored-path state its operation began with. */
        retryStored?: {
            stored: boolean;
            shownStored: boolean;
            pairing: { source: string; options: BilingualInterleaveOptions } | null;
        },
        display = { finished: false, mixed: false, reported: false, replaced: false },
        signal?: AbortSignal,
    ): Promise<string> => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        // The stored path, read once for this render (a switch renders again).
        const stored = retryStored ? retryStored.stored : storedPath;
        const shownStored = retryStored ? retryStored.shownStored : storedTranslationShown;
        const pairing = retryStored ? retryStored.pairing : bilingual;
        // The server transform's context, captured once for every stage and retry of this render (flag on).
        const transform = retryTransform !== undefined ? retryTransform : captureTransform(chatID);
        if (tries === undefined && pendingTransformOutcome) {
            if (transform && pendingTransformOutcome.run === run - 1) {
                transform.provisionalOutcome = pendingTransformOutcome.outcome;
            }
            pendingTransformOutcome = undefined;
        }
        // A retry starts before any translation probes again; only its final display may opt in.
        if (transform) transform.onProvisional = undefined;
        const reportMixed = () => {
            if (
                destroyed ||
                run !== parseRun ||
                !display.finished ||
                display.replaced ||
                display.reported ||
                transform?.pendingProvisional
            )
                return;
            if (transform && (display.mixed || transform.mixedDisplay)) {
                display.reported = true;
                onMixedRender?.(transform);
            }
        };
        const enableProvisional = () => {
            if (!transform) return;
            transform.onProvisional = ({ replaced, mixed, outcome }) => {
                if (destroyed || run !== parseRun || display.replaced) return;
                display.mixed ||= mixed;
                if (replaced) {
                    display.replaced = true;
                    pendingTransformOutcome = outcome ? { run, outcome } : undefined;
                    confirmedRevision += 1;
                } else {
                    reportMixed();
                }
            };
        };
        const preservePendingContent = lastRenderedRevision !== null && requestedRevision !== lastRenderedRevision;
        let lastParsedQueue = "";
        let mode = "notrim" as const;
        const parse = async (text: string, parseMode: "notrim" | "pretranslate" = mode) => {
            signal?.throwIfAborted();
            const result = await ParseMarkdown(text, charArg, parseMode, chatID, getCbsCondition(), transform, signal);
            signal?.throwIfAborted();
            return result;
        };
        const translate = async (text: string) => {
            signal?.throwIfAborted();
            translatingRun = run;
            translating = true;
            try {
                const result = await translateHTML(text, false, charArg, chatID, retranslate, transform, signal);
                signal?.throwIfAborted();
                return result;
            } finally {
                if (translatingRun === run) {
                    translatingRun = undefined;
                    translating = false;
                }
            }
        };
        try {
            signal?.throwIfAborted();
            if (stored) {
                // The normal display path; a stored translation takes the `edittrans` scripts first.
                let text = shownStored ? applyEdittransToStoredTranslation(data, charArg, chatID, transform) : data;
                if (shownStored && pairing) {
                    // The display scripts see the pairs' wrappers between the lines.
                    text = bilingualInterleave(pairing.source, text, pairing.options);
                }
                enableProvisional();
                const marked = await parse(text);
                lastParsedQueue = marked;
                return marked;
            }
            if (streaming) {
                lastAutoTranslate = null;
                enableProvisional();
                const marked = await parse(data);
                lastParsedQueue = marked;
                return marked;
            }
            // Read before any await, so a change of the chat's flag renders again (and restarts the row).
            const auto = autoTranslate;
            const restartAuto = !isEqual(lastCharArg, charArg) || chatID !== lastChatId || auto !== lastAutoTranslate;
            if (restartAuto) userOwnsTranslation = false;
            else if (lastAutoDecision !== undefined && translated !== lastAutoDecision) userOwnsTranslation = true;
            if (retranslate) userOwnsTranslation = true;

            const cachedOnly =
                auto &&
                settings.memoryTranslateMedia.autoTranslateCachedOnly &&
                settings.memoryTranslateMedia.translatorType === "llm";
            // Read synchronously so configuration changes invalidate this render, including after a miss.
            const cachePrefix = cachedOnly && !userOwnsTranslation ? llmTranslationCacheKey("") : undefined;
            const translateBeforeFormatting =
                settings.memoryTranslateMedia.translatorType === "llm" &&
                settings.memoryTranslateMedia.translateBeforeHTMLFormatting;
            const legacyTranslation = settings.memoryTranslateMedia.legacyTranslation;
            const translationMode = translateBeforeFormatting ? "raw" : legacyTranslation ? mode : "pretranslate";
            let translationSource: string | undefined;
            if (
                restartAuto ||
                (cachedOnly &&
                    !userOwnsTranslation &&
                    // A miss uses cheap triggers; a translated row already needs the effective source.
                    (translated ||
                        !lastCacheProbe ||
                        data !== lastCacheProbe.data ||
                        cachePrefix !== lastCacheProbe.prefix ||
                        translationMode !== lastCacheProbe.mode))
            ) {
                lastParsedQueue = "";
                let translateText = translated;
                let probeKey: string | undefined;
                const rememberProbe = () => {
                    if (signal?.aborted || destroyed || run !== parseRun) return;
                    lastCharArg = charArg;
                    lastChatId = chatID;
                    lastAutoTranslate = auto;
                    lastAutoDecision = userOwnsTranslation ? undefined : translateText;
                    lastCacheProbe =
                        cachedOnly && !userOwnsTranslation
                            ? { key: probeKey, data, prefix: cachePrefix, mode: translationMode }
                            : undefined;
                };
                try {
                    signal?.throwIfAborted();
                    if (!userOwnsTranslation) {
                        translateText = false;
                        if (auto) {
                            if (cachedOnly) {
                                translationSource = translateBeforeFormatting
                                    ? data
                                    : await parse(data, legacyTranslation ? mode : "pretranslate");
                                probeKey = llmTranslationCacheKey(translationSource);
                                if (restartAuto || probeKey !== lastCacheProbe?.key) {
                                    const cache = await getLLMCache(translationSource);
                                    signal?.throwIfAborted();
                                    translateText = cache !== null;
                                } else {
                                    translateText = lastAutoDecision ?? false;
                                }
                            } else {
                                translateText = true;
                            }
                        }
                    }
                } catch (error) {
                    if (signal?.aborted) throw error;
                    console.error(error);
                    // An unsuccessful check cannot carry an earlier hit's permission forward.
                    translateText = false;
                    probeKey = undefined;
                }

                // State change of `translated` triggers markParsing again,
                // causing redundant translation attempts. The empty body is what this
                // render shows until then (the template's prune takes a string).
                if (translated !== translateText) {
                    let resolveUpdate: () => void;
                    const translationUpdate = new Promise<void>((resolve) => {
                        resolveUpdate = resolve;
                    });
                    const finishUpdate = () => {
                        clearTimeout(timer);
                        signal?.removeEventListener("abort", finishUpdate);
                        if (pendingAutoTranslate === translationUpdate) pendingAutoTranslate = undefined;
                        resolveUpdate();
                    };
                    const timer = setTimeout(() => {
                        if (!signal?.aborted && !destroyed && run === parseRun) {
                            rememberProbe();
                            translated = translateText;
                        }
                        finishUpdate();
                    }, 10);
                    signal?.addEventListener("abort", finishUpdate, { once: true });
                    pendingAutoTranslate = translationUpdate;
                    return "";
                }
                rememberProbe();
            }
            if (retranslate || translated) {
                if (settings.ui.showTranslationLoading && !preservePendingContent && run === parseRun) {
                    lastParsed = LOADING_HTML;
                }

                let transResult;

                if (translateBeforeFormatting) {
                    await sleepAbortable(100, signal);
                    const translatedText = await translate(data);
                    const marked = await parse(translatedText);
                    lastParsedQueue = marked;
                    lastCharArg = charArg;
                    transResult = marked;
                } else if (!legacyTranslation) {
                    const marked = translationSource ?? (await parse(data, "pretranslate"));
                    const translatedText = await translate(marked);
                    signal?.throwIfAborted();
                    const translated = await postTranslationParse(translatedText, signal);
                    signal?.throwIfAborted();
                    lastParsedQueue = translated;
                    lastCharArg = charArg;
                    transResult = translated;
                } else {
                    const marked = translationSource ?? (await parse(data));
                    const translated = await translate(marked);
                    lastParsedQueue = translated;
                    lastCharArg = charArg;
                    transResult = translated;
                }

                setTimeout(() => {
                    if (!signal?.aborted) retranslate = false;
                }, 10);

                return transResult;
            } else {
                enableProvisional();
                const marked = await parse(data);
                lastParsedQueue = marked;
                lastCharArg = charArg;
                return marked;
            }
        } catch (error) {
            if (signal?.aborted) return lastParsedQueue;
            if (isTransient(error) && (tries ?? 0) < 2) {
                try {
                    await sleepAbortable(tries ? 1000 : 250, signal);
                    signal?.throwIfAborted();
                    const retried = await markParsing(
                        data,
                        charArg,
                        chatID,
                        requestedRevision,
                        run,
                        (tries ?? 0) + 1,
                        transform,
                        { stored, shownStored, pairing },
                        display,
                        signal,
                    );
                    lastParsedQueue = retried;
                    return retried;
                } catch (retryError) {
                    if (signal?.aborted) return lastParsedQueue;
                    error = retryError;
                }
            }
            const wrapped = new Error(`Error while parsing chat message: ${error?.message ?? error}`);
            if (error instanceof Error) {
                wrapped.stack = error.stack;
            }
            lastParsedQueue = data;
            alertError(wrapped);
            return data;
        } finally {
            // Keep the final source for the next pending render's prepared body.
            if (!destroyed && run === parseRun) {
                lastParsed = lastParsedQueue;
                lastRenderedRevision = requestedRevision;
                // Retries share the capture; only their outer call reports the completed render.
                if (tries === undefined) {
                    display.finished = true;
                    reportMixed();
                }
            }
        }
    };

    const checkImg = () => {
        if (!settings.memoryTranslateMedia.newImageHandlingBeta || !bodyRoot) {
            return;
        }
        const imgs = bodyRoot.querySelectorAll(
            'img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="/api/asset/"]):not([src^="/sw/img/"]):not([noimage])',
        ) as NodeListOf<HTMLImageElement>;

        if (imgs.length > 0) {
            const styl = selectedCharacter().prebuiltAssetStyle;
            const { list: normalizedAssets, exact: exactAssets, results } = imageAssets;

            imgs.forEach(async (img) => {
                const name = img.getAttribute("src")?.toLocaleLowerCase() || "";

                if (name.length > 200 || name.includes(":")) {
                    img.setAttribute("noimage", "true");
                    return;
                }

                const foundAsset = exactAssets.get(name);
                if (foundAsset) {
                    img.classList.add("root-loaded-image");
                    img.classList.add("root-loaded-image-" + styl);
                    img.src = await getFileSrc(foundAsset);
                    return;
                }

                if (name.length < 3) {
                    img.setAttribute("noimage", "true");
                    return;
                }
                let currentFound = results.get(name);
                if (currentFound === undefined) {
                    currentFound = findAssetPrefix(name, normalizedAssets);
                    if (results.size >= 10000) results.clear();
                    results.set(name, currentFound);
                }
                if (currentFound) {
                    const got = await getFileSrc(currentFound);
                    const name2 = img.getAttribute("src")?.toLocaleLowerCase() || "";
                    if (name === name2) {
                        img.setAttribute("src", got);
                    }

                    if (img.classList.length === 0) {
                        img.classList.add("root-loaded-image");
                        img.classList.add("root-loaded-image-" + styl);
                    }
                    img.removeAttribute("noimage");
                } else {
                    img.setAttribute("noimage", "true");
                }
            });
        }
    };

    // Under a chat screen, shareable `<style>`s use its registry: the body keeps inert
    // comment placeholders, and `ChatRowStyles` holds their CSS and attributes. Elsewhere they stay inline.
    const chatStyles = getChatStyleRegistry();
    const NO_STYLES: readonly ChatStyle[] = [];
    const styleTag = /<(?:risu-)?style/i;

    function shownBody(source: string): { html: string; styles: readonly ChatStyle[] } {
        if (!chatStyles || !source || !styleTag.test(source)) {
            return { html: pruneEmptyBilingualPairs(trimMarkdown(source)), styles: NO_STYLES };
        }
        // Pruned before the styles are taken out: a pair side holding only a style is kept, as before.
        return trimMarkdownSharingStyles(source, pruneEmptyBilingualPairsIn);
    }

    let shownMemo:
        | {
              source: string;
              model: string;
              hideImages: boolean;
              body: ReturnType<typeof shownBody>;
          }
        | undefined;

    function prepareShownBody(source: string, pending = false) {
        const model = modelShortName;
        const hideImages = settings.ui.hideAllImages;
        if (
            pending &&
            shownMemo?.source === source &&
            shownMemo.model === model &&
            shownMemo.hideImages === hideImages
        ) {
            return shownMemo.body;
        }
        const body = shownBody(source);
        shownMemo = { source, model, hideImages, body };
        return body;
    }

    let markParsingResult = $derived.by(() => {
        // Translation can await before ParseMarkdown reads the parser's asset inputs.
        moduleAssets;
        confirmedRevision;
        rawStreamingRevision;
        parseController?.abort();
        parseController = new AbortController();
        return markParsing(
            msgDisplay,
            character,
            idx,
            renderRevision,
            ++parseRun,
            undefined,
            undefined,
            undefined,
            undefined,
            parseController.signal,
        );
    });

    /**
     * Wait for a settled DOM render, including auto-translation and replacement parses (the ordered reveal and
     * screenshot capture rely on it). The auto-translate path's first, empty result is not settled: the wait
     * covers its delayed `translated` update and the real parse after it. Raw streaming settles at once.
     */
    export async function whenRendered() {
        while (!shouldRenderRawStreaming) {
            const pending = markParsingResult;
            await pending;
            await pendingAutoTranslate;
            await tick();
            if (shouldRenderRawStreaming) return;
            if (pending === markParsingResult && !pendingAutoTranslate) return;
        }
    }

    $effect(() => {
        if (shouldRenderRawStreaming) {
            return;
        }
        markParsingResult;
        checkImg();
        markParsingResult.then(checkImg);
    });
</script>

{#if shouldRenderRawStreaming}
    <span class="whitespace-pre-wrap">{rawStreamingText}</span>
{:else if storedPath && storedPending && settings.ui.showTranslationLoading}
    {@html LOADING_HTML}
{:else}
    {#await markParsingResult}
        {@const shown = prepareShownBody(lastParsed, true)}
        {#if chatStyles}<ChatRowStyles styles={shown.styles} messageIndex={idx} />{/if}{@html shown.html}
    {:then md}
        {@const shown = prepareShownBody(md)}
        {#if chatStyles}<ChatRowStyles styles={shown.styles} messageIndex={idx} />{/if}{@html shown.html}
    {/await}
{/if}
