// The client's `language` strings the request layer shows (`src/lang/en.ts`). Server messages are
// English whatever the tab's language (recorded in `request-layer-and-llm-secrets.md`).
export const messages = {
    errors: {
        unknownModel: "Error: Unknown model selected",
        httpError: "Error: error in request:",
    },
    /** The RisuAccess consent prompt (`language.mcpAccessPrompt`). */
    mcpAccessPrompt: '{{tool}} is trying to "{{action}}". Do you want to allow this?',
    pluginProviderNotFound: "Unknown Plugin detected. Please change the model or enable the corresponding plugin.",
};
