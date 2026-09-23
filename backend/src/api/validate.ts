import type { ZodError } from "zod";

/**
 * Flattens the first Zod issue into a single-line message for API error
 * responses. Call `schema.safeParse(body)` directly at each route and branch
 * on `result.success` yourself — narrowing that discriminant through a
 * shared generic wrapper does not reliably narrow under this project's
 * non-strict tsconfig, so this only formats, it doesn't branch.
 */
export function formatZodError(error: ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "invalid request body";
	const path = issue.path.join(".");
	return path ? `${path}: ${issue.message}` : issue.message;
}
