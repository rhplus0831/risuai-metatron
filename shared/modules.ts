// Module shapes persisted in the database and in `.risum` files (STRUCTURE D5).

import type { customscript, loreBook } from "./database.ts";
import type { triggerscript } from "./triggers.ts";

export interface MCPModule {
    url: string;
}

export interface RisuModule {
    name: string;
    description: string;
    lorebook?: loreBook[];
    regex?: customscript[];
    cjs?: string;
    trigger?: triggerscript[];
    id: string;
    lowLevelAccess?: boolean;
    hideIcon?: boolean;
    backgroundEmbedding?: string;
    assets?: [string, string, string][];
    namespace?: string;
    customModuleToggle?: string;
    mcp?: MCPModule;
    icon?: string;
}
