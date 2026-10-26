import { formatBuildId, projectBuildInfo } from "../../shared/buildInfo.ts";

/** This bundle's build, from Vite's `define` (`vite.config.ts`); unknown where nothing defines it, as in Vitest. */
export const buildInfo = projectBuildInfo(typeof __RISU_BUILD__ === "undefined" ? null : __RISU_BUILD__);

/** The build id the menu shows (`2026.10.26 · a9fa6f8c5`), or `unknown`. */
export const buildId = formatBuildId(buildInfo) ?? "unknown";
