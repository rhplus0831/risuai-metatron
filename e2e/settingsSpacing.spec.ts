import { expect, settle, test } from "./fixtures";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// Every page that mounts the renderer is spaced by `SettingRenderer`'s rule over each anchor's
// `data-spacing-kind`: rows 0.5rem apart, a field 1rem from a row or field neighbour, a run's first row
// or field 0.5rem below its heading, description, or container edge, and 0.5rem of its own margin after
// a block or a handwritten element; a field before a block, a handwritten element, or the end keeps 1rem
// below it. An item's box is the union of its anchor's boxed children (the anchor is `display: contents`).

type ExpectedItems = Partial<Record<"block" | "row" | "field", string[]>>;

interface SettingsView extends ExpectedItems {
    name: string;
    menu: number;
    ready: string;
    sections?: string[];
    open?: () => Promise<void>;
}

const pages: SettingsView[] = [
    {
        name: "Interaction",
        ready: "interaction.header",
        menu: 22,
        block: ["interaction.header"],
        field: ["acc.newChatBinding", "interaction.contextMeterTurnUnit", "interaction.contextMeterFixedWarn"],
        row: [
            "acc.sendWithEnter",
            "interaction.loreBudgetStop",
            "interaction.generationProgressWindow",
            "acc.clickToEdit",
            "acc.enableBlockPartialEdit",
            "acc.enableDragPartialEdit",
            "acc.longPressToPopupEditor",
            "acc.disableAutoPopupMessageEditor",
            "acc.askRemoval",
            "acc.instantRemove",
            "acc.swipe",
            "acc.botSettingAtStart",
            "acc.showMenuChatList",
            "acc.showMenuHypaMemoryModal",
            "acc.sideMenuRerollButton",
            "acc.goCharacterOnImport",
            "acc.createFolderOnBranch",
            "adv.scrollToActive",
            "adv.bookmark",
            "interaction.contextMeterEnabled",
            "interaction.contextMeterLookahead",
        ],
    },
    {
        name: "Accessibility",
        ready: "acc.header",
        menu: 11,
        block: ["acc.header"],
        field: ["acc.newMessageButtonStyle"],
        row: [
            "acc.autoScrollToNewMessage",
            "acc.alwaysScrollToNewMessage",
            "acc.scrollToReplyStartAfterStreaming",
            "acc.fixedChatTextarea",
            "acc.hamburgerButtonBottom",
        ],
    },
    {
        name: "Advanced",
        ready: "adv.header",
        menu: 6,
        sections: ["advanced.developer", "advanced.experimental", "advanced.legacy"],
        block: ["adv.header", "adv.warn", "adv.export", "adv.diagnosticsPanel"],
        field: [
            "adv.chatLoadInitial",
            "adv.chatLoadAdditional",
            "adv.assetAlloc",
            "adv.requestHistoryLimit",
            "adv.streamingDisplayOpt",
        ],
        row: [
            "adv.showUnrec",
            "adv.useExp",
            "display.hideApiKey",
            "adv.imgComp",
            "adv.legacyMedia",
            "adv.allowExt",
            "adv.dynAssets",
            "adv.dynAssetsEdit",
            "adv.newImgBeta",
            "adv.tokCache",
            "adv.toolUsage",
            "adv.simpleTool",
            "adv.requestHistoryContent",
            "adv.devTools",
            "adv.promptInfo",
            "adv.promptTextInfo",
            "adv.cssErr",
            "acc.requestInfoInsideChat",
            "acc.inlayErrorResponse",
            "adv.exp.googleToken",
            "adv.exp.cachePoint",
            "adv.exp.claudeRet",
            "adv.plainFetch",
            "display.useLegacyGUI",
        ],
    },
    {
        name: "Translation",
        ready: "translation.header",
        menu: 21,
        sections: ["translation.experimental"],
        block: ["translation.header", "lang.llmPresets", "lang.exportCache", "lang.importCache", "lang.clearCache"],
        field: [
            "lang.translatorLang",
            "lang.translatorType",
            "lang.llmTranslationTarget",
            "lang.translatorHistoryMaxTokens",
        ],
        row: ["lang.combineTranslation", "adv.noWaitTrans", "acc.showTranslationLoading", "adv.exp.googleTrans"],
    },
    {
        name: "Language",
        ready: "lang.header",
        menu: 10,
        block: ["lang.header"],
        field: ["lang.uiLanguage"],
        row: [],
    },
    {
        name: "Voice",
        menu: 20,
        ready: "adv.emoPrompt",
        field: ["adv.emoPrompt"],
    },
    {
        name: "Storage",
        menu: 23,
        ready: "storage.header",
        sections: ["storage.owners", "storage.details"],
        block: [
            "storage.header",
            "storage.description",
            "adv.storagePanel",
            "storage.cleanupPanel",
            "storage.snapshotsPanel",
            "storage.ownersPanel",
            "storage.detailsPanel",
        ],
    },
    {
        name: "Device link",
        menu: 25,
        ready: "deviceLink.header",
        block: [
            "deviceLink.header",
            "deviceLink.localNote",
            "deviceLink.description",
            "deviceLink.name",
            "display.remoteHost",
            "deviceLink.startHost",
            "display.handoff",
        ],
    },
];

