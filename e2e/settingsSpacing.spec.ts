import { expect, settle, test } from "./fixtures";
import { isolateContext, openApp } from "../util/playwright/stack.mjs";

// The pages that pass `itemSpacing` are spaced by `SettingRenderer`'s rule over each anchor's
// `data-spacing-kind`: rows 0.5rem apart, a field 1rem from a row or field neighbour, a run's first row
// or field 0.5rem below its heading, description, or container edge, and 0.5rem of its own margin after
// a block or a handwritten element; a field before a block, a handwritten element, or the end keeps 1rem
// below it. An item's box is the union of its anchor's boxed children (the anchor is `display: contents`).
// The flags and translator fields below show the conditional items, collapsible sections are opened.

/** Each page's menu index and the anchor ids it must show, by kind. */
const pages = [
    {
        name: "Interaction",
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
        menu: 6,
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
        menu: 21,
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
        menu: 10,
        block: ["lang.header"],
        field: ["lang.uiLanguage"],
        row: [],
    },
];

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
    await page.evaluate(async () => {
        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
        settings.ui.didFirstSetup = true;
        settings.ui.showUnrecommended = true;
        settings.ui.useExperimental = true;
        settings.ui.contextMeter = true;
        settings.ui.autoScrollToNewMessage = true;
        settings.ui.alwaysScrollToNewMessage = false;
        settings.ui.promptInfoInsideChat = true;
        settings.memoryTranslateMedia.dynamicAssets = true;
        settings.memoryTranslateMedia.translator = "ko";
        settings.memoryTranslateMedia.translatorType = "llm";
        settings.memoryTranslateMedia.llmTranslationTarget = "message";
    });
    await settle(page);

    const contentSelector = ".rs-setting-cont-4";
    const content = page.locator(contentSelector);
    for (const { name, menu, ...expectedKinds } of pages) {
        await test.step(name, async () => {
            await page.evaluate(async (index) => {
                const { settingsOpen, SettingsMenuIndex } = await import("/src/ts/stores.svelte.ts");
                settingsOpen.set(true);
                SettingsMenuIndex.set(index);
            }, menu);
            const heading = expectedKinds.block[0];
            await expect(content.locator(`[data-setting-id="${heading}"]`), `${name} ${heading}`).toBeAttached();
            const closed = content.locator('button[aria-expanded="false"]');
            while (await closed.count()) await closed.first().click();

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
});
