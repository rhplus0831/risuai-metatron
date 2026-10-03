import type { character, groupChat, Message } from "../../database.ts";
import type { RPCToolCallContent, ToolDescriptor } from "../../llm/request.ts";
import type { RisuModule } from "../../modules.ts";
import type { DeepReadonly } from "../../readonly.ts";

/** An MCP tool as a client lists it (`inputSchema` is a JSON schema). */
export type MCPTool = {
    name: string;
    description: string;
    inputSchema: any;
    annotations?: any;
};

/** One group of tools of an internal MCP: its schemas, and a call (null when the name is not its own). */
export abstract class MCPToolHandler {
    abstract getTools(): MCPTool[];
    abstract handle(toolName: string, args: any): Promise<RPCToolCallContent[] | null>;
}

/** The outcome of a host write: done, no such record, or a refused value (nothing was changed). */
export type RisuAccessWrite = { ok: true } | { ok: false; notFound: true } | { ok: false; error: string };

/**
 * What the RisuAccess tools (`internal:risuai`) need from where they run (Phase 5 slice 12b): the
 * tab's mirror and mutation modules (`src/ts/process/mcp/risuaccess/`), or the server's store inside
 * a job (`server/src/mcp/internal.ts`). The handlers hold no data of their own.
 *
 * Reads return the records as they are now, typed read-only. A write is synchronous and built from
 * the record the handler just read (Phase 4's rule: consent, the record found again by its id, then
 * the write with no await in between); a failure that is not the write's own (the job's end) throws.
 */
export type RisuAccessHost = {
    /** The character a tool names: by `chaId`, else by name; the current one for an empty id. */
    getCharacter(id: string): DeepReadonly<character | groupChat> | undefined;
    /** The character with `chaId`, as it is now. */
    findCharacter(chaId: string): DeepReadonly<character | groupChat> | undefined;
    characters(): readonly DeepReadonly<character | groupChat>[];
    /** The messages of the character's current chat, oldest first. */
    currentMessages(char: DeepReadonly<character>): Promise<readonly DeepReadonly<Message>[]>;
    /** Sets own fields of a character (`updateCharacter`'s rules: the fixed fields are refused). */
    updateCharacter(chaId: string, patch: Record<string, unknown>): RisuAccessWrite;
    modules(): readonly DeepReadonly<RisuModule>[];
    enabledModules(): readonly string[];
    findModule(id: string): DeepReadonly<RisuModule> | undefined;
    /**
     * Sets fields of a module (`updateModule`) and, when `enabled` is given, enables or disables it
     * globally after the fields were accepted: both or neither.
     */
    updateModule(id: string, patch: Record<string, unknown>, enabled?: boolean): RisuAccessWrite;
    /** Asks the user whether `tool` may do `action`. */
    confirm(tool: string, action: string): Promise<boolean>;
};

export type { RPCToolCallContent, ToolDescriptor };
