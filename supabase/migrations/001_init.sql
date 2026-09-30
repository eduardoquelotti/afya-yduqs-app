-- =============================================================
-- RI Control · Combinação Afya + Yduqs — schema inicial
-- Usuários (criados só pelo admin), histórico compartilhado,
-- configurações do app e segredos (tokens das APIs).
-- =============================================================

-- ---------- Perfis de usuário ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  nome        text,
  role        text not null default 'user' check (role in ('admin','user')),
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- Histórico de atualizações e simulações ----------
create table if not exists public.historico (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete set null,
  usuario     text,
  tipo        text not null check (tipo in ('update','simulacao')),
  ptax        numeric not null,
  ptax_data   text,
  ptax_tipo   text,
  yd_mc       numeric not null,   -- R$ milhões
  yd_px       numeric,            -- R$
  af_usd      numeric not null,   -- US$ milhões
  af_px       numeric,            -- US$
  div_y       numeric not null,   -- R$ milhões
  div_a       numeric not null,   -- R$ milhões
  erros       jsonb not null default '[]'::jsonb
);
create index if not exists historico_created_at_idx on public.historico (created_at desc);

-- ---------- Configurações do app (lidas por todos, editadas pelo admin) ----------
create table if not exists public.app_config (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

-- ---------- Segredos (tokens) — sem nenhuma policy: só o servidor lê ----------
create table if not exists public.app_secrets (
  key    text primary key,
  value  text not null
);

-- ---------- Funções auxiliares para as policies ----------
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and ativo);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and ativo and role = 'admin');
$$;

-- Quem insere pelo app fica registrado automaticamente (não dá para se passar por outro usuário)
create or replace function public.historico_set_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
    select username into new.usuario from public.profiles where id = auth.uid();
  end if;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists historico_set_user on public.historico;
create trigger historico_set_user before insert on public.historico
  for each row execute function public.historico_set_user();

create or replace function public.app_config_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists app_config_touch on public.app_config;
create trigger app_config_touch before insert or update on public.app_config
  for each row execute function public.app_config_touch();

-- ---------- Row Level Security ----------
alter table public.profiles    enable row level security;
alter table public.historico   enable row level security;
alter table public.app_config  enable row level security;
alter table public.app_secrets enable row level security;

drop policy if exists "profiles: ver o próprio ou admin vê todos" on public.profiles;
create policy "profiles: ver o próprio ou admin vê todos" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "historico: usuários ativos leem" on public.historico;
create policy "historico: usuários ativos leem" on public.historico
  for select to authenticated using (public.is_active_user());

-- pelo app só se registram simulações; os UPDATEs vêm da função do servidor
drop policy if exists "historico: usuários ativos registram simulação" on public.historico;
create policy "historico: usuários ativos registram simulação" on public.historico
  for insert to authenticated with check (public.is_active_user() and tipo = 'simulacao');

drop policy if exists "historico: admin exclui" on public.historico;
create policy "historico: admin exclui" on public.historico
  for delete to authenticated using (public.is_admin());

drop policy if exists "config: usuários ativos leem" on public.app_config;
create policy "config: usuários ativos leem" on public.app_config
  for select to authenticated using (public.is_active_user());

drop policy if exists "config: admin grava" on public.app_config;
create policy "config: admin grava" on public.app_config
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Valores padrão ----------
insert into public.app_config (key, value) values
  ('dividendos_padrao', '{"y": 750.0, "a": 1160.0}'),
  ('tickers',           '{"yduqs": "YDUQ3", "afya": "AFYA"}'),
  ('acoes_mn',          '{"yduqs": null, "afya": null}'),
  ('ptax_tipo',         '"venda"'),
  ('logos',             '{"afya": "", "yduqs": ""}')
on conflict (key) do nothing;
