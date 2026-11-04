// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatReport, scanTranscripts } from "./guideReads.mjs";

const GUIDE_TEXT = [
    "# Example",
    "## Scope",
    "Scope text.",
    "## Files",
    "### Readers",
    "Reader text.",
    "### Writers",
    "Writer text.",
    "## Flows",
    "Flow text.",
].join("\n");
const TIMESTAMP = "2026-01-02T03:04:05Z";
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>) {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-guide-reads-"));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
    return root;
}

function tool(id: string, name: "Read" | "Bash", input: Record<string, unknown>) {
    return { type: "tool_use", id, name, input };
}

function transcript(...blocks: ReturnType<typeof tool>[]) {
    return JSON.stringify({ type: "assistant", timestamp: TIMESTAMP, message: { content: blocks } }) + "\n";
}

const textAt = (_timestamp: string, guide: string) =>
    guide === "STRUCTURE" ? "# STRUCTURE\n## Map\nIndex text." : GUIDE_TEXT;

describe("docs:reads", () => {
    it("counts whole and ranged Reads per guide, including STRUCTURE", async () => {
        const file_path = "/checkout/docs/structure/example.md";
        const root = tree({
            "session.jsonl": transcript(
                tool("whole", "Read", { file_path }),
                tool("range", "Read", { file_path, offset: 5, limit: 2 }),
                tool("offset", "Read", { file_path, offset: 9 }),
                tool("limit", "Read", { file_path, limit: 1 }),
                tool("index", "Read", { file_path: "/checkout/STRUCTURE.md" }),
            ),
        });
        const { tally } = await scanTranscripts([root], textAt);
        expect([...tally.guides.keys()].sort()).toEqual(["STRUCTURE", "example"]);
        expect(tally.guides.get("example")).toMatchObject({ whole: 1, ranged: 3, bash: 0, sed: 0, docsRead: 0 });
        expect(tally.guides.get("STRUCTURE")).toMatchObject({
            whole: 1,
            ranged: 0,
            bash: 0,
            sed: 0,
            docsRead: 0,
            headings: new Map(),
        });
    });

    it("counts a copied tool_use id once across transcripts and keeps distinct calls", async () => {
        const input = { file_path: "docs/structure/example.md" };
        const copied = tool("shared-id", "Read", input);
        const root = tree({
            "parent.jsonl": transcript(copied),
            "fork/subagents/child.jsonl": transcript(copied, tool("distinct-id", "Read", input)),
        });
        const { tally, files } = await scanTranscripts([root], textAt);
        expect(files).toBe(2);
        expect(tally.guides.get("example")).toMatchObject({ whole: 2, ranged: 0 });
    });

    it("maps Read ranges to every intersected heading with an exclusive offset-plus-limit end", async () => {
        const file_path = "docs/structure/example.md";
        const root = tree({
            "session.jsonl": transcript(
                tool("crossing", "Read", { file_path, offset: 6, limit: 2 }),
                tool("parent", "Read", { file_path, offset: 4, limit: 1 }),
            ),
        });
        const { tally } = await scanTranscripts([root], textAt);
        expect(Object.fromEntries(tally.guides.get("example").headings)).toEqual({
            "Files > Readers": { ranges: 1, docsRead: 0 },
            "Files > Writers": { ranges: 1, docsRead: 0 },
            Files: { ranges: 1, docsRead: 0 },
        });
    });

    it("counts Bash, its sed subset, and docs:read separately per guide and heading", async () => {
        const root = tree({
            "session.jsonl": transcript(
                tool("search", "Bash", { command: "rg -n needle docs/structure/example.md" }),
                tool("sed", "Bash", { command: "sed -n '5,6p;6,7p' docs/structure/example.md" }),
                tool("reader", "Bash", { command: "pnpm --silent docs:read docs/structure/example.md Files" }),
                tool("outline", "Bash", { command: "node util/docsRead.mjs STRUCTURE" }),
            ),
        });
        const { tally } = await scanTranscripts([root], textAt);
        expect(tally.guides.get("example")).toMatchObject({ whole: 0, ranged: 0, bash: 2, sed: 1, docsRead: 1 });
        expect(Object.fromEntries(tally.guides.get("example").headings)).toEqual({
            "Files > Readers": { ranges: 1, docsRead: 0 },
            "Files > Writers": { ranges: 1, docsRead: 0 },
            Files: { ranges: 0, docsRead: 1 },
        });
        expect(tally.guides.get("STRUCTURE")).toMatchObject({ bash: 0, docsRead: 1, outline: 1, headings: new Map() });
    });

    it("reports aggregates and guide headings without transcript text or paths", async () => {
        const command = "rg -n COMMAND_PRIVATE_52 docs/structure/example.md";
        const query = "QUERY_PRIVATE_25";
        const root = tree({
            "session-private-77.jsonl": [
                JSON.stringify({ type: "user", message: { content: "PROMPT_PRIVATE_82 docs/structure/example.md" } }),
                JSON.stringify({
                    type: "assistant",
                    sessionId: "session-private-77",
                    timestamp: TIMESTAMP,
                    message: {
                        content: [
                            { type: "text", text: "ASSISTANT_PRIVATE_91" },
                            tool("tool-private-44", "Bash", { command: `pnpm docs:read example '${query}'` }),
                            tool("tool-private-45", "Read", {
                                file_path: "/checkout-private/docs/structure/example.md",
                                offset: 5,
                                limit: 1,
                            }),
                            tool("tool-private-46", "Bash", { command }),
                        ],
                    },
                }),
            ].join("\n"),
        });
        const { tally, files } = await scanTranscripts([root], textAt);
        const report = formatReport(tally, { date: "2026-01-03", files, dirs: 1 }, () => GUIDE_TEXT);
        expect(report).toContain("| example | 0 | 1 | 1 | 0 | 1 |");
        expect(report).toContain("| Files > Readers | 1 | 0 |");
        for (const privateText of [
            command,
            query,
            "PROMPT_PRIVATE_82",
            "ASSISTANT_PRIVATE_91",
            "session-private-77",
            "tool-private-",
            "/checkout-private",
            root,
            path.join(root, "session-private-77.jsonl"),
            TIMESTAMP,
            "Reader text.",
        ]) {
            expect(report).not.toContain(privateText);
        }
    });
});
