#!/usr/bin/env node
// Contract test for a deployed instance. 42 checks over the parts Claude Code actually
// depends on, in the order it depends on them.
//
//   node tools/contract-test.mjs https://<worker-host>/<SHIM_TOKEN> [model]
//
// Requires Node 18 or newer (global fetch).
// Exit code 0 = every check passed.

const base = (process.argv[2] || '').replace(/\/$/, '');
const model = process.argv[3] || 'kimi';
if (!base) {
  console.error('usage: node tools/contract-test.mjs <base-url-with-token> [model]');
  process.exit(2);
}

// The token is the last path segment of the base URL. It is never printed.
// `mount` is the base with that segment removed: the same route with no token in the path.
// Derived by dropping a segment rather than by regex, so a base with no path at all, or a
// base mounted under a prefix like /api/gateway/<token>, both come out right.
const baseUrl = new URL(base);
const segments = baseUrl.pathname.split('/').filter(Boolean);
const token = segments.pop() || '';
const mount = baseUrl.origin + (segments.length ? '/' + segments.join('/') : '');

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

  // Every block the client opened must be closed before the turn is finalised. A gateway
  // that emits message_delta first leaves the client with an unterminated block.
  const lines = [...text.matchAll(/^data: (\{.*\})$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  const deltaAt = lines.findIndex((d) => d.type === 'message_delta');
  const open = new Set();
  const closed = new Set();
  for (const d of lines.slice(0, deltaAt === -1 ? lines.length : deltaAt)) {
    if (d.type === 'content_block_start') open.add(d.index);
    if (d.type === 'content_block_stop') closed.add(d.index);
  }
  check('stream: content_block_stop precedes message_delta for every index',
    deltaAt !== -1 && open.size > 0 && [...open].every((i) => closed.has(i)),
    `opened=[${[...open]}] closed-before-delta=[${[...closed]}]`);

  const md = lines.find((d) => d.type === 'message_delta');
  check('stream: message_delta carries usage.output_tokens',
    !!(md && md.usage && typeof md.usage.output_tokens === 'number'),
    JSON.stringify(md?.usage || {}));
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

// 4. tool use, non-streaming (the Agent SDK and any non-interactive caller take this path)
{
  const r = await post('/v1/messages?beta=true', {
    model, max_tokens: 256,
    tools: [{ name: 'get_weather', description: 'Get the weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: 'Weather in Dallas?' }],
  });
  const j = await r.json().catch(() => ({}));
  const block = (j.content || []).find((b) => b && b.type === 'tool_use');
  check('tools (non-stream): a tool_use block is returned', !!block, JSON.stringify(j.content || '').slice(0, 120));
  check('tools (non-stream): input is a parsed object with the right key', !!(block && block.input && typeof block.input === 'object' && 'city' in block.input), JSON.stringify(block?.input || null));
  check('tools (non-stream): stop_reason is tool_use', j.stop_reason === 'tool_use', String(j.stop_reason));
}

// 5. tool_result round trip (the shape a second turn takes)
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

// 6. count_tokens
{
  const r = await post('/v1/messages/count_tokens?beta=true', {
    model, messages: [{ role: 'user', content: 'hello world' }], system: [{ type: 'text', text: 'be terse' }],
  });
  const j = await r.json().catch(() => ({}));
  check('count_tokens: returns input_tokens', r.status === 200 && typeof j.input_tokens === 'number', JSON.stringify(j));
}

// 7. model list, in the shape gateway discovery accepts
let published = [];
{
  const r = await fetch(base + '/v1/models');
  const j = await r.json().catch(() => ({}));
  published = j.data || [];
  const ids = published.map((m) => m.id);
  check('models: list returned', r.status === 200 && ids.length > 0, `${ids.length} ids`);
  check('models: every id is claude/anthropic-prefixed', ids.every((i) => /^(claude|anthropic)/.test(i)), ids.join(','));
}

// 8. every published id resolves to the model its display_name names. A published id that
// silently lands on a different model is a cost bug the client can never see.
{
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const m of published) {
    const want = slug(String(m.display_name).split('(')[0]);
    const r = await post('/v1/messages', { model: m.id, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    const j = await r.json().catch(() => ({}));
    const got = j.model || '';
    check(`models: ${m.id} resolves to "${m.display_name}"`, r.status === 200 && slug(got).includes(want), `status=${r.status} resolved=${got || JSON.stringify(j).slice(0, 90)}`);
  }
}

// 9. auth is actually enforced, on every method and every accepted credential
{
  // The right route with a wrong token in the path, so the request still reaches the
  // Worker and is refused there instead of failing on DNS.
  const r = await fetch(mount + '/definitely-not-the-token/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  check('auth: a wrong path token is rejected', r.status === 401, `status=${r.status}`);

  // GET is not exempt. An unauthenticated reader must not learn which models this routes.
  const g = await fetch(mount + '/v1/models');
  check('auth: an unauthenticated GET /v1/models is refused', g.status === 401, `status=${g.status}`);

  // Both header credentials work, so the token does not have to be in the URL.
  const k = await fetch(mount + '/v1/models', { headers: { 'x-api-key': token } });
  check('auth: x-api-key authenticates', k.status === 200, `status=${k.status}`);
  const b = await fetch(mount + '/v1/models', { headers: { authorization: 'Bearer ' + token } });
  check('auth: Authorization: Bearer authenticates', b.status === 200, `status=${b.status}`);
}

// 10. error paths. The client reads the status code before it reads the body.
{
  const bad = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'this is not json',
  });
  check('errors: a non-JSON body is 400', bad.status === 400, `status=${bad.status}`);

  const nf = await post('/v1/not-a-real-endpoint', {});
  check('errors: an unknown path is 404', nf.status === 404, `status=${nf.status}`);

  for (const method of ['PUT', 'DELETE']) {
    const r = await fetch(base + '/v1/messages', { method, headers: { 'content-type': 'application/json' }, body: '{}' });
    check(`errors: ${method} is 405`, r.status === 405, `status=${r.status}`);
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
