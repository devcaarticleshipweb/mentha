-- Safe to rerun in the Supabase SQL editor for an existing MENTHA database.
alter table public.contracts
  alter column initial_price type numeric(14, 4),
  alter column previous_close type numeric(14, 4);
alter table public.orders
  alter column price type numeric(16, 4),
  alter column fill_price type numeric(16, 4);
alter table public.trades
  alter column price type numeric(16, 4);

insert into public.contracts (id, name, subtitle, instrument_key, lot_size, tick_size, initial_price, previous_close)
select proposed.* from (values
  ('SHARK-BTCINR', 'BITCOIN', 'SHARK BTC/INR', 'SHARK:BTCINR', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-ETHINR', 'ETHEREUM', 'SHARK ETH/INR', 'SHARK:ETHINR', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-SOLINR', 'SOLANA', 'SHARK SOL/INR', 'SHARK:SOLINR', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-XRPINR', 'XRP', 'SHARK XRP/INR', 'SHARK:XRPINR', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-BTCUSDT', 'BITCOIN', 'SHARK BTC/USDT', 'SHARK:BTCUSDT', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-ETHUSDT', 'ETHEREUM', 'SHARK ETH/USDT', 'SHARK:ETHUSDT', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-SOLUSDT', 'SOLANA', 'SHARK SOL/USDT', 'SHARK:SOLUSDT', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-XRPUSDT', 'XRP', 'SHARK XRP/USDT', 'SHARK:XRPUSDT', 1, 0.0001, 1::numeric, 1::numeric)
) as proposed(id, name, subtitle, instrument_key, lot_size, tick_size, initial_price, previous_close)
where not exists (
  select 1 from public.contracts existing
  where existing.instrument_key in (proposed.instrument_key, replace(proposed.instrument_key, 'SHARK:', ''))
)
on conflict (id) do nothing;
