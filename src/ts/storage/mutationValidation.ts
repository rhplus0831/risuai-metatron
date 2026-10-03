// The mutation checks live in `shared/` (the server's MCP tools validate with them too, Phase 5
// slice 12b); the client's mutation modules import them from here.
export * from "../../../shared/mutationValidation.ts";
