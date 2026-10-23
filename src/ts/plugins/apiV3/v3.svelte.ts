import { selectedCharacter, characterList, characterSnapshot } from "../../storage/characterStore.svelte";
import { settings, activePreset } from "../../storage/settingsViews.svelte";
import { allowedDbKeys, handlePluginInstallViaPlugin, loadPlugins, type RisuPlugin } from "../plugins.svelte";
import {
    clearPluginProviders,
    customProviderStore,
    pluginHooks,
    type ChatOutputListener,
    type EditFunction,
    type PluginProviderArgument,
    type PluginProviderOptions,
    type ReplacerFunction,
} from "../pluginHooks";
import { SandboxHost } from "./factory";
import {
    addPreparedCharacter,
    checkCharacterInput,
    prepareNewCharacter,
    removeCharacter,
    replaceCharacterAt,
    replaceCharacterFields,
} from "src/ts/storage/characterStore.svelte";
import {
    checkPluginInput,
    setCharacterOrder,
    setEnabledModules,
    setModules,
    setPersonas,
    setPluginArgument,
    updateSettings,
    upsertPlugin,
} from "src/ts/storage/collectionStore.svelte";
import { MutationValidationError, requireArray } from "src/ts/storage/mutationValidation";
import {
    clearPluginStorage,
    getPluginStorageValue,
    pluginStorageKeys,
    removePluginStorageItem,
    replacePluginCustomStorage,
    setPluginCustomValue,
    setPluginStorageItem,
} from "src/ts/storage/pluginStorageStore.svelte";
import { onPluginStorageDiscarded } from "src/ts/storage/resourceSync.svelte";
import { selectPersona, selectedIndex } from "src/ts/storage/selection.svelte";
import { batchRecordWrites } from "src/ts/storage/records.svelte";
import { isForwardedPresetRoot, missingPresetTarget } from "src/ts/storage/settingsViews.svelte";
import { buildDatabaseSubset } from "src/ts/storage/snapshots.svelte";
import {
    currentContext,
    enterContext,
    PluginTargetGoneError,
    takeHandoff,
    type PluginCallContext,
} from "./pluginContext";
import {
    appendMessage,
    applyChatResult,
    captureChatBaseline,
    chatList,
    chatOwnerToken,
    currentChatRef,
    ensureChatLoaded,
    findChat,
    isCharacterGenerating,
    chatsLoaded,
    loadChats,
    pinChat,
    pinChats,
    reconcileCharacterChats,
    selectChat,
    selectedChatIndex,
    withChatsCopy,
} from "src/ts/storage/chatStore.svelte";
import { SafeLocalPluginStorage, SafeLocalStorage, tagWhitelist } from "../pluginSafeClass";
import DOMPurify from "dompurify";
import {
    additionalChatMenu,
    additionalFloatingActionButtons,
    additionalHamburgerMenu,
    additionalSettingsMenu,
    bodyIntercepterStore,
    chatPanelStore,
    type MenuDef,
} from "src/ts/stores.svelte";
import { v4 } from "uuid";
import { sleep } from "src/ts/util";
import { alertConfirm, alertError, alertNormal, terminalNoticeShown } from "src/ts/alert";
import { language } from "src/lang";
import { checkCharOrder, fetchNative, getFetchLogs, globalFetch, readImage, saveAsset } from "src/ts/globalApi.svelte";
import { changeColorScheme, updateColorScheme, updateTextThemeAndCSS, type ColorScheme } from "src/ts/gui/colorscheme";
import { get } from "svelte/store";
import { registerMCPModule, registeredCustomPluginMCPs, unregisterMCPModule } from "src/ts/process/mcp/pluginmcp";
import { getInlayAsset } from "src/ts/process/files/inlays";
import { getLLMCache, searchLLMCache } from "src/ts/translator/translator";
import { hasher, risuChatParser, risuChatParserScoped, type CbsConditions } from "src/ts/parser/parser.svelte";
import { getLastGrantTime, hasPermissionGrant, recordPermissionGrants } from "./permissionStore";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "src/ts/model/types";
import { sendChat as processSendChat } from "src/ts/process/index.svelte";
import { isChatBusy } from "src/ts/process/chatStatus.svelte";
import { anyLocalSend } from "src/ts/process/localSends";
import {
    channelCallbacksRunning,
    generationPluginWorkActive,
    onGenerationPluginWork,
} from "src/ts/network/generationJobs";
import { captureTransform, serverProcessScript } from "src/ts/parser/transformClient";
import { getModelInfoForMode } from "src/ts/model/modellist";
import type { ModelModeExtended } from "src/ts/process/request/shared";
import type { RegexScriptMode as ScriptMode } from "../../../../shared/scripts/regex.ts";
import { supaMemoryOnCount } from "../../../../shared/characters.ts";
import { requestChatDataMain, withRequestChat } from "src/ts/process/request/request";
import { getModuleLorebooks } from "src/ts/process/modules";
import {
    registerTTSPreprocessor,
    unregisterTTSPreprocessor,
    registerTTSPostprocessor,
    unregisterTTSPostprocessor,
    type BeforeTTSContext,
    type BeforeTTSResult,
    type AfterTTSContext,
    type AfterTTSResult,
    type TTSHookFn,
} from "src/ts/process/ttsHooks";

/*
    V3 API for RisuAI Plugins

    Before adding new APIs here, please check the limitations

    - APIs must be a functions
        - If you want nested objects, first add as a plain function, `_getPluginStorage` for example
            And add it too _getAliases function ({'pluginStorage':{'getItem': '_getPluginStorage', ... }})
            This will make pluginStorage.getItem() work in plugins
        - If you need constants, use _getPropertiesForInitialization to set them up
            For example apiVersion and apiVersionCompatibleWith are set this way,
            Accessable in plugins as risuai.apiVersion
    - APIs must return, or accept as parameters, only the following types:
        - Serializable data (string, number, boolean, null, array, object)
        - Class instances marked with __classType = 'REMOTE_REQUIRED'
        - Callback functions (only as parameters)
        - Note that Class or Callbacks inside arrays or objects are not supported
*/

const pluginChannel = new Map<string, Function>();
const documentEventListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; options: any }> = [];

class SafeElement {
    #element: HTMLElement;
    __classType = "REMOTE_REQUIRED" as const;

    constructor(element: HTMLElement) {
        if (element.getAttribute("freezed")) {
            throw new Error("This element cannot be accessed by SafeELement");
        }
        this.#element = element;
    }

    public appendChild(child: SafeElement) {
        this.#element.appendChild(child.#element);
    }

    public removeChild(child: SafeElement) {
        this.#element.removeChild(child.#element);
    }

    public replaceChild(newChild: SafeElement, oldChild: SafeElement) {
        this.#element.replaceChild(newChild.#element, oldChild.#element);
    }

    public replaceWith(newElement: SafeElement) {
        this.#element.replaceWith(newElement.#element);
    }

    public cloneNode(deep: boolean = false): SafeElement {
        const cloned = this.#element.cloneNode(deep);
        return new SafeElement(cloned as HTMLElement);
    }

    public prepend(child: SafeElement) {
        this.#element.prepend(child.#element);
    }

    public remove() {
        this.#element.remove();
    }

    public innerText(): string {
        return this.#element.innerText;
    }

    public textContent(): string | null {
        return this.#element.textContent;
    }

    public setTextContent(value: string) {
        this.#element.textContent = value;
    }

    public setInnerText(value: string) {
        this.#element.innerText = value;
    }