function displayTabs(themeFields: string[]) {
    return [
        {
            name: "Theme",
            ready: "display.theme",
            sections: ["display.theme.customCSS"],
            field: [
                "display.theme",
                ...themeFields,
                "display.textTheme",
                "display.font",
                "display.customFont",
                "display.customCSS",
            ],
            block: [
                "display.colorScheme",
                "display.customColorScheme",
                "display.customTextTheme",
                "display.customBackground",
            ],
            row: [],
        },
        {
            name: "Layout & sizing",
            ready: "display.zoomsize",
            field: [
                "display.zoomsize",
                "display.lineHeight",
                "display.chatScreenWidth",
                "display.iconsize",
                "display.textAreaSize",
                "display.textAreaTextSize",
                "display.sideBarSize",
                "display.animationSpeed",
                "display.settingsCloseButtonSize",
                "adv.heightMode",
            ],
            row: ["display.menuSideBar", "display.showFolderName", "display.hideRealm", "display.showSavingIcon"],
            block: [],
        },
        {
            name: "Chat appearance",
            ready: "display.showMemoryLimit",
            field: [
                "display.memoryLimitThickness",
                "display.leadingDoubleQuote",
                "display.trailingDoubleQuote",
                "display.leadingSingleQuote",
                "display.trailingSingleQuote",
                "display.assetWidth",
            ],
            row: [
                "display.showMemoryLimit",
                "display.showFirstMessagePages",
                "display.roundIcons",
                "display.textBorder",
                "display.textScreenRounded",
                "display.useChatCopy",
                "display.unformatQuotes",
                "display.blockquoteStyling",
                "display.customQuotes",
                "display.useChatSticker",
                "display.hideAllImages",
                "display.useAdditionalAssetsPreview",
            ],
            block: ["display.textScreenColor", "display.textScreenBorder"],
        },
        {
            name: "Sound & notifications",
            ready: "display.playMessage",
            field: ["adv.keepSessionAlive", "display.completionWaitMaxSeconds"],
            row: ["display.playMessage", "display.playMessageOnTranslateEnd"],
            block: ["display.notification"],
        },
    ];
}

