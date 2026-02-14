# Claude Bridge

OpenAI-compatible API server that bridges requests to Claude CLI. Use any OpenAI-compatible client (Cursor, Continue, Open WebUI, OpenClaw, LiteLLM, etc.) with your Claude CLI OAuth authentication.

```
Your App (OpenAI SDK)
    |
Claude Bridge (Express :8080)
    |
Claude CLI (--print --output-format json/stream-json)
    |
Anthropic API
```

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Claude CLI authenticated (`claude --print "test"` must work)

### Run with Docker

```bash
cp .env.example .env
# Edit .env - set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY

docker compose up -d
```

### Run locally (no Docker)

```bash
npm install
node server.js
# or with auto-reload:
npm run dev
```

### Test

```bash
# Health check
curl http://localhost:8080/health

# List models
curl http://localhost:8080/v1/models

# Chat completion
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl -N http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

## Usage with OpenAI SDK

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="not-needed"  # Auth handled by Claude CLI
)

response = client.chat.completions.create(
    model="sonnet",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the meaning of life?"}
    ]
)
print(response.choices[0].message.content)
```

### Python (Streaming)

```python
stream = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Write a poem"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'not-needed',
});

const response = await client.chat.completions.create({
  model: 'sonnet',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.choices[0].message.content);
```

## Model Aliases

You can use short aliases or even OpenAI model names:

| Alias | Maps to |
|---|---|
| `sonnet` | `claude-sonnet-4-5-20250929` |
| `opus` | `claude-opus-4-20250514` |
| `haiku` | `claude-haiku-3-5-20241022` |
| `gpt-4` / `gpt-4o` / `gpt-4-turbo` | Default model (sonnet) |
| `gpt-3.5-turbo` | `claude-haiku-3-5-20241022` |

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Server port |
| `DEFAULT_MODEL` | `claude-sonnet-4-5-20250929` | Default model when not specified |
| `LOG_LEVEL` | `info` | `info` or `debug` |
| `CLI_TIMEOUT_MS` | `300000` | CLI timeout (5 min) |
| `MAX_CONCURRENT` | `10` | Max concurrent CLI processes |
| `CLAUDE_CLI_PATH` | `claude` | Path to Claude CLI binary |

## Supported Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check with active process count |
| `GET /v1/models` | List available Claude models |
| `GET /v1/models/:id` | Get single model info |
| `POST /v1/chat/completions` | Chat completions (streaming + non-streaming) |
| `POST /v1/completions` | Legacy text completions |

## Authentication

Claude CLI in Docker cannot open a browser for OAuth login. Options:

### Method 1: OAuth Token (recommended for Max/Pro)

```bash
# On your Mac:
claude setup-token
# Copy the token to .env:
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

### Method 2: API Key (uses API credits)

```bash
# From https://console.anthropic.com
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Method 3: Mount credentials

Docker Compose already mounts `~/.claude` read-only. May break when tokens expire.

## Architecture

- Each API request spawns a fresh Claude CLI process (`--no-session-persistence`)
- Non-streaming: `--output-format json` returns structured result with real token usage
- Streaming: `--output-format stream-json --include-partial-messages` provides token-by-token SSE
- Concurrency limiter prevents spawning too many CLI processes
- Graceful shutdown on SIGTERM/SIGINT
- Input validation matches OpenAI error format
- System prompts passed via `--system-prompt` flag
- Multi-turn conversations formatted with `Human:` / `Assistant:` role prefixes

## Limitations

- Each request = new CLI process (~2-5s startup overhead)
- Image/vision inputs not supported (text-only)
- Tool use / function calling not supported
- Rate limits governed by your Claude CLI subscription
- `temperature`, `top_p`, `stop` parameters are accepted but not passed through (CLI doesn't support them)

## License

MIT
