-- Sticker Art CRM schema (Supabase / Postgres)
create extension if not exists pg_trgm;

create table if not exists stores (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique,                 -- tracker id (name, lowercase, dashes)
  name          text not null,
  city          text, state text, address text,
  phone         text, email text, website text,
  channel       text,                        -- faire | direct | both | prospect
  account_status text,                       -- Active | Overdue | Lapsed | Dormant | Closed
  status        text,                        -- not-contacted | contacted | replied | ordered | seasonal-hold | sample-hold | skip
  key_account   boolean not null default false,
  holdout       boolean not null default false,
  tags          text[] not null default '{}',
  background    text,                        -- free-form "about" text (Highrise background)
  next_follow_up date,
  pause_until   date,
  last_contact  date,
  last_order    date,
  faire_spend   numeric(12,2) default 0,
  shopify_spend numeric(12,2) default 0,
  highrise_id   bigint unique,
  shopify_customer_id text,
  extra         jsonb not null default '{}', -- every other tracker field, kept as-is
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists stores_name_trgm on stores using gin (name gin_trgm_ops);
create index if not exists stores_tags on stores using gin (tags);
create index if not exists stores_follow on stores (next_follow_up);

create table if not exists contacts (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid references stores(id) on delete cascade,
  name        text not null,
  title       text, email text, phone text,
  background  text,
  highrise_id bigint unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contacts_store on contacts (store_id);
create index if not exists contacts_name_trgm on contacts using gin (name gin_trgm_ops);

-- One row per thing that happened: note, email, call, Faire message, order, completed task...
create table if not exists timeline (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid references stores(id) on delete cascade,
  contact_id  uuid references contacts(id) on delete set null,
  kind        text not null default 'note',  -- note | email | call | faire | mail | order | task | system
  occurred_at timestamptz not null default now(),
  author      text,                          -- Bryant, Claude, faire-daily, ...
  subject     text,
  body        text,
  source      text not null default 'manual',-- manual | highrise | tracker | shopify | faire | claude
  source_id   text unique,                   -- e.g. highrise:263454912, shopify:#5234
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists timeline_store on timeline (store_id, occurred_at desc);
create index if not exists timeline_body_trgm on timeline using gin (body gin_trgm_ops);

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid references stores(id) on delete cascade,
  title       text not null,
  category    text,                          -- Follow-up | Email | Call | Ship | ...
  due_date    date,
  done_at     timestamptz,
  assignee    text default 'Bryant',
  source      text not null default 'manual',
  source_id   text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tasks_open on tasks (due_date) where done_at is null;

create table if not exists orders (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid references stores(id) on delete set null,
  channel     text not null,                 -- shopify | faire
  order_no    text,
  ordered_at  timestamptz not null,
  total       numeric(12,2),
  status      text,
  customer_name text, customer_email text,
  items       jsonb not null default '[]',
  source_id   text unique,                   -- shopify:gid / faire:PW427QE69Y
  created_at  timestamptz not null default now()
);
create index if not exists orders_store on orders (store_id, ordered_at desc);

-- Keep updated_at fresh
create or replace function touch_updated() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['stores','contacts','timeline','tasks'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated()', t, t);
  end loop;
end $$;

-- An order lands on the timeline automatically and refreshes the store's last order date
create or replace function order_to_timeline() returns trigger language plpgsql as $$
begin
  if new.store_id is not null then
    insert into timeline (store_id, kind, occurred_at, author, subject, body, source, source_id, meta)
    values (new.store_id, 'order', new.ordered_at, new.channel,
            initcap(new.channel) || ' order ' || coalesce(new.order_no,''),
            coalesce('$' || to_char(new.total,'FM999,999,990.00'), ''),
            new.channel, 'order:' || new.source_id, jsonb_build_object('order_id', new.id))
    on conflict (source_id) do update set store_id = excluded.store_id, body = excluded.body;
    update stores set last_order = greatest(coalesce(last_order, new.ordered_at::date), new.ordered_at::date)
      where id = new.store_id;
  end if;
  return new;
end $$;
drop trigger if exists orders_timeline on orders;
create trigger orders_timeline after insert or update of store_id, total on orders
  for each row execute function order_to_timeline();

-- Store list with handy computed columns for filters
create or replace view store_list as
select s.*,
  (select min(t.due_date) from tasks t where t.store_id = s.id and t.done_at is null) as next_task_due,
  (select count(*) from orders o where o.store_id = s.id) as order_count,
  (select coalesce(sum(o.total),0) from orders o where o.store_id = s.id) as order_total
from stores s;

-- Security: only signed-in users (Bryant) can read or write. The MCP server uses the service key.
alter table stores   enable row level security;
alter table contacts enable row level security;
alter table timeline enable row level security;
alter table tasks    enable row level security;
alter table orders   enable row level security;
do $$ declare t text; begin
  foreach t in array array['stores','contacts','timeline','tasks','orders'] loop
    execute format('drop policy if exists signed_in_all on %I', t);
    execute format('create policy signed_in_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
alter view store_list set (security_invoker = true);

-- Machine access (the Claude connector and import scripts) without the Supabase service key:
-- requests that carry the header  x-crm-key: <secret>  may read and write. The secret lives in a private table.
create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);
revoke all on schema private from anon, authenticated;
create or replace function public.crm_key_ok() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (current_setting('request.headers', true)::json ->> 'x-crm-key') =
    (select value from private.settings where key = 'crm_key'), false)
$$;
do $$ declare t text; begin
  foreach t in array array['stores','contacts','timeline','tasks','orders'] loop
    execute format('drop policy if exists machine_key on %I', t);
    execute format('create policy machine_key on %I for all to anon using (public.crm_key_ok()) with check (public.crm_key_ok())', t);
  end loop;
end $$;
-- After creating the project, set the secret once:
--   insert into private.settings values ('crm_key', '<long random string>') on conflict (key) do update set value = excluded.value;

-- Only these signed-in emails can use the app (sign-ups by anyone else see nothing)
insert into private.settings values ('allowed_emails', 'bryantaucoin@gmail.com') on conflict (key) do nothing;
create or replace function public.crm_user_ok() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(lower(auth.jwt() ->> 'email') = any (string_to_array((select value from private.settings where key = 'allowed_emails'), ',')), false)
$$;
-- (policies signed_in_all use public.crm_user_ok() instead of true)

-- Website files, used only when the Worker runs without its static-assets binding
create table if not exists public.site_files (path text primary key, content_type text not null, body text not null, updated_at timestamptz not null default now());
alter table public.site_files enable row level security;
create policy machine_key on public.site_files for all to anon using (public.crm_key_ok()) with check (public.crm_key_ok());

-- Outreach playbook, handoff notes between Claude chats, and wins (orders credited to outreach)
create table if not exists public.playbook (
  id uuid primary key default gen_random_uuid(), heading text not null unique, body text not null default '',
  sort int not null default 100, updated_at timestamptz not null default now());
create table if not exists public.handoffs (
  id uuid primary key default gen_random_uuid(), slug text unique, created_on date not null default current_date,
  from_who text, to_who text default 'all', topic text not null, note text, status text not null default 'open',
  done_by text, done_on date, done_note text, progress_note text, store_slugs text[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.wins (
  id uuid primary key default gen_random_uuid(), slug text unique, store_id uuid references public.stores(id) on delete set null,
  store_name text, amount numeric(12,2), channel text, confidence text default 'counted', contact_by text, contact_on date,
  contact_via text, won_on date not null default current_date, order_no text, note text, created_at timestamptz not null default now());
-- (same signed_in_all / machine_key policies as the other tables)

-- Archive (11/9): hidden from lists unless the Archived filter is on. New orders bring a store back.
alter table stores add column if not exists archived_at timestamptz;
create or replace function unarchive_on_order() returns trigger language plpgsql security definer set search_path = public as $$
begin update stores set archived_at = null where id = new.store_id and archived_at is not null; return new; end $$;
create trigger orders_unarchive after insert on orders for each row execute function unarchive_on_order();
-- store_list view gained archived_at as its last column.
