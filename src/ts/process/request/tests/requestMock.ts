import { vi } from "vitest";

type Request = typeof import("../request");

/** The LLM request boundary for callers that test routing into requests rather than providers. */
export function createRequestMock(overrides: Partial<Request> = {}) {
    const defaults = {
        requestChatData: vi.fn<Request["requestChatData"]>(async () => ({ type: "success", result: "" })),
        requestChatDataMain: vi.fn<Request["requestChatDataMain"]>(async () => ({ type: "success", result: "" })),
        requestChatHeld: vi.fn<Request["requestChatHeld"]>(() => true),
        withRequestChat: vi.fn<Request["withRequestChat"]>(async (_target, run) => run()),
        reformater: vi.fn<Request["reformater"]>((formated) => formated),
    } satisfies Request;
    return { ...defaults, ...overrides };
}
