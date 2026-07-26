#!/usr/bin/env node
// Contract test for a deployed instance. It checks the parts Claude Code actually depends
// on, in the order it depends on them.
//
//   node tools/contract-test.mjs https://<worker-host>/<SHIM_TOKEN> [model]
//
// Exit code 0 = every check passed.

const base = (process.argv[2] || '').replace(/\/$/, '');
const model = process.argv[3] || 'kimi';
if (!base) {
  console.error('usage: node tools/contract-test.mjs <base-url-with-token> [model]');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
};
const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });

// 1. non-streaming message
{
  const r = await post('/v1/messages?beta=true', {
    model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  });
  const j = await r.json().catch(() => ({}));
  check('messages: 200 + anthropic envelope', r.status === 200 && j.type === 'message' && Array.isArray(j.content), `status=${r.status} type=${j.type}`);
  check('messages: usage reported', !!(j.usage && typeof j.usage.input_tokens === 'number'), JSON.stringify(j.usage || {}));
  check('messages: stop_reason mapped', ['end_turn', 'max_tokens', 'tool_use'].includes(j.stop_reason), String(j.stop_reason));
}

// 2. streaming event sequence
{
  const r = await post('/v1/messages?beta=true', {
    model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Count to three.' }],
  });
  const text = await r.text();
  const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
  check('stream: content-type is text/event-stream', (r.headers.get('content-type') || '').includes('text/event-stream'));
  for (const e of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
    check(`stream: emits ${e}`, events.includes(e));
  }
  check('stream: ends with message_stop', events[events.length - 1] === 'message_stop', events.slice(-3).join(','));
}

// 3. tool use, streamed, with incremental arguments
{
  const r = await post('/v1/messages?beta=true', {
    model, max_tokens: 256, stream: true,
    tools: [{ name: 'get_weather', description: 'Get the weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: 'Weather in Dallas?' }],
  });
  const text = await r.text();
  const started = /"type":"tool_use"/.test(text);
  const deltas = [...text.matchAll(/"type":"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  let args = '';
  try { args = JSON.parse('"' + deltas.join('') + '"'); } catch { args = deltas.join(''); }
  let parsed = null;
  try { parsed = JSON.parse(args); } catch {}
  check('tools: tool_use block opened', started);
  check('tools: arguments arrive as input_json_delta', deltas.length > 0, `${deltas.length} deltas`);
  check('tools: arguments parse to JSON with the right key', !!(parsed && 'city' in parsed), args.slice(0, 80));
  check('tools: stop_reason is tool_use', /"stop_reason":"tool_use"/.test(text));
}

// 4. tool_result round trip (the shape a second turn takes)
{
  const r = await post('/v1/messages?beta=true', {
    model, max_tokens: 128,
    tools: [{ name: 'get_weather', description: 'Get the weather.', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'Weather in Dallas?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_test1', name: 'get_weather', input: { city: 'Dallas' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_test1', content: '41C and clear' }] },
    ],
  });
  const j = await r.json().catch(() => ({}));
  const said = JSON.stringify(j.content || '');
  check('tool_result: second turn returns 200', r.status === 200, `status=${r.status}`);
  check('tool_result: model used the tool output', /41/.test(said), said.slice(0, 120));
}

// 5. count_tokens
{
  const r = await post('/v1/messages/count_tokens?beta=true', {
    model, messages: [{ role: 'user', content: 'hello world' }], system: [{ type: 'text', text: 'be terse' }],
  });
  const j = await r.json().catch(() => ({}));
  check('count_tokens: returns input_tokens', r.status === 200 && typeof j.input_tokens === 'number', JSON.stringify(j));
}

// 6. model list, in the shape gateway discovery accepts
{
  const r = await fetch(base + '/v1/models');
  const j = await r.json().catch(() => ({}));
  const ids = (j.data || []).map((m) => m.id);
  check('models: list returned', r.status === 200 && ids.length > 0, `${ids.length} ids`);
  check('models: every id is claude/anthropic-prefixed', ids.every((i) => /^(claude|anthropic)/.test(i)), ids.join(','));
}

// 7. auth is actually enforced
{
  const wrong = base.replace(/\/[^/]*$/, '/definitely-not-the-token');
  const r = await fetch(wrong + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  check('auth: a wrong token is rejected', r.status === 401, `status=${r.status}`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
