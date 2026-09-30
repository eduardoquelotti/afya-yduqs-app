# RI Control · Combinação Afya + Yduqs

Aplicação web para acompanhar o market cap combinado de Afya e Yduqs, os dividendos esperados e a relação de troca entre os acionistas. Cada atualização fica registrada num histórico compartilhado, com o nome de quem atualizou.

## Como funciona

- **Front-end:** `index.html`, publicado no GitHub Pages. Funciona em computador, iPad e celular.
- **Banco e login:** Supabase. O login é por usuário e senha, e só o administrador cria acessos, na aba **Usuários** do app.
- **Dados de mercado:** a função `market-data` roda no servidor do Supabase. Ela busca:
  - a PTAX no Banco Central,
  - o market cap da Yduqs na brapi,
  - o market cap da Afya na Finnhub.

  Em seguida grava a linha no histórico. Os tokens das APIs ficam na tabela `app_secrets`, que só o servidor lê.

## Estrutura

| Caminho | O que é |
|---|---|
| `index.html` | App completo: login, visão, histórico, usuários e configurações |
| `supabase/migrations/001_init.sql` | Tabelas, regras de acesso (RLS) e valores padrão |
| `supabase/functions/market-data` | UPDATE: busca os dados de mercado e grava no histórico |
| `supabase/functions/admin-users` | Gestão de usuários pelo administrador |

## Tabelas

- `profiles`: usuário, nome, perfil (`admin`/`user`) e situação (ativo ou desativado).
- `historico`: cada UPDATE ou simulação, com PTAX, market caps, dividendos, autor e falhas de fonte.
- `app_config`: dividendos padrão, tickers, ações em circulação opcionais, tipo de PTAX e logos.
- `app_secrets`: tokens da brapi e da Finnhub. Não tem nenhuma policy, então só o servidor acessa.

## Permissões

| Ação | Usuário | Administrador |
|---|---|---|
| Ver visão e histórico | ✓ | ✓ |
| UPDATE e registrar simulação | ✓ | ✓ |
| Excluir linhas do histórico | | ✓ |
| Alterar configurações e logos | | ✓ |
| Criar, editar, desativar e excluir usuários | | ✓ |
