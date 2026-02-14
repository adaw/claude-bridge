# Claude Bridge

> OpenAI-compatible API proxy for Anthropic Claude models.  
> Use any OpenAI SDK client with your Claude API key or OAuth token.

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Your App            │────▶│  Claude Bridge    │────▶│  Anthropic API      │
│  (OpenAI SDK/client) │     │  (Express :8080)  │     │  api.anthropic.com  │
└─────────────────────┘     └──────────────────┘     └─────────────────────┘
```

**Works with:** Cursor, Continue, Open WebUI, OpenClaw, LiteLLM, LangChain, any OpenAI-compatible client.

## Features

- ✅ **Chat Completions** (`/v1/chat/completions`) — streaming & non-streaming
- ✅ **Legacy Completions** (`/v1/completions`)
- ✅ **Models endpoint** (`/v1/models`)
- ✅ **Vision / Images** — base64 and URL image inputs
- ✅ **Streaming** — real-time SSE, same format as OpenAI
- ✅ **Model aliases** — send `gpt-4` and it routes to Claude
- ✅ **OAuth token support** — use Claude CLI OAuth tokens (no API key needed)
- ✅ **API key support** — standard Anthropic API keys work too
- ✅ **Docker ready** — one command to deploy
- ✅ **Health check** — `/health` endpoint for monitoring

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/adaw/claude-bridge.git
cd claude-bridge
cp .env.example .env
# Edit .env — add your token (see Authentication below)
docker compose up -d
```

Bridge is now running at `http://localhost:8088/v1`.

### Node.js

```bash
git clone https://github.com/adaw/claude-bridge.git
cd claude-bridge
npm install
cp .env.example .env
# Edit .env — add your token
node server.js
```

## Authentication

Claude Bridge supports two authentication methods:

### Option 1: Anthropic API Key

Standard API key from [console.anthropic.com](https://console.anthropic.com).

```env
ANTHROPIC_AUTH_TOKEN=sk-ant-api03-xxxxx
```

### Option 2: Claude CLI OAuth Token

If you have Claude CLI (`@anthropic-ai/claude-code`) authenticated, you can use its OAuth token. This uses your CLI subscription — no separate API billing.

```env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

To get your OAuth token:
```bash
# Install Claude CLI
npm install -g @anthropic-ai/claude-code

# Authenticate (opens browser)
claude auth login

# Find the token
cat ~/.claude/credentials.json
# Look for the access_token field
```

OAuth tokens are auto-detected (they contain `sk-ant-oat`) and get the required Claude Code identity headers.

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `DEFAULT_MODEL` | `claude-sonnet-4-5-20250929` | Fallback model when none specified |
| `ANTHROPIC_AUTH_TOKEN` | — | Anthropic API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude CLI OAuth token (takes priority) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic API base URL |
| `REQUEST_BODY_LIMIT` | `10mb` | Max request body size |
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |

## Available Models

| Model ID | Alias |
|----------|-------|
| `claude-opus-4-6` | `opus` |
| `claude-opus-4-5-20251101` | `opus4.5` |
| `claude-sonnet-4-5-20250929` | `sonnet` |
| `claude-opus-4-20250514` | `opus4` |
| `claude-sonnet-4-20250514` | — |
| `claude-haiku-3-5-20241022` | `haiku` |

OpenAI model names are automatically mapped:
- `gpt-4`, `gpt-4o`, `gpt-4-turbo` → default model
- `gpt-3.5-turbo` → Haiku

## Usage Examples

### curl

```bash
curl http://localhost:8088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8088/v1",
    api_key="not-needed"  # auth handled by bridge
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5-20250929",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Vision

```python
response = client.chat.completions.create(
    model="claude-sonnet-4-5-20250929",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
        ]
    }]
)
```

### Streaming

```python
stream = client.chat.completions.create(
    model="claude-sonnet-4-5-20250929",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### OpenClaw

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "claude-proxy": {
        "baseUrl": "http://mac.local:8088/v1",
        "apiKey": "not-needed",
        "api": "openai-completions",
        "models": [
          { "id": "claude-opus-4-6", "name": "Claude Opus 4.6 (Bridge)" },
          { "id": "claude-sonnet-4-5-20250929", "name": "Claude Sonnet 4.5 (Bridge)" }
        ]
      }
    }
  }
}
```

> **⚠️ Important:** The `"api": "openai-completions"` field and `"apiKey": "not-needed"` are **required** — without them OpenClaw won't route requests to the bridge correctly.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (streaming & non-streaming) |
| `POST` | `/v1/completions` | Legacy text completions |
| `GET` | `/v1/models` | List available models |
| `GET` | `/v1/models/:id` | Get model details |
| `GET` | `/health` | Health check |

## Docker Compose

```yaml
services:
  claude-bridge:
    build: .
    container_name: claude-bridge
    restart: unless-stopped
    ports:
      - "8088:8080"
    env_file: .env
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

## Architecture

Claude Bridge is a lightweight Express.js server (~400 lines) that:

1. **Receives** OpenAI-formatted requests
2. **Converts** messages to Anthropic format (handles system prompts, image inputs, role alternation)
3. **Forwards** to `api.anthropic.com/v1/messages` with proper auth headers
4. **Translates** the response back to OpenAI format

No database. No state. No dependencies beyond Express.

### OAuth Flow

When using OAuth tokens (`sk-ant-oat*`), the bridge adds required Claude Code identity headers:
- `Authorization: Bearer <token>` (instead of `x-api-key`)
- `anthropic-beta` headers for Claude Code features
- `user-agent` and `x-app` identity headers

This allows using your Claude CLI subscription for API access.

## License

MIT

## Contributing

Issues and PRs welcome. Keep it simple — this is a bridge, not a framework.
