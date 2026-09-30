// Busca o dólar spot (Yahoo/AwesomeAPI), market cap da Yduqs (brapi) e da Afya (Finnhub),
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

// Dólar spot USD/BRL: Yahoo Finance como fonte principal, AwesomeAPI como reserva
async function fetchSpot() {
  const falhas: string[] = [];
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/BRL=X?interval=1m&range=1d`, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const m = j?.chart?.result?.[0]?.meta;
      if (!m?.regularMarketPrice) throw new Error("sem cotação");
      return { valor: m.regularMarketPrice, data: new Date(m.regularMarketTime * 1000).toISOString(), fonte: "Yahoo Finance (USD/BRL spot)" };
    } catch (e) { falhas.push(`Yahoo: ${(e as Error).message}`); }
  }
  try {
    const j = await getJson("https://economia.awesomeapi.com.br/json/last/USD-BRL");
    const q = j?.USDBRL;
    if (!q?.bid) throw new Error("sem cotação");
    const valor = q.ask ? (Number(q.bid) + Number(q.ask)) / 2 : Number(q.bid);
    return { valor, data: new Date(Number(q.timestamp) * 1000).toISOString(), fonte: "AwesomeAPI (USD/BRL comercial)" };
  } catch (e) { falhas.push(`AwesomeAPI: ${(e as Error).message}`); }
  throw new Error(falhas.join("; "));
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
  const divPadrao = cfg.dividendos_padrao ?? { y: 750, a: 1160 };

  const [rFx, rYd, rAf] = await Promise.allSettled([
    fetchSpot(),
    fetchYduqs(brapiToken, tickers.yduqs, acoes.yduqs ? Number(acoes.yduqs) : null),
    fetchAfya(finnhubToken, tickers.afya, acoes.afya ? Number(acoes.afya) : null),
  ]);
  const erros: string[] = [];
  if (rFx.status === "rejected") erros.push("Dólar: " + rFx.reason.message);
  if (rYd.status === "rejected") erros.push("Yduqs: " + rYd.reason.message);
  if (rAf.status === "rejected") erros.push("Afya: " + rAf.reason.message);
  if (erros.length === 3) return json({ error: "Nenhuma fonte respondeu.", erros }, 502);

  // se alguma fonte falhou, mantém o último valor conhecido
  const { data: ultimo } = await admin.from("historico").select("*").eq("tipo", "update")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const fallback = ultimo ?? { fx: 5.2034, fx_data: null, fx_fonte: "referência", yd_mc: 2853.3, yd_px: null, af_usd: 5764.3 / 5.2034, af_px: null };
  if (rFx.status === "rejected" || rYd.status === "rejected" || rAf.status === "rejected") {
    if (!ultimo) erros.push("sem atualização anterior: usados os valores de referência");
  }

  const row = {
    user_id: user.id,
    usuario: prof.username,
    tipo: "update",
    fx: rFx.status === "fulfilled" ? rFx.value.valor : fallback.fx,
    fx_data: rFx.status === "fulfilled" ? rFx.value.data : fallback.fx_data,
    fx_fonte: rFx.status === "fulfilled" ? rFx.value.fonte : fallback.fx_fonte,
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
