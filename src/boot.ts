import { startDiagnosticsCollector } from "./ts/diagnostics/collector";

/**
 * The app's entry on the self-host server (`src/main.ts`): the diagnostics collector starts first,
 * before the app's modules are even loaded, so a failure while they load or start is recorded too;
 * then the app starts (`startApp.ts`).
 */
export async function boot() {
    startDiagnosticsCollector();
    const { startApp } = await import("./startApp");
    startApp();
}
