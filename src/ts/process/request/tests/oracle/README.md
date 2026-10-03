# Client provider adapters (test oracles)

The browser's provider adapters as they were before the Phase 5 cutover at `219dfb51`
(`anthropic.ts`, `google.ts`, `openAI/`; only their import paths changed when they moved here). No
production code imports them: since the cutover every built-in provider request goes through the
server (`server/src/llm/`, the ports of these files); a plugin provider and a browser WebLLM model
still run in the tab by design. They are kept only as the
differential oracle of `../serverParity.test.ts` and `../../openAI/requests.responses.test.ts`, and
are removed with those tests in Phase 6's closeout.
