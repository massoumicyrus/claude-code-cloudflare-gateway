# Claude Code on the Cloudflare AI Gateway

Run the Claude Code CLI against Kimi, GLM, Grok, MiniMax, DeepSeek or Claude, with every
request going through **your own Cloudflare account** — one bill, one log, no provider API
keys in your shell.

Cloudflare publishes a first-party Claude Code integration, but it covers the `anthropic`
provider only: Claude Code speaks the Anthropic Messages API (`POST /v1/messages`) and
every other model in the Cloudflare catalogue is Chat Completions. This Worker is the
missing translation layer, in one file, deployed on your account.

Measured on `claude-cli 2.1.165`, 2026-07-25. Full write-up with sources:
https://miscsubjects.com/a/claude-code-on-cloudflare-ai-gateway

```
claude ──▶ POST /v1/messages ──▶ this Worker ──▶ your AI Gateway ──▶ @cf/moonshotai/kimi-k2.7-code
                                                                  ├▶ @cf/zai-org/glm-5.2
                                                                  ├▶ moonshotai/kimi-k3   (1M ctx)
                                                                  ├▶ xai/grok-4.5
                                                                  ├▶ minimax/m3
                                                                  └▶ anthropic/claude-opus-5
```

## Setup

**1. Create an API token** at https://dash.cloudflare.com/profile/api-tokens with
`Workers AI: Read` + `Workers AI: Run` and `AI Gateway: Run` on your account.

**2. Make sure your gateway has authentication ON.** Unified Billing is refused on an
unauthenticated gateway — catalogue models return HTTP 402 with
`Gateway authentication is required to use unified billing` while `@cf/…` models keep
working, which reads like a model problem and is a gateway setting.

**3. Deploy.**

```bash
git clone https://github.com/massoumicyrus/claude-code-cloudflare-gateway
cd claude-code-cloudflare-gateway
npx wrangler secret put CF_ACCOUNT_ID     # your account id
npx wrangler secret put CF_API_TOKEN      # the token from step 1
npx wrangler secret put SHIM_TOKEN        # any random string, e.g. openssl rand -base64 24
npx wrangler secret put AIG_RUN_TOKEN     # optional: gateway Run token for cf-aig-authorization
npx wrangler deploy
```

**4. Point the CLI at it.**

```bash
export ANTHROPIC_BASE_URL="https://claude-code-cloudflare-gateway.<subdomain>.workers.dev/<SHIM_TOKEN>"
export ANTHROPIC_AUTH_TOKEN="<SHIM_TOKEN>"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL="kimi"
export ANTHROPIC_DEFAULT_OPUS_MODEL="kimi"
export ANTHROPIC_DEFAULT_SONNET_MODEL="kimi"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-flash"   # the background/title slot
export CLAUDE_CODE_SUBAGENT_MODEL="kimi"
export ENABLE_TOOL_SEARCH=true                     # see "The two settings that matter"
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
claude
```

The `SHIM_TOKEN` is both the path segment and the accepted bearer, so it works whether or
not your client sends `ANTHROPIC_AUTH_TOKEN` (an existing `/login` session can override
that variable).

