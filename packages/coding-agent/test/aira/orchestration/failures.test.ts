/**
 * Step 8 — deterministic child-failure classification.
 *
 * A failed child run must distinguish "the delegated work failed" from "a
 * required capability/provider/environment could not run the work". These tests
 * pin the classifier to structured evidence only: typed errors, Node error
 * codes, provider status/codes, explicit timeout/cancel state. Unknown stays
 * unknown, and secret-bearing provider material never survives into the
 * preserved message.
 */
import { describe, expect, it } from "vitest";
import {
	AiraCapabilityError,
	AiraEnvironmentError,
	buildAiraChildFailure,
	classifyAiraChildFailure,
	sanitizeAiraFailureMessage,
	toAiraFailureEvidence,
} from "../../../src/aira/orchestration/failures.ts";

describe("Aira child-failure classification (Step 8)", () => {
	it("classifies a child that ran and missed acceptance criteria as task_failure", () => {
		const failure = classifyAiraChildFailure({
			origin: "task",
			message: "tests prove the proposed change is wrong",
			component: "child-run",
			operation: "acceptance",
		});
		expect(failure.kind).toBe("task_failure");
		expect(failure.category).toBe("driver");
		expect(failure.taskStatus).toBe("attempted");
		expect(failure.retryableHint).toBe("no");
		expect(failure.message).toBe("tests prove the proposed change is wrong");
	});

	it("classifies a failed child-session capability as capability_failure", () => {
		const failure = classifyAiraChildFailure({
			origin: "capability",
			message: "provider rejected child session creation",
			component: "child-provider",
			operation: "stream",
			code: "MissingSessionID",
			taskStatus: "attempted",
		});
		expect(failure.kind).toBe("capability_failure");
		expect(failure.component).toBe("child-provider");
		expect(failure.operation).toBe("stream");
		expect(failure.code).toBe("MissingSessionID");
		expect(failure.taskStatus).toBe("attempted");
	});

	it("classifies a structured provider rejection as capability_failure, never task failure", () => {
		const failure = classifyAiraChildFailure({
			origin: "capability",
			message: "HTTP 400: missing required session header",
			status: 400,
			component: "child-provider",
			operation: "request",
		});
		expect(failure.kind).toBe("capability_failure");
		expect(failure.taskStatus).toBe("not_attempted");
		expect(failure.retryableHint).toBe("no");
		expect(failure.retryable).toBe(false);
	});

	it("marks retryable provider statuses as advisory metadata only", () => {
		const throttled = classifyAiraChildFailure({
			origin: "capability",
			status: 429,
			message: "rate limited",
		});
		expect(throttled.kind).toBe("capability_failure");
		expect(throttled.retryableHint).toBe("yes");
		expect(throttled.retryable).toBe(true);

		const unavailable = classifyAiraChildFailure({
			origin: "capability",
			status: 503,
			message: "provider unavailable",
		});
		expect(unavailable.retryableHint).toBe("yes");

		// 401/403 are permission problems: capability failure, not retryable work.
		const denied = classifyAiraChildFailure({ origin: "capability", status: 403, message: "forbidden" });
		expect(denied.kind).toBe("capability_failure");
		expect(denied.category).toBe("permission-denied");
		expect(denied.retryableHint).toBe("no");
	});

	it("classifies a missing executable (ENOENT) as environment_failure", () => {
		const failure = classifyAiraChildFailure({
			code: "ENOENT",
			message: "spawn csharp-ls ENOENT",
			component: "csharp-ls",
			operation: "launch",
		});
		expect(failure.kind).toBe("environment_failure");
		expect(failure.component).toBe("csharp-ls");
		expect(failure.operation).toBe("launch");
		expect(failure.code).toBe("ENOENT");
		expect(failure.taskStatus).toBe("not_attempted");
	});

	it("classifies a permission failure (EACCES) as environment_failure", () => {
		const failure = classifyAiraChildFailure({
			code: "EACCES",
			message: "EACCES: permission denied, open '/usr/local/bin/tool'",
			component: "tool",
			operation: "launch",
		});
		expect(failure.kind).toBe("environment_failure");
		expect(failure.category).toBe("permission-denied");
	});

	it("classifies timeout and cancellation distinctly from task failure", () => {
		const timeout = classifyAiraChildFailure({
			timedOut: true,
			message: "child timed out after 120000ms",
			component: "child-run",
			operation: "timeout",
		});
		expect(timeout.kind).toBe("timeout");
		expect(timeout.category).toBe("timeout");
		expect(timeout.taskStatus).toBe("attempted");

		const cancelled = classifyAiraChildFailure({
			cancelled: true,
			message: "child cancelled",
			component: "child-run",
			operation: "cancel",
		});
		expect(cancelled.kind).toBe("cancelled");
		expect(cancelled.category).toBe("cancelled");
	});

	it("leaves an unrecognized error as unknown_failure without guessing", () => {
		const failure = classifyAiraChildFailure({ message: "something odd happened" });
		expect(failure.kind).toBe("unknown_failure");
		expect(failure.category).toBe("driver");
		expect(failure.taskStatus).toBe("unknown");
		expect(failure.retryableHint).toBe("unknown");
	});

	it("reads typed Aira capability/environment errors as structured evidence", () => {
		const capability = toAiraFailureEvidence(
			new AiraCapabilityError("child session could not be created", {
				code: "MissingSessionID",
				component: "child-session",
				operation: "create",
			}),
			"fallback",
		);
		const classified = classifyAiraChildFailure(capability);
		expect(classified.kind).toBe("capability_failure");
		expect(classified.code).toBe("MissingSessionID");
		expect(classified.component).toBe("child-session");
		expect(classified.operation).toBe("create");

		const environment = classifyAiraChildFailure(
			toAiraFailureEvidence(
				new AiraEnvironmentError("csharp-ls executable not found", {
					code: "ENOENT",
					component: "csharp-ls",
					operation: "launch",
				}),
				"fallback",
			),
		);
		expect(environment.kind).toBe("environment_failure");
		expect(environment.code).toBe("ENOENT");
	});

	it("reads Node codes and provider statuses off thrown plain errors", () => {
		const spawnError = Object.assign(new Error("spawn tool ENOENT"), { code: "ENOENT" });
		const evidence = toAiraFailureEvidence(spawnError, "fallback");
		expect(evidence.code).toBe("ENOENT");
		expect(evidence.message).toBe("spawn tool ENOENT");

		const providerError = Object.assign(new Error("HTTP 400"), { status: 400 });
		const classified = classifyAiraChildFailure({ ...toAiraFailureEvidence(providerError, "fallback") });
		expect(classified.kind).toBe("capability_failure");
		expect(classified.taskStatus).toBe("not_attempted");
	});

	it("preserves the original error message as evidence", () => {
		const message =
			"child returned no valid structured result: expected JSON with status and summary, got 412 bytes of prose";
		expect(classifyAiraChildFailure({ message }).message).toBe(message);
		expect(buildAiraChildFailure({ message }).message).toBe(message);
	});

	it("sanitizes provider headers, bearer tokens, and API keys", () => {
		const sanitized = sanitizeAiraFailureMessage(
			'HTTP 401 {"authorization":"Bearer sk-live-abcdef0123456789","x-api-key": "pk-prod-998877665544332211"}',
		);
		expect(sanitized).not.toContain("sk-live-abcdef0123456789");
		expect(sanitized).not.toContain("pk-prod-998877665544332211");
		expect(sanitized).toContain("[redacted]");
		expect(sanitized).toContain("HTTP 401");
	});

	it("keeps the failure record bounded and control-character free", () => {
		const sanitized = sanitizeAiraFailureMessage(`bad\u0007message ${"x".repeat(2000)}`);
		expect(sanitized).not.toContain("\u0007");
		expect(sanitized.length).toBeLessThanOrEqual(601);
	});

	it("treats a required capability gap as capability evidence, not task evidence", () => {
		const failure = classifyAiraChildFailure({
			message: "child run failed",
			capabilityGaps: [
				{
					capability: "process",
					component: "process-manager",
					operation: "resolve",
					message: "managed execution is not configured for this session",
				},
			],
		});
		expect(failure.kind).toBe("capability_failure");
		expect(failure.component).toBe("process-manager");
		expect(failure.operation).toBe("resolve");
		expect(failure.taskStatus).toBe("not_attempted");
		expect(failure.capabilityGaps).toHaveLength(1);
	});

	it("keeps a real task failure distinguishable even when a capability gap exists", () => {
		const failure = classifyAiraChildFailure({
			origin: "task",
			message: "acceptance criteria unmet",
			capabilityGaps: [
				{ capability: "process", component: "process-manager", operation: "resolve", message: "unavailable" },
			],
		});
		expect(failure.kind).toBe("task_failure");
		expect(failure.taskStatus).toBe("attempted");
		// The gap is still reported as evidence, but it does not rewrite the kind.
		expect(failure.capabilityGaps).toHaveLength(1);
	});

	it("is deterministic: identical evidence yields identical records", () => {
		const evidence = {
			origin: "capability" as const,
			message: "provider rejected child request",
			code: "MissingSessionID",
			component: "child-provider",
			operation: "stream",
		};
		expect(classifyAiraChildFailure(evidence)).toEqual(classifyAiraChildFailure(evidence));
		// Classification is a pure mapping: no retries, no I/O, no hidden state.
		expect(classifyAiraChildFailure(evidence).kind).toBe("capability_failure");
	});
});
