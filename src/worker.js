// Anthropic Messages API -> Cloudflare AI Gateway.
//
// Claude Code speaks exactly one wire protocol: POST /v1/messages in Anthropic's format.
// This Worker answers that protocol and forwards every call to your own Cloudflare
// account, so the model behind the CLI can be Kimi, GLM, Grok, GPT, MiniMax or Claude
// while authentication, logging, caching and billing all stay on Cloudflare.
//
// Point the CLI at it:
//   export ANTHROPIC_BASE_URL="https://<your-worker>.workers.dev/<SHIM_TOKEN>"
//   export ANTHROPIC_AUTH_TOKEN="<SHIM_TOKEN>"
//   export ANTHROPIC_MODEL="kimi"
//   export ENABLE_TOOL_SEARCH=true            # keeps MCP schemas out of every request
//   export CLAUDE_CODE_ATTRIBUTION_HEADER=0   # lets upstream prefix caching work
//
// Two lanes, both on the account AI REST surface so one credential covers everything:
//   1. anthropic/* -> POST /ai/v1/messages, Anthropic's own schema, body passed through.
//   2. everything else -> POST /ai/v1/chat/completions, translated in both directions.
//
// Also served: /v1/messages/count_tokens (estimate) and /v1/models (Claude-shaped alias
// ids, the only shape the client's gateway model discovery accepts).
//
// Workers AI models (@cf/...) bill as Workers AI; catalogue models (moonshotai/, xai/,
// anthropic/, openai/, minimax/) bill through Unified Billing credits. Neither needs a
// provider key in the client. Unified Billing requires an AUTHENTICATED gateway.
//
// Required secrets (wrangler secret put):
//   CF_ACCOUNT_ID      your Cloudflare account id
//   CF_API_TOKEN       API token with Workers AI Read/Run + AI Gateway Run
//   SHIM_TOKEN         a random string; it is the path segment and the client's bearer
// Optional:
//   AIG_GATEWAY_ID     gateway to log through (default "default"); must be authenticated
//   AIG_RUN_TOKEN      gateway Run token, sent as cf-aig-authorization
//   DEFAULT_MODEL      model for unresolved slots (default @cf/moonshotai/kimi-k2.7-code)

const GATEWAY = 'default'; // authenticated gateway; override with AIG_GATEWAY_ID

// Short names the CLI can put in ANTHROPIC_MODEL. Verified against the Cloudflare
// catalogue on 2026-07-25 -- see https://developers.cloudflare.com/ai/models/ for ids.
const ALIASES = {
  kimi: '@cf/moonshotai/kimi-k2.7-code',
  'kimi-k2.7-code': '@cf/moonshotai/kimi-k2.7-code',
  'kimi-k2.6': '@cf/moonshotai/kimi-k2.6',
  'kimi-k3': 'moonshotai/kimi-k3',
  glm: '@cf/zai-org/glm-5.2',
  'glm-5.2': '@cf/zai-org/glm-5.2',
  'glm-flash': '@cf/zai-org/glm-4.7-flash',
  grok: 'xai/grok-4.5',
  gpt: 'openai/gpt-5.5',
  minimax: 'minimax/m3',
  'claude-minimax-m3': 'minimax/m3',
  'claude-opus-5': 'anthropic/claude-opus-5',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  opus5: 'anthropic/claude-opus-5',
  sonnet5: 'anthropic/claude-sonnet-5',
};

// The CLI fills four model slots. Anything that still looks like a Claude id after alias
// resolution is a slot the operator did not set; send it to the default model instead of
// silently calling Anthropic.
// The desktop client rejects model names that don't look Anthropic-shaped, so keyword
// matching is what makes "claude-kimi" or "claude-sonnet-glm" usable as a picker entry.
function resolveModel(raw, env) {
  const asked = String(raw || '').trim();
  const fallback = env.DEFAULT_MODEL || ALIASES.kimi;
  if (!asked) return fallback;
  if (ALIASES[asked]) return ALIASES[asked];
  if (asked.startsWith('@cf/') || asked.includes('/')) return asked;
  const low = asked.toLowerCase();
  if (low.includes('kimi')) return ALIASES.kimi;
  if (low.includes('glm')) return ALIASES.glm;
  if (low.includes('grok')) return ALIASES.grok;
  if (low.includes('gpt')) return ALIASES.gpt;
  return fallback;
}

