// Busca PTAX (BCB), market cap da Yduqs (brapi) e da Afya (Finnhub),
// grava a atualização no histórico em nome do usuário logado e devolve a linha.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function getJson(url: string) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function fetchPtax(tipo: string) {
  // data de hoje no fuso de Brasília; volta até 10 dias para achar a última PTAX publicada
  const now = new Date(Date.now() - 3 * 3600 * 1000);
  for (let i = 0; i < 10; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${mm}-${dd}-${yyyy}'&$format=json`;
    const j = await getJson(url);
    if (j.value && j.value.length) {
      const v = j.value[j.value.length - 1];
      return { valor: tipo === "compra" ? v.cotacaoCompra : v.cotacaoVenda, data: `${dd}/${mm}/${yyyy}` };
    }
  }
  throw new Error("nenhuma PTAX nos últimos 10 dias");
}

async function fetchYduqs(token: string, ticker: string, sharesMn: number | null) {
  if (!token) throw new Error("token brapi não configurado");
  const j = await getJson(`https://brapi.dev/api/quote/${encodeURIComponent(ticker)}?token=${encodeURIComponent(token)}`);
  const q = j.results && j.results[0];
  if (!q) throw new Error("ticker não encontrado");
  const px = q.regularMarketPrice;
  const mc = sharesMn ? px * sharesMn : (q.marketCap ? q.marketCap / 1e6 : null);
  if (!mc) throw new Error("market cap indisponível");
  return { px, mc };
}

async function fetchAfya(token: string, ticker: string, sharesMn: number | null) {
  if (!token) throw new Error("token Finnhub não configurado");
  const t = encodeURIComponent(token), s = encodeURIComponent(ticker);
  const [q, p] = await Promise.all([
    getJson(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${t}`),
    getJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${s}&token=${t}`),
  ]);
  const px = q && q.c ? q.c : null;
  const shares = sharesMn || (p && p.shareOutstanding) || null;
  const usd = (px && shares) ? px * shares : (p && p.marketCapitalization) || null;
  if (!usd) throw new Error("cotação/market cap indisponível");
  return { px, usd };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "método não permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sessão expirada. Entre novamente." }, 401);

  const admin = createClient(url, service);
  const { data: prof } = await admin.from("profiles").select("username, ativo").eq("id", user.id).single();
  if (!prof || !prof.ativo) return json({ error: "Usuário sem acesso." }, 403);

  let body: { div_y?: number; div_a?: number } = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }

  // configurações e tokens
  const { data: cfgRows } = await admin.from("app_config").select("key, value");
  const cfg: Record<string, any> = Object.fromEntries((cfgRows ?? []).map((r) => [r.key, r.value]));
  const { data: secRows } = await admin.from("app_secrets").select("key, value");
  const sec: Record<string, string> = Object.fromEntries((secRows ?? []).map((r) => [r.key, r.value]));
  const brapiToken = Deno.env.get("BRAPI_TOKEN") || sec.brapi_token || "";
  const finnhubToken = Deno.env.get("FINNHUB_TOKEN") || sec.finnhub_token || "";
  const tickers = cfg.tickers ?? { yduqs: "YDUQ3", afya: "AFYA" };
  const acoes = cfg.acoes_mn ?? {};
  const ptaxTipo = cfg.ptax_tipo ?? "venda";
  const divPadrao = cfg.dividendos_padrao ?? { y: 750, a: 1160 };

  const [rFx, rYd, rAf] = await Promise.allSettled([
    fetchPtax(ptaxTipo),
    fetchYduqs(brapiToken, tickers.yduqs, acoes.yduqs ? Number(acoes.yduqs) : null),
    fetchAfya(finnhubToken, tickers.afya, acoes.afya ? Number(acoes.afya) : null),
  ]);
  const erros: string[] = [];
  if (rFx.status === "rejected") erros.push("PTAX: " + rFx.reason.message);
  if (rYd.status === "rejected") erros.push("Yduqs: " + rYd.reason.message);
  if (rAf.status === "rejected") erros.push("Afya: " + rAf.reason.message);
  if (erros.length === 3) return json({ error: "Nenhuma fonte respondeu.", erros }, 502);

  // se alguma fonte falhou, mantém o último valor conhecido
  const { data: ultimo } = await admin.from("historico").select("*").eq("tipo", "update")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const fallback = ultimo ?? { ptax: 5.2034, ptax_data: null, yd_mc: 2853.3, yd_px: null, af_usd: 5764.3 / 5.2034, af_px: null };
  if (rFx.status === "rejected" || rYd.status === "rejected" || rAf.status === "rejected") {
    if (!ultimo) erros.push("sem atualização anterior: usados os valores de referência");
  }

  const row = {
    user_id: user.id,
    usuario: prof.username,
    tipo: "update",
    ptax: rFx.status === "fulfilled" ? rFx.value.valor : fallback.ptax,
    ptax_data: rFx.status === "fulfilled" ? rFx.value.data : fallback.ptax_data,
    ptax_tipo: ptaxTipo,
    yd_mc: rYd.status === "fulfilled" ? rYd.value.mc : fallback.yd_mc,
    yd_px: rYd.status === "fulfilled" ? rYd.value.px : fallback.yd_px,
    af_usd: rAf.status === "fulfilled" ? rAf.value.usd : fallback.af_usd,
    af_px: rAf.status === "fulfilled" ? rAf.value.px : fallback.af_px,
    div_y: Number.isFinite(body.div_y) ? body.div_y : divPadrao.y,
    div_a: Number.isFinite(body.div_a) ? body.div_a : divPadrao.a,
    erros,
  };
  const { data: inserted, error } = await admin.from("historico").insert(row).select().single();
  if (error) return json({ error: "Falha ao gravar no histórico: " + error.message }, 500);
  return json({ row: inserted, erros });
});
