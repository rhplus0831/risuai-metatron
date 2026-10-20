import { getContext, setContext } from "svelte";

/*
 * The chat screen's shared row stylesheets (archived `docs/plan/heap-memory.md` C2). Each row used to keep
 * its own `<style>` copy of its CSS, so rows repeating a style cost one sheet, one import and one set
 * of font faces each. Here a chat screen keeps one `<style>` per distinct CSS text and attribute
 * list, held by the mounted rows that use it, in a container after the rows.
 *
 * Among shared sheets, the order keeps the cascade the rows' own copies gave: newest message first,
 * then the greeting, and each style's last copy decided where its rules fell. So every row's style
 * has the position (-message index, slot in the row), a sheet stands where its latest position is,
 * and sheets are ordered by that: the style of the oldest message (the greeting last) comes last.
 * Custom-GUI sheets and sheets containing @layer, layer(), or @scope stay at their row positions;
 * their order against a newer row's shared sheet can reverse. Layers inside imports are not detected.
 */

export interface ChatStyle {
    readonly css: string;
    readonly attributes: readonly (readonly [string, string])[];
}

/** A use's position among the rows' styles: the negated message index, then the slot in the row. */
type Position = readonly [number, number];

interface Entry {
    readonly key: string;
    readonly element: HTMLStyleElement;
    readonly users: Map<symbol, Position>;
    /** Creation order, the tie-break between equal positions. */
    readonly seq: number;
    /** The latest of the users' positions when the entry was last placed. */
    at: Position;
}

const comparePositions = (a: Position, b: Position) => a[0] - b[0] || a[1] - b[1];
const compareEntries = (a: Entry, b: Entry) => comparePositions(a.at, b.at) || a.seq - b.seq;

export class ChatStyleRegistry {
    /** Holds the sheets; in the document only while attached (`attach`). */
    readonly container: HTMLDivElement;
    readonly #entries = new Map<string, Entry>();
    /** The entries in the container's order. */
    #order: Entry[] = [];
    #seq = 0;
    #scheduled = false;
    #destroyed = false;

    constructor(doc: Document = document) {
        this.container = doc.createElement("div");
        this.container.hidden = true;
        this.container.dataset.chatStyles = "";
    }

    /**
     * One use of `style` by the row of `messageIndex` (-1: the greeting), as the row's `slot`-th style.
     * A new key gets its sheet at once. Returns the release (idempotent). Releases and moves wait for
     * the next microtask; a release and re-acquire in one synchronous flush are coalesced. A row
     * rendering again (an `{#await}` branch switch, a rerun effect) takes the same style
     * back without the sheet being removed, parsed again, and its imports and faces made again.
     */
    acquire(style: ChatStyle, messageIndex: number, slot: number): () => void {
        const { css, attributes } = style;
        if (this.#destroyed || css === "") return () => {};
        const key = JSON.stringify([css, attributes]);
        const position: Position = [-messageIndex, slot];
        const token = Symbol();
        let entry = this.#entries.get(key);
        if (entry) {
            entry.users.set(token, position);
            if (comparePositions(position, entry.at) > 0) this.#schedule();
        } else {
            const element = this.container.ownerDocument.createElement("style");
            // Attributes come from the sanitized element; CSS never re-enters the HTML parser.
            for (const [name, value] of attributes) element.setAttribute(name, value);
            element.textContent = css;
            entry = { key, element, users: new Map([[token, position]]), seq: this.#seq++, at: position };
            this.#entries.set(key, entry);
            const next = this.#order.findIndex((other) => compareEntries(other, entry!) > 0);
            if (next === -1) {
                this.#order.push(entry);
                this.container.append(element);
            } else {
                this.#order.splice(next, 0, entry);
                this.container.insertBefore(element, this.#order[next + 1].element);
            }
        }
        const used = entry;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            used.users.delete(token);
            this.#schedule();
        };
    }

    /** Puts the container at the end of `host`; returns its removal (an `{@attach}` attachment). */
    attach = (host: HTMLElement) => {
        if (!this.#destroyed) host.append(this.container);
        return () => {
            if (this.container.parentNode === host) this.container.remove();
        };
    };

    /** Removes every sheet; later uses and releases do nothing. */
    destroy() {
        this.#destroyed = true;
        this.container.remove();
        this.container.replaceChildren();
        this.#entries.clear();
        this.#order = [];
    }

    #schedule() {
        if (this.#scheduled || this.#destroyed) return;
        this.#scheduled = true;
        queueMicrotask(() => this.#reconcile());
    }

    /** Drops the sheets no row uses and moves a sheet only where the order changed. */
    #reconcile() {
        this.#scheduled = false;
        if (this.#destroyed) return;
        const kept: Entry[] = [];
        for (const entry of this.#order) {
            if (entry.users.size === 0) {
                entry.element.remove();
                this.#entries.delete(entry.key);
                continue;
            }
            let at: Position | undefined;
            for (const position of entry.users.values()) {
                if (!at || comparePositions(position, at) > 0) at = position;
            }
            entry.at = at!;
            kept.push(entry);
        }
        kept.sort(compareEntries);
        this.#order = kept;
        let cursor = this.container.firstChild;
        for (const entry of kept) {
            if (entry.element === cursor) cursor = cursor.nextSibling;
            else this.container.insertBefore(entry.element, cursor);
        }
    }
}

const REGISTRY = Symbol("chat-style-registry");

/** Gives the chat rows under the calling component this registry (component initialization only). */
export function setChatStyleRegistry(registry: ChatStyleRegistry) {
    setContext(REGISTRY, registry);
}

/** The chat screen's registry, or null outside one (the row then keeps its own `<style>`). */
export function getChatStyleRegistry(): ChatStyleRegistry | null {
    return getContext<ChatStyleRegistry | undefined>(REGISTRY) ?? null;
}
