#!/bin/bash
# E2E Test Suite for Claude Bridge v3.0.0 — Tool Calling
set -uo pipefail

PASS=0
FAIL=0
FAILED_TESTS=()
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

check() {
  local name="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "  ✅ $name"
    PASS=$((PASS+1))
  else
    echo "  ❌ $name"
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name")
  fi
}

test_endpoint() {
  local BASE="$1" LABEL="$2"
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Testing: $LABEL ($BASE)"
  echo "═══════════════════════════════════════════════════"

  # ─── Test 1: Health check ───
  echo ""; echo "─── Test 1: Health Check ───"
  curl -s "$BASE/health" > "$TMP/health.json"
  check "health returns ok" jq -e '.status == "ok"' "$TMP/health.json"
  check "has token" jq -e '.hasToken == true' "$TMP/health.json"

  # ─── Test 2: Non-streaming tool call ───
  echo ""; echo "─── Test 2: Non-streaming tool call ───"
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-opus-4-6",
      "messages": [{"role": "user", "content": "What is the weather in Prague? Use the get_weather tool."}],
      "tools": [{
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather for a city",
          "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
        }
      }],
      "max_tokens": 1024
    }' > "$TMP/t2.json"
  
  check "has tool_calls" jq -e '.choices[0].message.tool_calls | length > 0' "$TMP/t2.json"
  check "tool_calls[0].type=function" jq -e '.choices[0].message.tool_calls[0].type == "function"' "$TMP/t2.json"
  check "tool_calls[0].function.name=get_weather" jq -e '.choices[0].message.tool_calls[0].function.name == "get_weather"' "$TMP/t2.json"
  check "tool_calls[0].function.arguments valid JSON" bash -c "jq -r '.choices[0].message.tool_calls[0].function.arguments' $TMP/t2.json | jq . > /dev/null"
  check "tool_calls[0].id exists" jq -e '.choices[0].message.tool_calls[0].id != null and (.choices[0].message.tool_calls[0].id | length > 0)' "$TMP/t2.json"
  check "finish_reason=tool_calls" jq -e '.choices[0].finish_reason == "tool_calls"' "$TMP/t2.json"
  check "content is null" jq -e '.choices[0].message.content == null' "$TMP/t2.json"
  check "usage.prompt_tokens > 0" jq -e '.usage.prompt_tokens > 0' "$TMP/t2.json"

  # ─── Test 3: Multi-turn with tool result ───
  echo ""; echo "─── Test 3: Multi-turn with tool result ───"
  TOOL_CALL_ID=$(jq -r '.choices[0].message.tool_calls[0].id' "$TMP/t2.json")
  
  jq -n --arg tcid "$TOOL_CALL_ID" '{
    model: "claude-opus-4-6",
    messages: [
      {role: "user", content: "What is the weather in Prague?"},
      {role: "assistant", content: null, tool_calls: [{id: $tcid, type: "function", function: {name: "get_weather", arguments: "{\"city\": \"Prague\"}"}}]},
      {role: "tool", tool_call_id: $tcid, content: "{\"temperature\": 5, \"unit\": \"celsius\", \"condition\": \"cloudy\"}"}
    ],
    tools: [{type: "function", function: {name: "get_weather", description: "Get weather", parameters: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}}],
    max_tokens: 1024
  }' > "$TMP/t3_req.json"
  
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d @"$TMP/t3_req.json" > "$TMP/t3.json"
  
  check "multi-turn returns text" jq -e '.choices[0].message.content != null and (.choices[0].message.content | length > 0)' "$TMP/t3.json"
  check "multi-turn finish_reason=stop" jq -e '.choices[0].finish_reason == "stop"' "$TMP/t3.json"
  check "response mentions weather data" bash -c "jq -r '.choices[0].message.content' $TMP/t3.json | grep -iqE '5|celsius|cloud|prague|weather'"

  # ─── Test 4: tool_choice=required ───
  echo ""; echo "─── Test 4: tool_choice=required ───"
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-opus-4-6",
      "messages": [{"role": "user", "content": "Hello, how are you?"}],
      "tools": [{
        "type": "function",
        "function": {
          "name": "greet",
          "description": "Send a greeting message",
          "parameters": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}
        }
      }],
      "tool_choice": "required",
      "max_tokens": 1024
    }' > "$TMP/t4.json"
  
  check "required forces tool call" jq -e '.choices[0].message.tool_calls | length > 0' "$TMP/t4.json"
  check "required finish_reason=tool_calls" jq -e '.choices[0].finish_reason == "tool_calls"' "$TMP/t4.json"

  # ─── Test 5: tool_choice=specific function ───
  echo ""; echo "─── Test 5: tool_choice=specific function ───"
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-opus-4-6",
      "messages": [{"role": "user", "content": "Do something"}],
      "tools": [
        {"type": "function", "function": {"name": "tool_a", "description": "Tool A does stuff", "parameters": {"type": "object", "properties": {"x": {"type": "string"}}}}},
        {"type": "function", "function": {"name": "tool_b", "description": "Tool B does other stuff", "parameters": {"type": "object", "properties": {"y": {"type": "string"}}}}}
      ],
      "tool_choice": {"type": "function", "function": {"name": "tool_b"}},
      "max_tokens": 1024
    }' > "$TMP/t5.json"
  
  check "specific tool_choice calls tool_b" jq -e '.choices[0].message.tool_calls[0].function.name == "tool_b"' "$TMP/t5.json"

  # ─── Test 6: Streaming tool call ───
  echo ""; echo "─── Test 6: Streaming tool call ───"
  curl -sN "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-opus-4-6",
      "messages": [{"role": "user", "content": "Get weather for Berlin"}],
      "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
      "stream": true,
      "max_tokens": 1024
    }' > "$TMP/t6.txt"
  
  check "stream has role chunk" grep -q '"role":"assistant"' "$TMP/t6.txt"
  check "stream has tool_calls" grep -q '"tool_calls"' "$TMP/t6.txt"
  check "stream has function name" grep -q '"name":"get_weather"' "$TMP/t6.txt"
  check "stream has arguments" grep -q '"arguments"' "$TMP/t6.txt"
  check "stream finish_reason=tool_calls" grep -q '"finish_reason":"tool_calls"' "$TMP/t6.txt"
  check "stream ends with [DONE]" grep -q '\[DONE\]' "$TMP/t6.txt"

  # Reassemble streaming arguments
  ARGS=$(grep '^data: ' "$TMP/t6.txt" | grep -v '\[DONE\]' | sed 's/^data: //' | \
    jq -r 'select(.choices[0].delta.tool_calls != null) | .choices[0].delta.tool_calls[0].function.arguments // empty' 2>/dev/null | tr -d '\n')
  check "streaming args reassemble to valid JSON" bash -c "echo '$ARGS' | jq . > /dev/null 2>&1"

  # ─── Test 7: No tools = text only ───
  echo ""; echo "─── Test 7: No tools = text only ───"
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model": "claude-opus-4-6", "messages": [{"role": "user", "content": "Say hello in one word"}], "max_tokens": 50}' > "$TMP/t7.json"
  
  check "text response present" jq -e '.choices[0].message.content != null' "$TMP/t7.json"
  check "finish_reason=stop" jq -e '.choices[0].finish_reason == "stop"' "$TMP/t7.json"
  check "no tool_calls field" jq -e '.choices[0].message.tool_calls == null' "$TMP/t7.json"

  # ─── Test 8: tool_choice=none ───
  echo ""; echo "─── Test 8: tool_choice=none ───"
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-opus-4-6",
      "messages": [{"role": "user", "content": "What is 2+2? Answer with just the number."}],
      "tools": [{"type": "function", "function": {"name": "calc", "description": "Calculate", "parameters": {"type": "object", "properties": {"expr": {"type": "string"}}}}}],
      "tool_choice": "none",
      "max_tokens": 50
    }' > "$TMP/t8.json"
  
  check "none returns text" jq -e '.choices[0].message.content != null' "$TMP/t8.json"
  check "none has no tool_calls" jq -e '(.choices[0].message.tool_calls == null) or (.choices[0].message.tool_calls | length == 0)' "$TMP/t8.json"

  # ─── Test 9: Multiple tool results in sequence ───
  echo ""; echo "─── Test 9: Multiple tool results ───"
  curl -s "$BASE/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-opus-4-6",
      "messages": [
        {"role": "user", "content": "Get weather for Prague and Berlin"},
        {"role": "assistant", "content": null, "tool_calls": [
          {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"Prague\"}"}},
          {"id": "call_2", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"Berlin\"}"}}
        ]},
        {"role": "tool", "tool_call_id": "call_1", "content": "{\"temp\":5}"},
        {"role": "tool", "tool_call_id": "call_2", "content": "{\"temp\":3}"}
      ],
      "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
      "max_tokens": 1024
    }' > "$TMP/t9.json"
  
  check "multi-result returns text" jq -e '.choices[0].message.content != null and (.choices[0].message.content | length > 0)' "$TMP/t9.json"
  check "multi-result no error" jq -e '.error == null' "$TMP/t9.json"

  echo ""
}

# ═══════════════════
echo "╔═══════════════════════════════════════════════╗"
echo "║  Claude Bridge v3.0.0 — E2E Test Suite       ║"
echo "║  OpenAI Tool Calling Compatibility            ║"
echo "╚═══════════════════════════════════════════════╝"

test_endpoint "http://localhost:8089" "MBP (localhost)"
test_endpoint "http://192.168.1.31:8088" "Mac Studio"

echo "═══════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ ${#FAILED_TESTS[@]} -gt 0 ]; then
  echo "  Failed:"
  for t in "${FAILED_TESTS[@]}"; do echo "    ❌ $t"; done
fi
echo ""
exit $FAIL
