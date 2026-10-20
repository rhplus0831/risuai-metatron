import { readable, writable } from "svelte/store";
import { vi } from "vitest";

type AlertModule = typeof import("src/ts/alert");

/**
 * Every export of `src/ts/alert.ts` as a mock, for `vi.mock`. The callable exports are `vi.fn()`s;
 * an awaited helper resolves with what the real one returns when its dialog is dismissed (`false`,
 * `""`, `NaN`, a `cancel` card export). The stores are plain stores holding nothing. The defaults
 * `satisfies` the module's type, so a new or reshaped export of `alert.ts` fails `pnpm check` here
 * instead of failing a test that reaches it under load.
 *
 * Load it inside the hoisted factory, and pass a file's own handles as `overrides`:
 *
 * ```ts
 * vi.mock("src/ts/alert", async () =>
 *     (await import("src/ts/tests/alertMock")).createAlertMock({ alertError: mocks.alertError }),
 * );
 * ```
 */
export function createAlertMock(overrides: Partial<AlertModule> = {}): AlertModule {
    const defaults = {
        alertGenerationInfoStore: writable(null),
        alertStore: { set: vi.fn<AlertModule["alertStore"]["set"]>() },
        alertError: vi.fn<AlertModule["alertError"]>(),
        alertJobError: vi.fn<AlertModule["alertJobError"]>(),
        waitAlert: vi.fn(async () => {}),
        terminalNotice: readable<string | null>(null),
        alertTerminal: vi.fn(async (_msg: string) => {}),
        terminalNoticeShown: vi.fn(() => false),
        acknowledgeTerminalNotice: vi.fn(),
        reloadNotice: readable<string | null>(null),
        alertReloadNotice: vi.fn<AlertModule["alertReloadNotice"]>(),
        dismissReloadNotice: vi.fn(),
        alertNormal: vi.fn<AlertModule["alertNormal"]>(),
        alertNormalWait: vi.fn(async (_msg: string) => {}),
        alertAddCharacter: vi.fn(async () => ""),
        alertChatOptions: vi.fn(async () => NaN),
        alertSelect: vi.fn(async (_msg: string[], _display?: string) => ""),
        alertErrorWait: vi.fn(async (_msg: string) => {}),
        alertMd: vi.fn<AlertModule["alertMd"]>(),
        doingAlert: vi.fn(() => false),
        alertToast: vi.fn<AlertModule["alertToast"]>(),
        alertWait: vi.fn<AlertModule["alertWait"]>(),
        alertClear: vi.fn(),
        alertSelectChar: vi.fn(async () => ""),
        alertConfirm: vi.fn(async (_msg: string) => false),
        alertPluginConfirm: vi.fn(async (_msg: string) => false),
        alertCardExport: vi.fn(async () => ({ type: "cancel", type2: "" })),
        alertInput: vi.fn(async (_msg: string, _datalist?: [string, string][], _defaultValue?: string) => ""),
        alertModuleSelect: vi.fn(async () => ""),
        alertRequestData: vi.fn<AlertModule["alertRequestData"]>(),
        showHypaV2Alert: vi.fn(),
        alertRequestLogs: vi.fn<AlertModule["alertRequestLogs"]>(),
    } satisfies AlertModule;
    return { ...defaults, ...overrides };
}
