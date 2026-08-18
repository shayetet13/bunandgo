import { Hono } from "hono";
import { z } from "zod";
import { askClaude, askClaudeWithStream } from "./claude-client.ts";

export const claudeRoute = new Hono();

const askSchema = z.object({
	prompt: z.string().min(1),
	model: z
		.enum(["claude-fable-5", "claude-sonnet-5", "claude-opus-5"])
		.optional()
		.default("claude-sonnet-5"),
	systemPrompt: z.string().optional(),
});

// POST /api/claude/ask - Send a prompt and get a response
claudeRoute.post("/ask", async (c) => {
	try {
		const body = await c.req.json();
		const { prompt, model, systemPrompt } = askSchema.parse(body);

		const response = await askClaude(prompt, model, systemPrompt);

		return c.json({ success: true, response });
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({ success: false, error: error.errors }, 400);
		}
		return c.json(
			{ success: false, error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

// POST /api/claude/ask-stream - Send a prompt and stream the response (SSE)
claudeRoute.post("/ask-stream", async (c) => {
	try {
		const body = await c.req.json();
		const { prompt, model, systemPrompt } = askSchema.parse(body);

		c.header("Content-Type", "text/event-stream");
		c.header("Cache-Control", "no-cache");
		c.header("Connection", "keep-alive");

		const encoder = new TextEncoder();
		let isFirstChunk = true;

		await askClaudeWithStream(
			prompt,
			(chunk) => {
				const data = JSON.stringify({ chunk });
				const sseMessage = `data: ${data}\n\n`;
				c.res.write?.(encoder.encode(sseMessage));

				if (isFirstChunk) {
					isFirstChunk = false;
				}
			},
			model,
			systemPrompt,
		);

		c.res.write?.(encoder.encode("data: [DONE]\n\n"));
		return c.body(null);
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({ success: false, error: error.errors }, 400);
		}
		return c.json(
			{ success: false, error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});
