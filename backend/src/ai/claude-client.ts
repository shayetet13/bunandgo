import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface ClaudeMessage {
	role: "user" | "assistant";
	content: string;
}

export async function askClaude(
	prompt: string,
	model: "claude-fable-5" | "claude-sonnet-5" | "claude-opus-5" = "claude-sonnet-5",
	systemPrompt?: string,
	conversationHistory: ClaudeMessage[] = [],
) {
	try {
		const messages: Anthropic.MessageParam[] = [
			...conversationHistory,
			{ role: "user", content: prompt },
		];

		const params: Anthropic.MessageCreateParams = {
			model,
			max_tokens: 1024,
			messages,
		};

		if (systemPrompt) {
			params.system = systemPrompt;
		}

		const response = await client.messages.create(params);

		if (response.content[0]?.type === "text") {
			return response.content[0].text;
		}

		return "";
	} catch (error) {
		if (error instanceof Anthropic.APIError) {
			console.error("Claude API Error:", error.message);
			throw new Error(`Claude API failed: ${error.message}`);
		}
		throw error;
	}
}

export async function askClaudeWithStream(
	prompt: string,
	onChunk: (chunk: string) => void,
	model: "claude-fable-5" | "claude-sonnet-5" | "claude-opus-5" = "claude-sonnet-5",
	systemPrompt?: string,
) {
	try {
		const params: Anthropic.MessageCreateParams = {
			model,
			max_tokens: 1024,
			messages: [{ role: "user", content: prompt }],
		};

		if (systemPrompt) {
			params.system = systemPrompt;
		}

		const stream = await client.messages.create({
			...params,
			stream: true,
		});

		for await (const event of stream) {
			if (
				event.type === "content_block_delta" &&
				event.delta?.type === "text_delta" &&
				event.delta.text
			) {
				onChunk(event.delta.text);
			}
		}
	} catch (error) {
		if (error instanceof Anthropic.APIError) {
			console.error("Claude API Error:", error.message);
			throw new Error(`Claude API failed: ${error.message}`);
		}
		throw error;
	}
}
