import { Buffer } from "buffer";
import { writable } from "svelte/store";
import { vi } from "vitest";
import {
    LLMFlags,
    LLMProvider,
    LLMFormat,
    LLMTokenizer,
    ProviderNames,
    OpenAIParameters,
    ClaudeParameters,
} from "../model/types";
import { createAlertMock } from "./alertMock";
import { createServerAuthMock } from "../storage/tests/serverAuthMock";
import { createServerCommandsMock } from "../process/tests/serverCommandsMock";

type BootModules = {
    serverAuth: typeof import("../storage/serverAuth");
    alert: typeof import("../alert");
    serverCommands: typeof import("../process/serverCommands");
    assetClient: typeof import("../storage/assetClient");
    resourceSync: typeof import("../storage/resourceSync.svelte");
    characterCards: typeof import("../characterCards");
    plugins: typeof import("../plugins/plugins.svelte");
    permissionStore: typeof import("../plugins/apiV3/permissionStore");
    router: typeof import("../router/router.svelte");
    browserLocalImport: typeof import("../storage/browserLocalImport");
    modules: typeof import("../process/modules");
    parser: typeof import("../parser/parser.svelte");
    transformClient: typeof import("../parser/transformClient");
    inlays: typeof import("../process/files/inlays");
    animation: typeof import("../gui/animation");
    guisize: typeof import("../gui/guisize");
    observer: typeof import("../observer.svelte");
    modellist: typeof import("../model/modellist");
    eventFeed: typeof import("../network/eventFeed");
    pushNotifications: typeof import("../network/pushNotifications");
};

/** Shared, complete boot service doubles. Invoke inside each file's hoisted vi.mock factory;
 * overrides keep each suite's own handles and plugin startup controls. Boot service modules are referenced only as types here.
 */
