# Hosted web version — implementation plan

Status: **Phases 0–4 implemented in code** (2026-11-07). Remaining manual
items: apply the Supabase migration, add the real domain/keys, and run the
container on the host. Phase 2's migration was blocked because the project
database was unreachable at implementation time.

Goal: run LearnHarness as a free, public, multi-user website on a custom domain,
funded by the operator's own provider key. No payments, no desktop app.

## Decisions

| Decision | Choice |
| --- | --- |
| Model billing | One shared operator key in the server environment. Visitors use it free. |
| Identity | Anonymous by default (signed cookie → workspace). Optional email magic link to keep a workspace across devices. |
| Isolation | One data directory per workspace. Chats, graph, jobs, and settings never shared. |
| Hosting | One Docker container + persistent volume. Single instance by design. |
| Database | Supabase (Postgres + Auth) for users and workspace ownership only. Learning data stays on disk. |
| Abuse control | Cloudflare Turnstile + Upstash rate limits + per-workspace and global daily spend caps. |
| License | AGPL-3.0. Public source link + modified-version notice in the UI. |

Non-goals for the first beta: payment, per-user provider keys, horizontal
scaling, team workspaces, mobile apps, email digests.

## Architecture

```text
Browser
  │  signed lh_ws cookie
  ▼
Cloudflare (DNS, TLS, WAF, Turnstile)
  ▼
Next.js container (single instance)
  ├─ /api/*  → workspace context (AsyncLocalStorage) → existing services
  ├─ agent runs, background jobs, SSE
  └─ /data/workspaces/<id>/{chats,graph,jobs,settings.json,prompts}
        ▲
        └── persistent volume

Supabase
  ├─ Auth (magic link)
  └─ workspaces (id, owner_id, created_at, last_seen_at)
```

The app already keeps mutable state behind `src/core/ports.ts`. The hosted
version keeps the filesystem adapters and resolves the workspace root per call,
so the desktop path and every existing call site stay unchanged.

## Hosted mode

Server: `LH_HOSTED=1`. Client: `NEXT_PUBLIC_LH_HOSTED=1`.

**Build-time note:** `NEXT_PUBLIC_*` values are inlined by Next. Set
`NEXT_PUBLIC_LH_HOSTED=1` when the image is built, not only when it starts.
`LH_HOSTED` is read at runtime and is the actual authorization boundary; a
missing client flag only leaves controls visible that the server still refuses.

### Phase 0 — implemented

- `src/core/hosted.ts` parses `LH_HOSTED_MODEL_{STRONG,CHEAP,VISION}` and
  `LH_HOSTED_THINKING_{STRONG,CHEAP,VISION}` (`provider:model-id`, split on the
  first colon). Malformed pins are inert; a deployment with no pins keeps the
  honest 503 instead of inventing a model.
- `src/store/settings.ts` overlays pins at the single read seam, so first-boot
  workspaces, `effectiveSettings()`, chat birth stamping, and background roles
  all see the operator's models. Stored visitor choices cannot win.
- Per-session model overrides are ignored in hosted mode
  (`hostedConversationSettings`), so an old record cannot select a costlier model.
- `proxy.ts` refuses key mutation, custom endpoints, subscriptions, Claude Code,
  and STT token minting. Prompt override writes are refused centrally and in
  the route. `GET /api/keys` returns an empty hosted view (no masked operator
  key suffix or length).
- `PUT /api/settings/models`, `PUT /api/settings/chat`, and
  `PUT /api/chats/:id/settings` refuse hosted writes with 403.
- The settings dialog hides Providers and the Agent section hides model slots;
  the stats-bar model control, dictation, and attachment buttons are hidden.
- `tests/hosted-mode.test.ts` pins parsing, overlay, proxy gates, the empty key
  view, and the model-write refusal.

### Disabled or pinned

