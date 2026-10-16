<script module lang="ts">
    import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { getModuleAssets, getModules } from "src/ts/process/modules";
    import { findAssetPrefix } from "src/ts/parser/assetSearch";

    // This boundary preserves the value on disabled-module edits; every row shares the copies.
    const moduleAssets = $derived(getModuleAssets(undefined, getModules()));
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
    import { tick } from "svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import isEqual from "lodash/isEqual";
    import { sleep } from "src/ts/util";
    import { alertError } from "../../ts/alert";
    import {
        addMetadataToElement,
        ParseMarkdown,
        postTranslationParse,
        trimMarkdown,
        type CbsConditions,
        type simpleCharacterArgument,
    } from "../../ts/parser/parser.svelte";
    import { applyEdittransToStoredTranslation, getLLMCache, translateHTML } from "../../ts/translator/translator";
    import {
        bilingualInterleave,
        type BilingualInterleaveOptions,
        pruneEmptyBilingualPairs,
    } from "../../ts/translator/bilingualInterleave";
    import { type CapturedTransform, captureTransform } from "../../ts/parser/transformClient";
    import { getFileSrc } from "src/ts/globalApi.svelte";

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
        bodyRoot?: HTMLElement | null;
        modelShortName: string;
        renderRawStreaming?: boolean;
        rawStreamingText?: string;
        /**
         * The row is on the stored-translation path (`docs/plan/translation.md` slice 1.4): `msgDisplay`
         * is rendered as it is (the original, or the stored translation `Chat` chose), never through
         * the rendered translation, and `translated`/`retranslate` are not read.
         */
        storedPath?: boolean;
        /** On the stored path: `msgDisplay` is the stored translation (the `edittrans` scripts apply). */
        storedTranslationShown?: boolean;
        /** On the stored path: a translation the row shows is being requested (the loading state). */
        storedPending?: boolean;
        /**
         * On the stored path, with the stored translation shown: the chat's bilingual display
         * (`docs/plan/translation.md` slice 2.4). The translation (after its `edittrans` scripts) is
         * interleaved with `source` before the display transform. Null: the translation alone.
         */
        bilingual?: { source: string; options: BilingualInterleaveOptions } | null;
        /**
         * The row's chat's `autoTranslate` (`docs/plan/translation.md` slice 2.1): on the rendered path,
         * the row starts translated (or with the cached translation only, `autoTranslateCachedOnly`).
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
        bodyRoot,
        modelShortName = "",
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
    let lastRenderedRevision: number | null = null;
    /**
     * The newest render's run. Only that render writes `lastParsed` and `lastRenderedRevision`: an
     * older one that settles later would otherwise put its text back as the body shown while the
     * next render is pending.
     */
    let parseRun = 0;

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
        const preservePendingContent = lastRenderedRevision !== null && requestedRevision !== lastRenderedRevision;
        let lastParsedQueue = "";
        let mode = "notrim" as const;
        try {
            if (stored) {
                // The normal display path; a stored translation takes the `edittrans` scripts first.
                let text = shownStored ? applyEdittransToStoredTranslation(data, charArg, chatID, transform) : data;
                if (shownStored && pairing) {
                    // The display scripts see the pairs' wrappers between the lines (slice 2.4).
                    text = bilingualInterleave(pairing.source, text, pairing.options);
                }
                const marked = await ParseMarkdown(text, charArg, mode, chatID, getCbsCondition(), transform);
                lastParsedQueue = marked;
                return marked;
            }
            // Read before any await, so a change of the chat's flag renders again (and restarts the row).
            const auto = autoTranslate;
            if (!isEqual(lastCharArg, charArg) || chatID !== lastChatId || auto !== lastAutoTranslate) {
                lastParsedQueue = "";
                lastCharArg = charArg;
                lastChatId = chatID;
                lastAutoTranslate = auto;
                let translateText = false;
                try {
                    if (auto) {
                        if (
                            settings.memoryTranslateMedia.autoTranslateCachedOnly &&
                            settings.memoryTranslateMedia.translatorType === "llm"
                        ) {
                            const cache = settings.memoryTranslateMedia.translateBeforeHTMLFormatting
                                ? await getLLMCache(data)
                                : !settings.memoryTranslateMedia.legacyTranslation
                                  ? await getLLMCache(
                                        await ParseMarkdown(
                                            data,
                                            charArg,
                                            "pretranslate",
                                            chatID,
                                            getCbsCondition(),
                                            transform,
                                        ),
                                    )
                                  : await getLLMCache(
                                        await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), transform),
                                    );

                            translateText = cache !== null;
                        } else {
                            translateText = true;
                        }
                    }

                    const lastTranslated = translated;

                    setTimeout(() => {
                        translated = translateText;
                    }, 10);

                    // State change of `translated` triggers markParsing again,
                    // causing redundant translation attempts. The empty body is what this
                    // render shows until then (the template's prune takes a string).
                    if (lastTranslated !== translateText) {
                        return "";
                    }
                } catch (error) {
                    console.error(error);
                }
            }
            if (retranslate || translated) {
                if (settings.ui.showTranslationLoading && !preservePendingContent && run === parseRun) {
                    lastParsed = LOADING_HTML;
                }

                let transResult;

                if (
                    settings.memoryTranslateMedia.translatorType === "llm" &&
                    settings.memoryTranslateMedia.translateBeforeHTMLFormatting
                ) {
                    await sleep(100);
                    translating = true;
                    data = await translateHTML(data, false, charArg, chatID, retranslate, transform);
                    translating = false;
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), transform);
                    lastParsedQueue = marked;
                    lastCharArg = charArg;
                    transResult = marked;
                } else if (!settings.memoryTranslateMedia.legacyTranslation) {
                    const marked = await ParseMarkdown(
                        data,
                        charArg,
                        "pretranslate",
                        chatID,
                        getCbsCondition(),
                        transform,
                    );
                    translating = true;
                    const translated = await postTranslationParse(
                        await translateHTML(marked, false, charArg, chatID, retranslate, transform),
                    );
                    translating = false;
                    lastParsedQueue = translated;
                    lastCharArg = charArg;
                    transResult = translated;
                } else {
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), transform);
                    translating = true;
                    const translated = await translateHTML(marked, false, charArg, chatID, retranslate, transform);
                    translating = false;
                    lastParsedQueue = translated;
                    lastCharArg = charArg;
                    transResult = translated;
                }

                setTimeout(() => {
                    retranslate = false;
                }, 10);

                return transResult;
            } else {
                const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), transform);
                lastParsedQueue = marked;
                lastCharArg = charArg;
                return marked;
            }
        } catch (error) {
            //retry
            if (tries > 2) {
                alertError(`Error while parsing chat message: ${translated}, ${error.message}, ${error.stack}`);
                return data;
            }
            const retried = await markParsing(
                data,
                charArg,
                chatID,
                requestedRevision,
                run,
                (tries ?? 0) + 1,
                transform,
                {
                    stored,
                    shownStored,
                    pairing,
                },
            );
            if (retried !== undefined) {
                lastParsedQueue = retried;
            }
            return retried;
        } finally {
            //since trimMarkdown is fast, we don't need to cache it
            if (run === parseRun) {
                lastParsed = lastParsedQueue;
                lastRenderedRevision = requestedRevision;
            }
        }
    };

    const checkImg = () => {
        if (!settings.memoryTranslateMedia.newImageHandlingBeta || !bodyRoot) {
            return;
        }
        const imgs = bodyRoot.querySelectorAll(
            'img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([noimage])',
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

    let markParsingResult = $derived.by(() => markParsing(msgDisplay, character, idx, renderRevision, ++parseRun));

    /** Screenshot capture waits for the current parse, including a replacement started meanwhile. */
    export async function whenRendered() {
        while (!shouldRenderRawStreaming) {
            const pending = markParsingResult;
            await pending;
            await tick();
            if (pending === markParsingResult) return;
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
        {@html addMetadataToElement(pruneEmptyBilingualPairs(trimMarkdown(lastParsed)), modelShortName)}
    {:then md}
        {@html addMetadataToElement(pruneEmptyBilingualPairs(trimMarkdown(md)), modelShortName)}
    {/await}
{/if}