function measureSpacing(contentSelector: string) {
    const root = document.querySelector(contentSelector)!;
    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-setting-id]"));
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const isRowOrField = (kind: string | null) => kind === "row" || kind === "field";
    const nameOf = (element: Element) => element.getAttribute("data-setting-id") ?? element.localName;
    const box = (anchor: Element) => {
        const rects = Array.from(anchor.children)
            .filter((child) => child.getClientRects().length > 0)
            .map((child) => child.getBoundingClientRect());
        return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    };
    const measurements: { pair: string; actual: number; expected: number }[] = [];
    for (const anchor of anchors) {
        const { settingId: id, spacingKind: kind } = anchor.dataset;
        if (!isRowOrField(kind)) continue;

        const previous = anchor.previousElementSibling;
        const previousKind = previous?.getAttribute("data-spacing-kind");
        const pair = `${previous ? nameOf(previous) : "container start"} → ${id}`;
        const { top } = box(anchor);
        if (isRowOrField(previousKind)) {
            const expected = kind === "row" && previousKind === "row" ? rem / 2 : rem;
            measurements.push({ pair, actual: top - box(previous).bottom, expected });
        } else if (!previous) {
            const parent = anchor.parentElement!;
            const style = getComputedStyle(parent);
            const edge =
                parent.getBoundingClientRect().top +
                parseFloat(style.borderTopWidth) +
                parseFloat(style.paddingTop) -
                parent.scrollTop;
            measurements.push({ pair, actual: top - edge, expected: rem / 2 });
        } else if (
            !previous.hasAttribute("data-setting-id") &&
            (previous.matches("p") || previous.querySelector(":scope > h3"))
        ) {
            measurements.push({ pair, actual: top - previous.getBoundingClientRect().bottom, expected: rem / 2 });
        } else {
            const actual = parseFloat(getComputedStyle(anchor.firstElementChild!).marginTop);
            measurements.push({ pair: `${pair} (margin-top)`, actual, expected: rem / 2 });
        }

        const next = anchor.nextElementSibling;
        if (kind === "field" && !isRowOrField(next?.getAttribute("data-spacing-kind"))) {
            const actual = parseFloat(getComputedStyle(anchor.lastElementChild!).marginBottom);
            measurements.push({
                pair: `${id} → ${next ? nameOf(next) : "container end"} (margin-bottom)`,
                actual,
                expected: rem,
            });
        }
    }
    const items = anchors.map((anchor) => ({
        id: anchor.dataset.settingId,
        kind: anchor.dataset.spacingKind,
        display: getComputedStyle(anchor).display,
    }));
    return { items, measurements };
}

