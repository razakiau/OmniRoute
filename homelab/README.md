# OmniRoute 3.8.52, homelab build

Upstream `release/v3.8.52` plus four commits, and two plugins. This build runs
my homelab's Claude subscription (Opus, Sonnet and Haiku 5.5) behind GitHub
Copilot, with the Anthropic API key as a paid fallback.

Branch `homelab/v3.8.52` (this one) follows the build I run. Image:

```sh
docker pull ghcr.io/razakiau/omniroute:3.8.52-homelab-9e7fea28449897d2a9a64579a92d272001a5036d
# digest sha256:e23ac149e1e5c4687c936350f9ae16f1c52bc39d7301103eef360724e87c7dda
```

It is the upstream runner image with the changes below. Data, env and ports are
the same as upstream 3.8.52, so an upstream 3.8.52 setup can switch image tags.

## What it changes, compared with upstream v3.8.52

| Commit | Change | Why | Upstream |
|---|---|---|---|
| `05741822` | Claude Haiku 5.5 on the Claude OAuth provider: catalog, prices, fallbacks | 3.8.52 has Opus and Sonnet 5.5 only | Merged into 3.8.53 (diegosouzapw/OmniRoute#16159) |
| `ea7ff9ad` | Signed-thinking replay is **off** by default. `OMNIROUTE_CLAUDE_SIGNED_THINKING_REPLAY=true` turns it back on | See below | Not upstream (3.8.53 still replays) |
| `9e7fea28` | Prompt caching on the `anthropic` (API key) provider | See below | Not upstream (3.8.53 still skips it) |
| `acb4f358` | Homelab CI: `scripts/test/homelab-gate.mjs` and the image build | Every image passes the tests behind what the homelab relies on | Fork only |

### Signed-thinking replay

3.8.52 stores Claude's signed `thinking` blocks and replays them on the next
turn, so a model keeps its reasoning across tool calls for OpenAI-format
clients. The store lives in memory only. After a gateway restart, a crash or a
pause over an hour, the replay misses, and Anthropic rejects the turn with
`400 thinking/redacted_thinking blocks in the latest assistant message cannot
be modified`. The client keeps that broken turn in its history, so the chat
fails the same way on every retry until you abandon it. One OmniRoute restart
killed three live Opus chats this way.

Off, OmniRoute sends the redacted placeholder that 3.8.50 used, which survives
restarts. You lose the cross-turn reasoning replay.

### Prompt caching on the API-key provider

OmniRoute adds cache breakpoints (last system block, second-to-last user turn,
last assistant turn) only for `claude`, Vertex and `anthropic-compatible-*`.
The API-key connection is provider `anthropic`, the same Messages API, but
got none. An OpenAI-format client sends no `cache_control` itself, so every
turn on the paid key was billed in full: about 10x a cached turn at 150K
context. It spent $200 of credit in three days of fallback traffic. This only
matters if you use an Anthropic API key.

## Plugins (`homelab/plugins/`)

OmniRoute loads plugins from `~/.omniroute/plugins/<name>/` (in the image:
`/home/node/.omniroute/plugins`; mount a host directory there). Each plugin
has a `test.mjs` with no dependencies: `node test.mjs`.

### keep-warm

Anthropic's prompt cache lives one hour after its last use. A big chat that
waits longer than that for you (a question, lunch, a meeting) stores its
whole context again on the next turn, at 2x the input price: 268K tokens on
Opus is about $2.14 (or that share of your subscription's limit). keep-warm
replays the chat's last request with `max_tokens` 16, 55 minutes after its last
call, for up to 8 hours. A ping is a cache read: about $0.06 for that chat.
Simulated over a month of my traffic, 8 h windows save about $350 a month.

It keeps warm only:

- requests from the API key names in `allowKeys`;
- main-agent requests, recognized by an `ask_user` or `askUser` tool (GitHub
  Copilot's agent has one; its sub-agents don't). With another client, edit
  `mainTools` in `index.mjs`' `DEFAULTS`;
- chats whose restart would cost at least `thresholdUsd` ($1, about 125K
  tokens on Opus).

A ping that reads nothing marks the chat missed and stops pinging it.
`fusePerDay` caps the pings per day.

Setup:

1. Copy `plugins/keep-warm` into the plugins directory. Copy
   `config.example.json` to `config.json` and put your Copilot API key names
   in `allowKeys`.
2. Create an OmniRoute API key for the pings (I call mine `keepwarm`). Write
   it to `keep-warm/.key`, mode `0600`, owned by the container user. Without
   that file the plugin records chats but never pings.
3. **Restrict that key to your Claude subscription connections** (Dashboard,
   API keys, connection access). If a combo can fall back to a paid API key,
   a ping that fails on the subscription goes to the paid key and rewrites the
   whole context there. This is why the ping asks for 16 tokens and not 1:
   with adaptive thinking, a 1-token answer comes back empty, OmniRoute's
   combo quality check calls that a failure and moves to the next target.
4. Activate it (below).

Runtime switches (on/off, window hours, daily fuse, chats to skip) live in
the plugin's OmniRoute config under `settings`:
`PUT /api/plugins/keep-warm/config` with
`{"config": {"settings": {"enabled": true, "windowHours": 8, "fusePerDay": 200, "disabled": []}}}`.
The plugin writes its live state (chats, pings today, cost) under `state`
in the same config; `GET` it to see what it does. It re-reads `config.json`
every 30 s, so editing it needs no reload.

### tool-call-args-fix

A tool called with no arguments came back as `arguments: ""`, and replaying it
to Claude failed every later turn with `tool_use.input: Input should be an
object`. 3.8.52 fixes this in the translator, so the plugin does nothing on
this build. It's here for older images.

## Activating a plugin

Through the dashboard (Plugins, Scan, then Activate), or with
`plugin-converge.mjs`, which scans, activates, and reloads a plugin whose
files changed. It runs inside the container and authenticates with the
container's own CLI token:

```sh
docker exec -i -e PLUGINS="keep-warm tool-call-args-fix" -e MODE=apply omniroute \
  node --input-type=module - < homelab/plugin-converge.mjs
```

`MODE=plan` shows what it would do without changing anything.
