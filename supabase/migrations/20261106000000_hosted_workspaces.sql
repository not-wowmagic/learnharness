-- Hosted LearnHarness: user ↔ workspace ownership (hosted-web phase 2).
--
-- The learning data itself stays in the app server's per-workspace JSON
-- directories. This table only answers "which local workspace belongs to
-- this auth user?" so a magic-link sign-in can restore it on another device.
--
-- Access model: RLS is ON with NO policies for anon/authenticated. The app
-- server uses the service-role key (which bypasses RLS). The browser never
-- reads this table.

create table if not exists public.workspaces (
  id uuid primary key,
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  label text
);

alter table public.workspaces enable row level security;

revoke all on table public.workspaces from anon, authenticated;
grant all on table public.workspaces to service_role;

create index if not exists workspaces_owner_last_seen_idx
  on public.workspaces (owner_id, last_seen_at desc);

comment on table public.workspaces is
  'Hosted LearnHarness workspace ownership. Local JSON data lives under data/workspaces/<id>/.';
