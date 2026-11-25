import { beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_HISTORY_SHARE_OLDER_COPIES_REMAIN } from "../../../shared/requestHistory.ts";

const deps = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("../storage/serverAuth").authFetch>() }));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: deps.authFetch }),
);

import { RequestHistoryError, shareRequestHistory } from "./requestHistory";

beforeEach(() => {
    deps.authFetch.mockReset();
});

describe("shareRequestHistory failures", () => {
    it.each([
        {
            name: "preserves the response body's code on RequestHistoryError",
            body: { error: "Older copies remain", code: REQUEST_HISTORY_SHARE_OLDER_COPIES_REMAIN },
            code: REQUEST_HISTORY_SHARE_OLDER_COPIES_REMAIN,
        },
        {
            name: "sets RequestHistoryError.code to null when the response body has no code",
            body: { error: "The shared copy could not be written" },
            code: null,
        },
    ])("$name", async ({ body, code }) => {
        deps.authFetch.mockResolvedValueOnce(Response.json(body, { status: 500 }));

        const result = shareRequestHistory({ jobId: "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c", shared: true });
        await expect(result).rejects.toBeInstanceOf(RequestHistoryError);
        await expect(result).rejects.toMatchObject({ message: body.error, status: 500, code });
    });
});
