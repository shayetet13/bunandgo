# Claude AI Integration

This directory contains utilities for integrating Claude AI into the backend.

## Setup

### 1. Get API Key

1. Go to https://console.anthropic.com
2. Sign up or log in
3. Navigate to **API Keys** → **Create Key**
4. Copy the API key

### 2. Add to `.env`

```bash
ANTHROPIC_API_KEY=sk-ant-v7-xxxxxxxxxxxxx
```

### 3. Install Dependencies

```bash
cd backend
bun add @anthropic-ai/sdk
```

## Usage

### Basic Usage (claude-client.ts)

```typescript
import { askClaude } from "./ai/claude-client.ts";

// Simple prompt
const response = await askClaude("What is 2+2?");
console.log(response);

// With system prompt
const response = await askClaude(
  "Explain quantum computing",
  "claude-sonnet-5",
  "You are a physics expert. Keep explanations concise."
);

// With conversation history
const history = [
  { role: "user", content: "What is AI?" },
  { role: "assistant", content: "AI is artificial intelligence..." }
];
const response = await askClaude(
  "Can you elaborate?",
  "claude-sonnet-5",
  undefined,
  history
);
```

### Streaming Responses

```typescript
import { askClaudeWithStream } from "./ai/claude-client.ts";

await askClaudeWithStream(
  "Write a poem about cats",
  (chunk) => {
    process.stdout.write(chunk);
  },
  "claude-sonnet-5"
);
```

### API Endpoints (Example)

See `claude-example-endpoint.ts` for ready-to-use endpoints:

#### POST /api/claude/ask

Request:
```json
{
  "prompt": "Hello, how are you?",
  "model": "claude-sonnet-5",
  "systemPrompt": "You are a helpful assistant"
}
```

Response:
```json
{
  "success": true,
  "response": "I'm doing well, thank you for asking!..."
}
```

#### POST /api/claude/ask-stream

Same request body, but streams the response as Server-Sent Events (SSE).

## Models

- **claude-fable-5**: Fast, economical, 90% of Sonnet capability. Best for lightweight tasks.
- **claude-sonnet-5**: Balanced, great for coding and general use.
- **claude-opus-5**: Most capable, best for complex reasoning and analysis.

## Error Handling

All functions throw on API errors. Catch with:

```typescript
try {
  const response = await askClaude("prompt");
} catch (error) {
  console.error("Claude API error:", error);
}
```

## Integration Notes

- API key is required in `.env` to use Claude functions
- Streaming is useful for long-running operations (show progress to users)
- Keep `max_tokens` reasonable to control costs and latency
- System prompts help guide Claude's behavior