test("settings rows and fields follow their neighbors' spacing", async ({ page, baseURL }) => {
    await isolateContext(page.context());
    await openApp(page, baseURL!);
    await settle(page);
    // All specs in the browser run share a server. Restore the settings and profiles this one edits.
    const restore = await page.evaluateHandle(async () => {
        const { recordData, replaceRecord } = await import("/src/ts/storage/records.svelte.ts");
        const { settingsOpen } = await import("/src/ts/stores.svelte.ts");
        const kinds = ["ui", "memoryTranslateMedia", "modelProfiles", "presets"] as const;
        const saved = kinds.map((kind) => [kind, JSON.stringify(recordData(kind))] as const);
        return () => {
            settingsOpen.set(false);
            for (const [kind, data] of saved) replaceRecord(kind, JSON.parse(data));
        };
    });

    const contentSelector = ".rs-setting-cont-4";
    const content = page.locator(contentSelector);
    async function visit({ name, menu, ready, open, sections = [], ...expectedKinds }: SettingsView) {
        await test.step(name, async () => {
            await page.evaluate(async (index) => {
                const { settingsOpen, SettingsMenuIndex } = await import("/src/ts/stores.svelte.ts");
                settingsOpen.set(true);
                SettingsMenuIndex.set(index);
            }, menu);
            await open?.();
            for (const section of sections) {
                // These sections start closed. In particular, leave Storage's nested action menus alone.
                await content
                    .locator(`[data-settings-section="${section}"]`)
                    .getByRole("button", { expanded: false })
                    .click();
            }
            await expect(content.locator(`[data-setting-id="${ready}"]`), `${name} ${ready}`).toBeAttached();

            const { items, measurements } = await page.evaluate(measureSpacing, contentSelector);
            for (const { id, kind, display } of items) {
                expect(display, `${name} ${id}`).toBe("contents");
                expect(["row", "field", "block"], `${name} ${id}`).toContain(kind);
            }
            const kinds = new Map(items.map(({ id, kind }) => [id, kind]));
            for (const [kind, ids] of Object.entries(expectedKinds)) {
                for (const id of ids) expect(kinds.get(id), `${name} ${id}`).toBe(kind);
            }
            for (const { pair, actual, expected } of measurements) {
                expect(actual, `${name} ${pair} (px)`).toBeCloseTo(expected, 0);
            }
        });
    }

    try {
        await page.evaluate(async () => {
            const { settings, editedMainProfile, editedPreset } =
                await import("/src/ts/storage/settingsViews.svelte.ts");
            const { changeLanguage } = await import("/src/lang/index.ts");
            settings.ui.language = "en";
            changeLanguage("en");
            settings.ui.didFirstSetup = true;
            settings.ui.showUnrecommended = true;
            settings.ui.useExperimental = true;
            settings.ui.useLegacyGUI = false;
            settings.ui.contextMeter = true;
            settings.ui.autoScrollToNewMessage = true;
            settings.ui.alwaysScrollToNewMessage = false;
            settings.ui.promptInfoInsideChat = true;
            settings.memoryTranslateMedia.dynamicAssets = true;
            settings.memoryTranslateMedia.translator = "ko";
            settings.memoryTranslateMedia.translatorType = "llm";
            settings.memoryTranslateMedia.llmTranslationTarget = "message";

            settings.ui.theme = "waifu";
            settings.ui.colorSchemeName = "custom";
            settings.ui.textTheme = "custom";
            settings.ui.font = "custom";
            settings.ui.showMemoryLimit = true;
            settings.ui.customQuotes = true;
            editedPreset.maxContextOverride = true;
            editedMainProfile.enableCustomFlags = false;
            editedMainProfile.modelId = "ooba";
            editedMainProfile.instructChatTemplate = "chatml";
        });
        await settle(page);

        await visit({
            name: "Model",
            menu: 1,
            ready: "acc.applyAdditionalParamsToAll",
            open: () => content.getByRole("button", { name: /^Additional Parameters/, expanded: false }).click(),
            sections: ["model.advanced", "model.customModels"],
            block: ["adv.customModels"],
            field: ["adv.retries", "adv.genTime", "adv.visionQual", "adv.autoContinueMin"],
            row: [
                "acc.applyAdditionalParamsToAll",
                "adv.autoFill",
                "adv.autoCont",
                "adv.remIncomp",
                "adv.newOai",
                "adv.dynamicModelRegistry",
                "adv.antiOverload",
                "adv.openAIFlex",
                "adv.claudeCache",
                "adv.claudeBatch",
            ],
        });
        await visit({
            name: "Memory",
            menu: 2,
            ready: "adv.remPunc",
            open: async () => {
                await content.locator('select:has(option[value="supaMemory"])').selectOption("supaMemory");
            },
            field: ["adv.lbDepth", "adv.lbToken"],
            row: ["adv.remPunc", "acc.localActivationInGlobalLorebook", "acc.bulkEnabling"],
        });

        const chatFormat = ["chatFormat.template", "chatFormat.jinjaTemplate"];
        await visit({
            name: "Connections / Chat Formatting",
            menu: 18,
            ready: "chatFormat.jinjaTemplate",
            open: async () => {
                // Only the explicitly selected connection uses Jinja here.
                const id = await page.evaluate(async () => {
                    const { addModelProfile } = await import("/src/ts/storage/collectionStore.svelte.ts");
                    return addModelProfile({ name: "Jinja connection", instructChatTemplate: "jinja" });
                });
                await content.locator(`[data-profile-id="${id}"]`).click();
                await content.getByRole("button", { name: "Chat Formatting", exact: true, expanded: false }).click();
            },
            field: ["params.maxContext", ...chatFormat],
        });

        const parameterFields = ["params.maxResponse", "params.maxContextOverrideSize"];
        await visit({
            name: "Prompt preset / Parameters / Ooba Settings",
            menu: 16,
            ready: "chatFormat.jinjaTemplate",
            open: async () => {
                await page.evaluate(async () => {
                    const { editedMainProfile } = await import("/src/ts/storage/settingsViews.svelte.ts");
                    editedMainProfile.instructChatTemplate = "jinja";
                });
                await content.getByRole("button", { name: "Parameters", exact: true }).click();
                await content.getByRole("button", { name: "Ooba Settings", exact: true, expanded: false }).click();
            },
            row: ["params.maxContextOverride"],
            field: [...parameterFields, ...chatFormat],
        });
        await visit({
            name: "Prompt preset / Parameters / OpenRouter",
            menu: 16,
            ready: "params.seed",
            open: () =>
                page.evaluate(async () => {
                    const { editedMainProfile } = await import("/src/ts/storage/settingsViews.svelte.ts");
                    editedMainProfile.modelId = "openrouter";
                }),
            row: ["params.maxContextOverride"],
            field: [
                ...parameterFields,
                "params.seed",
                "params.temperature",
                "params.topK",
                "params.minP",
                "params.topA",
                "params.repetitionPenalty",
                "params.topP",
                "params.frequencyPenalty",
                "params.presencePenalty",
            ],
        });
        await test.step("Prompt preset / Parameters / handwritten labels have a 1rem gap", async () => {
            const override = content.locator('[data-setting-id="params.maxContextOverride"]');
            const size = content.locator('[data-setting-id="params.maxContextOverrideSize"]');
            for (const { modelId, label } of [
                { modelId: "mancer", label: "Repetition Penalty" },
                { modelId: "novellist", label: "Top P" },
            ]) {
                await page.evaluate(async (id) => {
                    const { editedMainProfile, editedPreset } = await import("/src/ts/storage/settingsViews.svelte.ts");
                    editedMainProfile.modelId = id;
                    editedPreset.maxContextOverride = false;
                }, modelId);
                const handwritten = content.getByText(label, { exact: true });
                await expect(handwritten).toBeVisible();
                const expectGap = async (settingId: string) => {
                    const { previousId, gap, rem } = await handwritten.evaluate((element) => {
                        const previous = element.previousElementSibling!;
                        const bottom = Math.max(
                            ...Array.from(previous.children)
                                .filter((child) => child.getClientRects().length > 0)
                                .map((child) => child.getBoundingClientRect().bottom),
                        );
                        return {
                            previousId: previous.getAttribute("data-setting-id"),
                            gap: element.getBoundingClientRect().top - bottom,
                            rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
                        };
                    });
                    expect(previousId, `${modelId} control before ${label}`).toBe(settingId);
                    expect(gap, `${modelId} ${settingId} → ${label} (px)`).toBeCloseTo(rem, 0);
                };

                await expect(size).toHaveCount(0);
                await expectGap("params.maxContextOverride");
                await override.locator("label").click();
                await expect(size).toBeAttached();
                await expectGap("params.maxContextOverrideSize");
            }
        });
        await visit({
            name: "Prompt preset / Others",
            menu: 16,
            ready: "adv.addPrompt",
            open: () => content.getByRole("button", { name: "Others", exact: true }).click(),
            sections: ["prompt.advanced"],
            field: ["adv.addPrompt", "adv.descPrefix", "adv.presetChain"],
            row: ["adv.sayNothing", "adv.cot", "display.showPromptComparison"],
            block: ["adv.banChar"],
        });

        for (const tab of displayTabs(["display.waifuWidth", "display.waifuWidth2"])) {
            await visit({
                ...tab,
                name: `Display / ${tab.name}`,
                menu: 3,
                open: () => content.getByRole("button", { name: tab.name, exact: true }).click(),
            });
        }
        for (const view of pages) await visit(view);

        // Display reads the legacy flag at mount. Custom HTML and the Waifulike sliders are mutually exclusive.
        await page.evaluate(async () => {
            const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
            settings.ui.useLegacyGUI = true;
            settings.ui.theme = "customHTML";
        });
        const stacked = displayTabs(["display.guiHTML"]);
        await visit({
            name: "Display / legacy",
            menu: 3,
            ready: "display.guiHTML",
            sections: stacked.flatMap((tab) => tab.sections ?? []),
            row: stacked.flatMap((tab) => tab.row),
            field: stacked.flatMap((tab) => tab.field),
            block: stacked.flatMap((tab) => tab.block),
        });
    } finally {
        await restore.evaluate((undo) => undo());
        await settle(page);
    }
});
