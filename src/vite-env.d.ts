/// <reference types="svelte" />
/// <reference types="vite/client" />

declare var Buffer: BufferConstructor;
declare var safeStructuredClone: <T>(data: T) => T;
declare var userScriptFetch: (url: string, arg: RequestInit) => Promise<Response>;
/** The build (`shared/buildInfo.ts` `BuildInfo`) Vite's `define` puts in the bundle; read it through `src/ts/buildInfo.ts`. */
declare const __RISU_BUILD__: unknown;
