/**
 * Client entrypoint for validation errors, JSON checks, detached copies, and field writes from
 * `shared/mutationValidation.ts`. `server/src/mcp/internal.ts` imports those helpers directly,
 * keeping client mutations and the server's MCP tools on the same validation rules.
 */

export * from "../../../shared/mutationValidation.ts";