    public setAttribute(name: string, value: string) {
        if (!name.startsWith("x-")) {
            throw new Error(
                "Can only set attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.",
            );
        }
        this.#element.setAttribute(name, value);
    }
    public getAttribute(name: string): string | null {
        if (!name.startsWith("x-")) {
            throw new Error(
                "Can only get attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.",
            );
        }
        return this.#element.getAttribute(name);
    }
    public setStyle(property: string, value: string) {
        (this.#element.style as any)[property] = value;
    }
    public getStyle(property: string): string {
        return (this.#element.style as any)[property];
    }
    public getStyleAttribute(): string {
        return this.#element.getAttribute("style") || "";
    }
    public setStyleAttribute(value: string) {
        this.#element.setAttribute("style", value);
    }
    public addClass(className: string) {
        //
        this.#element.classList.add(className);
    }
    public removeClass(className: string) {
        //
        this.#element.classList.remove(className);
    }
    public setClassName(className: string) {
        this.#element.className = className;
    }
    public getClassName() {
        return this.#element.className;
    }
    public hasClass(className: string): boolean {
        //We don't need to check the className here since we're just checking
        return this.#element.classList.contains(className);
    }
    public focus() {
        this.#element.focus();
    }
    public getChildren(): SafeClassArray<SafeElement> {
        const children: SafeElement[] = [];
        this.#element.childNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
                children.push(new SafeElement(node));
            }
        });
        return new SafeClassArray<SafeElement>(children);
    }
    public getParent(): SafeElement | null {
        if (this.#element.parentElement) {
            return new SafeElement(this.#element.parentElement);
        }
        return null;
    }
    public getInnerHTML(): string {
        return this.#element.innerHTML;
    }
    public getOuterHTML(): string {
        return this.#element.outerHTML;
    }
    public clientHeight(): number {
        return this.#element.clientHeight;
    }
    public clientWidth(): number {
        return this.#element.clientWidth;
    }
    public clientTop(): number {
        return this.#element.clientTop;
    }
    public clientLeft(): number {
        return this.#element.clientLeft;
    }
    public nodeName(): string {
        return this.#element.nodeName;
    }
    public nodeType(): number {
        return this.#element.nodeType;
    }
    public querySelectorAll(selector: string): SafeClassArray<SafeElement> {
        const nodeList = this.#element.querySelectorAll(selector);
        const elements: SafeElement[] = [];
        nodeList.forEach((node) => {
            if (node instanceof HTMLElement) {
                elements.push(new SafeElement(node));
            }
        });
        return new SafeClassArray<SafeElement>(elements);
    }
    public querySelector(selector: string): SafeElement | null {
        const element = this.#element.querySelector(selector);
        if (element instanceof HTMLElement) {
            return new SafeElement(element);
        }
        return null;
    }
    public getElementById(id: string): SafeElement | null {
        const element = this.querySelector("#" + id);
        return element;
    }
    public getElementsByClassName(className: string): SafeClassArray<SafeElement> {
        return this.querySelectorAll("." + className);
    }
    public getClientRects(): DOMRectList {
        return this.#element.getClientRects();
    }
    public getBoundingClientRect(): DOMRect {
        return this.#element.getBoundingClientRect();
    }
    public setInnerHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.innerHTML = san;
    }
    public setOuterHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.outerHTML = san;
    }
    public scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        this.#element.scrollIntoView(options);
    }
    #eventIdMap = new Map<string, Function>();

    public async addEventListener(
        type: string,
        listener: (event: any) => void,
        options?: boolean | AddEventListenerOptions,
    ): Promise<string> {
        const realOptions = typeof options === "boolean" ? { capture: options } : options || {};

        //allowed with unlimited
        const allowedDocumentEventListeners = [
            "click",
            "dblclick",
            "contextmenu",
            "mousedown",
            "mouseup",
            "mousemove",
            "mouseover",
            "mouseleave",
            "pointercancel",
            "pointerdown",
            "pointerenter",
            "pointerleave",
            "pointermove",
            "pointerout",
            "pointerover",
            "pointerup",
            "scroll",
            "scrollend",
        ];

        //allowed, but it has fingerprinting issues,
        //so it will be delayed random ms.
        const allowedDelayedEventListeners = ["keydown", "keyup", "keypress"];

        const id = v4();

        const trimEvent = (event: MouseEvent | KeyboardEvent | Event) => {
            if (event instanceof MouseEvent) {
                return {
                    type: event.type,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: event.button,
                    buttons: event.buttons,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                };
            } else if (event instanceof KeyboardEvent) {
                return {
                    type: event.type,
                    key: event.key,
                    code: event.code,
                    repeat: event.repeat,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                };
            } else {
                return {
                    type: event.type,
                };
            }
        };

        if (allowedDocumentEventListeners.includes(type)) {
            const modifiedListener = (event: any) => {
                listener(trimEvent(event));
            };
            this.#eventIdMap.set(id, modifiedListener);
            documentEventListeners.push({
                type,
                listener: modifiedListener as EventListenerOrEventListenerObject,
                options: realOptions,
            });
            document.addEventListener(type, modifiedListener, realOptions);
            return id;
        } else if (allowedDelayedEventListeners.includes(type)) {
            const modifiedListener = (event: any) => {
                // No key typed while the terminal notice is up reaches a plugin: the notice stops
                // only bubbling, and a capture-phase listener on `document` runs before it.
                if (terminalNoticeShown()) {
                    return;
                }
                let delay = 0;
                try {
                    delay = (crypto.getRandomValues(new Uint32Array(1))[0] / 100) % 100; //0-99 ms
                } catch (error) {}
                setTimeout(() => {
                    listener(trimEvent(event));
                }, delay);
            };
            this.#eventIdMap.set(id, modifiedListener);
            documentEventListeners.push({
                type,
                listener: modifiedListener as EventListenerOrEventListenerObject,
                options: realOptions,
            });
            document.addEventListener(type, modifiedListener, realOptions);
            return id;
        } else {
            throw new Error(`Event listener of type '${type}' is not allowed for security reasons.`);
        }
    }

    public removeEventListener(type: string, id: string, options?: boolean | EventListenerOptions) {
        const listener = this.#eventIdMap.get(id);
        if (listener) {
            const realOptions = typeof options === "boolean" ? { capture: options } : options || {};
            document.removeEventListener(type, listener as EventListenerOrEventListenerObject, realOptions);
            const idx = documentEventListeners.findIndex((e) => e.listener === listener);
            if (idx !== -1) documentEventListeners.splice(idx, 1);
            this.#eventIdMap.delete(id);
        }
    }

    public matches(selector: string): boolean {
        return this.#element.matches(selector);
    }
}

class SafeDocument extends SafeElement {
    __classType = "REMOTE_REQUIRED" as const;
    constructor(document: Document) {
        super(document.documentElement);
    }
    createElement(tagName: string): SafeElement {
        if (!tagWhitelist.includes(tagName.toLowerCase())) {
            console.warn(`Creation of <${tagName}> elements is restricted. Creating a <div> instead.`);
            tagName = "div";
        }
        if (tagName.toLowerCase() === "a") {
            console.warn(
                `<a> can be created but href attribute cannot be set directly for security reasons. Use .createAnchorElement(href: string) to create safe anchor elements.`,
            );
        }
        const element = document.createElement(tagName);
        return new SafeElement(element);
    }
    createAnchorElement(href: string): SafeElement {
        const anchor = document.createElement("a");
        try {
            const url = new URL(href);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error("Invalid protocol");
            }
            anchor.setAttribute("href", url.toString());
        } catch (error) {
            console.warn(`Invalid URL provided for anchor element: ${href}. Setting href to '#' instead.`);
            anchor.setAttribute("href", "#");
        }
        return new SafeElement(anchor);
    }
}

type SafeMutationRecordObject = {
    type: string;
    target: SafeElement;
    addedNodes: SafeElement[];
};

class SafeClassArray<T> {
    #items: T[];
    __classType = "REMOTE_REQUIRED" as const;
    constructor(items: T[] = []) {
        this.#items = items;
    }
    at(index: number): T {
        return this.#items.at(index);
    }
    length(): number {
        return this.#items.length;
    }
    push(item: T) {
        this.#items.push(item);
    }
}

class SafeMutationRecord {
    __classType = "REMOTE_REQUIRED" as const;
    #type: string;
    #target: SafeElement;
    #addedNodes: SafeClassArray<SafeElement>;
    constructor(type: string, target: SafeElement, addedNodes: SafeElement[]) {
        this.#type = type;
        this.#target = target;
        this.#addedNodes = new SafeClassArray<SafeElement>(addedNodes);
    }
    getType(): string {
        return this.#type;
    }
    getTarget(): SafeElement {
        return this.#target;
    }
    getAddedNodes(): SafeClassArray<SafeElement> {
        return this.#addedNodes;
    }
}

type SafeMutationCallback = (mutations: SafeClassArray<SafeMutationRecord>) => void;

class SafeMutationObserver {
    #observer: MutationObserver;
    __classType = "REMOTE_REQUIRED" as const;
    constructor(callback: SafeMutationCallback) {
        this.#observer = new MutationObserver((mutations) => {
            const safeMutations: SafeMutationRecordObject[] = mutations.map((mutation) => {
                const elementMapHelper = (nodeList: NodeList): SafeElement[] => {
                    const elements: SafeElement[] = [];
                    nodeList.forEach((node) => {
                        if (node instanceof HTMLElement) {
                            elements.push(new SafeElement(node));
                        }
                    });
                    return elements;
                };

                return {
                    type: mutation.type,
                    target: new SafeElement(mutation.target as HTMLElement),
                    addedNodes: elementMapHelper(mutation.addedNodes),
                    removedNodes: elementMapHelper(mutation.removedNodes),
                };
            });

            const safeClassed = new SafeClassArray<SafeMutationRecord>([]);
            for (const record of safeMutations) {
                safeClassed.push(new SafeMutationRecord(record.type, record.target, record.addedNodes));
            }
            callback(safeClassed);
        });
    }

    observe(element: SafeElement, options: MutationObserverInit) {
        const identifier = v4();
        element.setAttribute("x-identifier", identifier);
        const rawElement = document.querySelector(`[x-identifier="${identifier}"]`) as HTMLElement;
        if (rawElement) {
            this.#observer.observe(rawElement, options);
            element.setAttribute("x-identifier", "");
        }
    }

    disconnect() {
        this.#observer.disconnect();
    }
}

const pluginUnloadCallbacks: Map<string, Function[]> = new Map();

const addPluginUnloadCallback = (pluginName: string, callback: Function) => {
    if (!pluginUnloadCallbacks.has(pluginName)) {
        pluginUnloadCallbacks.set(pluginName, []);
    }
    pluginUnloadCallbacks.get(pluginName)?.push(callback);
};

const makeMenuUnloadCallback = (menuId: string, menuStore: MenuDef[]) => {
    return () => {
        const index = menuStore.findIndex((item) => item.id === menuId);
        if (index !== -1) {
            menuStore.splice(index, 1);
        }
    };
};

const removeChatPanel = (id: string) => {
    const index = chatPanelStore.findIndex((item) => item.id === id);
    if (index !== -1) {
        chatPanelStore.splice(index, 1);
    }
};

const removePluginChatPanels = (pluginName: string) => {
    for (let i = chatPanelStore.length - 1; i >= 0; i--) {
        if (chatPanelStore[i].pluginName === pluginName) {
            chatPanelStore.splice(i, 1);
        }
    }
};

const unloadV3Plugin = async (pluginName: string) => {
    forgetPluginPermissions(pluginName);
    const callbacks = pluginUnloadCallbacks.get(pluginName);
    const instance = v3PluginInstances.find((p) => p.name === pluginName);
    if (instance) {
        const index = v3PluginInstances.findIndex((p) => p.name === pluginName);
        if (index !== -1) {
            v3PluginInstances.splice(index, 1);
        }
    }
    if (callbacks) {
        pluginUnloadCallbacks.delete(pluginName);
        let promises: Promise<void>[] = [];
        for (const callback of callbacks) {
            const result = callback();
            if (result instanceof Promise) {
                promises.push(result);
            }
        }

        await Promise.any([
            Promise.all(promises),
            sleep(1000), //timeout after 1 second
        ]);
    }
    try {
        instance?.host?.terminate();
    } catch (error) {
        console.error(`Error terminating plugin ${pluginName}:`, error);
    }
    notifyPluginWork();
};

// Plugin work (`plugins-mcp.md`): a reload after a remote plugin change waits
// until `pluginWorkIdle`, and listeners of `onPluginWorkChange` hear whenever it may have become true.
const pluginWorkListeners = new Set<() => void>();
// Host-side hook invocations still running (a wrapped hook, a provider awaiting its permission prompt).
let runningHostHooks = 0;

function notifyPluginWork() {
    for (const listener of [...pluginWorkListeners]) {
        try {
            listener();
        } catch (error) {
            console.error(error);
        }
    }
}

function hostHookSettled() {
    runningHostHooks--;
    notifyPluginWork();
}

/** Runs a hook invocation counted as plugin work until it returns or, for a promise, settles. */
function trackHostHook<T>(run: () => T): T {
    runningHostHooks++;
    let result: T;
    try {
        result = run();
    } catch (error) {
        hostHookSettled();
        throw error;
    }
    if (result && typeof (result as { then?: unknown }).then === "function") {
        Promise.resolve(result).then(hostHookSettled, hostHookSettled);
    } else {
        hostHookSettled();
    }
    return result;
}

