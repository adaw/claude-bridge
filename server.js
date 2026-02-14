// ─────────────────────────────────────────────────────────────────────────────
// Claude Bridge - OpenAI-compatible API server bridging to Claude CLI
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 8080;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-5-20250929';
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const CLI_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT_MS, 10) || 300000;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT, 10) || 10;
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '10mb';

// Known Claude models for /v1/models endpoint
const KNOWN_MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5' },
];

// Model aliases - OpenAI model names map to Claude models
const MODEL_ALIASES = {
  'gpt-4': DEFAULT_MODEL,
  'gpt-4o': DEFAULT_MODEL,
  'gpt-4-turbo': DEFAULT_MODEL,
  'gpt-3.5-turbo': 'claude-haiku-3-5-20241022',
  'sonnet': 'claude-sonnet-4-5-20250929',
  'opus': 'claude-opus-4-6',
  'opus4.5': 'claude-opus-4-5-20251101',
  'opus4': 'claude-opus-4-20250514',
  'haiku': 'claude-haiku-3-5-20241022',
};

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[level] ?? 1) < (levels[LOG_LEVEL] ?? 1)) return;
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, level, msg, ...data }));
}

// ─── Concurrency limiter ─────────────────────────────────────────────────────

let activeProcesses = 0;

function acquireSlot() {
  if (activeProcesses >= MAX_CONCURRENT) return false;
  activeProcesses++;
  return true;
}

function releaseSlot() {
  activeProcesses = Math.max(0, activeProcesses - 1);
}

// ─── Request ID generator ────────────────────────────────────────────────────

