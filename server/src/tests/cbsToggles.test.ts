// @vitest-environment node
import path from "node:path";
import { expect, it } from "vitest";
import { createCbsEvaluator } from "../../../shared/cbs/evaluator.ts";
import type { Chat, character } from "../../../shared/database.ts";
import { createJobCbsHost, serverCbsLimits } from "../jobs/cbsHost.ts";
import type { JobScope } from "../jobs/jobScope.ts";

function setup() {
    const chat = {
        id: "k",
        name: "K",
        message: [],
        GLGlobalVariables: { toggle_text: "", toggle_pick: "1", toggle_flag: "" },
    } as unknown as Chat;
    const owner = {
        chaId: "c",
        type: "character",
        name: "Owner",
        chatPage: 0,
        chats: [chat],
        customModuleToggle: "owner=Owner=textarea\nmodule_first=Owner checkbox",
    } as unknown as character;
    const scope = {
        characterId: "c",
        chatId: "k",
        effectivePersona: { id: "p", name: "User", personaPrompt: "" },
        db: {
            characters: [owner],
            personas: [],
            customPromptTemplateToggle:
                "flag=Flag\npick=Pick=select=First,Second\ntext=Text=text\nfirst=Preset first=text",
            globalChatVariables: { toggle_text: "legacy", toggle_pick: "0", toggle_flag: "1" },
            enabledModules: ["enabled"],
            modules: [
                {
                    id: "enabled",
                    name: "Enabled",
                    customModuleToggle:
                        "module=Module=select=One,Two\nfirst=Module checkbox\nmodule_first=Module first=text",
                },
                { id: "disabled", name: "Disabled", customModuleToggle: "disabled=Disabled" },
            ],
        },
    } as unknown as JobScope;
    const host = createJobCbsHost(scope, {
        rootDir: path.resolve(import.meta.dirname, "../../.."),
        setChatVar: () => false,
        limits: serverCbsLimits({ usedMs: 0 }),
    });
    return { scope, chat, owner, host, parse: createCbsEvaluator(host).risuChatParser };
}

it("resolves job toggle defaults and overrides from preset, enabled modules, and owner in join order", () => {
    const { host, parse } = setup();
    const keys = [
        "toggle_flag",
        "toggle_pick",
        "toggle_text",
        "toggle_module",
        "toggle_owner",
        "toggle_first",
        "toggle_module_first",
        "toggle_disabled",
        "toggle_unknown",
        "plain",
    ];
    for (const ref of [undefined, { chaId: "c", chatId: "k" }]) {
        expect(keys.map((key) => host.getGlobalChatVar(key, ref))).toEqual([
            "1",
            "1",
            "",
            "0",
            "",
            "",
            "",
            "null",
            "null",
            "null",
        ]);
    }
    expect(
        parse(
            "[{{getglobalvar::toggle_module}}|{{getglobalvar::toggle_owner}}|{{getglobalvar::toggle_text}}] {{#when::toggle::flag}}ON{{:else}}OFF{{/when}} {{#when::module::tis::0}}FIRST{{/when}} {{#when::module::tisnot::0}}WRONG{{:else}}ZERO{{/when}} {{? @toggle_pick + 1}}",
        ),
    ).toBe("[0||] ON FIRST ZERO 2");
});

it("follows live character definition replacements within the same job host", () => {
    const { scope, owner, host, parse } = setup();
    const read = () => [host.getGlobalChatVar("toggle_live"), parse("[{{getglobalvar::toggle_live}}]")];
    expect(read()).toEqual(["null", "[null]"]);
    // Replace the overlay record, not the host: a cached character or kind table would go stale.
    scope.db.characters[0] = { ...owner, customModuleToggle: "live=Live checkbox" };
    expect(read()).toEqual(["0", "[0]"]);
    scope.db.characters[0] = { ...owner, customModuleToggle: "live=Live text=text" };
    expect(read()).toEqual(["", "[]"]);
    scope.db.characters[0] = { ...owner, customModuleToggle: "live=Layout only=caption" };
    expect(read()).toEqual(["null", "[null]"]);
});
