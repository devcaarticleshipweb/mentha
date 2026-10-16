-- Run in Supabase SQL Editor if the last applied schema added individual
-- margin and brokerage rates. This migration is safe to run again.
begin;

create extension if not exists pgcrypto;

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

insert into public.contracts
  (id, name, subtitle, instrument_key, lot_size, tick_size, initial_price, previous_close)
values
  ('MENTHAOIL-OCT26', 'MENTHAOIL FUT', 'MCX 30 OCT 26', 'MCX_FO|552719', 360, 0.1, 927.4, 921.8)
on conflict (id) do nothing;

create table if not exists public.fund_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  type text not null check (type in ('OPENING', 'ADD', 'REMOVE')),
  amount numeric(14, 2) not null,
  note text,
  created_at timestamptz not null default now()
);

alter table public.app_users
  add column if not exists allow_market_orders boolean not null default true,
  add column if not exists allow_limit_orders boolean not null default true;

alter table public.orders
  add column if not exists contract_id text not null default 'MENTHAOIL-OCT26' references public.contracts(id),
  add column if not exists fill_price numeric(12, 2),
  add column if not exists filled_at timestamptz;

alter table public.trades
  add column if not exists contract_id text not null default 'MENTHAOIL-OCT26' references public.contracts(id),
  add column if not exists brokerage numeric(12, 2) not null default 0;

-- Older filled orders may not have both execution fields populated.
update public.orders as o
set fill_price = coalesce(o.fill_price, t.price),
    filled_at = coalesce(o.filled_at, t.created_at)
from (
  select distinct on (order_id) order_id, price, created_at
  from public.trades
  order by order_id, created_at
) as t
where o.id = t.order_id
  and o.status = 'FILLED'
  and (o.fill_price is null or o.filled_at is null);

create index if not exists idx_orders_contract_id on public.orders(contract_id);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_trades_user_id_created_at on public.trades(user_id, created_at desc);
create index if not exists idx_fund_ledger_user_id_created_at on public.fund_ledger(user_id, created_at desc);

alter table public.contracts enable row level security;
drop policy if exists "service role manages contracts" on public.contracts;
create policy "service role manages contracts"
  on public.contracts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

alter table public.fund_ledger enable row level security;
drop policy if exists "service role manages fund ledger" on public.fund_ledger;
create policy "service role manages fund ledger"
  on public.fund_ledger for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

commit;