function genId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('base64url')}`;
}

// ─── Model resolution ────────────────────────────────────────────────────────

function resolveModel(model) {
  if (!model) return DEFAULT_MODEL;
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  return model;
}

// ─── Convert OpenAI messages to Claude CLI input ─────────────────────────────
// Returns { systemPrompt, userPrompt } - system prompt separated for --system-prompt flag,
// conversation formatted with role prefixes for multi-turn context.

function convertMessages(messages) {
  if (!messages || messages.length === 0) {
    return { systemPrompt: null, userPrompt: '' };
  }

  let systemParts = [];
  const turns = [];

  for (const msg of messages) {
    const content = extractTextContent(msg.content);
    if (!content) continue;

    switch (msg.role) {
      case 'system':
        systemParts.push(content);
        break;
      case 'user':
        turns.push({ role: 'Human', content });
        break;
      case 'assistant':
        turns.push({ role: 'Assistant', content });
        break;
      case 'function':
      case 'tool':
        // Treat tool/function results as user context
        turns.push({ role: 'Human', content: `[Tool result: ${msg.name || 'unknown'}]\n${content}` });
        break;
    }
  }

  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : null;

  // For single user message (most common case), just pass the content directly
  if (turns.length === 1 && turns[0].role === 'Human') {
    return { systemPrompt, userPrompt: turns[0].content };
  }

  // For multi-turn, format with role prefixes so Claude understands the conversation
  const userPrompt = turns
    .map((t) => `${t.role}: ${t.content}`)
    .join('\n\n');

  return { systemPrompt, userPrompt };
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

// ─── Input validation ────────────────────────────────────────────────────────

function validateChatRequest(body) {
  const errors = [];

  if (!body.messages || !Array.isArray(body.messages)) {
    errors.push('messages must be a non-empty array');
    return errors;
  }

  if (body.messages.length === 0) {
    errors.push('messages array must not be empty');
    return errors;
  }

  const hasNonSystem = body.messages.some((m) => m.role !== 'system');
  if (!hasNonSystem) {
    errors.push('at least one non-system message is required');
  }

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!msg.role || typeof msg.role !== 'string') {
      errors.push(`messages[${i}].role is required and must be a string`);
    }
    if (msg.content === undefined || msg.content === null) {
      errors.push(`messages[${i}].content is required`);
    }
  }

  if (body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || body.max_tokens < 1)) {
    errors.push('max_tokens must be a positive number');
  }

  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) {
    errors.push('temperature must be a number between 0 and 2');
  }

  if (body.top_p !== undefined && (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1)) {
    errors.push('top_p must be a number between 0 and 1');
  }

  return errors;
}

// ─── Spawn Claude CLI process ────────────────────────────────────────────────

function spawnClaude(userPrompt, options = {}) {
  const args = ['--print'];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }

  if (options.streaming) {
    // stream-json requires --verbose
    args.push('--verbose');
    args.push('--output-format', 'stream-json');
    args.push('--include-partial-messages');
  } else {
    // Without --verbose, json format returns a single clean result object
    args.push('--output-format', 'json');
  }

  // Disable session persistence for bridge calls - each request is independent
  args.push('--no-session-persistence');

  // Skip permission prompts (headless server — no TTY)
  args.push('--dangerously-skip-permissions');

  // Prompt is a positional argument, must be last
  args.push(userPrompt);

  log('debug', 'Spawning Claude CLI', {
    args: args.map((a) => (a === userPrompt ? '[PROMPT]' : a)),
  });

  const proc = spawn(CLAUDE_CLI_PATH, args, {
    env: { ...process.env },
    timeout: options.timeout || CLI_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Close stdin immediately - we don't send input
  proc.stdin.end();

  return proc;
}

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'claude-bridge',
    active_processes: activeProcesses,
    max_concurrent: MAX_CONCURRENT,
  });
});

// ─── OpenAI-compatible: List models ──────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: KNOWN_MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'anthropic',
    })),
  });
});

// ─── OpenAI-compatible: Retrieve model ───────────────────────────────────────

app.get('/v1/models/:model_id', (req, res) => {
  const model = KNOWN_MODELS.find((m) => m.id === req.params.model_id);
  if (!model) {
    return res.status(404).json({
      error: {
        message: `Model '${req.params.model_id}' not found`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
  }
  res.json({
    id: model.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'anthropic',
  });
});

// ─── OpenAI-compatible: Chat Completions ─────────────────────────────────────

app.post('/v1/chat/completions', async (req, res) => {
  const requestId = genId('chatcmpl');
  const startTime = Date.now();

  // Validate input
  const errors = validateChatRequest(req.body);
  if (errors.length > 0) {
    return res.status(400).json({
      error: {
        message: errors.join('; '),
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
  }

  // Check concurrency
  if (!acquireSlot()) {
    return res.status(429).json({
      error: {
        message: `Too many concurrent requests (max ${MAX_CONCURRENT}). Try again later.`,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    });
  }

  const {
    messages,
    stream = false,
    max_tokens,
    temperature,
    top_p,
    stop,
  } = req.body;

  const model = resolveModel(req.body.model);
  const created = Math.floor(Date.now() / 1000);
  const { systemPrompt, userPrompt } = convertMessages(messages);

  log('info', 'Chat completion request', {
    requestId,
    model,
    stream,
    messageCount: messages.length,
  });

  const cliOptions = {
    model,
    systemPrompt,
    maxTokens: max_tokens,
    streaming: stream,
  };

  // ─── Streaming response ──────────────────────────────────────────────────

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send initial role chunk
    sendSSE(res, {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });

    let proc;
    try {
      proc = spawnClaude(userPrompt, cliOptions);
    } catch (err) {
      releaseSlot();
      log('error', 'Failed to spawn Claude CLI', { requestId, error: err.message });
      sendSSE(res, { error: { message: 'Failed to start Claude CLI', type: 'server_error' } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let buffer = '';
    let stderr = '';
    let sentContent = false;
    let finished = false;

    proc.stdout.on('data', (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);
          if (handleStreamEvent(event, res, requestId, created, model)) {
            sentContent = true;
          }
        } catch {
          log('debug', 'Non-JSON stream line', { line: line.substring(0, 200) });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (handleStreamEvent(event, res, requestId, created, model)) {
            sentContent = true;
          }
        } catch {
          log('debug', 'Non-JSON remaining buffer', { buffer: buffer.substring(0, 200) });
        }
      }

      if (!finished) {
        finished = true;

        if (code !== 0 && !sentContent) {
          log('error', 'Claude CLI stream failed', { requestId, code, stderr: stderr.substring(0, 500) });
          sendSSE(res, {
            error: {
              message: `Claude CLI exited with code ${code}: ${stderr.substring(0, 200)}`,
              type: 'server_error',
            },
          });
        }

        // Send finish chunk
        sendSSE(res, {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: code === 0 || sentContent ? 'stop' : 'error',
          }],
        });

        res.write('data: [DONE]\n\n');
        res.end();
        releaseSlot();

        log('info', 'Stream completed', {
          requestId,
          exitCode: code,
          durationMs: Date.now() - startTime,
        });
      }
    });

    proc.on('error', (err) => {
      if (!finished) {
        finished = true;
        log('error', 'Claude CLI spawn error', { requestId, error: err.message });
        sendSSE(res, { error: { message: err.message, type: 'server_error' } });
        res.write('data: [DONE]\n\n');
        res.end();
        releaseSlot();
      }
    });

    // Handle client disconnect - use res.on('close') not req.on('close')
    // req 'close' fires when the request body is fully consumed (immediately for SSE),
    // while res 'close' fires when the underlying connection is actually terminated.
    res.on('close', () => {
      if (!finished) {
        finished = true;
        log('info', 'Client disconnected', { requestId });
        proc.kill('SIGTERM');
        releaseSlot();
      }
    });

    return;
  }

  // ─── Non-streaming response ──────────────────────────────────────────────

  try {
    const result = await runClaudeNonStreaming(userPrompt, cliOptions);

    const completion = {
      id: requestId,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: result.usage?.input_tokens ?? estimateTokens(userPrompt),
        completion_tokens: result.usage?.output_tokens ?? estimateTokens(result.text),
        total_tokens: (result.usage?.input_tokens ?? estimateTokens(userPrompt)) +
          (result.usage?.output_tokens ?? estimateTokens(result.text)),
      },
    };

    log('info', 'Chat completion done', {
      requestId,
      durationMs: Date.now() - startTime,
      responseLength: result.text.length,
      usage: completion.usage,
    });

    releaseSlot();
    res.json(completion);
  } catch (err) {
    releaseSlot();
    log('error', 'Chat completion error', { requestId, error: err.message });

    const statusCode = err.message.includes('timed out') ? 504 : 500;
    res.status(statusCode).json({
      error: {
        message: err.message,
        type: 'server_error',
        code: 'claude_cli_error',
      },
    });
  }
});

// ─── OpenAI-compatible: Completions (legacy) ─────────────────────────────────

app.post('/v1/completions', async (req, res) => {
  const requestId = genId('cmpl');

  if (!req.body.prompt || (typeof req.body.prompt === 'string' && !req.body.prompt.trim())) {
    return res.status(400).json({
      error: {
        message: 'prompt is required and must be a non-empty string',
        type: 'invalid_request_error',
      },
    });
  }

  if (!acquireSlot()) {
    return res.status(429).json({
      error: {
        message: `Too many concurrent requests (max ${MAX_CONCURRENT}).`,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    });
  }

  const model = resolveModel(req.body.model);
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : req.body.prompt.join('\n');

  try {
    const result = await runClaudeNonStreaming(prompt, { model, maxTokens: req.body.max_tokens });

    releaseSlot();
    res.json({
      id: requestId,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          text: result.text,
          index: 0,
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.usage?.input_tokens ?? estimateTokens(prompt),
        completion_tokens: result.usage?.output_tokens ?? estimateTokens(result.text),
        total_tokens: (result.usage?.input_tokens ?? estimateTokens(prompt)) +
          (result.usage?.output_tokens ?? estimateTokens(result.text)),
      },
    });
  } catch (err) {
    releaseSlot();
    res.status(500).json({
      error: { message: err.message, type: 'server_error' },
    });
  }
});

// ─── Catch-all for unsupported endpoints ─────────────────────────────────────

app.use('/v1/*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.method} ${req.path} is not supported by claude-bridge`,
      type: 'invalid_request_error',
      code: 'endpoint_not_found',
    },
  });
});

