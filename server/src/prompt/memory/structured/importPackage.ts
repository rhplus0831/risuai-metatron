import { MAX_READ_RESPONSE_BYTES } from "../../../../../shared/resources.ts";
import {
    MEMORY_PACKAGE_VERSION,
    type MemoryPage,
    type MemoryThread,
    type StructuredMemoryImportFile,
    type StructuredMemoryImportRefusal,
} from "../../../../../shared/structuredMemory.ts";
import { isPlainObject } from "../../../../../shared/valueKinds.ts";
import type { MemoryEventWrite } from "../../../data/memoryStore.ts";
import { isValidResourceId, ResourceValidationError, serialize } from "../../../data/resourceStore.ts";
import { parseRestoredRecords, type RestoredRecords } from "./restore.ts";

/**
 * What the import route keeps of a Markdown package, without any I/O: the records its files hold, read
 * back by the grammar the tab's renderers write (`renderMemoryPage`, `renderMemoryTimeline`,
 * `renderMemoryThreads` in `src/ts/process/structuredMemory.svelte.ts`), and what each refused file got
 * wrong. The route owns the fence, the chat's emptiness, and the write.
 *
 * - A file's Markdown is display and its metadata lines are the authority: a page's fields and its
 *   sections' fields sit in the frontmatter, an event's and a thread's in a `yaml` fence, each line `key:
 *   <JSON>`. Bodies are rebuilt by position from the line counts the metadata gives (`bodyLines`,
 *   `summaryLines`), so a body holding `## x` or `---` splits exactly. Where the layout and the metadata
 *   disagree, the file or the event is refused rather than read two ways, and a file is read to its last
 *   line, so nothing in it goes unseen.
 * - A record's shape is `parseRestoredRecords`' (`restore.ts`), one record at a time, so this module adds
 *   no second shape check. Before that, what the store would refuse whole is refused per file instead: an
 *   id that is no resource id, a stored text over `MAX_READ_RESPONSE_BYTES`, an id a file of the kind
 *   already used, a second scene page. Nothing is cut.
 * - Pages come back live, discarding any `trashedAt` metadata, and with an empty history, since the
 *   package holds none. A package before `threads.md` (`packageVersion` 1) imports with its events'
 *   `openThreads.close` and `transitions` dropped, under one `missingThreads` notice, because those name
 *   threads the package cannot hold.
 */

/** The records a package holds, ready for `store.memory.write`, and what stayed out. */
export type ParsedMemoryPackage = RestoredRecords & { refusals: StructuredMemoryImportRefusal[] };

/** A layout the grammar does not read, with where it broke. */
class UnreadableFile extends Error {}

const TIMELINE = "timeline.md";

const THREADS = "threads.md";

const PAGE_PATH = /^pages\/[^/]+\/[^/]+\.md$/;

/** Whitespace runs as one space, which is how the renderers write a heading or a quote line. */
const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();

/** A file's lines with a cursor, so each rule reads from where the last one stopped. */
class Reader {
    readonly lines: string[];
    at = 0;

    constructor(text: string) {
        this.lines = text.split("\n");
    }

    /** The current line, or undefined past the end. */
    peek(): string | undefined {
        return this.lines[this.at];
    }

    /** `where` for a refusal: the 1-based line number. */
    private place(): string {
        return `line ${this.at + 1}`;
    }

    /** Consumes one line that must be `text`. */
    expect(text: string, what: string): void {
        if (this.lines[this.at] !== text) {
            throw new UnreadableFile(`${this.place()}: expected ${what}`);
        }
        this.at += 1;
    }

    /** Consumes `count` lines as one text. */
    take(count: number, what: string): string {
        if (this.at + count > this.lines.length) {
            throw new UnreadableFile(`${this.place()}: ${what} runs past the end of the file`);
        }
        const text = this.lines.slice(this.at, this.at + count).join("\n");
        this.at += count;
        return text;
    }

