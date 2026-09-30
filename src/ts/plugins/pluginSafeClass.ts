import {
    clearSafeLocalPluginStorage,
    getSafeLocalPluginValue,
    removeSafeLocalPluginValue,
    safeLocalPluginKeys,
    setSafeLocalPluginValue,
} from "../storage/pluginStorageStore.svelte";

const MAX_JSON_DEPTH = 256;

/**
 * Whether a value is plain JSON data: null, a boolean, a finite number, a string, or plain arrays and
 * objects of those (no class instances, Dates, Blobs, Maps, typed arrays, functions, or cycles).
 */
export function isJsonValue(value: unknown, depth = 0, seen = new Set<object>()): boolean {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (typeof value !== "object" || depth >= MAX_JSON_DEPTH || seen.has(value)) {
        return false;
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.every((item) => isJsonValue(item, depth + 1, seen));
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            return false;
        }
        return Object.values(value).every((item) => isJsonValue(item, depth + 1, seen));
    } finally {
        seen.delete(value);
    }
}

export class SafeLocalStorage {
    getItem(key: string): string | null {
        return localStorage.getItem(`safe_plugin_${key}`);
    }
    setItem(key: string, value: string): void {
        localStorage.setItem(`safe_plugin_${key}`, value);
    }
    removeItem(key: string): void {
        localStorage.removeItem(`safe_plugin_${key}`);
    }
    //not a standard localStorage method, but useful
    keys(): string[] {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("safe_plugin_")) {
                keys.push(key.substring("safe_plugin_".length));
            }
        }
        return keys;
    }

    key(index: number): string | null {
        const safeKeys = this.keys();
        return safeKeys[index] || null;
    }

    clear(): void {
        const keys = this.keys();
        for (const key of keys) {
            this.removeItem(key);
        }
    }

    get length(): number {
        return this.keys().length;
    }
}

/**
 * The plugin API's `getLocalPluginStorage()`: shared by every plugin and saved on the server inside
 * `pluginCustomStorage` (it was browser-local before Phase 1) through the plugin storage mutations
 * (`pluginStorageStore.svelte.ts`). Values must be plain JSON data; any other value throws a
 * `TypeError` and changes nothing. Any string is a valid key. Reads return copies.
 */
export class SafeLocalPluginStorage {
    __classType = "REMOTE_REQUIRED" as const;

    async getItem<T>(key: string): Promise<T | null> {
        return getSafeLocalPluginValue(String(key)) as T | null;
    }
    async setItem<T>(key: string, value: T): Promise<void> {
        if (value === undefined) {
            // LocalForage stored `undefined` as null; keep that.
            setSafeLocalPluginValue(String(key), null);
            return;
        }
        if (!isJsonValue(value)) {
            throw new TypeError("getLocalPluginStorage() stores only JSON-serializable values");
        }
        setSafeLocalPluginValue(String(key), JSON.parse(JSON.stringify(value)));
    }
    async removeItem(key: string): Promise<void> {
        removeSafeLocalPluginValue(String(key));
    }
    async keys(): Promise<string[]> {
        return safeLocalPluginKeys();
    }
    async clear(): Promise<void> {
        clearSafeLocalPluginStorage();
    }
}

export const tagWhitelist = [
    "a",
    "abbr",
    "acronym",
    "address",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "bdi",
    "bdo",
    "big",
    "blink",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "content",
    "data",
    "datalist",
    "dd",
    "decorator",
    "del",
    "details",
    "dfn",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "element",
    "em",
    "fieldset",
    "figcaption",
    "figure",
    "font",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "i",
    "img",
    "input",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "main",
    "map",
    "mark",
    "marquee",
    "menu",
    "menuitem",
    "meter",
    "nav",
    "nobr",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "picture",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "search",
    "section",
    "select",
    "shadow",
    "slot",
    "small",
    "source",
    "spacer",
    "span",
    "strike",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "track",
    "tt",
    "u",
    "ul",
    "var",
    "video",
    "wbr",
    "svg",
    "a",
    "altglyph",
    "altglyphdef",
    "altglyphitem",
    "animatecolor",
    "animatemotion",
    "animatetransform",
    "circle",
    "clippath",
    "defs",
    "desc",
    "ellipse",
    "enterkeyhint",
    "exportparts",
    "filter",
    "font",
    "g",
    "glyph",
    "glyphref",
    "hkern",
    "image",
    "inputmode",
    "line",
    "lineargradient",
    "marker",
    "mask",
    "metadata",
    "mpath",
    "part",
    "path",
    "pattern",
    "polygon",
    "polyline",
    "radialgradient",
    "rect",
    "stop",
    "style",
    "switch",
    "symbol",
    "text",
    "textpath",
    "title",
    "tref",
    "tspan",
    "view",
    "vkern",
];
