// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

type HostApi = Record<string, (...args: any[]) => any>;
const captured = vi.hoisted(() => ({ api: null as HostApi | null }));

// Only the sandbox transport is replaced; listeners are registered through the real host API.
vi.mock("./factory", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./factory")>()),
    SandboxHost: class {
        constructor(api: HostApi) {
            captured.api = api;
        }
        run() {}
    },
}));
vi.mock("./permissionStore", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./permissionStore")>()),
    hasPermissionGrant: () => true,
    recordPermissionGrants: vi.fn(async () => undefined),
}));
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);

import { acknowledgeTerminalNotice, alertTerminal } from "src/ts/alert";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { executePluginV3 } from "./v3.svelte";

afterEach(() => {
    acknowledgeTerminalNotice();
    document.body.replaceChildren();
    vi.useRealTimers();
});

it("withholds acknowledgement keypress and keyup and all later keys from capture and bubbling plugin listeners", async () => {
    installFlatDatabaseWithChats({ characters: [] });
    await executePluginV3({
        name: "terminal-key-listeners",
        script: "",
        version: "3.0",
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
    });
    const root = await captured.api!.getRootDocument();
    const delivered: string[] = [];
    const registrations: { type: string; id: string; capture: boolean }[] = [];
    for (const type of ["keydown", "keypress", "keyup"]) {
        for (const capture of [true, false]) {
            const id = await root.addEventListener(
                type,
                (event: KeyboardEvent) => delivered.push(`${type}:${capture}:${event.key}`),
                capture,
            );
            registrations.push({ type, id, capture });
        }
    }
    vi.useFakeTimers();
    const dispatch = (type: string, key: string) =>
        document.body.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
    try {
        for (const type of ["keydown", "keypress", "keyup"]) dispatch(type, "a");
        await vi.advanceTimersByTimeAsync(100);
        expect(delivered.sort()).toEqual(
            [
                "keydown:true:a",
                "keydown:false:a",
                "keypress:true:a",
                "keypress:false:a",
                "keyup:true:a",
                "keyup:false:a",
            ].sort(),
        );
        delivered.length = 0;

        const notice = alertTerminal("Restored; reload required");
        for (const type of ["keydown", "keypress", "keyup"]) dispatch(type, "s");
        dispatch("keydown", "Enter");
        acknowledgeTerminalNotice();
        await notice;
        dispatch("keypress", "Enter");
        dispatch("keyup", "Enter");
        // The document is still the restored page: even a fresh stroke stays gated until reload.
        for (const type of ["keydown", "keypress", "keyup"]) dispatch(type, "b");
        await vi.advanceTimersByTimeAsync(100);
        expect(delivered).toEqual([]);
    } finally {
        for (const { type, id, capture } of registrations) root.removeEventListener(type, id, capture);
    }
});
