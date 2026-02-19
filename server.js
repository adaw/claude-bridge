// ─────────────────────────────────────────────────────────────────────────────
// Claude Bridge - OpenAI-compatible API server → Anthropic Messages API
// Uses OAuth token (Bearer auth) with Claude Code identity headers
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');

const app = express();

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 8080;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-5-20250929';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '10mb';
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const ANTHROPIC_VERSION = '2023-06-01';

// OAuth token — uses Bearer auth with special beta headers
const AUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || '';

const KNOWN_MODELS = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
];

const MODEL_ALIASES = {
  'gpt-4': DEFAULT_MODEL,
  'gpt-4o': DEFAULT_MODEL,
  'gpt-4-turbo': DEFAULT_MODEL,
  'gpt-3.5-turbo': 'claude-haiku-4-5',
  'sonnet': 'claude-sonnet-4-5-20250929',
  'opus': 'claude-opus-4-6',
  'opus4.5': 'claude-opus-4-5-20251101',
  'opus4': 'claude-opus-4-20250514',
  'haiku': 'claude-haiku-4-5',
};

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, msg, data = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[level] ?? 1) < (levels[LOG_LEVEL] ?? 1)) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('base64url')}`;
}

function resolveModel(model) {
  if (!model) return DEFAULT_MODEL;
  return MODEL_ALIASES[model] || model;
}

function isOAuthToken(token) {
  return token && token.includes('sk-ant-oat');
}

// ─── Build Anthropic request headers ─────────────────────────────────────────

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'accept': 'application/json',
  };

  if (isOAuthToken(AUTH_TOKEN)) {
    // OAuth tokens require Bearer auth + Claude Code identity headers
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14';
    headers['user-agent'] = 'claude-cli/2.1.2 (external, cli)';
    headers['x-app'] = 'cli';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    // Regular API key
    headers['x-api-key'] = AUTH_TOKEN;
  }

  return headers;
}

// ─── Convert OpenAI tools → Anthropic tools ─────────────────────────────────

function convertTools(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  });
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'none') return { type: 'none' };  // Anthropic doesn't support 'none' but we pass it
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  return { type: 'auto' };
}

// ─── Convert OpenAI messages → Anthropic format ─────────────────────────────

function convertMessages(messages) {
  const systemParts = [];
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    // Handle assistant messages with tool_calls
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const contentBlocks = [];
      // Include any text content first
      if (msg.content) {
        const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
        if (text) contentBlocks.push({ type: 'text', text });
      }
      // Convert each tool_call to Anthropic tool_use block
      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        let args = {};
        if (typeof fn.arguments === 'string') {
          try { args = JSON.parse(fn.arguments); } catch { args = {}; }
        } else if (typeof fn.arguments === 'object') {
          args = fn.arguments;
        }
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id || genId('toolu'),
          name: fn.name,
          input: args,
        });
      }
      pushMessage(anthropicMessages, 'assistant', contentBlocks);
      continue;
    }

    // Handle tool result messages
    if (msg.role === 'tool') {
      const resultContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: resultContent,
      };
      pushMessage(anthropicMessages, 'user', [toolResultBlock]);
      continue;
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = convertContent(msg.content);
    pushMessage(anthropicMessages, role, content);
  }

  // Ensure first message is from user
  if (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
    anthropicMessages.unshift({ role: 'user', content: '(continue)' });
  }

  // For OAuth tokens, prepend Claude Code identity to system prompt
  let systemPrompt;
  if (isOAuthToken(AUTH_TOKEN)) {
    const parts = ['You are Claude Code, Anthropic\'s official CLI for Claude.'];
    if (systemParts.length > 0) parts.push(systemParts.join('\n\n'));
    systemPrompt = [{ type: 'text', text: parts.join('\n\n'), cache_control: { type: 'ephemeral' } }];
  } else {
    systemPrompt = systemParts.length > 0
      ? [{ type: 'text', text: systemParts.join('\n\n') }]
      : undefined;
  }

  return { system: systemPrompt, messages: anthropicMessages };
}

// Merge consecutive same-role messages (Anthropic requires alternating)
function pushMessage(arr, role, content) {
  if (arr.length > 0 && arr[arr.length - 1].role === role) {
    const last = arr[arr.length - 1];
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content }];
    }
    if (typeof content === 'string') {
      last.content.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      last.content.push(...content);
    }
  } else {
    arr.push({ role, content });
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  return '';
}

function convertContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');

  const parts = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      if (url.startsWith('data:')) {
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          });
        }
      } else {
        parts.push({
          type: 'image',
          source: { type: 'url', url },
        });
      }
    }
  }

  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

// ─── Call Anthropic Messages API ─────────────────────────────────────────────

async function callAnthropic(body, stream = false) {
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ ...body, stream }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${errBody.substring(0, 500)}`);
  }

  return res;
}

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'claude-bridge', hasToken: !!AUTH_TOKEN, isOAuth: isOAuthToken(AUTH_TOKEN) });
});

// ─── Models ──────────────────────────────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: KNOWN_MODELS.map(m => ({ id: m.id, object: 'model', created: now, owned_by: 'anthropic' })),
  });
});