/**
 * No plugin work of this tab is in flight (a reload never interrupts it): no send
 * (`anyLocalSend`), no job that may still call its hooks (`generationPluginWorkActive`), no host-side hook
 * running, and every loaded sandbox idle (`SandboxHost.isIdle`).
 */
export function pluginWorkIdle(): boolean {
    return (
        !get(anyLocalSend) &&
        !generationPluginWorkActive() &&
        runningHostHooks === 0 &&
        v3PluginInstances.every(({ host }) => host.isIdle?.() ?? true)
    );
}

/** Calls `listener` whenever `pluginWorkIdle` may have changed; returns the unsubscribe function. */
export function onPluginWorkChange(listener: () => void): () => void {
    pluginWorkListeners.add(listener);
    const offChat = anyLocalSend.subscribe(() => listener());
    const offJobs = onGenerationPluginWork(listener);
    return () => {
        pluginWorkListeners.delete(listener);
        offChat();
        offJobs();
    };
}

type PluginPermission = "fetchLogs" | "db" | "mainDom" | "replacer" | "provider" | "sendChat" | "inlay";

/** The plugin as it was loaded: the hash of this script, not of the database copy, keys its grants. */
type PluginIdentity = { readonly name: string; readonly script: string };

/** What `onStorageDiscarded` listeners get (`risuai.d.ts` `StorageDiscardedEvent`). */
type StorageDiscardedEvent = {
    type: "storageDiscarded";
    pluginStorage: string[];
    localPluginStorage: string[];
    customStorage: boolean;
};

/** Answers given this page load, per plugin and permission; cleared when the plugin unloads. */
const permissionAnswers = new Map<string, boolean>();
const permissionAnswerKey = (pluginName: string, permission: string) => `${pluginName}\u0000${permission}`;

const forgetPluginPermissions = (pluginName: string) => {
    for (const key of [...permissionAnswers.keys()]) {
        if (key.startsWith(`${pluginName}\u0000`)) {
            permissionAnswers.delete(key);
        }
    }
};

type PluginV3ProviderOptions = PluginProviderOptions & {
    model?: LLMModel;
};

export const customV3ProviderMetaStore: LLMModel[] = [];

/**
 * Asks the user for a permission unless it was granted before (a grant is kept in the server-owned
 * `pluginPermissions` record, which no plugin API can read or write). `"periodically"` asks again
 * three days after the last grant.
 */
const getPluginPermission = async (
    plugin: PluginIdentity,
    permissionDesc: PluginPermission,
    reconfirm: boolean | "periodically" = false,
) => {
    const answerKey = permissionAnswerKey(plugin.name, permissionDesc);
    const answered = permissionAnswers.get(answerKey);
    if (answered !== undefined) {
        return answered;
    }

    let requiresReconfirm = false;
    const lastGrantTimeKey = plugin.name + "_" + permissionDesc + "_lastGrantTime";

    if (reconfirm === "periodically") {
        const lastGrantTime = getLastGrantTime(lastGrantTimeKey);
        const now = Date.now();
        if (!lastGrantTime || now - lastGrantTime > 3 * 24 * 60 * 60 * 1000) {
            //3 days
            requiresReconfirm = true;
        }
    } else if (reconfirm === true) {
        requiresReconfirm = true;
    }

    const pluginHash = (await hasher(new TextEncoder().encode(plugin.script))) + `_${permissionDesc}`;

    if (!requiresReconfirm && hasPermissionGrant(pluginHash)) {
        permissionAnswers.set(answerKey, true);
        return true;
    }

    const pluginName = plugin.name;
    let alertTitle =
        permissionDesc === "fetchLogs"
            ? language.fetchLogConsent.replace("{}", pluginName)
            : permissionDesc === "db"
              ? language.getFullDatabaseConsent.replace("{}", pluginName)
              : permissionDesc === "mainDom"
                ? language.mainDomAccessConsent.replace("{}", pluginName)
                : permissionDesc === "replacer"
                  ? language.replacerPermissionConsent.replace("{}", pluginName)
                  : permissionDesc === "provider"
                    ? language.providerPermissionConsent.replace("{}", pluginName)
                    : permissionDesc === "sendChat"
                      ? language.sendChatConsent.replace("{}", pluginName)
                      : permissionDesc === "inlay"
                        ? language.inlayPermissionConsent.replace("{}", pluginName)
                        : `Error`;
    if (alertTitle === "Error") {
        return false;
    }
    const conf = await alertConfirm(alertTitle);
    if (conf) {
        permissionAnswers.set(answerKey, true);
        try {
            await recordPermissionGrants({
                grants: [pluginHash],
                lastGrantTime: reconfirm === "periodically" ? { [lastGrantTimeKey]: Date.now() } : undefined,
            });
        } catch (error) {
            // The grant still holds for this page load; it is asked again after a reload.
            console.error(`[RisuAI Plugin: ${pluginName}] Could not save the permission grant:`, error);
        }
        return true;
    }
    permissionAnswers.set(answerKey, false);
    return false;
};

const urlBlacklist = ["risuai.xyz", "risuai.net", "sionyw.com"];

const authorizationHeaders = ["x-api-key", "authorization", "proxy-authorization"];

/**
 * The character and chat a hook's context names, found by id as they are now. Throws
 * `PluginTargetGoneError` when either was deleted: the call is refused, never redirected.
 */
function contextTarget(context: PluginCallContext) {
    const member = contextMember(context);
    const chat = findChat(context.chatRef);
    if (!chat) {
        // A listed chat that is not loaded: the caller loads it first (`ensureChatLoaded`).
        throw new Error("The chat this plugin hook runs for is not loaded");
    }
    return { ...member, chat };
}

/**
 * The hook's character and chat by membership (the chat may be unloaded): refused with
 * `PluginTargetGoneError` when either is gone. For checks before a load and for index reads.
 */
function contextMember(context: PluginCallContext) {
    const characters = characterList();
    const characterIndex = characters.findIndex((entry) => entry?.chaId === context.chatRef.chaId);
    const character = characters[characterIndex];
    if (!character) {
        throw new PluginTargetGoneError("character");
    }
    const chatIndex = chatList(character.chaId).findIndex((entry) => entry.id === context.chatRef.chatId);
    if (chatIndex === -1 || (context.owner !== undefined && chatOwnerToken(character.chaId) !== context.owner)) {
        // Gone, or replaced (its character's chats installed again) since the hook began.
        throw new PluginTargetGoneError("chat");
    }
    return { characterIndex, character, chatIndex };
}

/**
 * Runs `run` (synchronous) once the chats of `chaIds` are loaded, with them pinned from before the
 * load until it returns. A character can gain a chat (not loaded) while another one loads, so every
 * target is checked again right before `run`, and loaded again (a few rounds) when it is incomplete.
 * The targets are captured by id before the load and found again inside `run`.
 */
async function withChatsLoaded<T>(chaIds: readonly (string | undefined)[], run: () => T): Promise<T> {
    const ids = [...new Set(chaIds.filter((chaId): chaId is string => typeof chaId === "string"))];
    const owners = new Map(ids.map((chaId) => [chaId, chatOwnerToken(chaId)]));
    const releases = ids.map((chaId) => pinChats(chaId));
    try {
        for (let round = 0; ; round++) {
            const missing = ids.filter((chaId) => !chatsLoaded(chaId));
            if (missing.length === 0) {
                break;
            }
            if (round === 3) {
                throw new Error("The chats could not be loaded");
            }
            for (const chaId of missing) {
                await loadChats(chaId);
            }
        }
        // A character whose chats were replaced meanwhile (a re-import under the same id) is another
        // owner: nothing is read or applied for it. A deleted one is left to `run` (it is gone).
        for (const [chaId, owner] of owners) {
            if (chatOwnerToken(chaId) !== owner && characterList().some((entry) => entry?.chaId === chaId)) {
                throw new PluginTargetGoneError("character");
            }
        }
        return run();
    } finally {
        for (const release of releases) {
            release();
        }
    }
}

/**
 * The hook's character with a context, else the selected one: a detached copy in the legacy shape,
 * with its chats (`withChatsCopy`). A hook's character reports the hook's chat as its `chatPage`, so
 * `chats[chatPage]` is the chat the hook runs for.
 */
const getChar = async (context: PluginCallContext | undefined) => {
    const chaId = context ? context.chatRef.chaId : selectedCharacter()?.chaId;
    if (chaId === undefined) {
        return undefined;
    }
    return withChatsLoaded([chaId], () => {
        if (context) {
            const { character } = contextTarget(context);
            return withChatsCopy($state.snapshot(character), context.chatRef.chatId);
        }
        const snapshot = characterSnapshot(chaId);
        return snapshot === undefined ? undefined : withChatsCopy(snapshot);
    });
};

/**
 * Applies a character to the hook's character with a context, else to the selected one (the one
 * selected when the call came; its chats are loaded first). Inside a hook, a `chatPage` naming the
 * hook's chat is what `getChar` reported, not a change of the user's chat selection, so it is not
 * applied.
 */
const setChar = async (context: PluginCallContext | undefined, char: any) => {
    const chaId = context ? context.chatRef.chaId : selectedCharacter()?.chaId;
    if (context) {
        // Before the load: a `chatPage` naming the hook's chat (as `getChar` reported it then) is not
        // a selection change, whatever the order is after the load.
        const { chatIndex } = contextMember(context);
        if (char && typeof char === "object" && char.chatPage === chatIndex) {
            const { chatPage: _reported, ...rest } = char;
            char = rest;
        }
    }
    await withChatsLoaded([chaId], () => {
        if (!context) {
            applyPluginCharacter(
                chaId === undefined ? -1 : characterList().findIndex((entry) => entry?.chaId === chaId),
                char,
            );
            return;
        }
        applyPluginCharacter(contextTarget(context).characterIndex, char);
    });
};

/** Runs a plugin write; a refused value (`MutationValidationError`) is warned about and changes nothing. */
function warnRefused(what: string, write: () => void) {
    try {
        write();
    } catch (error) {
        if (!(error instanceof MutationValidationError)) {
            throw error;
        }
        console.warn(`[Plugin] Refused ${what}; the previous value was kept: ${error.message}`);
    }
}

