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

/** `key=label[=type[=options]]` lines; select values are option indices. */
export function parseToggleSyntax(template: string): sidebarToggle[] {
    const toggles: sidebarToggle[] = [];
    for (const line of template.split("\n")) {
        const [key, value, type, option] = line.split("=");
        if (!key || !value) {
            continue;
        }
        if (type === "group") {
            toggles.push({ key, value, type, children: [] });
        } else if (type === "groupEnd" || type === "divider" || type === "caption") {
            toggles.push({ key, value, type });
        } else {
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

export type ToggleKind = "checkbox" | "select" | "text" | "textarea";

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

// Key by the full source text: definitions can change during a job or between reactive reads.
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

/** Chat override, then legacy global, then a defined toggle's kind default (else "null"). */
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