    /**
     * Consumes metadata lines up to and including `end`: each `key: <JSON>`, keys unique, the values as
     * parsed. A key never holds `: `, which is what splits the line. `Object.fromEntries` makes a
     * `__proto__` key an own data property, so metadata cannot change the result's prototype.
     */
    metadata(end: string): Record<string, unknown> {
        const entries: [string, unknown][] = [];
        const keys = new Set<string>();
        for (;;) {
            const line = this.lines[this.at];
            if (line === undefined) {
                throw new UnreadableFile(`${this.place()}: metadata is not closed by ${JSON.stringify(end)}`);
            }
            this.at += 1;
            if (line === end) {
                return Object.fromEntries(entries);
            }
            const colon = line.indexOf(": ");
            const key = colon > 0 ? line.slice(0, colon) : "";
            if (key === "" || keys.has(key)) {
                throw new UnreadableFile(`${this.place()}: ${key === "" ? "not a metadata line" : `${key} twice`}`);
            }
            keys.add(key);
            let value: unknown;
            try {
                value = JSON.parse(line.slice(colon + 2));
            } catch {
                throw new UnreadableFile(`${this.place()}: ${key} is not JSON`);
            }
            entries.push([key, value]);
        }
    }

    /** Consumes the file's end: one empty line, which the trailing newline leaves. */
    end(): void {
        if (this.at !== this.lines.length - 1 || this.lines[this.at] !== "") {
            throw new UnreadableFile(`${this.place()}: text past the end of the file's layout`);
        }
    }
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

/**
 * The `packageVersion` of a file's header: an integer from 1 up to `MEMORY_PACKAGE_VERSION`; a newer one
 * is a `newerVersion` refusal, which the caller lists, and anything else unreadable.
 */
function packageVersion(header: Record<string, unknown>): number | "newer" {
    const { packageVersion: version } = header;
    if (!isCount(version)) {
        throw new UnreadableFile("the header's packageVersion is not a version");
    }
    return version > MEMORY_PACKAGE_VERSION ? "newer" : version;
}

/** The `---` header of a file: its metadata, followed by one empty line. */
function header(reader: Reader): Record<string, unknown> {
    reader.expect("---", "the opening ---");
    const fields = reader.metadata("---");
    reader.expect("", "an empty line after the header");
    return fields;
}

/** A page from its file: the frontmatter's fields, and each section's body by its position and line count. */
function readPage(text: string): Record<string, unknown> {
    const reader = new Reader(text);
    const { sections: listed, ...fields } = header(reader);
    if (!Array.isArray(listed)) {
        throw new UnreadableFile("the header lists no sections");
    }
    const sections = listed.map((section: unknown) => {
        if (!isPlainObject(section) || typeof section.heading !== "string" || !isCount(section.bodyLines)) {
            throw new UnreadableFile("a listed section has no heading or line count");
        }
        const { bodyLines, ...rest } = section;
        reader.expect(`## ${collapsed(section.heading)}`, `the heading of ${JSON.stringify(section.heading)}`);
        reader.expect("", "an empty line after the heading");
        const body = reader.take(bodyLines, "the section's body");
        reader.expect("", "an empty line after the section");
        return { ...rest, body };
    });
    reader.end();
    return { ...fields, sections, history: [] };
}

/** One `## title` entry with a `yaml` fence: its metadata, with the fence and the line after it consumed. */
function fencedEntry(reader: Reader): Record<string, unknown> {
    const line = reader.peek();
    const place = `line ${reader.at + 1}`;
    if (line === undefined || !line.startsWith("## ")) {
        throw new UnreadableFile(`${place}: expected an entry's ## heading`);
    }
    reader.at += 1;
    reader.expect("", "an empty line after the heading");
    reader.expect("```yaml", "the entry's yaml fence");
    const fields = reader.metadata("```");
    reader.expect("", "an empty line after the fence");
    if (`## ${collapsed(typeof fields.title === "string" ? fields.title : "")}` !== line) {
        throw new UnreadableFile(`${place}: the heading is not the entry's title`);
    }
    return fields;
}

/** The quote lines an entry ends with, as rendered: `> speaker: text`, then one empty line when there were any. */
function quoteLines(reader: Reader): string[] {
    const quotes: string[] = [];
    for (let line = reader.peek(); line !== undefined && line.startsWith("> "); line = reader.peek()) {
        quotes.push(line.slice(2));
        reader.at += 1;
    }
    if (quotes.length > 0) {
        reader.expect("", "an empty line after the key lines");
    }
    return quotes;
}

/** One timeline event as read: its fields, and why it alone is unreadable, when it is. */
type TimelineEvent = { fields: Record<string, unknown>; unreadable?: string };

/**
 * The timeline's version and events, each as its fence's fields with its summary by position. An event's
 * quote lines must be its `keyLines` as rendered, else that event is unreadable; the file goes on.
 */
function readTimeline(text: string): { version: number | "newer"; events: TimelineEvent[] } {
    const reader = new Reader(text);
    const version = packageVersion(header(reader));
    const events: TimelineEvent[] = [];
    while (reader.at < reader.lines.length - 1) {
        const { summaryLines, ...fields } = fencedEntry(reader);
        if (!isCount(summaryLines)) {
            throw new UnreadableFile(`line ${reader.at}: the entry has no summary line count`);
        }
        const summary = reader.take(summaryLines, "the event's summary");
        reader.expect("", "an empty line after the summary");
        const quotes = quoteLines(reader);
        const { keyLines } = fields;
        const rendered =
            Array.isArray(keyLines) &&
            keyLines.map((line: unknown) =>
                isPlainObject(line) && typeof line.speaker === "string" && typeof line.text === "string"
                    ? `${collapsed(line.speaker)}: ${collapsed(line.text)}`
                    : undefined,
            );
        const agree = rendered && rendered.length === quotes.length && rendered.every((q, i) => q === quotes[i]);
        events.push({
            fields: { ...fields, summary },
            ...(agree ? {} : { unreadable: "its key lines are not the quote lines below it" }),
        });
    }
    reader.end();
    return { version, events };
}

/** The threads file's version and threads, each its fence's fields. */
function readThreads(text: string): { version: number | "newer"; threads: Record<string, unknown>[] } {
    const reader = new Reader(text);
    const version = packageVersion(header(reader));
    const threads: Record<string, unknown>[] = [];
    while (reader.at < reader.lines.length - 1) {
        threads.push(fencedEntry(reader));
    }
    reader.end();
    return { version, threads };
}

/** The ids each kind has taken, and whether a scene page has, across the package. */
type Taken = { pages: Set<string>; events: Set<string>; threads: Set<string>; scene: boolean };

/**
 * `record` of `kind` as the store would take it, or the refusal it would make: an id that is no resource
 * id, one already taken, a second scene page, a stored text over the read budget, or a shape
 * `parseRestoredRecords` refuses. Pages discard `trashedAt` on a copy before the checks, so every
 * imported page is live. A record that passes takes its id.
 */
function admitted(
    kind: keyof RestoredRecords,
    record: Record<string, unknown>,
    taken: Taken,
): MemoryPage | MemoryEventWrite | MemoryThread | Omit<StructuredMemoryImportRefusal, "file"> {
    if (kind === "pages") {
        const { trashedAt, ...live } = record;
        record = live;
    }
    const { id } = record;
    if (!isValidResourceId(id)) {
        return { reason: "invalidId" };
    }
    if (taken[kind].has(id)) {
        return { reason: "duplicateId", detail: id };
    }
    const scene = kind === "pages" && record.type === "scene";
    if (scene && taken.scene) {
        return { reason: "secondScene", detail: id };
    }
    let text: string;
    try {
        ({ text } = serialize(record));
    } catch (error) {
        return { reason: "shape", detail: error instanceof ResourceValidationError ? error.message : "not JSON" };
    }
    if (Buffer.byteLength(text, "utf8") > MAX_READ_RESPONSE_BYTES) {
        return { reason: "tooLarge", detail: id };
    }
    const checked = parseRestoredRecords({ pages: [], events: [], threads: [], [kind]: [record] });
    if (!checked) {
        return { reason: "shape" };
    }
    taken[kind].add(id);
    if (scene) {
        taken.scene = true;
    }
    return checked[kind][0];
}

/**
 * The records `files`, the entries of one package zip, hold, and what each refused file got wrong. A file
 * that is not a page file, `timeline.md`, or `threads.md` is `unknownFile`; one the grammar does not read
 * is `unreadable`, with where it broke; a readable `timeline.md` or `threads.md` of a newer version is
 * `newerVersion`. A timeline event that fails on its own is refused as `timeline.md#<id>` and the rest of
 * the file goes on.
 * Without a readable, supported `threads.md`, a readable timeline keeps its events but loses their
 * `openThreads.close` and `transitions`, with `missingThreads`: those ids would name absent threads.
 */
export function parseMemoryPackage(files: readonly StructuredMemoryImportFile[]): ParsedMemoryPackage {
    const refusals: StructuredMemoryImportRefusal[] = [];
    const records: RestoredRecords = { pages: [], events: [], threads: [] };
    const taken: Taken = { pages: new Set(), events: new Set(), threads: new Set(), scene: false };
    const refuse = (file: string, refusal: Omit<StructuredMemoryImportRefusal, "file">) =>
        refusals.push({ file, ...refusal });
    const read = <T>(file: string, parse: () => T): T | undefined => {
        try {
            return parse();
        } catch (error) {
            if (error instanceof UnreadableFile) {
                refuse(file, { reason: "unreadable", detail: error.message });
                return undefined;
            }
            throw error;
        }
    };
    const admit = (file: string, kind: keyof RestoredRecords, record: Record<string, unknown>) => {
        const result = admitted(kind, record, taken);
        if ("reason" in result) {
            refuse(file, result);
        } else {
            (records[kind] as unknown[]).push(result);
        }
    };

    let timeline: ReturnType<typeof readTimeline> | undefined;
    let threads: ReturnType<typeof readThreads> | undefined;
    for (const { path, text } of files) {
        if (path === TIMELINE) {
            timeline = read(path, () => readTimeline(text));
        } else if (path === THREADS) {
            threads = read(path, () => readThreads(text));
        } else if (PAGE_PATH.test(path)) {
            const page = read(path, () => readPage(text));
            if (page) {
                admit(path, "pages", page);
            }
        } else {
            refuse(path, { reason: "unknownFile" });
        }
    }

    if (threads?.version === "newer") {
        refuse(THREADS, { reason: "newerVersion" });
        threads = undefined;
    }
    if (timeline?.version === "newer") {
        refuse(TIMELINE, { reason: "newerVersion" });
        timeline = undefined;
    }
    // A package without a threads file cannot hold what its events' close and transition lists name.
    const threadless = timeline !== undefined && threads === undefined;
    if (threadless) {
        refuse(THREADS, { reason: "missingThreads" });
    }
    for (const thread of threads?.threads ?? []) {
        admit(THREADS, "threads", thread);
    }
    timeline?.events.forEach(({ fields: event, unreadable }, index) => {
        const file = `${TIMELINE}#${typeof event.id === "string" ? event.id : index + 1}`;
        if (unreadable !== undefined) {
            refuse(file, { reason: "unreadable", detail: unreadable });
            return;
        }
        const openThreads = isPlainObject(event.openThreads) ? event.openThreads : undefined;
        admit(
            file,
            "events",
            threadless && openThreads
                ? { ...event, openThreads: { ...openThreads, close: [], transitions: [] } }
                : event,
        );
    });
    return { ...records, refusals };
}