// The client's model discovery drops any id that does not start with claude/anthropic,
// so every alias is published under a Claude-shaped name. Picking one in /model routes to
// the underlying model here; the display name says what it really is.
function modelCatalogue() {
  const rows = [
    ['claude-kimi-k2.7-code', 'Kimi K2.7 Code (Workers AI, 262k)'],
    ['claude-kimi-k3', 'Kimi K3 (catalogue, 1M)'],
    ['claude-glm-5.2', 'GLM-5.2 (Workers AI, 262k)'],
    ['claude-glm-flash', 'GLM-4.7 Flash (Workers AI, cheapest)'],
    ['claude-grok-4.5', 'Grok 4.5 (catalogue)'],
    ['claude-minimax-m3', 'MiniMax M3 (catalogue)'],
    ['claude-opus-5', 'Claude Opus 5 (native lane)'],
    ['claude-sonnet-5', 'Claude Sonnet 5 (native lane)'],
  ];
  return {
    data: rows.map(([id, name]) => ({ type: 'model', id, display_name: name, created_at: '2026-07-25T00:00:00Z' })),
    has_more: false,
    first_id: rows[0][0],
    last_id: rows[rows.length - 1][0],
  };
}

function aiBase(env) {
  return 'https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT_ID + '/ai';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function apiError(message, status = 400, type = 'invalid_request_error') {
  return json({ type: 'error', error: { type, message } }, status);
}

// ---------------------------------------------------------------- request translation

function textOf(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block.text === 'string') return block.text;
  return '';
}

// The CLI puts a per-request attribution line at the very front of the system prompt.
// Forwarding it moves the cache key on every call, so upstream prefix caches never hit.
// Dropping it is what makes Workers AI cached-input pricing actually apply.
function isAttributionBlock(block) {
  return /^\s*x-anthropic-billing-header:/i.test(textOf(block));
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.filter((b) => !isAttributionBlock(b)).map(textOf).filter(Boolean).join('\n\n');
  }
  return '';
}

function stringifyToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((b) => {
      if (typeof b === 'string') return b;
      if (b && b.type === 'text') return b.text || '';
      if (b && b.type === 'image') return '[image omitted]';
      return JSON.stringify(b);
    });
    return parts.filter(Boolean).join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

// Anthropic messages -> OpenAI chat messages. Tool results become role:"tool" turns and
// must be emitted before any remaining user text so they follow their assistant call.
function toOpenAIMessages(body) {
  const out = [];
  const sys = systemText(body.system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const msg of body.messages || []) {
    const content = msg.content;
    if (typeof content === 'string') {
      out.push({ role: msg.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (msg.role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input == null ? {} : b.input) },
          });
        }
        // thinking / redacted_thinking blocks carry no cross-provider meaning: dropped.
      }
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }

    // user turn: tool results first, then whatever the human/harness said. Images become
    // OpenAI image_url parts -- Kimi K2.7 Code and GLM both accept vision input, so a
    // screenshot pasted into the CLI reaches the model instead of being dropped.
    const userParts = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: stringifyToolResult(b.content) || '(no output)',
        });
      } else if (b.type === 'text') {
        if (b.text) userParts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        const src = b.source || {};
        if (src.type === 'base64' && src.data) {
          userParts.push({ type: 'image_url', image_url: { url: 'data:' + (src.media_type || 'image/png') + ';base64,' + src.data } });
        } else if (src.type === 'url' && src.url) {
          userParts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      }
    }
    if (userParts.length) {
      const onlyText = userParts.every((p) => p.type === 'text');
      out.push({ role: 'user', content: onlyText ? userParts.map((p) => p.text).join('\n') : userParts });
    }
  }
  return out;
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || !t.name) continue;
    // Server-side Anthropic tools (web_search, text_editor, bash) have no schema and no
    // meaning off-platform. Skipping them keeps the request valid instead of half-valid.
    if (!t.input_schema && t.type) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: String(t.description || '').slice(0, 4000),
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function toOpenAIToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

