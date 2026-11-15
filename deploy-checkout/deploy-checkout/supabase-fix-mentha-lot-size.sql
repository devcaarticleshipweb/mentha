-- Run once in Supabase SQL Editor for an existing deployment.
update public.contracts
set lot_size = 360
where id = 'MENTHAOIL-OCT26' and lot_size <> 360;
