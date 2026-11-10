import { Agent } from "undici";

// Long non-streaming generations can exceed undici's 300 s header and body timeout defaults.
export const PROVIDER_RESPONSE_TIMEOUT_MS = 30 * 60_000;

const providerDispatcher = new Agent({
    headersTimeout: PROVIDER_RESPONSE_TIMEOUT_MS,
    bodyTimeout: PROVIDER_RESPONSE_TIMEOUT_MS,
});

export const providerFetch: typeof fetch = (input, init) => {
    const providerInit = { ...init, dispatcher: providerDispatcher };
    return fetch(input, providerInit);
};
