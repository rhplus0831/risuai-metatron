export type sidebarToggleGroup = {
    key?: string;
    value?: string;
    type: "group";
    children: sidebarToggle[];
};

export type sidebarToggleGroupEnd = {
    key?: string;
    value?: string;
    type: "groupEnd";
};

export type sidebarToggle =
    | sidebarToggleGroup
    | sidebarToggleGroupEnd
    | {
          key?: string;
          value?: string;
          type: "caption";
      }
    | {
          key?: string;
          value?: string;
          type: "divider";
      }
    | {
          key: string;
          value: string;
          type: "select";
          options: string[];
      }
    | {
          key: string;
          value: string;
          type: "text" | "textarea" | undefined;
          options?: string[];
      };

/**
 * `key=label[=type[=options]]` lines; select values are option indices. Layout rows need no key:
 * `=Label=group`, `==groupEnd` and `==divider` are kept, a caption needs only its label.
 */
export function parseToggleSyntax(template: string): sidebarToggle[] {
    const toggles: sidebarToggle[] = [];
    for (const line of template.split("\n")) {
        const [key, value, type, option] = line.split("=");
        if (type === "group") {
            toggles.push({ key, value, type, children: [] });
        } else if (type === "groupEnd" || type === "divider") {
            toggles.push({ key, value, type });
        } else if (type === "caption") {
            if (value) {
                toggles.push({ key, value, type });
            }
        } else if (key && value) {
            toggles.push({
                key,
                value,
                type: type === "select" || type === "text" || type === "textarea" ? type : undefined,
                options: option?.split(",") ?? [],
            });
        }
    }
    return toggles;
}

export const TOGGLE_KINDS = ["checkbox", "select", "text", "textarea"] as const;
export type ToggleKind = (typeof TOGGLE_KINDS)[number];

export function toggleKindOf(toggle: sidebarToggle): ToggleKind | undefined {
    switch (toggle.type) {
        case "select":
        case "text":
        case "textarea":
            return toggle.type;
        case undefined:
            return "checkbox";
        default:
            return undefined;
    }
}

export const TOGGLE_VARIABLE_PREFIX = "toggle_";

export function toggleStorageKey(key: string): string {
    return TOGGLE_VARIABLE_PREFIX + key;
}

/** The value an unset toggle reads: `""` for text and textarea, `"0"` (off, or the first option) otherwise. */
export function toggleDefault(kind: ToggleKind): string {
    return kind === "text" || kind === "textarea" ? "" : "0";
}

export function toggleDefinitionsText(presetText: unknown, moduleText: unknown, characterText: unknown): string {
    return [presetText, moduleText, characterText].map((text) => (typeof text === "string" ? text : "")).join("\n");
}

type ValueToggle = Extract<sidebarToggle, { key: string; value: string }>;

/** Value entries in source order; the first definition of a key wins. */
export function valueToggles(definitions: readonly sidebarToggle[]): ValueToggle[] {
    const seen = new Set<string>();
    return definitions.filter((toggle): toggle is ValueToggle => {
        if (toggleKindOf(toggle) === undefined || !toggle.key || seen.has(toggle.key)) {
            return false;
        }
        seen.add(toggle.key);
        return true;
    });
}

/**
 * The kinds per definitions text, keyed by the full source text: definitions can change during a job or between
 * reactive reads. At most 16 texts; the oldest goes first.
 */
const kindCache = new Map<string, Map<string, ToggleKind>>();

function toggleKinds(text: string): ReadonlyMap<string, ToggleKind> {
    let kinds = kindCache.get(text);
    if (!kinds) {
        kinds = new Map(valueToggles(parseToggleSyntax(text)).map((toggle) => [toggle.key, toggleKindOf(toggle)!]));
        if (kindCache.size >= 16) {
            kindCache.delete(kindCache.keys().next().value!);
        }
        kindCache.set(text, kinds);
    }
    return kinds;
}

function nonemptyValue(value: unknown): value is string {
    return typeof value === "string" && value !== "" && value !== "null";
}

/**
 * Chat override, then legacy global, then a defined toggle's kind default (else "null").
 * - `""` and `"null"` are unset, except that an empty value counts as set for a text or textarea toggle: an empty
 *   chat value wins over a legacy one, and an empty legacy value over the default.
 * - Only `toggle_` keys get defaults; any other key without a value reads `"null"`.
 * - `definitionsText` (the preset's, the enabled modules', then the chat owner's toggle definitions; the first
 *   definition of a key wins) is read only when a `toggle_` key reaches it.
 */
export function resolveGlobalChatVar(
    key: string,
    chatMap: Readonly<Record<string, unknown>> | null | undefined,
    legacyMap: Readonly<Record<string, unknown>> | null | undefined,
    definitionsText: string | (() => string),
): string {
    const local = chatMap?.[key];
    if (nonemptyValue(local)) {
        return local;
    }
    const legacy = legacyMap?.[key];
    if (!key.startsWith(TOGGLE_VARIABLE_PREFIX)) {
        return nonemptyValue(legacy) ? legacy : "null";
    }
    // An empty local text/textarea is set and must win over even a non-empty legacy value.
    if (local !== "" && nonemptyValue(legacy)) {
        return legacy;
    }
    const text = typeof definitionsText === "function" ? definitionsText() : definitionsText;
    const kind = toggleKinds(text).get(key.slice(TOGGLE_VARIABLE_PREFIX.length));
    const keepsEmpty = kind === "text" || kind === "textarea";
    if (keepsEmpty && local === "") {
        return "";
    }
    if (nonemptyValue(legacy) || (keepsEmpty && legacy === "")) {
        return legacy;
    }
    return kind === undefined ? "null" : toggleDefault(kind);
}
