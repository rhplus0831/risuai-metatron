import { ModuleHandler as SharedModuleHandler } from "../../../../../shared/mcp/risuaccess/modules.ts";
import { tabRisuAccessHost } from "./host";

/** The RisuAccess module tools in the tab: the shared handler over the tab's host. */
export class ModuleHandler extends SharedModuleHandler {
    constructor() {
        super(tabRisuAccessHost);
    }
}