/**
 * Applies a whole character a plugin hands back (last writer wins). The same `chaId` as the
 * character at `index`: its own fields replace the character's (`replaceCharacterFields`), and its
 * chats are reconciled by id through the chat module (changed chats diffed, new ones created,
 * missing ones deleted, the order and a given `chatPage` followed). Another `chaId` (or none):
 * the character replaces the one at the index (`replaceCharacterAt`), unless that one is generating
 * a reply or the `chaId` is already another character's. A refusal is warned about.
 */
function applyPluginCharacter(index: number, char: any) {
    warnRefused("a character", () => {
        const current = characterList()[index];
        if (!current || !char || typeof char !== "object" || char.chaId !== current.chaId) {
            // The two ordinary skips keep the warnings plugins have seen.
            if (current && isCharacterGenerating(current.chaId)) {
                console.warn("[Plugin] Kept a character that is generating a reply; the replacement was skipped");
                return;
            }
            const chaId = char && typeof char === "object" ? char.chaId : undefined;
            if (
                typeof chaId === "string" &&
                characterList().some((other, i) => i !== index && other?.chaId === chaId)
            ) {
                console.warn("[Plugin] Skipped a character whose chaId another character already has");
                return;
            }
            replaceCharacterAt(index, char);
            return;
        }
        // Turning memory on counts, as the sidebar toggle's (`supaMemoryOnCount`): it voids every
        // chat's "don't ask again" answer to the no-memory trim question. The stored count is kept
        // otherwise: the plugin's copy (stale, missing, or changed) never replaces it.
        const { supaMemoryOnCount: _theirs, ...fields } = char;
        if (fields.supaMemory && !current.supaMemory) {
            fields.supaMemoryOnCount = supaMemoryOnCount(current) + 1;
        } else if (current.supaMemoryOnCount !== undefined) {
            fields.supaMemoryOnCount = current.supaMemoryOnCount;
        }
        replaceCharacterFields(fields);
        const { chats, chatPage } = char;
        if (Array.isArray(chats)) {
            reconcileCharacterChats(current.chaId, chats, typeof chatPage === "number" ? chatPage : undefined);
        } else if (typeof chatPage === "number") {
            selectChat(current.chaId, chatPage);
        }
    });
}

/**
 * Applies a whole character list a plugin hands back. The list is checked first and refused as a
 * whole (nothing changes) when an entry is malformed, or when two entries share a `chaId` or are one
 * object (they would become two characters sharing one set of chats). Then characters matched by
 * `chaId` go through `applyPluginCharacter`, new ones are appended (prepared by `prepareNewCharacter`
 * before the list changes, their chats saved with them), and missing ones removed
 * (`removeCharacter`), except a character that is generating a reply: it stays (with a console
 * warning). The mirror keeps its order.
 */
function applyPluginCharacters(incoming: unknown, vanished: ReadonlySet<string> = new Set()) {
    requireArray("characters", incoming);
    const checked = Array.from(incoming, (char, i) => {
        checkCharacterInput(char, `characters[${i}]`);
        return char;
    });
    const checkedIds = checked
        .map((char) => char.chaId)
        .filter((id): id is string => typeof id === "string" && id !== "");
    if (new Set(checkedIds).size !== checkedIds.length || new Set(checked).size !== checked.length) {
        throw new MutationValidationError("characters", "duplicate chaId values (or one object listed twice)");
    }
    // The whole list is checked first; then an entry whose existing character was deleted while its
    // chats loaded (`vanished`, captured before the load) is skipped, never turned into a creation.
    if ([...vanished].some((chaId) => checkedIds.includes(chaId))) {
        console.warn("[Plugin] Skipped characters that were deleted while their chats loaded");
    }
    const entries = checked.filter((char) => !(typeof char.chaId === "string" && vanished.has(char.chaId)));
    const ids = checkedIds.filter((chaId) => !vanished.has(chaId));
    const kept = new Set(ids);
    const existing = characterList().map((character) => character?.chaId);
    // Every new character is prepared (checked, normalized, its creation steps done) before the list
    // changes, so an entry refused there leaves the whole list unapplied.
    const prepared = new Map(
        entries.flatMap((char, i) =>
            typeof char.chaId === "string" && existing.includes(char.chaId)
                ? []
                : [[char, prepareNewCharacter(char, `characters[${i}]`)] as const],
        ),
    );
    for (const char of entries) {
        const ready = prepared.get(char);
        if (ready) {
            addPreparedCharacter(ready);
        } else {
            applyPluginCharacter(
                characterList().findIndex((entry) => entry?.chaId === char.chaId),
                char,
            );
        }
    }
    for (const chaId of existing) {
        if (typeof chaId !== "string" || kept.has(chaId)) {
            continue;
        }
        if (isCharacterGenerating(chaId)) {
            console.warn("[Plugin] Kept a character that is generating a reply; its removal was skipped");
            continue;
        }
        removeCharacter(chaId);
    }
}

const getArg = (arg: string) => {
    const [name, realArg] = arg.split("::");
    for (const plugin of settings.plugins) {
        if (plugin.name === name) {
            return plugin.realArg[realArg];
        }
    }
};

const setArg = (arg: string, value: string | number) => {
    const [name, realArg] = arg.split("::");
    warnRefused(`the argument ${arg}`, () => setPluginArgument(name, realArg, value));
};

const addRisuScriptHandler = (name: ScriptMode, func: EditFunction) => {
    if (pluginHooks["edit" + name]) {
        pluginHooks["edit" + name].add(func);
    } else {
        throw `script handler named ${name} not found`;
    }
};

const removeRisuScriptHandler = (name: ScriptMode, func: EditFunction) => {
    if (pluginHooks["edit" + name]) {
        pluginHooks["edit" + name].delete(func);
    } else {
        throw `script handler named ${name} not found`;
    }
};

const addRisuReplacer = (name: string, func: ReplacerFunction) => {
    if (pluginHooks["replacer" + name]) {
        pluginHooks["replacer" + name].add(func);
    } else {
        throw `replacer handler named ${name} not found`;
    }
};

const removeRisuReplacer = (name: string, func: ReplacerFunction) => {
    if (pluginHooks["replacer" + name]) {
        pluginHooks["replacer" + name].delete(func);
    } else {
        throw `replacer handler named ${name} not found`;
    }
};

const addRisuChatListener = (mode: string, func: ChatOutputListener) => {
    if (mode === "output") {
        pluginHooks.chatOutput.add(func);
    } else {
        throw `chat listener mode ${mode} not found`;
    }
};

const removeRisuChatListener = (mode: string, func: ChatOutputListener) => {
    if (mode === "output") {
        pluginHooks.chatOutput.delete(func);
    } else {
        throw `chat listener mode ${mode} not found`;
    }
};

/** Keys applied after the others, in this order, because they refer to what the others set. */
const lateKeys = ["characterOrder", "selectedPersona"];

/**
 * The keys of a plugin's database object in the order they are applied, whatever the object's key
 * order: `characterOrder` after `characters` (each added or removed character repairs the order, which
 * would drop the ids of characters the same call adds later), and `selectedPersona` last, so its index
 * is resolved against the persona list the same call sets (it selects on this client only).
 */
function pluginKeyOrder(newDb: Record<string, unknown>): string[] {
    const keys = Object.keys(newDb).filter((key) => !lateKeys.includes(key));
    return [...keys, ...lateKeys.filter((key) => Object.hasOwn(newDb, key))];
}

/** Selects the persona at an index of the persona list, on this client only. */
function selectPersonaAt(index: unknown) {
    const persona = typeof index === "number" ? settings.personas?.[index] : undefined;
    if (typeof persona?.id !== "string") {
        throw new MutationValidationError("selectedPersona", "no persona at this index");
    }
    selectPersona(persona.id);
}

/**
 * Applies one key of a plugin's database object through the mutation that owns it: the collections
 * (`characters`, `personas`, `modules`, `enabledModules`, `characterOrder`, `plugins`,
 * `pluginCustomStorage`), the persona selection, the settings keys of `allowedDbKeys` (a section
 * field, or a forwarded preset/profile root), and any other key into the top level of
 * `pluginCustomStorage`. Only the full setter passes `plugins`: the plugins the user confirmed,
 * added or updated by name.
 */
function applyPluginKey(
    key: string,
    value: unknown,
    context: PluginCallContext | undefined,
    vanished: ReadonlySet<string> = new Set(),
) {
    switch (key) {
        case "characters":
            return applyPluginCharacters(value, vanished);
        case "personas":
            return setPersonas(value);
        case "modules":
            return setModules(value);
        case "enabledModules":
            return setEnabledModules(value);
        case "characterOrder":
            return setCharacterOrder(value);
        case "plugins":
            for (const plugin of value as RisuPlugin[]) {
                upsertPlugin(plugin);
            }
            return;
        case "pluginCustomStorage":
            return replacePluginCustomStorage(value);
        case "selectedPersona":
            return selectPersonaAt(value);
    }
    if (allowedDbKeys.includes(key)) {
        // Validation stays in the mutation module; model roots then use `writeModelRoot` with this
        // captured scope, including its unchanged-value check before matching profiles.
        updateSettings({ [key]: value }, { presetId: context?.presetId, modelPresetId: context?.modelPresetId });
    } else {
        setPluginCustomValue(key, value);
    }
}

/**
 * Both database setters: the lite setter has already dropped `plugins`, and the full setter has
 * confirmed the plugins to install. Each key is applied on its own, so a refused value (warned
 * about) keeps that key's previous value and the other keys still apply. A preset that is gone
 * (`MutationTargetGoneError`) and unexpected errors reach the plugin. Inside a hook (`context`), a
 * forwarded preset key goes to the hook's preset; when that preset is gone, nothing is applied
 * (`PluginTargetGoneError`).
 */
function applyPluginDatabase(
    newDb: Record<string, unknown>,
    context: PluginCallContext | undefined,
    vanished: ReadonlySet<string> = new Set(),
) {
    if (context) {
        const missing = missingPresetTarget(
            context,
            Object.keys(newDb).filter((key) => allowedDbKeys.includes(key) && isForwardedPresetRoot(key)),
        );
        if (missing !== undefined) {
            throw new PluginTargetGoneError(missing);
        }
    }
    // One queued write per settings record the call changed (`records.svelte.ts`).
    batchRecordWrites(() => {
        for (const key of pluginKeyOrder(newDb)) {
            warnRefused(`the database key ${key}`, () => applyPluginKey(key, newDb[key], context, vanished));
        }
    });
}

