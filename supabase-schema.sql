create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id text primary key,
  name text not null,
  funds numeric(14, 2) not null default 0,
  active boolean not null default true,
  pin_salt text not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.fund_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  type text not null check (type in ('OPENING', 'ADD', 'REMOVE')),
  amount numeric(14, 2) not null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  side text not null check (side in ('BUY', 'SELL')),
  type text not null check (type in ('MARKET', 'LIMIT')),
  qty integer not null check (qty > 0),
  price numeric(12, 2),
  status text not null check (status in ('OPEN', 'FILLED', 'CANCELLED')) default 'OPEN',
  fill_price numeric(12, 2),
  created_at timestamptz not null default now(),
  filled_at timestamptz,
  cancelled_at timestamptz
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  side text not null check (side in ('BUY', 'SELL')),
  qty integer not null check (qty > 0),
  price numeric(12, 2) not null,
  brokerage numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  brokerage_per_lot numeric(12, 2) not null default 0,
  margin_per_lot numeric(14, 2) not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id, brokerage_per_lot, margin_per_lot)
values (1, 0, 0)
on conflict (id) do nothing;

alter table public.trades
add column if not exists brokerage numeric(12, 2) not null default 0;

create index if not exists idx_orders_user_id_created_at on public.orders(user_id, created_at desc);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_trades_user_id_created_at on public.trades(user_id, created_at desc);
create index if not exists idx_fund_ledger_user_id_created_at on public.fund_ledger(user_id, created_at desc);

alter table public.app_users enable row level security;
alter table public.fund_ledger enable row level security;
alter table public.orders enable row level security;
alter table public.trades enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "service role manages app users" on public.app_users;
drop policy if exists "service role manages fund ledger" on public.fund_ledger;
drop policy if exists "service role manages orders" on public.orders;
drop policy if exists "service role manages trades" on public.trades;
drop policy if exists "service role manages app settings" on public.app_settings;

create policy "service role manages app users"
on public.app_users
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role manages fund ledger"
on public.fund_ledger
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role manages orders"
on public.orders
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role manages trades"
on public.trades
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role manages app settings"
on public.app_settings
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