Persist it instead in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<worker-host>/<SHIM_TOKEN>",
    "ANTHROPIC_AUTH_TOKEN": "<SHIM_TOKEN>",
    "ANTHROPIC_MODEL": "claude-kimi-k2.7-code",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-kimi-k2.7-code",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-kimi-k2.7-code",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-glm-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-kimi-k2.7-code",
    "ENABLE_TOOL_SEARCH": "true",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "DISABLE_TELEMETRY": "1",
    "API_TIMEOUT_MS": "1200000"
  }
}
```

Why `claude-kimi-k2.7-code` and not `kimi`? The desktop client validates model names
against an Anthropic-shaped allowlist and rejects `kimi-k2.7-code` before sending anything.
Any name containing `kimi`, `glm`, `grok` or `gpt` resolves to that model here, so a
Claude-shaped name routes wherever you want.

## Models

| Alias | Resolves to | Billing |
| --- | --- | --- |
| `kimi` | `@cf/moonshotai/kimi-k2.7-code` (262k ctx, tool calling) | Workers AI |
| `kimi-k2.6` | `@cf/moonshotai/kimi-k2.6` | Workers AI |
| `kimi-k3` | `moonshotai/kimi-k3` (1,048,576 ctx) | Unified Billing |
| `glm` | `@cf/zai-org/glm-5.2` | Workers AI |
| `glm-flash` | `@cf/zai-org/glm-4.7-flash` (cheapest tool-caller) | Workers AI |
| `grok` | `xai/grok-4.5` | Unified Billing |
| `gpt` | `openai/gpt-5.5` | Unified Billing |
| `minimax` | `minimax/m3` | Unified Billing |
| `opus5` / `sonnet5` | `anthropic/claude-opus-5` / `-sonnet-5` | Unified Billing |

Any `@cf/...` id or `author/model` id passes through unchanged. `anthropic/*` takes the
native lane (`/ai/v1/messages`, body untouched, no translation loss); everything else is
translated over `/ai/v1/chat/completions`.

## The two settings that matter more than the model

Both measured through one gateway with a 856-tool MCP server attached:

| Configuration | Input tokens / turn | Cached input | Cost / turn |
| --- | --- | --- | --- |
| MCP attached, no tool search | 149,187 | 64 | $0.02852109 |
| MCP attached, `ENABLE_TOOL_SEARCH=true` | 14,109 | 12,480 | $0.00443075 |
| No MCP server at all | 21,928 | 13,312 | $0.01089448 |

- **`ENABLE_TOOL_SEARCH=true`** drops the request from 856 tool definitions to 9 plus a
  `ToolSearch` tool the model calls on demand. Verified end to end: Kimi searched for an
  MCP tool it had never been shown and invoked it correctly. Tool schemas, not the
  conversation, are what a big MCP setup actually costs.
- **`CLAUDE_CODE_ATTRIBUTION_HEADER=0`** stops the client prepending a per-request nonce
  (`x-anthropic-billing-header: … cch=…`) to the system prompt. `api.anthropic.com` strips
  that line positionally; everyone else caches nothing behind it. This Worker also strips
  it server-side, which is why cached input goes from 64 tokens to ~13,000.

## What the translation gets right

Seven things, each of which is a real bug in some published shim:

1. Streams. A gateway that buffers whole responses stalls the client.
2. Emits tool arguments incrementally (`content_block_start` → `input_json_delta`), not
   one blob at the end.
3. Orders tool results correctly: Anthropic puts `tool_result` in a user turn, OpenAI wants
   `role:"tool"` messages straight after the assistant call.
4. Maps stop reasons (`stop`→`end_turn`, `length`→`max_tokens`, `tool_calls`→`tool_use`).
5. Never returns an empty turn: Kimi and GLM spend the output budget on
   `reasoning_content` first, and an empty assistant turn makes the CLI abort with
   "no visible output". The reasoning text is used as a fallback.
6. Answers `/v1/messages/count_tokens` with an estimate instead of a 404.
7. Drops the attribution block without reordering the `system` array — the strip is
   positional, and a merged block starting with that header swallows the rest of your
   system prompt.

## Verify a deployment

```bash
node tools/contract-test.mjs https://<worker-host>/<SHIM_TOKEN> kimi
```

21 checks over the parts the CLI actually depends on: the Anthropic envelope, usage and
stop-reason mapping, the full SSE event sequence in order, a streamed `tool_use` block whose
arguments arrive as `input_json_delta` and parse to valid JSON, a `tool_result` second turn
the model reads, `count_tokens`, the model list, and that a wrong token is refused. Every
check passes on the reference deployment as of 2026-07-25.

## What else it serves

- **`GET /v1/models`** — the alias list in the shape gateway model discovery accepts. That
  discovery is off by default (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, CLI ≥ 2.1.129),
  times out at three seconds, treats any redirect as failure, and **drops every id that does
  not start with `claude` or `anthropic`** — which is why the ids here are `claude-kimi-k2.7-code`,
  `claude-glm-5.2` and so on, with the real model in `display_name`.
- **Images.** `image` blocks are forwarded as OpenAI `image_url` parts, base64 or URL. Verified:
  an 8×8 blue PNG pasted through the CLI came back "Blue" from `@cf/moonshotai/kimi-k2.7-code`.
- **Per-session cost attribution.** `cf-aig-metadata` carries the CLI's
  `x-claude-code-session-id`, `x-claude-code-agent-id` and parent agent id, plus the model you
  asked for and the tool count, so the gateway's cost view is filterable per session and per
  subagent instead of one blur.
- **Gateway-side retries.** `cf-aig-max-attempts: 3` with exponential backoff, because the
  client's own retry logic matches on Anthropic's error wording and will not fire for an
  upstream that phrases failures differently.

## Wire capture tool

`tools/capture-gateway.mjs` is a local Anthropic-compatible server that logs exactly what
the client sends and answers with a valid response, so you can re-derive all of this on a
newer CLI version instead of trusting this README:

```bash
node tools/capture-gateway.mjs   # listens on :8787, appends capture.jsonl
ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_AUTH_TOKEN=x claude -p "say ok"
```

## Known limits

- Anthropic "doesn't endorse, maintain, or audit third-party gateway products, and doesn't
  support routing Claude Code to non-Claude models through any gateway." Nothing forbids
  it; you are the one who keeps up when the client changes.
- `thinking` is dropped rather than translated. That is deliberate — the client sends
  `thinking: {"type":"adaptive"}` and many backends 400, empty out or hang on it.
- Prompt caching is whatever the upstream does. `cache_control` breakpoints are not
  honoured by Workers AI models; the cached-input rates are prefix-based, which is why
  stripping the nonce matters.
- The model picker will not list these models: gateway model discovery is off by default
  and ignores any id that does not start with `claude` or `anthropic`.
- AI Gateway token permissions cannot be scoped to one gateway. A Run token reaches every
  gateway on the account, including any holding stored provider keys.

## License

MIT.
