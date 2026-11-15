-- Run once in the Supabase SQL editor for an existing MENTHA database.
insert into public.contracts (id, name, subtitle, instrument_key, lot_size, tick_size, initial_price, previous_close)
select proposed.* from (values
  ('SHARK-BTCINR', 'BITCOIN', 'SHARK BTC/INR', 'SHARK:BTCINR', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-ETHINR', 'ETHEREUM', 'SHARK ETH/INR', 'SHARK:ETHINR', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-SOLINR', 'SOLANA', 'SHARK SOL/INR', 'SHARK:SOLINR', 1, 0.01, 1::numeric, 1::numeric),
  ('SHARK-XRPINR', 'XRP', 'SHARK XRP/INR', 'SHARK:XRPINR', 1, 0.01, 1::numeric, 1::numeric)
) as proposed(id, name, subtitle, instrument_key, lot_size, tick_size, initial_price, previous_close)
where not exists (
  select 1 from public.contracts existing
  where existing.instrument_key in (proposed.instrument_key, replace(proposed.instrument_key, 'SHARK:', ''))
)
on conflict (id) do nothing;