/** The existing characters whose chats a plugin's `characters` reconciles (loaded first). */
function charactersReconciled(newDb: Record<string, unknown>): string[] {
    const incoming = newDb && typeof newDb === "object" ? newDb.characters : undefined;
    if (!Array.isArray(incoming)) {
        return [];
    }
    const existing = new Set(characterList().map((character) => character?.chaId));
    return incoming
        .map((char) => (char && typeof char === "object" ? (char as { chaId?: unknown }).chaId : undefined))
        .filter((chaId): chaId is string => typeof chaId === "string" && existing.has(chaId));
}

/** Which of `targets` (existing characters captured before the load) left the list during it. */
function vanishedOf(targets: readonly string[]): Set<string> {
    const present = new Set(characterList().map((character) => character?.chaId));
    return new Set(targets.filter((chaId) => !present.has(chaId)));
}

//Keys outside allowedDbKeys are stored at the top level of db.pluginCustomStorage
const setPluginDatabaseLite = async (newDb: any, context: PluginCallContext | undefined) => {
    if (newDb && typeof newDb === "object" && Object.hasOwn(newDb, "plugins")) {
        newDb = { ...newDb };
        delete newDb.plugins;
    }
    const targets = charactersReconciled(newDb);
    await withChatsLoaded(targets, () => applyPluginDatabase(newDb, context, vanishedOf(targets)));
};

const setPluginDatabase = async (newDb: any, context: PluginCallContext | undefined) => {
    if (Object.hasOwn(newDb, "plugins")) {
        console.warn(
            "[WARN] Plugin attempted to access plugin directly. this would be blocked in future versions. Instead, use the provided APIs to manage plugins. Attempting to handle plugin installation via plugin for new plugins in the provided database object.",
        );
        let plugins: RisuPlugin[] = [];
        warnRefused("the database key plugins", () => {
            requireArray("plugins", newDb.plugins);
            plugins = Array.from(newDb.plugins, (plugin, i) => {
                checkPluginInput(plugin, `plugins[${i}]`);
                return plugin as unknown as RisuPlugin;
            });
        });
        // Only the plugins the user confirms are installed; the installed ones stay.
        newDb = { ...newDb, plugins: await handlePluginInstallViaPlugin(plugins) };
    }
    // After the chats load, no await: a forwarded preset field lands in the hook's preset, else in the one selected now.
    const targets = charactersReconciled(newDb);
    await withChatsLoaded(targets, () => applyPluginDatabase(newDb, context, vanishedOf(targets)));
};

const readAssetImage = (path: string) => {
    if (path.startsWith("assets/")) {
        //trim assets/ prefix temporarily
        path = path.slice(7);
    }
    if (path.includes("/") || path.includes("\\")) {
        throw new Error("readImage path cannot contain '/' or '\\' for security reasons, except assets/ prefix.");
    }
    //re-add assets/ prefix
    return readImage("assets/" + path);
};