| Surface | Hosted behavior |
| --- | --- |
| `PUT/DELETE /api/keys/:id` | 403. Visitors must not change the shared key. |
| `GET /api/keys` | 403 or empty; provider settings hidden. |
| `/api/custom-provider` | 403. Prevents key exfiltration to an arbitrary endpoint. |
| `/api/subscriptions`, `/api/claude-code` | 403. Desktop-only credential paths. |
| `/api/stt/token` | 403. Dictation would spend the operator's Deepgram key. |
| `/api/settings/prompts/*` | Read-only in beta. |
| Model selection | Pinned from env. Settings/chat PUT reject model changes. |
| Attachments | Hidden. Web has no path-based picker; uploads are a later phase. |
| Demo browser tool | Off in beta unless SSRF guards and Chrome are added. |
| Research search | Off unless a search key and quota are configured. |

### Model pinning

`FACTORY_SETTINGS` intentionally ships no models, so every workspace is seeded
with operator defaults:

```bash
LH_HOSTED_MODEL_STRONG=openrouter:anthropic/claude-sonnet-4.5
LH_HOSTED_MODEL_CHEAP=openrouter:google/gemini-2.5-flash
LH_HOSTED_MODEL_VISION=openrouter:google/gemini-2.5-flash
LH_HOSTED_THINKING_STRONG=medium
```

Enforcement is server-side, not just hidden UI:

1. `resolveSettings()` overlays the pinned slots.
2. Chat create and per-chat settings ignore `model` in hosted mode.
3. `/api/models` returns only the pinned catalog.
4. The settings UI hides the model and provider sections.

## Workspace isolation

### Phase 1 — implemented

- `src/store/workspace.ts` owns the path family, the `AsyncLocalStorage`
  context, signed-id validation, creation, last-seen metadata, and the
  30-day anonymous-workspace sweep.
- Every storage adapter (`chats`, `graph`, `graph-format`, `jobs`, `settings`,
  `prompt-overrides`, `render-settings`, `source-organization`) resolves its
  paths through `currentWorkspace()` per operation, so no path is captured at
  module load.
- `proxy.ts` now runs on pages as well as APIs, mints the signed `lh_ws`
  cookie on first contact, and forwards the id + HMAC as private request
  headers. `withWorkspace` and `withWorkspacePage` re-verify the signature
  before entering the context; a forged or missing signature gets a fresh
  workspace, never the operator's data root.
- API routes are wrapped individually; the three server components that read
  settings/chat data (`/`, `/chat/new`, `/chat/[id]`) use
  `withWorkspacePage`.
- Hosted learner file tools are closed: `fileAccessPolicy()` returns
  `{ restricted: true, folders: [] }`, so no visitor can read the server's
  filesystem or another workspace's records.
- Job recovery is per workspace (`lastSweepAt` is keyed by workspace id).
- Bus events carry the emitting workspace and `/api/events` drops other
  workspaces' frames; the activity dock, `/api/graph/status`, and the
  extraction-deletion gates filter the process-global extraction registry by
  workspace ownership. `/api/activity/abort` verifies the target chat/source
  belongs to the caller.
- `LH_WORKSPACE_SECRET` (32+ chars) is required in hosted production; a
  fixed dev secret is used only outside production.
- `tests/workspace.test.ts` pins path isolation, chat/job/settings isolation,
  signed-header resolution, forged-signature fallback, cookie reuse/rejection,
  the proxy's first-contact cookie, and the closed file policy.

### Phase 2 — implemented (code complete; DB migration pending)

- **Optional save.** Anonymous workspaces stay the default. Settings → Account
  sends a Supabase email magic link; the callback exchanges the code (PKCE) or
  verifies a `token_hash`, then claims the current workspace or switches to the
  most recent workspace the user already owns.
- **Cross-device restore.** On a new browser, sign in once and the callback
  points `lh_ws` at the owned workspace. The Supabase `workspaces` table is the
  cross-device mapping; learning data never leaves the app server.
- **Sign out.** `POST /api/auth/signout` clears the Supabase session and
  expires `lh_ws`; the next navigation mints a fresh anonymous workspace.
- **Local ownership metadata.** `meta.json` carries `ownerId`, which exempts
  claimed workspaces from the 30-day anonymous retention sweep.
- **Safe redirects.** `safeNextPath` rejects `//host` and `/\host` gadgets.
- **Config gate.** Accounts appear only when `LH_HOSTED=1` and all three
  Supabase env values exist; otherwise the Account tab explains that accounts
  are unconfigured.