function buildCompatBody(body, model) {
  const out = {
    model,
    messages: toOpenAIMessages(body),
    stream: !!body.stream,
  };
  const maxTokens = Number(body.max_tokens) || 4096;
  out.max_tokens = Math.min(maxTokens, 16384);
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences.slice(0, 4);
  const tools = toOpenAITools(body.tools);
  if (tools) {
    out.tools = tools;
    const choice = toOpenAIToolChoice(body.tool_choice);
    if (choice) out.tool_choice = choice;
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

// ---------------------------------------------------------------- response translation

function toAnthropicMessage(oai, model) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  // Kimi and GLM spend max_tokens on reasoning_content first. When the budget runs out
  // before any answer text, falling back to the reasoning keeps the turn non-empty --
  // an empty assistant turn makes the CLI abort with "no visible output".
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  else if (msg.reasoning_content) content.push({ type: 'text', text: String(msg.reasoning_content) });
  for (const call of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: call.id || ('toolu_' + Math.random().toString(36).slice(2)), name: call.function?.name || 'unknown', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const usage = oai.usage || {};
  return {
    id: oai.id || 'msg_aig',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// OpenAI SSE deltas -> the Anthropic event sequence the CLI's parser expects.
function streamTranslate(upstream, model) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let blockIndex = -1;
  let openBlock = null; // 'text' | 'tool'
  const toolSlots = new Map(); // openai tool index -> anthropic block index
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let buffer = '';
  let reasoning = '';

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(enc.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
      };
      const closeBlock = () => {
        if (openBlock !== null) {
          send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          openBlock = null;
        }
      };

      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_aig', type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let chunk;
            try { chunk = JSON.parse(payload); } catch { continue; }
            if (chunk.usage) {
              usage = {
                input_tokens: chunk.usage.prompt_tokens || usage.input_tokens,
                output_tokens: chunk.usage.completion_tokens || usage.output_tokens,
              };
            }
            const choice = (chunk.choices && chunk.choices[0]) || null;
            if (!choice) continue;
            const delta = choice.delta || {};

            if (typeof delta.content === 'string' && delta.content.length) {
              if (openBlock !== 'text') {
                closeBlock();
                blockIndex += 1;
                openBlock = 'text';
                send('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
              }
              send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
            }

            for (const call of delta.tool_calls || []) {
              const slot = call.index == null ? 0 : call.index;
              if (!toolSlots.has(slot)) {
                closeBlock();
                blockIndex += 1;
                toolSlots.set(slot, blockIndex);
                openBlock = 'tool';
                send('content_block_start', {
                  type: 'content_block_start', index: blockIndex,
                  content_block: { type: 'tool_use', id: call.id || ('toolu_' + slot + '_' + Math.random().toString(36).slice(2)), name: call.function?.name || 'unknown', input: {} },
                });
              }
              const args = call.function?.arguments;
              if (args) {
                send('content_block_delta', { type: 'content_block_delta', index: toolSlots.get(slot), delta: { type: 'input_json_delta', partial_json: args } });
              }
            }

            if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
            if (choice.finish_reason) stopReason = STOP_MAP[choice.finish_reason] || 'end_turn';
          }
        }
      } catch (e) {
        send('error', { type: 'error', error: { type: 'api_error', message: String(e && e.message || e) } });
      }

      // Nothing was emitted at all: hand back the reasoning so the turn isn't empty.
      if (blockIndex === -1) {
        blockIndex = 0;
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reasoning || '(no output returned by the model)' } });
        openBlock = 'text';
      }
      closeBlock();
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      send('message_stop', { type: 'message_stop' });
      controller.close();
    },
  });
}

// ---------------------------------------------------------------- routing

function authorized(env, request, url) {
  const key = env.SHIM_TOKEN;
  if (!key) return false;
  const header = (request.headers.get('x-api-key') || '').trim();
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const seg = url.pathname.split('/').filter(Boolean);
  const pathToken = seg[0] && seg[0] !== 'v1' ? decodeURIComponent(seg[0]) : '';
  return key === header || key === bearer || key === pathToken;
}

