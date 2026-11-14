-- Run once in the Supabase SQL editor for an existing MENTHA database.
insert into public.contracts (id, name, subtitle, instrument_key, lot_size, tick_size, initial_price, previous_close)
values
  ('SHARK-BTCINR', 'BITCOIN', 'SHARK BTC/INR', 'SHARK:BTCINR', 1, 0.01, 1, 1),
  ('SHARK-ETHINR', 'ETHEREUM', 'SHARK ETH/INR', 'SHARK:ETHINR', 1, 0.01, 1, 1),
  ('SHARK-SOLINR', 'SOLANA', 'SHARK SOL/INR', 'SHARK:SOLINR', 1, 0.01, 1, 1),
  ('SHARK-XRPINR', 'XRP', 'SHARK XRP/INR', 'SHARK:XRPINR', 1, 0.01, 1, 1)
on conflict (id) do nothing;