- `tests/accounts.test.ts` pins the workspace choice (existing wins, claim
  current, collision mints a fresh one), redirect safety, local ownership
  metadata, and the Supabase config gate.

**Required Supabase setup** (manual, once the project database is reachable):

1. Apply `supabase/migrations/20261106000000_hosted_workspaces.sql`.
2. Auth → URL Configuration: add
   `http://localhost:3000/auth/callback` and
   `https://<your-domain>/auth/callback` as redirect URLs.
3. Auth → Email: enable magic links. Configure custom SMTP for production
   (the built-in sender is rate-limited).
4. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` on the server. The first two are public and
   must also be present at build time.

Limit for the first beta: only the most recent owned workspace is restored;
a multi-workspace switcher is later. A PKCE magic link should be opened in the
same browser that requested it (or use a custom `token_hash` email template).

1. **Cookie.** `lh_ws` = `<uuid>.<HMAC>` with `LH_WORKSPACE_SECRET`.
   `httpOnly`, `Secure`, `SameSite=Lax`, one year. Invalid or missing values get
   a fresh workspace. The server never trusts a client-supplied user or workspace
   id outside the cookie.
2. **Context.** `src/store/workspace.ts` holds an `AsyncLocalStorage` with
   `{ id, root }`. A `withWorkspace(handler)` wrapper resolves the cookie,
   ensures the directory, seeds settings on first use, and runs the handler
   inside the context.
3. **Adapters.** Replace module-level path constants in `src/store/*` with
   per-call resolvers (`currentWorkspace().chats`, etc.). `config.ts` keeps the
   desktop defaults. No call-site changes in `src/server` or `src/agent`.
4. **Jobs.** AsyncLocalStorage propagates through agent and worker promises.
   Persist `workspaceId` on `JobRecord`, and iterate workspaces on restart so
   recovery re-enters the right context.
5. **Retention.** Delete anonymous workspaces idle for 30 days. Owned
   workspaces are kept. Runs as a daily server task.
6. **Limits.** 50 sessions per workspace, 25 MiB per notes import (already
   enforced), and a workspace disk cap with a clear error.

## Accounts (optional save)

- "Save your progress" sends a Supabase magic link.
- On the callback, the current anonymous workspace is claimed by the user.
- On a new device, the most recently active owned workspace loads.
- Signing out returns to a fresh anonymous workspace.
- Table: `workspaces(id uuid primary key, owner_id uuid null, created_at,
  last_seen_at)`. Server uses the service role; no anonymous table access.

Supabase project creation and env vars are manual setup steps.

### Phase 3 — implemented

- **Turn budgets** per workspace: 20/hour and 100/day by default
  (`LH_HOSTED_TURNS_PER_HOUR`, `LH_HOSTED_TURNS_PER_DAY`), plus a 60/hour
  per-IP budget (`LH_HOSTED_TURNS_PER_IP_HOUR`). Refusals are 429 with
  `Retry-After`; counters are in-process (single-instance design).
- **Concurrency** per workspace (`LH_HOSTED_ACTIVE_TURNS`, default 3), using
  the existing turn-liveness registry.
- **Spend caps** recomputed from durable usage records (teaching turns,
  background jobs, and extraction runs): workspace daily
  `LH_HOSTED_WORKSPACE_DAILY_USD` (default 2) and global daily
  `LH_HOSTED_GLOBAL_DAILY_USD` (default 20). Spend survives restarts; the
  scan is cached briefly.
- **Kill switch**: `LH_HOSTED_PAUSED=1` refuses new turns with 503.
- **Storage bounds**: 50 sessions per workspace (`LH_HOSTED_MAX_SESSIONS`)
  and a 250 MB workspace disk cap (`LH_HOSTED_WORKSPACE_DISK_MB`), enforced
  on session creation and notes import.
- **SSRF guard** for research/web fetch and PDF URL downloads: loopback,
  RFC1918, link-local, CGNAT, metadata, ULA, and mapped/private IPv6 are
  refused; every redirect hop is re-checked.
- **Demo disabled** in hosted mode (server-side Chromium is the largest
  SSRF/compute surface); the Agent UI hides its toggle and the settings
  overlay forces it off.
- Bot protection at the edge: put the domain behind Cloudflare and enable a
  Managed Challenge / Turnstile rule. App-level Turnstile verification is
  deferred; the turn/IP budgets are the in-app backstop.

`tests/limits.test.ts` and `tests/safe-url.test.ts` pin the budgets, cap
refusals, concurrency gate, pause switch, and private-address classification.

The operator key is public money. All of these ship before the link is shared.

| Control | Detail |
| --- | --- |
| Turnstile | Cloudflare Managed Challenge / Turnstile at the edge (deployment step). App-level verification deferred. |
| Rate limits | In-process sliding windows: 20 turns/hour and 100/day per workspace; 60/hour per IP; 3 concurrent turns. |
| Spend caps | Sum `TurnUsage`, job usage, and extraction usage. Workspace daily $2 and global daily $20 defaults; refusals are 429/503. |
| Concurrency | Per-workspace active-turn counter in the existing liveness registry. |
| Egress | Block private IPs, localhost, link-local, metadata, ULA, and mapped private IPv6; re-check redirects. |
| Uploads | Existing 25 MiB body bounds; 250 MB per-workspace disk cap; 50 sessions. |
| Observability | Spend is recomputed from durable records; cap refusals are explicit codes. |

### Phase 4 — container (implemented)

- `Dockerfile`: multi-stage `node:24-bookworm-slim`, `npm ci` →
  `next build` → standalone `node server.js`. Runs as the non-root `node`
  user, mounts `/data`, exposes 3000, and health-checks `/api/health`.
  Repo-only build bloat is removed in the runner stage.
- `docker-compose.yml`: one app service, `./data:/data`, public Supabase
  values as build args, secrets/runtime limits from `.env.hosted`.
- `proxy.ts` bypasses workspace minting for `/api/health` (health probes must
  not create directories).
- The standalone layout was verified locally: `node .next/standalone/server.js`
  served pages and APIs, two cookie jars stayed isolated, and the key
  inventory was empty. Docker itself was not available on the development
  machine, so the image build is the one unverified step.
- Start locally/production:
  ```bash
  cp docs/hosted-web.md .env.hosted   # then fill it
  docker compose --env-file .env.hosted up -d --build
  ```
  `NEXT_PUBLIC_*` values must be present at build time; `LH_*` values are
  runtime. The health endpoint is `GET /api/health`.
- Fly.io shape: one machine (do not scale), a volume mounted at `/data`,
  `LH_DATA_DIR=/data`, secrets via `fly secrets set`, and the public build
  args in `[build.args]`. Cloudflare DNS in front with Full (strict) TLS;
  enable a Managed Challenge on `/chat/*` and `/api/chat` for bot pressure.

## Deployment

```bash
# required
LH_HOSTED=1
NEXT_PUBLIC_LH_HOSTED=1
LH_WORKSPACE_SECRET=<32+ random bytes>
OPENROUTER_API_KEY=<operator key>
LH_HOSTED_MODEL_STRONG=...
LH_HOSTED_MODEL_CHEAP=...
LH_HOSTED_MODEL_VISION=...
LH_DATA_DIR=/data

# optional — accounts (magic link)
NEXT_PUBLIC_SITE_URL=https://your-domain
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# limits
LH_HOSTED_TURNS_PER_HOUR=20
LH_HOSTED_TURNS_PER_DAY=100
LH_HOSTED_TURNS_PER_IP_HOUR=60
LH_HOSTED_ACTIVE_TURNS=3
LH_HOSTED_WORKSPACE_DAILY_USD=2
LH_HOSTED_GLOBAL_DAILY_USD=20
LH_HOSTED_MAX_SESSIONS=50
LH_HOSTED_WORKSPACE_DISK_MB=250
# LH_HOSTED_PAUSED=1
```

- Multi-stage Dockerfile on `node:24-bookworm-slim`; `npm ci`,
  `NEXT_PUBLIC_LH_HOSTED=1 npm run build`. The repo uses
  `output: "standalone"`, and Next 16 refuses `next start` in that mode, so
  the hosted image runs `node .next/standalone/server.js` after the usual
  `public/` and `.next/static/` copies (the same layout the desktop build
  already curates). Chromium is not needed in the hosted image: the demo
  tool is disabled in hosted mode.
- One Fly.io machine (or Railway/Render/VPS) with a volume mounted at `/data`.
  Do not scale above one instance: jobs, locks, and SSE coordination are
  process-local.
- Cloudflare DNS in front; TLS at the edge. Bind the app port to the edge only.
- Daily volume snapshot. JSON records are inspectable and portable.
- Health check endpoint for the platform.

## Phases

### Phase 0 — Hosted mode and lock-down (2–3 days)

- Add `LH_HOSTED` / `NEXT_PUBLIC_LH_HOSTED` flags.
- Block key, custom-provider, subscription, Claude Code, and STT routes.
- Seed and pin models; enforce pinning in settings and chat parsers.
- Hide model/provider/attachment/dictation UI in hosted mode.
- Tests: blocked routes return 403; pinned models cannot be overridden.

### Phase 1 — Workspaces (4–6 days) — **implemented**

- Add `src/store/workspace.ts` and per-call path resolution in every adapter.
- Add signed cookie handling and `withWorkspace` around API routes.
- Persist `workspaceId` on jobs; workspace-aware restart recovery.
- First-boot model resolution comes from the hosted overlay (no seed file
  needed); retention sweep for idle anonymous workspaces. The per-workspace
  disk cap moves to Phase 3 with the other abuse controls.
- Tests: two workspaces cannot read each other's chats, graph, or jobs;
  restart recovery stays in the right workspace.

### Phase 2 — Accounts (3–4 days) — **implemented (code); migration pending**

- Supabase Auth magic link, callback, claim current workspace.
- Owned workspace resolution on a new device; sign-out behavior.
- Minimal "Save progress" UI and workspace indicator.
- Tests: claim, re-login, and sign-out flows.

### Phase 3 — Abuse controls (3–4 days) — **implemented**

- Turnstile verification on workspace creation and magic-link requests.
- Upstash rate limits and concurrency caps.
- Per-workspace and global spend caps from existing usage records.
- SSRF guard for research; disable browser tool if it cannot be guarded.
- Tests: caps refuse before inference; limits reset on schedule.

### Phase 4 — Deployment (2–3 days) — **implemented in code**

- Dockerfile, `.dockerignore`, compose file for local testing.
- Volume, snapshots, health check, structured logs.
- Cloudflare DNS/TLS and Turnstile keys.
- AGPL footer link, modified-version notice, privacy page with retention.
- Beta checklist: fresh-visitor flow, cap trip, cookie loss, second device.

## Risks

- **Key drain.** Mitigated by turn/IP budgets, concurrency, and spend caps.
  A single turn can still overshoot slightly (one turn may dispatch several
  jobs/extractions before the next admission check); the caps are a soft
  ceiling, not a per-request wallet. Keep optional key variables unset in
  production and enable the Cloudflare edge challenge.
- **Single instance.** A crash stops all live runs. Restart recovery exists,
  but there is no HA. Acceptable for beta.
- **Anonymous data loss.** Clearing cookies loses a workspace. The optional
  account is the answer; the UI must warn before the user invests hours.
- **Auth/database outage.** If Supabase is unreachable during the callback,
  ownership cannot be recorded; the visitor keeps the local anonymous
  workspace, but the save does not follow them to another device.
- **Disk growth.** JSON sessions and image snapshots accumulate. Retention and
  per-workspace caps are not optional.
- **Upstream divergence.** Keep `main` tracking `amosblomqvist/learnharness`
  and build on a `hosted-web` branch to keep merges possible.

## Open setup choices

1. Supabase project for Auth + workspace ownership (implemented; the project
   database must be reachable to apply the migration).
2. Enable the demo/browser tool in beta (needs Chrome + SSRF guard), or ship
   without it.
3. Enable research search in beta (needs a search key + quota), or ship without.
4. Retention window for anonymous workspaces (default 30 days).
5. Global daily spend cap (default USD 20).