async function handle(request, env) {
  const url = new URL(request.url);
  // strip an optional leading token segment: /<SHIM_TOKEN>/v1/messages -> /v1/messages
  const tail = url.pathname.replace(/^\/[^/]*(?=\/v1\/)/, '');

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (/\/v1\/models/.test(tail)) return json(modelCatalogue());
    return json({
      ok: true,
      endpoint: 'anthropic-messages -> cloudflare ai gateway (' + (env.AIG_GATEWAY_ID || GATEWAY) + ')',
      models: Object.keys(ALIASES),
      usage: 'ANTHROPIC_BASE_URL=https://<worker-host>/<SHIM_TOKEN>',
    });
  }
  if (request.method !== 'POST') return apiError('POST only', 405);
  if (!authorized(env, request, url)) return apiError('unauthorized', 401, 'authentication_error');
  if (!env.CF_ACCOUNT_ID) return apiError('CF_ACCOUNT_ID missing', 500, 'api_error');

  let body;
  try { body = await request.json(); } catch { return apiError('body must be JSON'); }

  if (/count_tokens/.test(tail)) {
    // Optional endpoint: without it the client estimates locally. A cheap character-based
    // count over the parts that actually cost tokens beats a 404 and beats counting the
    // JSON envelope, which inflates by roughly a third on a tool-heavy request.
    let chars = systemText(body.system).length;
    for (const m of toOpenAIMessages(body)) {
      chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    for (const t of toOpenAITools(body.tools) || []) chars += JSON.stringify(t).length;
    return json({ input_tokens: Math.ceil(chars / 3.7) });
  }

  // Model discovery: the client asks GET/POST /v1/models with a 3-second timeout and
  // ignores every id that does not begin with claude or anthropic, so the aliases are
  // published Claude-shaped. Turn it on with CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1.
  if (/\/v1\/models/.test(tail)) return json(modelCatalogue());
  if (!/\/v1\/messages/.test(tail)) return apiError('unknown path: ' + tail, 404, 'not_found_error');

  const model = resolveModel(body.model, env);
  const token = env.CF_API_TOKEN;
  if (!token) return apiError('CF_API_TOKEN missing', 500, 'api_error');

  // Unified Billing is refused on an unauthenticated gateway, so coding-agent traffic
  // rides the authenticated gateway and carries its Run token.
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + token,
    'cf-aig-gateway-id': env.AIG_GATEWAY_ID || GATEWAY,
    'cf-aig-metadata': JSON.stringify({
      via: 'claude-code',
      shim: 'claude-code-cloudflare-gateway',
      model_asked: String(body.model || ''),
      // The CLI labels its own subagents; forwarding the ids makes the gateway's cost
      // and latency views filterable per session and per agent instead of one blur.
      session: request.headers.get('x-claude-code-session-id') || undefined,
      agent: request.headers.get('x-claude-code-agent-id') || undefined,
      parent_agent: request.headers.get('x-claude-code-parent-agent-id') || undefined,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
    }),
    // Retry transient upstream failures at the gateway rather than surfacing them to the
    // client, whose own retry logic matches on Anthropic's error wording.
    'cf-aig-max-attempts': '3',
    'cf-aig-retry-delay': '600',
    'cf-aig-backoff': 'exponential',
  };
  if (env.AIG_RUN_TOKEN) headers['cf-aig-authorization'] = 'Bearer ' + env.AIG_RUN_TOKEN;

  // Lane 1: Claude keeps Anthropic's own schema end to end, no translation loss.
  if (model.startsWith('anthropic/')) {
    const upstream = await fetch(aiBase(env) + '/v1/messages', {
      method: 'POST',
      headers: { ...headers, 'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01' },
      body: JSON.stringify({ ...body, model }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' },
    });
  }

  // Lane 2: every other model speaks chat completions; translate both directions.
  const compat = buildCompatBody(body, model);
  let upstream;
  try {
    upstream = await fetch(aiBase(env) + '/v1/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(compat),
    });
  } catch (e) {
    return apiError('gateway fetch failed: ' + (e && e.message || e), 502, 'api_error');
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return apiError('gateway ' + upstream.status + ': ' + text.slice(0, 800), upstream.status, 'api_error');
  }

  if (compat.stream && upstream.body) {
    return new Response(streamTranslate(upstream.body, model), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
    });
  }

  const oai = await upstream.json();
  return json(toAnthropicMessage(oai, model));
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
