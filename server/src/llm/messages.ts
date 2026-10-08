// The client's `language` strings the request layer shows (`src/lang/en.ts`). Server messages are
// English whatever the tab's language (recorded in `request-layer-and-llm-secrets.md`).
export const messages = {
    errors: {
        unknownModel: "Error: Unknown model selected",
        httpError: "Error: error in request:",
        credentialRefused: (model: string, name: string | undefined, reason: string) =>
            `Cannot request model "${model}"${name === undefined ? "" : ` with credential "${name}"`}: ${reason}`,
        credentialMissing: "The bound credential no longer exists.",
        credentialEmpty: "The bound credential has no key.",
        credentialTypeMismatch: "The bound credential's type is not accepted by this model.",
        credentialVertexEmailMissing: "The bound Vertex credential has no client email.",
        credentialUnsupportedModel: "This model does not accept a credential binding.",
    },
    /** The RisuAccess consent prompt (`language.mcpAccessPrompt`). */
    mcpAccessPrompt: '{{tool}} is trying to "{{action}}". Do you want to allow this?',
    pluginProviderNotFound: "Unknown Plugin detected. Please change the model or enable the corresponding plugin.",
};
