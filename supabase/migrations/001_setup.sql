-- ────────────────────────────────────────────────────────────────────
-- Storage buckets для биометрических фото
-- ────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('originals', 'originals', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('processed', 'processed', false)
on conflict (id) do nothing;

-- ────────────────────────────────────────────────────────────────────
-- Таблица photos (история обработанных фото)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.photos (
  id                uuid          primary key default gen_random_uuid(),
  telegram_user_id  text          not null default 'anonymous',
  original_path     text          not null,
  processed_path    text          not null,
  mime_type         text          not null default 'image/jpeg',
  status            text          not null default 'completed',
  created_at        timestamptz   not null default now()
);

create index if not exists photos_user_idx       on public.photos (telegram_user_id);
create index if not exists photos_created_at_idx on public.photos (created_at desc);

-- ────────────────────────────────────────────────────────────────────
-- RLS — только service_role читает таблицу (Edge Function пишет туда)
-- ────────────────────────────────────────────────────────────────────
alter table public.photos enable row level security;

drop policy if exists "service_role_all" on public.photos;
create policy "service_role_all" on public.photos
  for all using (auth.role() = 'service_role')
         with check (auth.role() = 'service_role');
