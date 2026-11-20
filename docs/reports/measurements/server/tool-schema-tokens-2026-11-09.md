# Tool schema tokens — 2026-11-09

What was measured: how many tokens the MCP tool descriptors a job offers add to a provider request, which prompt
assembly's final recheck did not count before `AssemblyHost.toolSchemaTokens`.

How: the descriptors serialized by `server/src/llm/toolSchemas.ts` `serializeToolSchemas` in each adapter's tools form,
encoded with the server tokenizers (`server/src/prompt/tokenizers/index.ts` `createTokenizers`), on the tree the charge
landed in. A throwaway script; nothing in the repository runs it.

| Tool set                                                                           | Tools | GPT-4o (`o200k_base`, chat form) | Claude (`claude`, Messages form) | Gemini (`gemma`, `functionDeclarations`) |
| ---------------------------------------------------------------------------------- | ----: | -------------------------------: | -------------------------------: | ---------------------------------------: |
| `server/src/tests/mcp.test.ts` fixture: two remote servers (`echo` twice, `other`) |     3 |                               86 |                               71 |                                       68 |
| `internal:dice` and `internal:aiaccess`                                            |     2 |                              223 |                              217 |                                      211 |
| `internal:graphmem` and `internal:risuaccess`                                      |    29 |                            3,104 |                            3,117 |                                    2,860 |

Reading: the test fixtures are small, but two real internal servers cost about 3,000 tokens, so a prompt assembled to
`maxContext − maxResponse` could exceed the provider's context by that much. The gap is real and the recheck now charges
it.
