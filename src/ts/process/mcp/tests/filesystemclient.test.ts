import { describe, expect, it } from "vitest";
import { FileSystemClient } from "../filesystemclient";

describe("filesystem tool advertisement", () => {
    it("omits directory watching and dispatches every advertised tool", async () => {
        const client = new FileSystemClient();
        const tools = await client.getToolList();
        expect(tools.map((tool) => tool.name)).not.toContain("fs_watch_directory");
        expect(tools).toHaveLength(11);
        for (const tool of tools) {
            // No directory was picked: implemented tools report that failure, never unknown-tool dispatch.
            const answer = await client.callTool(tool.name, {
                path: "test.txt",
                source: "test.txt",
                destination: "copy.txt",
                content: "test",
            });
            expect(answer.length, tool.name).toBeGreaterThan(0);
            expect(JSON.stringify(answer), tool.name).not.toContain("Unknown tool:");
        }
    });
});
