import { describe, expect, it } from "vitest";
import { GENERATION_ERROR_REASONS, GENERATION_ERROR_STAGES } from "../../../shared/jobs.ts";
import type { JobFailureInfo } from "../alert";
import { jobDebugInfo } from "./jobDebugInfo";

// The job error alert's "Copy debug info" block. Built only from the named fields, each checked; the
// job's message never reaches it.

const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
const REQUEST = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PRIVATE = "Private Character said: rate_limit_exceeded at 2026-10-13T00:00:00.000Z setup";
const failure = (
    end: Partial<JobFailureInfo["end"]> = {},
    at = Date.UTC(2026, 9, 13, 12, 30, 15, 250),
): JobFailureInfo => ({
    jobId: JOB,
    at,
    end: {
        type: "error",
        epoch: "e",
        message: PRIVATE,
        status: 429,
        reason: "failed",
        stage: "request",
        requestId: REQUEST,
        providerCode: "rate_limit_exceeded",
        ...end,
    },
});

describe("jobDebugInfo", () => {
    it("is the fixed English block of the version, time, job, request, stage, status, reason, and provider code", () => {
        expect(jobDebugInfo(failure(), "1.2.3")).toBe(
            [
                "RisuAI job failure",
                "Version: 1.2.3",
                "Time: 2026-10-13T12:30:15.250Z",
                `Job: ${JOB}`,
                `Request: ${REQUEST}`,
                "Stage: request",
                "Status: 429",
                "Reason: failed",
                "Provider code: rate_limit_exceeded",
            ].join("\n"),
        );
    });

    it("never holds the message, whatever it says, and nothing of the terminal beyond the named fields", () => {
        const block = jobDebugInfo(
            {
                ...failure({ message: "boom\nStage: tail\nJob: leaked" }),
                end: {
                    ...failure().end,
                    message: "boom\nStage: tail\nJob: leaked",
                    ...({ extra: "leaked field", stack: "at private.ts:1:1" } as object),
                },
            },
            "1.2.3",
        );
        expect(block).not.toContain("boom");
        expect(block).not.toContain("leaked");
        expect(block).not.toContain("private");
        expect(block.split("\n")).toHaveLength(9);
        expect(jobDebugInfo(failure(), "1.2.3")).not.toContain("Private");
    });

    it("leaves out a field that fails its check: a text as an id, a stage or reason outside its list, a status outside 100–999 or not an integer, a text as a provider code, a version with spaces or over-long, an invalid time", () => {
        expect(
            jobDebugInfo(
                {
                    jobId: "Private Character",
                    at: Number.NaN,
                    end: {
                        type: "error",
                        epoch: "e",
                        message: "m",
                        status: 99,
                        reason: "exploded" as never,
                        stage: "parsing" as never,
                        requestId: "r/1",
                        providerCode: "rate limit exceeded",
                    },
                },
                "version 1 with spaces",
            ),
        ).toBe("RisuAI job failure");
        expect(jobDebugInfo(failure({ status: 1000 }, 1e20), "x".repeat(33))).toBe(
            [
                "RisuAI job failure",
                `Job: ${JOB}`,
                `Request: ${REQUEST}`,
                "Stage: request",
                "Reason: failed",
                "Provider code: rate_limit_exceeded",
            ].join("\n"),
        );
        expect(jobDebugInfo(failure({ status: 500.5 }, -1e20), "1.0")).not.toContain("Status");
        expect(jobDebugInfo(failure({ status: 500.5 }, -1e20), "1.0")).not.toContain("Time");
        // The optional fields absent: the block is shorter, in the same order.
        expect(jobDebugInfo(failure({ stage: undefined, requestId: undefined, providerCode: undefined }), "1.0")).toBe(
            [
                "RisuAI job failure",
                "Version: 1.0",
                "Time: 2026-10-13T12:30:15.250Z",
                `Job: ${JOB}`,
                "Status: 429",
                "Reason: failed",
            ].join("\n"),
        );
    });

    it("accepts every stage and reason of the shared lists, the status bounds, and a code at the pattern's bound", () => {
        for (const stage of GENERATION_ERROR_STAGES) {
            expect(jobDebugInfo(failure({ stage }), "1.0")).toContain(`Stage: ${stage}`);
        }
        for (const reason of GENERATION_ERROR_REASONS) {
            expect(jobDebugInfo(failure({ reason }), "1.0")).toContain(`Reason: ${reason}`);
        }
        expect(jobDebugInfo(failure({ status: 100 }), "1.0")).toContain("Status: 100");
        expect(jobDebugInfo(failure({ status: 999 }), "1.0")).toContain("Status: 999");
        expect(jobDebugInfo(failure({ providerCode: "x".repeat(64) }), "1.0")).toContain(
            `Provider code: ${"x".repeat(64)}`,
        );
        expect(jobDebugInfo(failure({ providerCode: "x".repeat(65) }), "1.0")).not.toContain("Provider code");
        expect(jobDebugInfo(failure(), "2.0.0-beta.1+build")).toContain("Version: 2.0.0-beta.1+build");
    });
});
