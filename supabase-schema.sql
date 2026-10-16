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

create table if not exists public.contracts (
  id text primary key,
  name text not null,
  subtitle text not null,
  instrument_key text not null unique,
  lot_size integer not null default 360 check (lot_size > 0),
  tick_size numeric(10, 4) not null default 0.1 check (tick_size > 0),
  initial_price numeric(14, 2) not null default 0 check (initial_price > 0),
  previous_close numeric(14, 2) not null default 0 check (previous_close > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.contracts (id, name, subtitle, instrument_key, lot_size, tick_size, initial_price, previous_close)
values ('MENTHAOIL-OCT26', 'MENTHAOIL FUT', 'MCX 30 OCT 26', 'MCX_FO|552719', 360, 0.1, 927.4, 921.8)
on conflict (id) do nothing;

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

alter table public.orders
add column if not exists contract_id text not null default 'MENTHAOIL-OCT26' references public.contracts(id);

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

alter table public.trades
add column if not exists contract_id text not null default 'MENTHAOIL-OCT26' references public.contracts(id);

create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  brokerage_per_lot numeric(12, 2) not null default 0,
  margin_per_lot numeric(14, 2) not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id, brokerage_per_lot, margin_per_lot)
values (1, 0, 0)
on conflict (id) do nothing;

-- Preserve the previous shared rates for existing traders when upgrading.
alter table public.app_users
add column if not exists brokerage_per_lot numeric(12, 2),
add column if not exists margin_per_lot numeric(14, 2);

update public.app_users
set brokerage_per_lot = coalesce(brokerage_per_lot, (select brokerage_per_lot from public.app_settings where id = 1), 0),
    margin_per_lot = coalesce(margin_per_lot, (select margin_per_lot from public.app_settings where id = 1), 0)
where brokerage_per_lot is null or margin_per_lot is null;

alter table public.app_users
alter column brokerage_per_lot set default 0,
alter column brokerage_per_lot set not null,
alter column margin_per_lot set default 0,
alter column margin_per_lot set not null;

alter table public.app_users
add column if not exists allow_market_orders boolean not null default true,
add column if not exists allow_limit_orders boolean not null default true;

alter table public.trades
add column if not exists brokerage numeric(12, 2) not null default 0;

create index if not exists idx_orders_user_id_created_at on public.orders(user_id, created_at desc);
create index if not exists idx_orders_contract_id on public.orders(contract_id);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_trades_user_id_created_at on public.trades(user_id, created_at desc);
create index if not exists idx_fund_ledger_user_id_created_at on public.fund_ledger(user_id, created_at desc);

alter table public.app_users enable row level security;
alter table public.contracts enable row level security;
alter table public.fund_ledger enable row level security;
alter table public.orders enable row level security;
alter table public.trades enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "service role manages app users" on public.app_users;
drop policy if exists "service role manages contracts" on public.contracts;
drop policy if exists "service role manages fund ledger" on public.fund_ledger;
drop policy if exists "service role manages orders" on public.orders;
drop policy if exists "service role manages trades" on public.trades;
drop policy if exists "service role manages app settings" on public.app_settings;

create policy "service role manages app users"
on public.app_users
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

create policy "service role manages contracts"
on public.contracts
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
