/**
 * The first path segment of every client route other than `/`. The server serves the client for
 * these paths, so a reload or a link lands on its screen; the client parses the rest
 * (`src/ts/router/routes.ts`).
 */
export const CLIENT_ROUTE_SEGMENTS: readonly string[] = ["chat", "playground", "realm", "characters", "settings"];

/** Whether `path` (a URL pathname, without the query) belongs to a client route other than `/`. */
export function isClientRoutePath(path: string): boolean {
    return CLIENT_ROUTE_SEGMENTS.includes(path.split("/")[1] ?? "");
}
