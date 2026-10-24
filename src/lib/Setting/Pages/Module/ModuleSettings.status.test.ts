// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { alertData } from "src/ts/alert";

const alerts = vi.hoisted(() => ({ queue: null as unknown as import("src/ts/alertQueue").AlertQueue }));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertStore: { set: (status) => alerts.queue.set(status) },
        alertWait: vi.fn((msg, onInstall) => {
            const status: alertData = { type: "wait", msg };
            onInstall?.(status);
            alerts.queue.set(status);
        }),
        alertClear: () => alerts.queue.clearStatus(),
        alertSelect: vi.fn(async () => "0"),
    }),
);
vi.mock("src/ts/gui/tooltip", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/gui/tooltip")>()),
    tooltip: (node: HTMLElement, tip: string) => {
        node.dataset.tip = tip;
    },
}));
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);

import { language } from "src/lang";
import { alertSelect } from "src/ts/alert";
import { LocalWriter } from "src/ts/globalApi.svelte";
import * as globalApi from "src/ts/globalApi.svelte";
import * as media from "src/ts/media";
import * as assetQueue from "src/ts/storage/assetQueue";
import { pngWithText } from "src/ts/storage/tests/importFixtures";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { alertStore } from "src/ts/stores.svelte";
import ModuleSettings from "./ModuleSettings.svelte";

let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;
beforeEach(() => {
    vi.useFakeTimers();
    alerts.queue = alertStore;
    const png = pngWithText({});
    installFlatDatabaseWithChats({
        characters: [],
        enabledModules: [],
        modules: [
            {
                id: "module",
                name: "Shared",
                description: "",
                icon: "assets/icon.png",
                assets: [["image", "assets/image.png", "png"]],
            },
        ],
    });
    // The real exporters, encoders, and status queue run; asset reads, image conversion, and
    // the download stream are the I/O boundaries controlled here.
    vi.spyOn(globalApi, "readImage").mockResolvedValue(png);
    vi.spyOn(assetQueue, "loadAssetsInBatches").mockImplementation(async function* (keys) {
        for (let index = 0; index < keys.length; index++) yield { index, key: keys[index], bytes: png };
    });
    vi.spyOn(media, "compressImage").mockImplementation(async (bytes) => bytes);
    vi.spyOn(LocalWriter.prototype, "init").mockResolvedValue(true);
    vi.spyOn(LocalWriter.prototype, "write").mockResolvedValue();
    vi.spyOn(LocalWriter.prototype, "abort").mockResolvedValue();
    alertStore.clearStatus();
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(ModuleSettings, { target });
    flushSync();
});
afterEach(async () => {
    await unmount(instance);
    target.remove();
    alertStore.clearStatus();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
});

it.each([
    ["CharX", "0"],
    ["RisuM", "1"],
] as const)(
    "%s cleanup clears its own status and preserves a newer owner's status after success or failure",
    async (_format, choice) => {
        vi.mocked(alertSelect).mockResolvedValue(choice);
        const close = vi.spyOn(LocalWriter.prototype, "close");
        const share = () => target.querySelector<HTMLButtonElement>(`button[data-tip="${language.download}"]`)!.click();
        for (const phase of (_format === "CharX" ? ["wait", "progress"] : ["wait"]) as ("wait" | "progress")[]) {
            for (const outcome of phase === "progress" ? ["failure"] : ["success", "failure"]) {
                for (const newerType of [null, "wait", "progress"] as const) {
                    alertStore.clearStatus();
                    let finish!: () => void;
                    let fail!: (error: unknown) => void;
                    const pending = new Promise<void>((resolve, reject) => {
                        finish = resolve;
                        fail = reject;
                    });
                    close.mockClear().mockResolvedValue();
                    const write = vi.mocked(LocalWriter.prototype.write).mockResolvedValue();
                    if (phase === "wait") close.mockReturnValueOnce(pending);
                    else
                        write.mockImplementation(async () => {
                            if (alertStore.status()?.type === "progress") await pending;
                        });
                    share();
                    await vi.advanceTimersByTimeAsync(100);
                    if (phase === "wait") expect(close).toHaveBeenCalledOnce();
                    const owned = alertStore.status();
                    expect(owned?.type).toBe(phase);
                    // Equal content deliberately: a newer status belongs to its own operation even
                    // when its text/type matches the export's last update.
                    const newer: alertData | null = newerType ? { ...owned!, type: newerType } : null;
                    if (newer) alertStore.set(newer);
                    if (outcome === "success") finish();
                    else fail(new Error("Download failed"));
                    await vi.advanceTimersByTimeAsync(100);
                    expect(alertStore.status(), `${_format} ${phase} ${outcome} ${newerType}`).toBe(newer);
                }
            }
        }
    },
);