app.get('/v1/models/:model_id', (req, res) => {
  const model = KNOWN_MODELS.find(m => m.id === req.params.model_id);
  if (!model) return res.status(404).json({ error: { message: `Model '${req.params.model_id}' not found`, type: 'invalid_request_error' } });
  res.json({ id: model.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' });
});

// ─── Chat Completions ────────────────────────────────────────────────────────

app.post('/v1/chat/completions', async (req, res) => {
  const requestId = genId();
  const startTime = Date.now();
  const { messages, stream = false, max_tokens, temperature, top_p, tools, tool_choice } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
  }

  if (!AUTH_TOKEN) {
    return res.status(500).json({ error: { message: 'No auth token configured', type: 'server_error' } });
  }

  const model = resolveModel(req.body.model);
  const created = Math.floor(Date.now() / 1000);
  const { system, messages: anthropicMessages } = convertMessages(messages);

  const anthropicBody = {
    model,
    messages: anthropicMessages,
    max_tokens: max_tokens || 8192,
  };
  if (system) anthropicBody.system = system;
  if (temperature !== undefined) anthropicBody.temperature = temperature;
  if (top_p !== undefined) anthropicBody.top_p = top_p;

  // Tool calling support
  const anthropicTools = convertTools(tools);
  if (anthropicTools) anthropicBody.tools = anthropicTools;
  const anthropicToolChoice = convertToolChoice(tool_choice);
  if (anthropicToolChoice) anthropicBody.tool_choice = anthropicToolChoice;

  log('info', 'Chat request', { requestId, model, stream, msgCount: messages.length });

  try {
    if (stream) {
      await handleStreaming(res, anthropicBody, requestId, created, model);
    } else {
      await handleNonStreaming(res, anthropicBody, requestId, created, model);
    }
    log('info', 'Chat done', { requestId, durationMs: Date.now() - startTime });
  } catch (err) {
    log('error', 'Chat error', { requestId, error: err.message });
    if (!res.headersSent) {
      res.status(502).json({ error: { message: err.message, type: 'server_error' } });
    }
  }
});

// ─── Non-streaming handler ───────────────────────────────────────────────────

async function handleNonStreaming(res, body, requestId, created, model) {
  const apiRes = await callAnthropic(body, false);
  const result = await apiRes.json();

  const { text, toolCalls } = extractResponseContent(result.content || []);
  const finishReason = result.stop_reason === 'tool_use' ? 'tool_calls' : mapStopReason(result.stop_reason);

  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  res.json({
    id: requestId,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  });
}

// Extract text and tool_calls from Anthropic content blocks
function extractResponseContent(contentBlocks) {
  const textParts = [];
  const toolCalls = [];

  for (const block of contentBlocks) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || genId('call'),
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  return { text: textParts.join(''), toolCalls };
}

// ─── Streaming handler ───────────────────────────────────────────────────────

async function handleStreaming(res, body, requestId, created, model) {
  const apiRes = await callAnthropic(body, true);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Initial role chunk
  sendSSE(res, {
    id: requestId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });

  const reader = apiRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Track tool use blocks during streaming
  let toolCallIndex = -1;
  const activeToolCalls = new Map(); // index → { id, name }
  let stopReason = 'stop';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          // Text content delta
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
            sendSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
            });
          }

          // Tool use block starts
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            toolCallIndex++;
            const block = event.content_block;
            activeToolCalls.set(toolCallIndex, { id: block.id, name: block.name });
            sendSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created, model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolCallIndex,
                    id: block.id || genId('call'),
                    type: 'function',
                    function: { name: block.name, arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            });
          }

          // Tool use input delta (JSON chunks)
          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && event.delta?.partial_json !== undefined) {
            sendSSE(res, {
              id: requestId, object: 'chat.completion.chunk', created, model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolCallIndex,
                    function: { arguments: event.delta.partial_json },
                  }],
                },
                finish_reason: null,
              }],
            });
          }

          // Track stop reason
          if (event.type === 'message_delta' && event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
        } catch { /* skip non-JSON */ }
      }
    }
  } finally {
    const finishReason = stopReason === 'tool_use' ? 'tool_calls' : mapStopReason(stopReason);
    sendSSE(res, {
      id: requestId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function sendSSE(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { }
}

function mapStopReason(reason) {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

// ─── Legacy completions ─────────────────────────────────────────────────────

app.post('/v1/completions', async (req, res) => {
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : (req.body.prompt || []).join('\n');
  if (!prompt.trim()) return res.status(400).json({ error: { message: 'prompt required', type: 'invalid_request_error' } });

  const model = resolveModel(req.body.model);
  const requestId = genId('cmpl');
  const { system, messages } = convertMessages([{ role: 'user', content: prompt }]);
  const body = { model, messages, max_tokens: req.body.max_tokens || 8192 };
  if (system) body.system = system;

  try {
    const apiRes = await callAnthropic(body, false);
    const result = await apiRes.json();
    const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    res.json({
      id: requestId, object: 'text_completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ text, index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: result.usage?.input_tokens || 0, completion_tokens: result.usage?.output_tokens || 0, total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0) },
    });
  } catch (err) {
    res.status(502).json({ error: { message: err.message, type: 'server_error' } });
  }
});

// ─── Catch-all ───────────────────────────────────────────────────────────────

app.use('/v1/*', (req, res) => {
  res.status(404).json({ error: { message: `${req.method} ${req.path} not supported`, type: 'invalid_request_error' } });
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

let server;
function shutdown(signal) {
  log('info', `${signal}, shutting down...`);
  if (server) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
  } else process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ───────────────────────────────────────────────────────────────────

server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'Claude Bridge started', { port: PORT, defaultModel: DEFAULT_MODEL, hasToken: !!AUTH_TOKEN, isOAuth: isOAuthToken(AUTH_TOKEN) });
  log('info', `OpenAI-compatible API: http://0.0.0.0:${PORT}/v1`);
});
