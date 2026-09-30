-- Substitui a PTAX pela cotação spot USD/BRL (Yahoo Finance) buscada a cada UPDATE.
alter table public.historico rename column ptax to fx;
alter table public.historico rename column ptax_data to fx_data;
alter table public.historico rename column ptax_tipo to fx_fonte;
comment on column public.historico.fx is 'Cotação USD/BRL usada no cálculo';
comment on column public.historico.fx_data is 'Horário da cotação (ISO) ou data da PTAX em registros antigos';
comment on column public.historico.fx_fonte is 'Fonte da cotação';
update public.historico set fx_fonte = 'PTAX BCB (' || coalesce(fx_fonte,'venda') || ')'
  where fx_fonte is null or fx_fonte in ('venda','compra');
delete from public.app_config where key = 'ptax_tipo';