export function createBootMock<K extends keyof BootModules>(
    module: K,
    overrides: Partial<BootModules[K]> = {},
): BootModules[K] {
    const defaults = {
        serverAuth: createServerAuthMock(),
        alert: createAlertMock(),
        serverCommands: createServerCommandsMock(),
        assetClient: {
            writeAsset: vi.fn<BootModules["assetClient"]["writeAsset"]>(),
            readAsset: vi.fn<BootModules["assetClient"]["readAsset"]>(async () => Buffer.from([137, 80, 78, 71])),
            writeAssets: vi.fn<BootModules["assetClient"]["writeAssets"]>(),
            readAssets: vi.fn<BootModules["assetClient"]["readAssets"]>(),
            MAX_ASSET_ATTEMPTS: 8,
            BASE_RETRY_DELAY_MS: 1000,
            MAX_BACKOFF_MS: 30000,
            MAX_RETRY_AFTER_MS: 60000,
            ASSET_BATCH_CLIENT_BYTES: 64 * 1024 * 1024,
            ASSET_BATCH_CLIENT_RECORDS: 500,
        },
        resourceSync: {
            seedResources: vi.fn<BootModules["resourceSync"]["seedResources"]>(),
            onRemoteRecordApplied: vi.fn<BootModules["resourceSync"]["onRemoteRecordApplied"]>(),
            onPluginStorageDiscarded: vi.fn<BootModules["resourceSync"]["onPluginStorageDiscarded"]>(),
            refusedItems: vi.fn<BootModules["resourceSync"]["refusedItems"]>(),
            retryRefused: vi.fn<BootModules["resourceSync"]["retryRefused"]>(),
            discardRefused: vi.fn<BootModules["resourceSync"]["discardRefused"]>(),
            utf8ByteLength: vi.fn<BootModules["resourceSync"]["utf8ByteLength"]>(),
            splitBatches: vi.fn<
                BootModules["resourceSync"]["splitBatches"]
            >() as BootModules["resourceSync"]["splitBatches"],
            awaitSecretWrites: vi.fn<BootModules["resourceSync"]["awaitSecretWrites"]>(),
            assertSaveAdmission: vi.fn<BootModules["resourceSync"]["assertSaveAdmission"]>(),
            beforeRestoreReload: vi.fn<BootModules["resourceSync"]["beforeRestoreReload"]>(),
            watchForRestore: vi.fn<BootModules["resourceSync"]["watchForRestore"]>(),
            refreshStaleChat: vi.fn<BootModules["resourceSync"]["refreshStaleChat"]>(),
            setRemoteResourceOwner: vi.fn<BootModules["resourceSync"]["setRemoteResourceOwner"]>(),
            noteRemoteChanges: vi.fn<BootModules["resourceSync"]["noteRemoteChanges"]>(),
            reconcileRemote: vi.fn<BootModules["resourceSync"]["reconcileRemote"]>(),
            heldRecordRevision: vi.fn<BootModules["resourceSync"]["heldRecordRevision"]>(),
            applyHydration: vi.fn<BootModules["resourceSync"]["applyHydration"]>(),
            applyPatchHydration: vi.fn<BootModules["resourceSync"]["applyPatchHydration"]>(),
            beginMutationScope: vi.fn<BootModules["resourceSync"]["beginMutationScope"]>(),
            generatingNoticeCount: vi.fn<BootModules["resourceSync"]["generatingNoticeCount"]>(),
            flushResources: vi.fn<BootModules["resourceSync"]["flushResources"]>(),
            startResourceSync: vi.fn<BootModules["resourceSync"]["startResourceSync"]>(),
            saving: { state: false },
            GenerationBlockedError: class extends Error {},
        },
        characterCards: {
            importCharacter: vi.fn<BootModules["characterCards"]["importCharacter"]>(),
            importCharacterProcess: vi.fn<
                BootModules["characterCards"]["importCharacterProcess"]
            >() as BootModules["characterCards"]["importCharacterProcess"],
            characterURLImport: vi.fn<BootModules["characterCards"]["characterURLImport"]>(),
            exportChar: vi.fn<BootModules["characterCards"]["exportChar"]>(),
            exportCharacterCard: vi.fn<BootModules["characterCards"]["exportCharacterCard"]>(),
            createBaseV3: vi.fn<BootModules["characterCards"]["createBaseV3"]>(),
            getRisuHub: vi.fn<BootModules["characterCards"]["getRisuHub"]>(),
            downloadRisuHub: vi.fn<BootModules["characterCards"]["downloadRisuHub"]>(),
            getHubResources: vi.fn<BootModules["characterCards"]["getHubResources"]>(),
            isCharacterHasAssets: vi.fn<BootModules["characterCards"]["isCharacterHasAssets"]>(),
            hubURL: "/hub-proxy",
            getRealmInfo: vi.fn<BootModules["characterCards"]["getRealmInfo"]>(),
            showRealmInfoStore: writable(null),
            JSON_EXPORT_ASSET_LIMIT: 64 * 1024 * 1024,
            hubAdditionalHTML: "",
        },
        plugins: {
            createBlankPlugin: vi.fn<BootModules["plugins"]["createBlankPlugin"]>(),
            updatePlugin: vi.fn<BootModules["plugins"]["updatePlugin"]>(),
            importPlugin: vi.fn<BootModules["plugins"]["importPlugin"]>(),
            loadPlugins: vi.fn<BootModules["plugins"]["loadPlugins"]>(),
            loadPluginsForBoot: vi.fn<BootModules["plugins"]["loadPluginsForBoot"]>(async () => ({
                guestsStarted: Promise.resolve(true),
                stopFollowingGuests: vi.fn(),
            })),
            handlePluginInstallViaPlugin: vi.fn<BootModules["plugins"]["handlePluginInstallViaPlugin"]>(),
            checkPluginUpdate: vi.fn<BootModules["plugins"]["checkPluginUpdate"]>(),
            allowedDbKeys: [],
        },
        permissionStore: {
            loadPluginPermissions: vi.fn<BootModules["permissionStore"]["loadPluginPermissions"]>(),
            hasPermissionGrant: vi.fn<BootModules["permissionStore"]["hasPermissionGrant"]>(),
            getLastGrantTime: vi.fn<BootModules["permissionStore"]["getLastGrantTime"]>(),
            recordPermissionGrants: vi.fn<BootModules["permissionStore"]["recordPermissionGrants"]>(),
            refreshPluginPermissions: vi.fn<BootModules["permissionStore"]["refreshPluginPermissions"]>(),
        },
        router: {
            browserHistory: vi.fn<BootModules["router"]["browserHistory"]>(),
            baseRouteOfState: vi.fn<BootModules["router"]["baseRouteOfState"]>(),
            layerRouteOfState: vi.fn<BootModules["router"]["layerRouteOfState"]>(),
            openRoute: vi.fn<BootModules["router"]["openRoute"]>(),
            startRouter: vi.fn<BootModules["router"]["startRouter"]>(() => () => {}),
        },
        browserLocalImport: {
            sameLocalValue: vi.fn<BootModules["browserLocalImport"]["sameLocalValue"]>(),
            importBrowserLocalData: vi.fn<BootModules["browserLocalImport"]["importBrowserLocalData"]>(),
        },
        modules: {
            exportModule: vi.fn<BootModules["modules"]["exportModule"]>(),
            exportModuleLegacy: vi.fn<BootModules["modules"]["exportModuleLegacy"]>(),
            readModule: vi.fn<BootModules["modules"]["readModule"]>(),
            prepareModuleImport: vi.fn<BootModules["modules"]["prepareModuleImport"]>(),
            importModuleFile: vi.fn<BootModules["modules"]["importModuleFile"]>(),
            serverImportErrorMessage: vi.fn<BootModules["modules"]["serverImportErrorMessage"]>(),
            addImportedModule: vi.fn<BootModules["modules"]["addImportedModule"]>(),
            importModule: vi.fn<BootModules["modules"]["importModule"]>(),
            getModules: vi.fn<BootModules["modules"]["getModules"]>(() => []),
            getModuleLorebooks: vi.fn<BootModules["modules"]["getModuleLorebooks"]>(),
            getModuleAssets: vi.fn<BootModules["modules"]["getModuleAssets"]>(),
            getModuleTriggers: vi.fn<BootModules["modules"]["getModuleTriggers"]>(),
            getModuleRegexScripts: vi.fn<BootModules["modules"]["getModuleRegexScripts"]>(),
            getModuleToggles: vi.fn<BootModules["modules"]["getModuleToggles"]>(),
            getModuleMcps: vi.fn<BootModules["modules"]["getModuleMcps"]>(),
            applyModule: vi.fn<BootModules["modules"]["applyModule"]>(),
            moduleUpdate: vi.fn<BootModules["modules"]["moduleUpdate"]>(),
        },
        parser: {
            resetAssetsCache: vi.fn<BootModules["parser"]["resetAssetsCache"]>(),
            getDistance: vi.fn<BootModules["parser"]["getDistance"]>(),
            ParseMarkdown: vi.fn<BootModules["parser"]["ParseMarkdown"]>(),
            trimMarkdown: vi.fn<BootModules["parser"]["trimMarkdown"]>(),
            trimMarkdownSharingStyles: vi.fn<BootModules["parser"]["trimMarkdownSharingStyles"]>(),
            addMetadataToElement: vi.fn<BootModules["parser"]["addMetadataToElement"]>(),
            postTranslationParse: vi.fn<BootModules["parser"]["postTranslationParse"]>(),
            parseMarkdownSafe: vi.fn<BootModules["parser"]["parseMarkdownSafe"]>(),
            hasher: vi.fn<BootModules["parser"]["hasher"]>(),
            risuChatParser: vi.fn<BootModules["parser"]["risuChatParser"]>((text) => text),
            risuChatParserForDisplay: vi.fn<BootModules["parser"]["risuChatParserForDisplay"]>(),
            risuChatParserScoped: vi.fn<BootModules["parser"]["risuChatParserScoped"]>(),
            applyMarkdownToNode: vi.fn<BootModules["parser"]["applyMarkdownToNode"]>(),
            risuEscape: vi.fn<BootModules["parser"]["risuEscape"]>(),
            risuUnescape: vi.fn<BootModules["parser"]["risuUnescape"]>(),
            assetRegex: /assets\/[^\s]+/g,
        },
        transformClient: {
            captureTransform: vi.fn<BootModules["transformClient"]["captureTransform"]>(),
            rerenderMessage: vi.fn<BootModules["transformClient"]["rerenderMessage"]>(),
            resetTransformEffects: vi.fn<BootModules["transformClient"]["resetTransformEffects"]>(),
            serverProcessScript: vi.fn<BootModules["transformClient"]["serverProcessScript"]>(),
        },
        inlays: {
            seedInlays: vi.fn<BootModules["inlays"]["seedInlays"]>(),
            noteRemoteInlay: vi.fn<BootModules["inlays"]["noteRemoteInlay"]>(),
            reconcileInlays: vi.fn<BootModules["inlays"]["reconcileInlays"]>(),
            invalidateInlayCaches: vi.fn<BootModules["inlays"]["invalidateInlayCaches"]>(),
            postInlayAsset: vi.fn<BootModules["inlays"]["postInlayAsset"]>(),
            writeInlayImage: vi.fn<BootModules["inlays"]["writeInlayImage"]>(),
            saveInlayedSignature: vi.fn<BootModules["inlays"]["saveInlayedSignature"]>(),
            getInlayAsset: vi.fn<BootModules["inlays"]["getInlayAsset"]>(),
            getInlayMedia: vi.fn<BootModules["inlays"]["getInlayMedia"]>(),
            getInlayObjectUrl: vi.fn<BootModules["inlays"]["getInlayObjectUrl"]>(),
            getInlayAssetBlob: vi.fn<BootModules["inlays"]["getInlayAssetBlob"]>(),
            listInlayAssets: vi.fn<BootModules["inlays"]["listInlayAssets"]>(),
            setInlayAsset: vi.fn<BootModules["inlays"]["setInlayAsset"]>(),
            removeInlayAsset: vi.fn<BootModules["inlays"]["removeInlayAsset"]>(),
            verifyInlay: vi.fn<BootModules["inlays"]["verifyInlay"]>(),
            repairInlayMedia: vi.fn<BootModules["inlays"]["repairInlayMedia"]>(),
            getInlayMetadata: vi.fn<BootModules["inlays"]["getInlayMetadata"]>(),
            supportsInlayImage: vi.fn<BootModules["inlays"]["supportsInlayImage"]>(),
            reencodeImage: vi.fn<BootModules["inlays"]["reencodeImage"]>(),
        },
        animation: {
            updateAnimationSpeed: vi.fn<BootModules["animation"]["updateAnimationSpeed"]>(),
        },
        guisize: {
            updateGuisize: vi.fn<BootModules["guisize"]["updateGuisize"]>(),
            guiSizeText: vi.fn<BootModules["guisize"]["guiSizeText"]>(),
            textAreaSize: writable(0),
            sideBarSize: writable(0),
            textAreaTextSize: writable(0),
        },
        observer: {
            startObserveDom: vi.fn<BootModules["observer"]["startObserveDom"]>(),
        },
        modellist: {
            isDynamicModel: vi.fn<BootModules["modellist"]["isDynamicModel"]>(),
            registerModelDynamic: vi.fn<BootModules["modellist"]["registerModelDynamic"]>(),
            getModelInfo: vi.fn<BootModules["modellist"]["getModelInfo"]>(),
            getModelInfoForMode: vi.fn<BootModules["modellist"]["getModelInfoForMode"]>(),
            getModelList: vi.fn<BootModules["modellist"]["getModelList"]>() as BootModules["modellist"]["getModelList"],
            LLMFlags: LLMFlags,
            LLMProvider: LLMProvider,
            LLMFormat: LLMFormat,
            LLMTokenizer: LLMTokenizer,
            ProviderNames: ProviderNames,
            OpenAIParameters: OpenAIParameters,
            ClaudeParameters: ClaudeParameters,
            LLMModels: [],
        },
        eventFeed: {
            startEventFeed: vi.fn<BootModules["eventFeed"]["startEventFeed"]>(),
            stopEventFeed: vi.fn<BootModules["eventFeed"]["stopEventFeed"]>(),
        },
        pushNotifications: {
            reconcilePush: vi.fn<BootModules["pushNotifications"]["reconcilePush"]>(),
            enablePushOnThisBrowser: vi.fn<BootModules["pushNotifications"]["enablePushOnThisBrowser"]>(),
            disablePushOnThisBrowser: vi.fn<BootModules["pushNotifications"]["disablePushOnThisBrowser"]>(),
            declinePushPrompt: vi.fn<BootModules["pushNotifications"]["declinePushPrompt"]>(),
            showCompletionNotification: vi.fn<BootModules["pushNotifications"]["showCompletionNotification"]>(),
            startPushNotifications: vi.fn<BootModules["pushNotifications"]["startPushNotifications"]>(),
            pushBrowserState: writable({
                availability: "checking",
                permission: "default",
                subscribed: false,
                optedOut: false,
                promptDismissed: false,
                busy: false,
                error: null,
            }),
        },
    } satisfies BootModules;
    const modules: BootModules = defaults;
    return { ...modules[module], ...overrides };
}

type ColorSchemeModule = typeof import("../gui/colorscheme");

/** Keep the theme catalogue real; replace only boot's DOM-writing entry points. */
export function createBootColorSchemeMock(
    original: ColorSchemeModule,
    overrides: Partial<ColorSchemeModule> = {},
): ColorSchemeModule {
    const defaults = {
        ...original,
        updateColorScheme: vi.fn<ColorSchemeModule["updateColorScheme"]>(),
        updateTextThemeAndCSS: vi.fn<ColorSchemeModule["updateTextThemeAndCSS"]>(),
    } satisfies ColorSchemeModule;
    return { ...defaults, ...overrides };
}