const makeRisuaiAPIV3 = (iframe: HTMLIFrameElement, plugin: RisuPlugin) => {
    const safeLocalStorage = new SafeLocalStorage();
    // Captured now: a plugin with database access could rewrite its own script in the database.
    const identity: PluginIdentity = { name: plugin.name, script: plugin.script };
    // The hooks this plugin registers, wrapped to take their call context (`pluginContext.ts`): a runner
    // hands it over synchronously, and it stays on this plugin's stack until the hook settles. Keyed
    // by the registered function, so a removal finds the wrapper it registered.
    const hookWrappers = new WeakMap<Function, Function>();
    // The owner of this instance's context stack: a reloaded instance of the plugin gets its own.
    const contextOwner = {};
    const withContext = <F extends Function>(hook: F): F => {
        const cached = hookWrappers.get(hook);
        if (cached) {
            return cached as unknown as F;
        }
        const wrapped = (...args: unknown[]) =>
            trackHostHook(() => {
                const context = takeHandoff();
                if (!context) {
                    return hook(...args);
                }
                const exit = enterContext(contextOwner, context);
                try {
                    return Promise.resolve(hook(...args)).finally(exit);
                } catch (error) {
                    exit();
                    throw error;
                }
            });
        hookWrappers.set(hook, wrapped);
        return wrapped as unknown as F;
    };
    const registered = <F extends Function>(hook: F): F => (hookWrappers.get(hook) as unknown as F) ?? hook;
    return {
        //Older API names, kept for compatibility
        risuFetch: (url, options) => {
            console.error(
                `[DEPRECATION WARNING] risuFetch is deprecated and will be removed in future versions. Please use nativeFetch instead.`,
            );
            for (const blocked of urlBlacklist) {
                if (url.toLowerCase().includes(blocked)) {
                    throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
                }
            }

            //scan headers
            const headers = options?.headers || {};
            for (const headerName in headers) {
                if (authorizationHeaders.includes(headerName.toLowerCase())) {
                    console.warn(
                        `Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to only work with nativeFetch.`,
                    );
                }
            }
            return globalFetch(url, options);
        },
        nativeFetch: async (url: string, options: RequestInit = {}) => {
            for (const blocked of urlBlacklist) {
                if (url.toLowerCase().includes(blocked)) {
                    throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
                }
            }

            // Normalize both sandbox-supported forms before scanning or logging their names.
            const normalizedHeaders = new Headers(options.headers ?? {});
            let method = options.method ?? "GET";
            const upperMethod = method.toUpperCase();
            if (["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(upperMethod)) {
                method = upperMethod;
            }
            if ((method === "GET" || method === "HEAD") && options.body != null) {
                throw new TypeError(`Request with ${method} method cannot have a body`);
            }
            let body: string | Uint8Array | ArrayBuffer | undefined;
            if (options.body == null) {
                body = undefined;
            } else if (typeof options.body === "string") {
                body = options.body;
                if (!normalizedHeaders.has("Content-Type")) {
                    normalizedHeaders.set("Content-Type", "text/plain;charset=UTF-8");
                }
            } else if (options.body instanceof ArrayBuffer) {
                body = options.body;
            } else if (ArrayBuffer.isView(options.body)) {
                body = new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength);
            } else if (options.body instanceof Blob) {
                body = new Uint8Array(await options.body.arrayBuffer());
                if (options.body.type && !normalizedHeaders.has("Content-Type")) {
                    normalizedHeaders.set("Content-Type", options.body.type);
                }
            } else {
                throw new TypeError(`Unsupported nativeFetch body: ${Object.prototype.toString.call(options.body)}`);
            }
            const headers = Object.fromEntries(normalizedHeaders.entries());
            for (const headerName in headers) {
                if (authorizationHeaders.includes(headerName.toLowerCase())) {
                    console.warn(
                        `Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to use server-side approch with write-only api access in the future for better security.`,
                    );
                }
            }
            // RequestInit is public; internal routing, logging and interceptor options are not.
            return fetchNative(url, { method, headers, body, signal: options.signal });
        },
        getChar: () => getChar(currentContext(contextOwner)),
        setChar: (char: any) => setChar(currentContext(contextOwner), char),
        addProvider: (
            name: string,
            func: (
                arg: PluginProviderArgument,
                abortSignal?: AbortSignal,
            ) => Promise<{ success: boolean; content: string | ReadableStream<string> }>,
            options?: PluginV3ProviderOptions,
        ) => {
            console.warn(
                `[WARN] addProvider is a powerful API that can potentially be unsafe if used incorrectly. addProvider's functionality might be limited or changed in future updates to ensure security. please use other APIs if possible.`,
            );
            const provs = get(customProviderStore);
            (pluginHooks.providers.set(name, async (arg, abortSignal) => {
                // The request's call context is taken before the first await (the permission prompt).
                const context = takeHandoff();
                const exit = context ? enterContext(contextOwner, context) : undefined;
                // Plugin work from here, the permission prompt included (no guest callback is pending yet).
                runningHostHooks++;
                try {
                    const conf = await getPluginPermission(identity, "provider", "periodically");
                    if (!conf) {
                        return {
                            success: false,
                            content: language.pluginProviderPermissionDenied.replace("{}", identity.name),
                        };
                    }
                    if (abortSignal?.aborted) {
                        return { success: false, content: language.pluginProviderRequestAborted };
                    }
                    //mode is overridden to v3, due to vulnerabilities using mode.
                    //Alternative to mode will be added in future
                    arg.mode = "v3";
                    return await func(arg, abortSignal);
                } finally {
                    exit?.();
                    hostHookSettled();
                }
            }),
                pluginHooks.providerOptions.set(name, options ?? {}));
            if (!provs.includes(name)) {
                customProviderStore.set([...provs, name]);
            }

            const modelData: LLMModel = {
                id: `pluginmodel:::${name}`,
                name: options?.model?.name ?? name,
                shortName: options?.model?.shortName ?? name,
                fullName: options?.model?.fullName ?? name,
                internalID: options?.model?.internalID ?? `pluginmodel:::${name}`,
                provider: LLMProvider.AsIs,
                format: LLMFormat.Plugin,
                flags: options?.model?.flags ?? [LLMFlags.hasFullSystemPrompt],
                parameters: options?.model?.parameters ?? [
                    "temperature",
                    "top_p",
                    "frequency_penalty",
                    "presence_penalty",
                    "repetition_penalty",
                    "min_p",
                    "top_a",
                    "top_k",
                    "thinking_tokens",
                ],
                tokenizer: options?.model?.tokenizer ?? LLMTokenizer.Unknown,
            };
            const modelIndex = customV3ProviderMetaStore.findIndex((model) => model.id === modelData.id);
            if (modelIndex === -1) {
                customV3ProviderMetaStore.push(modelData);
            } else {
                customV3ProviderMetaStore[modelIndex] = modelData;
            }
        },
        addTTSPreprocessor: async (func: TTSHookFn<BeforeTTSContext, BeforeTTSResult>) => {
            registerTTSPreprocessor(func);
            addPluginUnloadCallback(plugin.name, () => unregisterTTSPreprocessor(func));
        },
        addTTSPostprocessor: async (func: TTSHookFn<AfterTTSContext, AfterTTSResult>) => {
            registerTTSPostprocessor(func);
            addPluginUnloadCallback(plugin.name, () => unregisterTTSPostprocessor(func));
        },
        addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            const handler = withContext(func);
            addRisuScriptHandler(name, handler);
            addPluginUnloadCallback(plugin.name, () => pluginHooks["edit" + name]?.delete(handler));
        },
        removeRisuScriptHandler: (name: ScriptMode, func: EditFunction) =>
            removeRisuScriptHandler(name, registered(func)),
        addRisuReplacer: async (name: string, func: Function) => {
            //permission check for replacer
            const conf = await getPluginPermission(identity, "replacer", "periodically");
            if (!conf) {
                return;
            }
            // Removed when the plugin unloads: the registry is not reset on reload, and a replacer of an
            // unloaded plugin would call into its terminated sandbox.
            const replacer = withContext(func) as any;
            addRisuReplacer(name, replacer);
            addPluginUnloadCallback(plugin.name, () => pluginHooks["replacer" + name]?.delete(replacer));
        },
        removeRisuReplacer: (name: string, func: ReplacerFunction) => removeRisuReplacer(name, registered(func)),
        addRisuChatListener: async (mode: "output", func: Function) => {
            //permission check, lets use same as replacer
            const conf = await getPluginPermission(identity, "replacer", "periodically");
            if (!conf) {
                return;
            }
            const listener = withContext(func) as any;
            addRisuChatListener(mode, listener);
            addPluginUnloadCallback(plugin.name, () => removeRisuChatListener(mode, listener));
        },
        removeRisuChatListener: (mode: string, func: ChatOutputListener) =>
            removeRisuChatListener(mode, registered(func)),
        setDatabaseLite: (newDb: any) => setPluginDatabaseLite(newDb, currentContext(contextOwner)),
        setDatabase: (newDb: any) => setPluginDatabase(newDb, currentContext(contextOwner)),
        loadPlugins: loadPlugins,
        readImage: readAssetImage,
        readInlay: async (id: string) => {
            const conf = await getPluginPermission(identity, "inlay", "periodically");
            if (!conf) {
                return null;
            }
            return await getInlayAsset(id);
        },
        saveAsset: (data: Uint8Array) => {
            return saveAsset(data);
        },
        //Same functionality, but new implementation
        getDatabase: async (includeOnly: string[] | "all" = "all") => {
            const context = currentContext(contextOwner);
            const conf = await getPluginPermission(identity, "db", "periodically");
            if (!conf) {
                return null;
            }
            const included = (key: string) => includeOnly === "all" || includeOnly.includes(key);
            // The characters' chats are loaded (and pinned) first; then every key is read in one
            // synchronous pass, so the snapshot is one state of the tab.
            const characterIds = included("characters") ? characterList().map((character) => character?.chaId) : [];
            const keys = allowedDbKeys.filter(included);
            const liteDB = await withChatsLoaded(characterIds, () => {
                // Inside a hook, the forwarded preset keys come from the hook's preset (refused when it
                // is gone), so a read-modify-write through setDatabase stays in one preset.
                const missing = context ? missingPresetTarget(context, keys) : undefined;
                if (missing !== undefined) {
                    throw new PluginTargetGoneError(missing);
                }
                return buildDatabaseSubset(keys, context ?? null);
            });
            return liteDB;
        },

        installPlugin: handlePluginInstallViaPlugin,

        // --- Color Scheme APIs ---
        changeColorScheme: (name: string) => {
            changeColorScheme(name);
        },
        setColorScheme: (scheme: ColorScheme) => {
            const requiredKeys = [
                "bgcolor",
                "darkbg",
                "borderc",
                "selected",
                "draculared",
                "textcolor",
                "textcolor2",
                "darkBorderc",
                "darkbutton",
                "type",
            ] as const;
            for (const key of requiredKeys) {
                if (typeof (scheme as any)[key] !== "string") {
                    throw new Error(`Invalid color scheme: missing or invalid '${key}'`);
                }
            }
            if (scheme.type !== "light" && scheme.type !== "dark") {
                throw new Error('Invalid color scheme type: must be "light" or "dark"');
            }
            updateSettings({ colorSchemeName: "custom", customColorScheme: scheme, colorScheme: scheme });
            updateColorScheme();
        },
        getColorScheme: () => {
            return {
                name: settings.ui.colorSchemeName,
                scheme: $state.snapshot(settings.ui.colorScheme),
            };
        },

        // --- Text Theme APIs ---
        changeTextTheme: (name: string) => {
            if (!["standard", "highcontrast"].includes(name)) {
                throw new Error(`Invalid text theme: ${name}`);
            }
            updateSettings({ textTheme: name });
            updateTextThemeAndCSS();
        },
        setCustomTextTheme: (theme: {
            FontColorStandard: string;
            FontColorBold: string;
            FontColorItalic: string;
            FontColorItalicBold: string;
            FontColorQuote1: string;
            FontColorQuote2: string;
        }) => {
            const requiredKeys = [
                "FontColorStandard",
                "FontColorBold",
                "FontColorItalic",
                "FontColorItalicBold",
                "FontColorQuote1",
                "FontColorQuote2",
            ] as const;
            for (const key of requiredKeys) {
                if (typeof (theme as any)[key] !== "string") {
                    throw new Error(`Invalid text theme: missing or invalid '${key}'`);
                }
            }
            updateSettings({ textTheme: "custom", customTextTheme: theme });
            updateTextThemeAndCSS();
        },
        getTextTheme: () => {
            return {
                name: settings.ui.textTheme,
                customTheme: $state.snapshot(settings.ui.customTextTheme),
            };
        },

        //Deprecated APIs
        //Use getArgument / setArgument instead if possible
        getArg: getArg,
        setArg: setArg,

        //New APIs for v3
        getArgument: async (key: string) => {
            for (const p of settings.plugins) {
                if (p.name === plugin.name) {
                    return p.realArg[key];
                }
            }
        },
        setArgument: async (key: string, value: string) => {
            warnRefused(`the argument ${key}`, () => setPluginArgument(plugin.name, key, value));
        },
        // The plugin index APIs address the character list by position (creation order).
        getCharacterFromIndex: async (index: number) => {
            const chaId = characterList()[index]?.chaId;
            if (chaId === undefined) {
                return null;
            }
            return withChatsLoaded([chaId], () => {
                const snapshot = characterSnapshot(chaId);
                return snapshot === undefined ? null : withChatsCopy(snapshot);
            });
        },
        setCharacterToIndex: async (index: number, char: any) => {
            // The character at the index when the call came, found again by id after its chats load.
            const chaId = characterList()[index]?.chaId;
            if (chaId === undefined) {
                return;
            }
            await withChatsLoaded([chaId], () => {
                const at = characterList().findIndex((entry) => entry?.chaId === chaId);
                if (at !== -1) {
                    applyPluginCharacter(at, char);
                }
            });
        },
        getChatFromIndex: async (characterIndex: number, chatIndex: number) => {
            const chaId = characterList()[characterIndex]?.chaId;
            const chatId = chaId === undefined ? undefined : chatList(chaId)[chatIndex]?.id;
            if (chaId === undefined || chatId === undefined) {
                return null;
            }
            const ref = { chaId, chatId };
            await ensureChatLoaded(ref);
            // Found again after the load: the chat as it is now (none when it was deleted meanwhile).
            const chat = findChat(ref);
            return chat ? $state.snapshot(chat) : null;
        },
        parseRisuChat: async (
            text: string,
            options?: {
                messageIndex?: number;
                role?: string;
                processRegex?: boolean;
                runVar?: boolean;
                rmVar?: boolean;
                tokenizeAccurate?: boolean;
                cbsConditions?: CbsConditions;
            },
        ) => {
            const context = currentContext(contextOwner);
            // The hook's chat (refused at once when it is gone), else the one selected when the call
            // came, loaded first; the target is found again after the load.
            if (context) {
                contextMember(context);
            }
            const ref = context ? context.chatRef : currentChatRef();
            if (ref) {
                // The same chat after the load: deleted or replaced meanwhile (even under the same
                // ids) refuses the call.
                const owner = chatOwnerToken(ref.chaId);
                if (!(await ensureChatLoaded(ref)) || chatOwnerToken(ref.chaId) !== owner) {
                    throw new PluginTargetGoneError("chat");
                }
            }
            const target = context ? contextTarget(context) : undefined;
            const char = target
                ? target.character
                : ref
                  ? characterList().find((entry) => entry?.chaId === ref.chaId)
                  : selectedCharacter();
            if (!char) {
                throw new Error("No character selected");
            }
            const chat = target ? target.chat : ref ? findChat(ref) : undefined;
            if (!chat) {
                throw new Error("No active chat found");
            }
            const chatID = options?.messageIndex ?? -1;
            if (!Number.isInteger(chatID) || chatID < -1 || chatID >= chat.message.length) {
                throw new Error(`Invalid messageIndex: ${chatID}`);
            }
            const role = options?.role;
            const cbsConditions: CbsConditions = {
                ...(role ? { chatRole: role } : {}),
                ...(options?.cbsConditions ?? {}),
            };
            // The captured chat throughout (the hook's, else the one selected when the call came), so a
            // selection change during the load does not redirect the parse.
            const chatRef = context ? context.chatRef : { chaId: char.chaId, chatId: chat.id };
            const parseArg = {
                chara: char,
                chatRef,
                chatID,
                role,
                runVar: options?.runVar,
                rmVar: options?.rmVar,
                tokenizeAccurate: options?.tokenizeAccurate,
                cbsConditions,
            };
            // Inside a hook, the hook's preset and persona, not the tab's selection.
            const parsed = context
                ? risuChatParserScoped(text ?? "", parseArg, {
                      presetId: context.presetId,
                      modelPresetId: context.modelPresetId,
                      personaId: context.personaId,
                  })
                : risuChatParser(text ?? "", parseArg);

            if (!options?.processRegex) {
                return parsed;
            }

            // The server transform, for the hook's chat, preset, and persona when inside one. Without a
            // context (no chat, a chat not saved on the server yet) the regex stage is skipped.
            const transform = captureTransform(chatID, {
                chatRef,
                pluginContext: context,
            });
            if (!transform) {
                return parsed;
            }
            return (await serverProcessScript(char, parsed, "editprocess", chatID, cbsConditions, transform, "message"))
                .data;
        },
        setChatToIndex: async (characterIndex: number, chatIndex: number, chat: any) => {
            // The chat at the indexes when the call came, by id, loaded first.
            const chaId = characterList()[characterIndex]?.chaId;
            const chatId = chaId === undefined ? undefined : chatList(chaId)[chatIndex]?.id;
            if (chaId === undefined || chatId === undefined || !chat || typeof chat !== "object") {
                return;
            }
            const ref = { chaId, chatId };
            if (!(await ensureChatLoaded(ref))) {
                return;
            }
            // Last writer wins: the plugin's chat is diffed against the chat as it is now.
            try {
                applyChatResult(captureChatBaseline(ref), { ...chat, id: chatId });
            } catch (error) {
                console.warn("[Plugin] Skipped a chat change (a message being generated, or a refused field)", error);
            }
        },
        getCurrentCharacterIndex: () => {
            const context = currentContext(contextOwner);
            return context ? contextMember(context).characterIndex : selectedIndex();
        },
        getCurrentChatIndex: () => {
            const context = currentContext(contextOwner);
            if (context) {
                return contextMember(context).chatIndex;
            }
            return selectedChatIndex(selectedCharacter().chaId);
        },
        getCurrentLorebookEntries: async () => {
            // The hook's chat, else the one selected when the call came, loaded first (its local lore
            // and its chat modules' lore are part of the result).
            const context = currentContext(contextOwner);
            if (context) {
                contextMember(context);
            }
            const ref = context ? context.chatRef : currentChatRef();
            if (!ref) {
                const char = selectedCharacter();
                return char ? $state.snapshot([...(char.globalLore ?? []), ...getModuleLorebooks()]) : [];
            }
            const owner = chatOwnerToken(ref.chaId);
            const release = pinChat(ref);
            try {
                if (!(await ensureChatLoaded(ref)) || chatOwnerToken(ref.chaId) !== owner) {
                    throw new PluginTargetGoneError("chat");
                }
                const { character, chat } = context
                    ? contextTarget(context)
                    : {
                          character: characterList().find((entry) => entry?.chaId === ref.chaId),
                          chat: findChat(ref),
                      };
                if (!character || !chat) {
                    throw new PluginTargetGoneError(character ? "chat" : "character");
                }
                return $state.snapshot([
                    ...(character.globalLore ?? []),
                    ...(chat.localLore ?? []),
                    ...getModuleLorebooks(ref),
                ]);
            } finally {
                release();
            }
        },
        //New names for character APIs, to match API naming conventions
        getCharacter: () => getChar(currentContext(contextOwner)),
        setCharacter: (char: any) => setChar(currentContext(contextOwner), char),

        showContainer: (
            //more types may be added in future
            type: "fullscreen" = "fullscreen",
        ) => {
            iframe.style.display = "block";

            switch (type) {
                case "fullscreen": {
                    //move iframe to body if not already there
                    if (iframe.parentElement !== document.body) {
                        document.body.appendChild(iframe);
                    }

                    //Make iframe cover whole screen
                    iframe.style.position = "fixed";
                    iframe.style.top = "0";
                    iframe.style.left = "0";
                    iframe.style.width = "100%";
                    iframe.style.height = "100%";
                    iframe.style.border = "none";
                    iframe.style.zIndex = "1000";
                    break;
                }
                default: {
                    return;
                }
            }
        },
        hideContainer: () => {
            iframe.style.display = "none";
        },
        getRootDocument: async () => {
            const conf = await getPluginPermission(identity, "mainDom");
            if (!conf) {
                return null;
            }
            return new SafeDocument(document);
        },
        registerSetting: (
            name: string,
            callback: any,
            icon: string = "",
            iconType: "html" | "img" | "none" = "none",
            id?: string,
        ) => {
            if (iconType !== "html" && iconType !== "img" && iconType !== "none") {
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if (typeof name !== "string" || name.trim() === "") {
                throw new Error("name must be a non-empty string");
            }
            const menuId = id || v4();
            const menuDef: MenuDef = {
                id: menuId,
                name,
                icon,
                iconType,
                callback,
            };
            const existingIndex = additionalSettingsMenu.findIndex((item) => item.id === menuId);
            if (existingIndex !== -1) {
                additionalSettingsMenu[existingIndex] = menuDef;
                addPluginUnloadCallback(plugin.name, makeMenuUnloadCallback(menuId, additionalSettingsMenu));
                return { id: menuId };
            }
            additionalSettingsMenu.push(menuDef);
            addPluginUnloadCallback(plugin.name, makeMenuUnloadCallback(menuId, additionalSettingsMenu));
            return { id: menuId };
        },
        registerBodyIntercepter: async (callback: (body: any, type: string) => any) => {
            if ((await getPluginPermission(identity, "replacer")) === false) {
                return null;
            }

            const id = v4();
            bodyIntercepterStore.push({
                id,
                callback,
            });
            addPluginUnloadCallback(plugin.name, () => {
                const index = bodyIntercepterStore.findIndex((item) => item.id === id);
                if (index !== -1) {
                    bodyIntercepterStore.splice(index, 1);
                }
            });
            return { id: id };
        },

        unregisterBodyIntercepter: (id: string) => {
            const index = bodyIntercepterStore.findIndex((item) => item.id === id);
            if (index !== -1) {
                bodyIntercepterStore.splice(index, 1);
            }
        },

        registerButton: (
            arg: {
                name: string;
                icon: string;
                iconType: "html" | "img" | "none";
                location?: "action" | "chat" | "hamburger";
                id?: string;
            },
            callback: () => void,
        ) => {
            let { name, icon, iconType, location, id: providedId } = arg;
            location = location || "action";
            if (iconType !== "html" && iconType !== "img" && iconType !== "none") {
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if (typeof name !== "string" || name.trim() === "") {
                throw new Error("name must be a non-empty string");
            }
            if (typeof icon !== "string") {
                throw new Error("icon must be a string");
            }
            const id = providedId || v4();
            const menuDef: MenuDef = {
                name,
                icon,
                iconType,
                callback,
                id,
            };

            const buttonStores = [additionalFloatingActionButtons, additionalHamburgerMenu, additionalChatMenu];
            for (const store of buttonStores) {
                const existingIndex = store.findIndex((item) => item.id === id);
                if (existingIndex !== -1) {
                    store[existingIndex] = menuDef;
                    addPluginUnloadCallback(plugin.name, makeMenuUnloadCallback(id, store));
                    return { id };
                }
            }

            switch (location) {
                case "action": {
                    additionalFloatingActionButtons.push(menuDef);
                    addPluginUnloadCallback(
                        plugin.name,
                        makeMenuUnloadCallback(menuDef.id, additionalFloatingActionButtons),
                    );
                    break;
                }
                case "hamburger": {
                    additionalHamburgerMenu.push(menuDef);
                    addPluginUnloadCallback(plugin.name, makeMenuUnloadCallback(menuDef.id, additionalHamburgerMenu));
                    break;
                }
                case "chat": {
                    additionalChatMenu.push(menuDef);
                    addPluginUnloadCallback(plugin.name, makeMenuUnloadCallback(menuDef.id, additionalChatMenu));
                    break;
                }
                default: {
                    throw new Error("Invalid location for button");
                }
            }
            return { id };
        },
        setChatPanel: (
            content: string | null,
            options: {
                id?: string;
                className?: string;
            } = {},
        ) => {
            const id = options.id || `${plugin.name}:default`;

            if (content === null || content === "") {
                removeChatPanel(id);
                return { id };
            }

            if (typeof content !== "string") {
                throw new Error("content must be a string or null");
            }

            const panel = {
                id,
                pluginName: plugin.name,
                html: DOMPurify.sanitize(content),
                className:
                    typeof options.className === "string"
                        ? DOMPurify.sanitize(options.className, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
                        : undefined,
            };

            const existingIndex = chatPanelStore.findIndex((item) => item.id === id);
            if (existingIndex !== -1) {
                chatPanelStore[existingIndex] = panel;
            } else {
                chatPanelStore.push(panel);
            }
            addPluginUnloadCallback(plugin.name, () => removePluginChatPanels(plugin.name));
            return { id };
        },
        registerMCP: (...[arg, getToolList, callTool]: Parameters<typeof registerMCPModule>) => {
            const client = registerMCPModule(arg, withContext(getToolList), withContext(callTool));
            addPluginUnloadCallback(plugin.name, () => {
                if (registeredCustomPluginMCPs.get(arg.identifier) === client) {
                    return unregisterMCPModule(arg.identifier);
                }
            });
        },
        unregisterMCP: unregisterMCPModule,
        unregisterUIPart: (id: string) => {
            const removeFromMenuStore = (menuStore: MenuDef[]) => {
                const index = menuStore.findIndex((item) => item.id === id);
                if (index !== -1) {
                    menuStore.splice(index, 1);
                }
            };

            removeFromMenuStore(additionalSettingsMenu);
            removeFromMenuStore(additionalFloatingActionButtons);
            removeFromMenuStore(additionalHamburgerMenu);
            removeFromMenuStore(additionalChatMenu);
            removeChatPanel(id);
        },
        log: (message: string) => {
            console.log(`[RisuAI Plugin: ${plugin.name}] ${message}`);
        },
        createMutationObserver(callback: SafeMutationCallback): SafeMutationObserver {
            const observer = new SafeMutationObserver(callback);
            addPluginUnloadCallback(plugin.name, () => {
                observer.disconnect();
            });
            return observer;
        },
        onUnload: (callback: () => void) => {
            addPluginUnloadCallback(plugin.name, callback);
        },
        //Storage writes resolve when queued; a conflict that discards unsaved ones (another tab or
        //device wrote the same key) is told to every listener, not to the write's promise
        onStorageDiscarded: (callback: (event: StorageDiscardedEvent) => unknown) => {
            const unsubscribe = onPluginStorageDiscarded((lost) => {
                const event: StorageDiscardedEvent = {
                    type: "storageDiscarded",
                    pluginStorage: lost.pluginStorage,
                    localPluginStorage: lost.localPluginStorage,
                    customStorage: lost.customStorage,
                };
                // Not awaited: the save adapter goes on; a sandbox that is gone rejects the call.
                Promise.resolve()
                    .then(() => callback(event))
                    .catch((error) => {
                        console.error(`[RisuAI Plugin: ${plugin.name}] storageDiscarded listener failed`, error);
                    });
            });
            addPluginUnloadCallback(plugin.name, unsubscribe);
        },
        getFetchLogs: async () => {
            const unsafeFetchLog = getFetchLogs();
            const conf = await getPluginPermission(identity, "fetchLogs");
            if (!conf) {
                return null;
            }
            return unsafeFetchLog.map((log) => {
                const url = new URL(log.url);
                return {
                    url: url.origin + url.pathname,
                    body: log.body,
                    status: log.status,
                    response: log.response,
                };
            });
        },

        alert: (msg: string) => {
            return alertNormal(msg);
        },
        alertConfirm: (msg: string) => {
            return alertConfirm(msg);
        },
        alertError: (msg: string) => {
            return alertError(msg);
        },
        getRuntimeInfo: () => {
            return {
                apiVersion: "3.0",
                platform: "node",
                saveMethod: "local",
            };
        },
        getLocalPluginStorage: () => {
            return new SafeLocalPluginStorage();
        },
        checkCharOrder: checkCharOrder,
        requestPluginPermission: (permission: string) => {
            return getPluginPermission(identity, permission as any);
        },
        //Internal use APIs
        _getPropertiesForInitialization: () => {
            const v = {
                apiVersion: "3.0",
                apiVersionCompatibleWith: ["3.0"],
            } as any;

            v.list = Object.keys(v);

            return v;
        },
        //v3 pluginStorage lives under its own key in db.pluginCustomStorage,
        //apart from the custom properties setDatabase/setDatabaseLite store at its top level
        _getPluginStorage: async (key: string) => {
            return getPluginStorageValue(String(key));
        },
        _setPluginStorage: async (key: string, value: any) => {
            //JSON round trip rejects values the save file cannot hold, e.g. BigInt
            const json = JSON.stringify(value);
            setPluginStorageItem(String(key), json === undefined ? null : JSON.parse(json));
        },
        _removePluginStorage: async (key: string) => {
            removePluginStorageItem(String(key));
        },
        _clearPluginStorage: async () => {
            clearPluginStorage();
        },
        _keyPluginStorage: async (index: number) => {
            return pluginStorageKeys()[index] ?? null;
        },
        _keysPluginStorage: async () => {
            return pluginStorageKeys();
        },
        _lengthPluginStorage: async () => {
            return pluginStorageKeys().length;
        },
        _getSafeLocalStorage: (key: string) => safeLocalStorage.getItem(key),
        _setSafeLocalStorage: (key: string, value: string) => safeLocalStorage.setItem(key, value),
        _removeSafeLocalStorage: (key: string) => safeLocalStorage.removeItem(key),
        _clearSafeLocalStorage: () => safeLocalStorage.clear(),
        _keySafeLocalStorage: (index: number) => safeLocalStorage.key(index),
        _keysSafeLocalStorage: () => safeLocalStorage.keys(),
        searchTranslationCache: async (partialKey: string) => {
            return searchLLMCache(partialKey);
        },
        getTranslationCache: async (key: string) => {
            return getLLMCache(key);
        },
        _getAliases: () => {
            return {
                pluginStorage: {
                    getItem: "_getPluginStorage",
                    setItem: "_setPluginStorage",
                    removeItem: "_removePluginStorage",
                    clear: "_clearPluginStorage",
                    key: "_keyPluginStorage",
                    keys: "_keysPluginStorage",
                    length: "_lengthPluginStorage",
                },
                safeLocalStorage: {
                    getItem: "_getSafeLocalStorage",
                    setItem: "_setSafeLocalStorage",
                    removeItem: "_removeSafeLocalStorage",
                    clear: "_clearSafeLocalStorage",
                    key: "_keySafeLocalStorage",
                    keys: "_keysSafeLocalStorage",
                },
            };
        },
        runLLMModel: async (options: {
            mode: ModelModeExtended;
            messages: OpenAIChat[];
            staticModel?: string;
            allowPlugins?: boolean;
        }) => {
            // Inside a hook, the request is for the hook's chat (refused when it is gone), and its plugin
            // hooks get the hook's context.
            const context = currentContext(contextOwner);
            if (context) {
                contextMember(context);
            }
            // The hook's chat stays loaded for the request (a plugin provider may read it), and the
            // request refuses it once it was replaced (its owner when the call came).
            const chatOwner = context ? chatOwnerToken(context.chatRef.chaId) : undefined;
            return withRequestChat(
                context?.chatRef ?? null,
                () =>
                    requestChatDataMain(
                        {
                            formated: options.messages,
                            bias: {},
                            staticModel: options.staticModel,
                            ...(context ? { chatRef: context.chatRef, pluginContext: context, chatOwner } : {}),

                            // Calls into plugin-provided models are blocked by default to
                            // guard against accidental IPC loops between provider plugins.
                            // Plugin authors who need to reach the user's plugin-supplied
                            // main or auxiliary model (e.g. a TTS preprocessor that
                            // rewrites text with the configured otherAx model) can opt in
                            // explicitly with `allowPlugins: true`, accepting responsibility
                            // for avoiding provider-to-provider call loops.
                            blockPlugins: !options.allowPlugins,
                        },
                        options.mode,
                    ),
                chatOwner,
            );
        },
        sendChat: async (message: string) => {
            const context = currentContext(contextOwner);
            const conf = await getPluginPermission(identity, "sendChat");
            if (!conf) {
                return false;
            }

            // Inside a hook, the send goes to the hook's chat, else to the selection after permission.
            const ref = context ? context.chatRef : currentChatRef();

            if (typeof message !== "string") {
                throw new Error("Message must be a string");
            }

            // A hook's chat that is gone refuses the call at once.
            if (context) {
                contextMember(context);
            }

            if (getModelInfoForMode("model", context ?? undefined).id.startsWith("pluginmodel:::")) {
                // Executing plugin provider is block because it can be used for loopholes for ipc right now.
                throw new Error("Sending chat with plugin-based model is currently blocked");
            }

            // Refused while the target chat has work of its own (a send of this tab, a followed job,
            // or a lock), as a generation hook's chat in a job channel callback always does.
            // Also refused while any job callback runs in this tab: a hook that waited for the new
            // job would hold the channel lane that job's callbacks need.
            const refuseBusy = () => {
                if ((ref && isChatBusy(ref)) || channelCallbacksRunning()) {
                    throw new Error("A chat is already in progress");
                }
            };
            refuseBusy();

            // Loaded first, the target found again after the load.
            if (ref) {
                // The same chat after the load: deleted or replaced meanwhile (even under the same
                // ids) refuses the call.
                const owner = chatOwnerToken(ref.chaId);
                if (!(await ensureChatLoaded(ref)) || chatOwnerToken(ref.chaId) !== owner) {
                    throw new PluginTargetGoneError("chat");
                }
            }
            const target = context ? contextTarget(context) : undefined;
            const char = target
                ? target.character
                : ref
                  ? characterList().find((entry) => entry?.chaId === ref.chaId)
                  : selectedCharacter();
            if (!char) {
                throw new Error("No character selected");
            }

            const chat = target ? target.chat : ref ? findChat(ref) : undefined;
            if (!chat) {
                throw new Error("No active chat found");
            }

            // Again after the load: from here to the send's registry entry nothing awaits.
            refuseBusy();

            if (message && chat.id) {
                appendMessage(
                    { chaId: char.chaId, chatId: chat.id },
                    { role: "user", data: message, time: Date.now() },
                );
            }

            // The chat captured before the load (the hook's, else the selection after permission).
            const sendTarget = { chaId: char.chaId, chatId: chat.id };
            return await processSendChat(
                -1,
                context ? { target: context.chatRef, pluginContext: context } : { target: sendTarget },
            );
        },
        addPluginChannelListener: (channelName: string, callback: Function) => {
            pluginChannel.set(plugin.name + channelName, callback);
            addPluginUnloadCallback(plugin.name, () => {
                pluginChannel.delete(plugin.name + channelName);
            });
        },
        postPluginChannelMessage: (pluginName: string, channelName: string, message: any) => {
            const currentPluginName = plugin.name;
            const receiverPlugin = settings.plugins.find((p) => p.name === pluginName);

            if (!receiverPlugin) {
                console.warn(
                    `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`,
                );
                return;
            }

            if (!receiverPlugin.allowedIPC?.includes(currentPluginName)) {
                console.warn(
                    `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`,
                );
                return;
            }

            if (!plugin.allowedIPC?.includes(receiverPlugin.name)) {
                console.warn(
                    `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`,
                );
                return;
            }

            const callback = pluginChannel.get(pluginName + channelName);
            if (callback) {
                callback(message, {
                    sender: currentPluginName,
                    channel: channelName,
                });
            }
        },
        saveSecretHeader: async (key: string, value: string | string[]) => {
            //TODO: Implement server-side secret storage with write-only access for plugins, to enhance security when handling sensitive information like API keys.
            //This will have rate-limit, to prevent saving it publicly and writing as secret every time before using it.
            console.warn(
                `[RisuAI Plugin: ${plugin.name}] saveServerSecret is not implemented yet. This API is intended for securely storing sensitive information like API keys with write-only access for plugins. Please avoid using this API until it is implemented.`,
            );
        },
    };
};

type V3PluginInstance = {
    name: string;
    host: SandboxHost;
};

const v3PluginInstances: V3PluginInstance[] = [];

export async function loadV3Plugins(plugins: RisuPlugin[]) {
    await Promise.all(
        [...v3PluginInstances].map(async (instance) => {
            await unloadV3Plugin(instance.name);
        }),
    );

    // Unloading instances can still register providers until their sandboxes terminate.
    clearPluginProviders();
    customV3ProviderMetaStore.length = 0;

    for (const entry of documentEventListeners) {
        document.removeEventListener(entry.type, entry.listener, entry.options);
    }
    documentEventListeners.length = 0;

    const loadPromises = plugins.map((plugin) => executePluginV3(plugin));
    await Promise.all(loadPromises);
}

export async function executePluginV3(plugin: RisuPlugin) {
    const alreadyRunning = v3PluginInstances.find((p) => p.name === plugin.name);
    if (alreadyRunning) {
        console.log(`[RisuAI Plugin: ${plugin.name}] Plugin is already running. Skipping load.`);
        return;
    }

    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    const host = new SandboxHost(makeRisuaiAPIV3(iframe, plugin));
    host.onActivityChanged?.(notifyPluginWork);
    v3PluginInstances.push({
        name: plugin.name,
        host,
    });
    host.run(iframe, plugin.script);
    console.log(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`);
}

export function getV3PluginInstance(name: string) {
    return v3PluginInstances.find((p) => p.name === name);
}

globalThis.__debugV3Plugin = (code: string | Function, pluginName: string = "") => {
    if (code instanceof Function) {
        code = `(${code.toString()})()`;
    }
    if (pluginName === "") {
        return v3PluginInstances[0].host.executeInIframe(code);
    }
    const instance = v3PluginInstances.find((p) => p.name === pluginName);
    if (!instance) {
        throw new Error(`Plugin ${pluginName} not found.`);
    }
    return instance.host.executeInIframe(code);
};
