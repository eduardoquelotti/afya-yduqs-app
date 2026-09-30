// Gestão de usuários pelo administrador: listar, criar, editar, redefinir senha,
// ativar/desativar e excluir. Também cria o primeiro admin (bootstrap) enquanto não existir nenhum.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL_DOMAIN = "usuarios.riafya.app";
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const toEmail = (u: string) => `${u}@${EMAIL_DOMAIN}`;
const BAN_FOREVER = "876000h"; // ~100 anos

function checkPassword(p: unknown) {
  if (typeof p !== "string" || p.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "método não permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service, { auth: { persistSession: false } });

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Requisição inválida." }, 400); }
  const action = body.action;

  try {
    // ---------- bootstrap: só funciona enquanto não houver nenhum admin ----------
    if (action === "bootstrap") {
      const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
      if ((count ?? 0) > 0) return json({ error: "Já existe um administrador." }, 403);
      const username = String(body.username || "").toLowerCase().trim();
      if (!USERNAME_RE.test(username)) throw new Error("Usuário inválido.");
      checkPassword(body.password);
      const { data, error } = await admin.auth.admin.createUser({ email: toEmail(username), password: body.password, email_confirm: true });
      if (error) throw error;
      const { error: e2 } = await admin.from("profiles").insert({ id: data.user.id, username, nome: body.nome || username, role: "admin" });
      if (e2) { await admin.auth.admin.deleteUser(data.user.id); throw e2; }
      return json({ ok: true, id: data.user.id });
    }

    // ---------- demais ações: exigem admin logado ----------
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Sessão expirada. Entre novamente." }, 401);
    const { data: me } = await admin.from("profiles").select("role, ativo").eq("id", user.id).single();
    if (!me || !me.ativo || me.role !== "admin") return json({ error: "Apenas administradores." }, 403);

    const countActiveAdmins = async () => {
      const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin").eq("ativo", true);
      return count ?? 0;
    };

    if (action === "list") {
      const { data: profs, error } = await admin.from("profiles").select("*").order("username");
      if (error) throw error;
      const { data: au } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const last = new Map((au?.users ?? []).map((u) => [u.id, u.last_sign_in_at]));
      return json({ users: (profs ?? []).map((p) => ({ ...p, last_sign_in_at: last.get(p.id) ?? null })) });
    }

    if (action === "create") {
      const username = String(body.username || "").toLowerCase().trim();
      if (!USERNAME_RE.test(username)) throw new Error("Usuário inválido: use 3 a 32 caracteres (letras minúsculas, números, ponto, hífen ou _).");
      checkPassword(body.password);
      const role = body.role === "admin" ? "admin" : "user";
      const { data: exists } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
      if (exists) throw new Error("Esse usuário já existe.");
      const { data, error } = await admin.auth.admin.createUser({ email: toEmail(username), password: body.password, email_confirm: true });
      if (error) throw error;
      const { error: e2 } = await admin.from("profiles").insert({ id: data.user.id, username, nome: body.nome || username, role });
      if (e2) { await admin.auth.admin.deleteUser(data.user.id); throw e2; }
      return json({ ok: true });
    }

    if (action === "update") {
      const id = String(body.id || "");
      const patch: Record<string, unknown> = {};
      if (typeof body.nome === "string") patch.nome = body.nome.trim();
      if (body.role === "admin" || body.role === "user") patch.role = body.role;
      if (typeof body.ativo === "boolean") patch.ativo = body.ativo;
      const { data: alvo } = await admin.from("profiles").select("role, ativo").eq("id", id).single();
      if (!alvo) throw new Error("Usuário não encontrado.");
      const perdeAdmin = alvo.role === "admin" && alvo.ativo && (patch.role === "user" || patch.ativo === false);
      if (perdeAdmin && (await countActiveAdmins()) <= 1) throw new Error("Não é possível remover o último administrador ativo.");
      const { error } = await admin.from("profiles").update(patch).eq("id", id);
      if (error) throw error;
      if (typeof body.ativo === "boolean") {
        await admin.auth.admin.updateUserById(id, { ban_duration: body.ativo ? "none" : BAN_FOREVER });
      }
      return json({ ok: true });
    }

    if (action === "set_password") {
      checkPassword(body.password);
      const { error } = await admin.auth.admin.updateUserById(String(body.id || ""), { password: body.password });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (id === user.id) throw new Error("Você não pode excluir o próprio usuário.");
      const { data: alvo } = await admin.from("profiles").select("role, ativo").eq("id", id).single();
      if (alvo?.role === "admin" && alvo.ativo && (await countActiveAdmins()) <= 1) throw new Error("Não é possível excluir o último administrador ativo.");
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400);
  }
});