// ─── Non-streaming CLI execution ─────────────────────────────────────────────

function runClaudeNonStreaming(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(prompt, { ...options, streaming: false });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, options.timeout || CLI_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;

      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.substring(0, 500)}`));
        return;
      }

      // Parse the JSON output
      try {
        const result = JSON.parse(stdout.trim());
        if (result.is_error) {
          reject(new Error(`Claude CLI error: ${result.result || 'Unknown error'}`));
          return;
        }
        resolve({
          text: result.result || '',
          usage: result.usage || null,
          costUsd: result.total_cost_usd || 0,
          durationMs: result.duration_ms || 0,
        });
      } catch {
        // If it's not JSON, treat as plain text (fallback)
        resolve({ text: stdout.trim(), usage: null, costUsd: 0, durationMs: 0 });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (killed) return;
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}

// ─── Stream event handler ────────────────────────────────────────────────────
// Claude CLI stream-json with --verbose --include-partial-messages emits:
//   { type: "system", subtype: "init", ... }
//   { type: "stream_event", event: { type: "content_block_delta", delta: { text: "..." } } }
//   { type: "assistant", message: { content: [...] }, ... }  (complete message)
//   { type: "stream_event", event: { type: "message_stop" } }
//   { type: "result", ... }

function handleStreamEvent(event, res, requestId, created, model) {
  // Primary streaming path: content_block_delta events contain token-by-token text
  if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
    const text = event.event.delta?.text;
    if (text) {
      sendSSE(res, {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: { content: text },
          finish_reason: null,
        }],
      });
      return true; // indicates we sent content
    }
  }
  return false;
}

// ─── SSE helper ──────────────────────────────────────────────────────────────

function sendSSE(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Connection already closed
  }
}

// ─── Token estimation ────────────────────────────────────────────────────────
// Rough heuristic: ~4 characters per token for English text

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────

let server;

function shutdown(signal) {
  log('info', `Received ${signal}, shutting down gracefully...`);
  if (server) {
    server.close(() => {
      log('info', 'Server closed');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => {
      log('warn', 'Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start server ────────────────────────────────────────────────────────────

server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'Claude Bridge started', {
    port: PORT,
    defaultModel: DEFAULT_MODEL,
    cliPath: CLAUDE_CLI_PATH,
    maxConcurrent: MAX_CONCURRENT,
    cliTimeoutMs: CLI_TIMEOUT_MS,
  });
  log('info', `OpenAI-compatible API: http://0.0.0.0:${PORT}/v1`);
});
