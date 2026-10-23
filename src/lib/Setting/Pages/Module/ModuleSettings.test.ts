// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it } from "vitest";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import ModuleSettings from "./ModuleSettings.svelte";

let instance: ReturnType<typeof mount> | null = null;
let target: HTMLDivElement;

afterEach(async () => {
    if (instance) await unmount(instance);
    instance = null;
    target.remove();
});

it("renders modules with a missing name and sorts that name as an empty string", () => {
    installFlatDatabase({
        enabledModules: [],
        modules: [
            { id: "z", name: "Zulu", description: "" },
            { id: "unnamed", description: "" },
            { id: "a", name: "alpha", description: "" },
        ],
    });
    target = document.createElement("div");
    document.body.append(target);

    expect(() => {
        instance = mount(ModuleSettings, { target });
        flushSync();
    }).not.toThrow();
    const rows = [...target.querySelectorAll("span.text-lg")];
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).map((row) => row.textContent)).toEqual(["alpha", "Zulu"]);
});
