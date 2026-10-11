// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Chat, RisuPersona, character, groupChat } from "../../../shared/database.ts";
import type { RisuModule } from "../../../shared/modules.ts";
import { jobModules } from "../jobs/cbsHost.ts";
import type { JobScope } from "../jobs/jobScope.ts";

// `jobModules` (`server/src/jobs/cbsHost.ts`), the server's `getModules`: the persona module links
// (`RisuPersona.modules`) of the chat's bound persona join the enabled modules, resolved by id only
// (never by namespace, never an MCP module: `personaLinksModule`), each module once in stored order;
// the legacy id lists (`enabledModules`, `chat.modules`, `character.modules`, `moduleIntergration`)
// keep matching namespaces. Only `chat.bindedPersona` counts: an unbound chat, a chat bound to a
// deleted persona, and a ref to another chat each get their own chat's links. The client's
// `getModules` answers the same lists for the same data (`src/ts/storage/tests/personaModuleLinks.test.ts`).

const MINA = "mina";

const modules: RisuModule[] = [
    { id: "global", name: "Global", description: "" },
    { id: "plain", name: "Plain", description: "" },
    // Its namespace is one of Mina's linked texts: a legacy list resolves it, a persona link does not.
    { id: "nsmod", name: "Namespaced", description: "", namespace: "shared-ns" },
    { id: "mcpmod", name: "Mcp", description: "", mcp: { url: "http://mcp" } as RisuModule["mcp"] },
    { id: "chatonly", name: "Chat only", description: "" },
];

const mina: RisuPersona = {
    id: MINA,
    name: "Mina",
    icon: "",
    personaPrompt: "",
    note: "",
    // `plain` twice and `global` (also enabled) once: each module resolves once. `missing` names no
    // module (a deleted module leaves its id in the links), `shared-ns` is a namespace, `mcpmod` is MCP.
    modules: ["plain", "plain", "global", "missing", "shared-ns", "mcpmod"],
};

const chatOf = (id: string, extra: Partial<Chat> = {}): Chat =>
    ({ id, name: id, fmIndex: -1, message: [], ...extra }) as unknown as Chat;

function scopeOf(options: { characterId: string; chatId: string; moduleIntergration?: string }) {
    const owner = {
        chaId: "c",
        type: "character",
        name: "Owner",
        chatPage: 0,
        chats: [
            chatOf("k", { bindedPersona: MINA }),
            chatOf("j", { modules: ["shared-ns"] }),
            chatOf("g", { bindedPersona: "gone" }),
        ],
    } as unknown as character;
    const member = {
        chaId: "mem",
        type: "character",
        name: "Member",
        chatPage: 0,
        chats: [chatOf("own")],
        modules: ["chatonly"],
    } as unknown as character;
    const group = {
        chaId: "grp",
        type: "group",
        name: "Group",
        chatPage: 0,
        characters: ["mem"],
        chats: [chatOf("gk", { bindedPersona: MINA })],
    } as unknown as groupChat;
    return {
        db: {
            characters: [owner, member, group],
            personas: [mina],
            modules,
            enabledModules: ["global"],
            moduleIntergration: options.moduleIntergration ?? "",
        },
        characterId: options.characterId,
        chatId: options.chatId,
        effectivePersona: mina,
    } as unknown as JobScope;
}

const ids = (scope: JobScope, ref?: { chaId: string; chatId: string }) =>
    jobModules(scope, ref).map((module) => module.id);

describe("jobModules with persona module links", () => {
    it("adds the bound persona's links by id only, once each, in stored order, MCP modules excepted", () => {
        const scope = scopeOf({ characterId: "c", chatId: "k" });
        // Stored order (`global` before `plain`), not the link order; `shared-ns`, `mcpmod`, and
        // `missing` contribute nothing.
        expect(ids(scope)).toEqual(["global", "plain"]);
        expect(ids(scope, { chaId: "c", chatId: "k" })).toEqual(["global", "plain"]);
        expect(jobModules(scope).map((module) => module.name)).toEqual(["Global", "Plain"]);
    });

    it("keeps matching namespaces through the legacy lists while the same text in a link matches nothing", () => {
        // Chat `j` has `shared-ns` in `chat.modules`: the legacy list resolves the namespaced module.
        const scope = scopeOf({ characterId: "c", chatId: "j" });
        expect(ids(scope)).toEqual(["global", "nsmod"]);
        // `moduleIntergration` resolves the namespace too, for the bound chat `k`, next to its links.
        const integrated = scopeOf({ characterId: "c", chatId: "k", moduleIntergration: "shared-ns" });
        expect(ids(integrated)).toEqual(["global", "plain", "nsmod"]);
        // An MCP module named by a legacy list does resolve (only the persona path excludes it).
        const mcpEnabled = scopeOf({ characterId: "c", chatId: "k" });
        (mcpEnabled.db as { enabledModules: string[] }).enabledModules = ["global", "mcpmod"];
        expect(ids(mcpEnabled)).toEqual(["global", "plain", "mcpmod"]);
    });

    it("gives an unbound chat and a chat bound to a deleted persona only the legacy lists", () => {
        expect(ids(scopeOf({ characterId: "c", chatId: "j" }))).toEqual(["global", "nsmod"]);
        expect(ids(scopeOf({ characterId: "c", chatId: "g" }))).toEqual(["global"]);
        // A persona without the field links nothing.
        const bare = scopeOf({ characterId: "c", chatId: "k" });
        (bare.db as { personas: RisuPersona[] }).personas = [{ ...mina, modules: undefined }];
        expect(ids(bare)).toEqual(["global"]);
    });

    it("resolves a ref's own chat, never the job's chat, and the group's chat by the group's ref", () => {
        const scope = scopeOf({ characterId: "c", chatId: "k" });
        // The job's chat `k` is bound to Mina; a ref to `j` or `g` reads that chat's binding.
        expect(ids(scope, { chaId: "c", chatId: "j" })).toEqual(["global", "nsmod"]);
        expect(ids(scope, { chaId: "c", chatId: "g" })).toEqual(["global"]);
        // A group chat bound to Mina: the links resolve by the group's own ref (the chat owner), with
        // no `character.modules` of its own.
        const groupScope = scopeOf({ characterId: "grp", chatId: "gk" });
        expect(ids(groupScope)).toEqual(["global", "plain"]);
        expect(ids(groupScope, { chaId: "grp", chatId: "gk" })).toEqual(["global", "plain"]);
        // A speaker's ref names a chat the member does not hold: as for the embedded module and
        // `chat.modules`, only the member's own `character.modules` apply (the binding is the chat owner's).
        expect(ids(groupScope, { chaId: "mem", chatId: "gk" })).toEqual(["global", "chatonly"]);
    });

    it("resolves a module the enabled list and a link both name once, and a link that duplicates a stored id to the first module", () => {
        const scope = scopeOf({ characterId: "c", chatId: "k" });
        (scope.db as { modules: RisuModule[] }).modules = [
            ...modules,
            // A second module with the id `plain` (`addModule` does not refuse duplicates): first wins.
            { id: "plain", name: "Plain copy", description: "" },
        ];
        const out = jobModules(scope);
        expect(out.map((module) => module.id)).toEqual(["global", "plain"]);
        expect(out[1].name).toBe("Plain");
    });
});
