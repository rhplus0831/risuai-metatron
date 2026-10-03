import type { MCPTool, RPCToolCallContent } from "./risuaccess/host.ts";

type GraphIndex = {
    name: string;
    summary: string;
    connections: string[];
};

/**
 * What the graph memory tools (`internal:graphmem`) need from where they run (Phase 5 slice 12b): the
 * tab (`src/ts/process/mcp/graphmem.ts`) or a server job (`server/src/mcp/jobTools.ts`). The graph is
 * the chat variable `graphmem_graph` of the chat the tools run for.
 */
export type GraphMemHost = {
    getVar(key: string): string;
    setVar(key: string, value: string): void;
    /**
     * A similarity search prepared for the entry `names`: the client's `new HypaProcesser()` with
     * `embedDocuments(names)`, answering `similaritySearch(term)` for each term asked.
     */
    search(names: string[]): Promise<(term: string) => Promise<string[]>>;
    /** Whether a failure is not the tool's own (a job's end): it is thrown on instead of answered. */
    fatal?(error: unknown): boolean;
};

export const GRAPHMEM_TOOLS: MCPTool[] = [
    {
        name: "writeMemory",
        description: "Write a memory entry to the graph database.",
        inputSchema: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "The name of the memory entry.",
                },
                summary: {
                    type: "string",
                    description: "A brief summary of the memory entry.",
                },
                connections: {
                    type: "array",
                    items: {
                        type: "string",
                        description: "Names of related memory entries.",
                    },
                    description: "Connections to other memory entries.",
                },
            },
            required: ["name", "summary"],
        },
    },
    {
        name: "readMemory",
        description: "Read a memory entry from the graph database.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                    description: "The query terms to search for memory entries.",
                },
                search_depth: {
                    type: "number",
                    description: "The depth of connections to explore in the graph. default is 2.",
                },
            },
            required: ["query"],
        },
    },
];

export async function callGraphMemTool(host: GraphMemHost, toolName: string, args: any): Promise<RPCToolCallContent[]> {
    try {
        switch (toolName) {
            case "writeMemory": {
                return await writeMemory(host, args);
            }
            case "readMemory": {
                return await readMemory(host, args);
            }
            default:
                return [{ type: "text", text: `Unknown tool: ${toolName}` }];
        }
    } catch (error: unknown) {
        if (host.fatal?.(error)) {
            throw error;
        }
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        return [{ type: "text", text: `Error: ${errorMessage}` }];
    }
}

async function writeMemory(host: GraphMemHost, args: any): Promise<RPCToolCallContent[]> {
    const {
        name,
        summary,
        connections = [],
    }: {
        name: string;
        summary: string;
        connections: string[];
    } = args;

    let graph: GraphIndex[] = [];

    try {
        graph = JSON.parse(host.getVar("graphmem_graph")) as GraphIndex[];
    } catch (error) {}

    graph.push({ name, summary, connections });

    host.setVar("graphmem_graph", JSON.stringify(graph));
    return [{ type: "text", text: `Memory entry "${name}" written successfully.` }];
}

async function readMemory(host: GraphMemHost, args: any): Promise<RPCToolCallContent[]> {
    const {
        query,
        search_depth = 2,
    }: {
        query: string[];
        search_depth?: number;
        threshold?: number;
    } = args;

    let graph: GraphIndex[] = [];

    try {
        graph = JSON.parse(host.getVar("graphmem_graph")) as GraphIndex[];
    } catch (error) {}

    if (!Array.isArray(query) || query.length === 0) {
        return [{ type: "text", text: `Query must be a non-empty array of strings.` }];
    }

    if (!Array.isArray(graph) || graph.length === 0) {
        return [{ type: "text", text: `No memory entries found in the graph database.` }];
    }

    const search = await host.search(graph.map((g) => g.name));

    let results: {
        queryTerm: string;
        entries: GraphIndex[];
    }[] = [];
    for (let i = 0; i < query.length; i++) {
        let currentEntries: GraphIndex[] = [];
        let toSearch: string[] = [query[i]];
        // Stops once nothing new was found: a later depth would search nothing (a huge depth is no loop).
        for (let depth = 0; depth < search_depth && toSearch.length > 0; depth++) {
            const newEntries: GraphIndex[] = [];
            for (const searchTerm of toSearch) {
                const searched = await search(searchTerm);
                for (const entry of searched) {
                    const found = graph.find((g) => g.name === entry);
                    if (found && !currentEntries.includes(found)) {
                        newEntries.push(found);
                    }
                }
            }
            currentEntries = currentEntries.concat(newEntries);
            toSearch = newEntries.flatMap((e) => e.connections);
        }

        results.push({ queryTerm: query[i], entries: currentEntries });
    }

    return [{ type: "text", text: JSON.stringify(results, null, 2) }];
}
