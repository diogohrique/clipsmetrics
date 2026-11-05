import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OAuth do Google para app instalado (cliente "App para computador"), com PKCE.
 * Fluxo manual: o usuário abre o link, autoriza e o navegador vai para http://localhost/?code=...
 * (a página não carrega, e tudo bem). O endereço é colado de volta e trocado pelo token.
 * O código sozinho não serve para nada sem o verificador PKCE, que fica só neste ambiente.
 */

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

const REDIRECT_URI = "http://localhost";
export const configDir = () => process.env.CLIPMETRICS_HOME ?? join(homedir(), ".config", "clipmetrics");

interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope?: string;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writePrivate(path: string, data: unknown) {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function loadClient(): Promise<ClientConfig> {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  }
  const file = await readJson<{ installed?: { client_id: string; client_secret: string } }>(
    join(configDir(), "client_secret.json"),
  );
  if (file?.installed) return { clientId: file.installed.client_id, clientSecret: file.installed.client_secret };
  throw new Error(
    `Credenciais do Google não encontradas. Defina GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET ou coloque o JSON em ${join(configDir(), "client_secret.json")}.`,
  );
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Gera o link de autorização e guarda o verificador PKCE para a troca. */
export async function startAuth(): Promise<string> {
  const { clientId } = await loadClient();
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  await writePrivate(join(configDir(), "pending_auth.json"), { verifier, state, createdAt: Date.now() });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<StoredToken & { expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google recusou a troca de token: ${data.error} ${data.error_description ?? ""}`);
  return data as unknown as StoredToken & { expires_in: number };
}

/** Recebe o endereço completo para onde o navegador foi (ou só o code) e salva o token. */
export async function finishAuth(redirectedUrlOrCode: string): Promise<StoredToken> {
  const pending = await readJson<{ verifier: string; state: string }>(join(configDir(), "pending_auth.json"));
  if (!pending) throw new Error("Nenhuma autorização pendente. Gere o link de novo.");
  let code = redirectedUrlOrCode.trim();
  if (code.startsWith("http")) {
    const u = new URL(code);
    if (u.searchParams.get("error")) throw new Error(`Autorização negada: ${u.searchParams.get("error")}`);
    if (u.searchParams.get("state") !== pending.state) throw new Error("O state não confere. Gere o link de novo.");
    code = u.searchParams.get("code") ?? "";
  }
  if (!code) throw new Error("Não encontrei o code no endereço.");
  const { clientId, clientSecret } = await loadClient();
  const t = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
  });
  const stored: StoredToken = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
    scope: t.scope,
  };
  await writePrivate(join(configDir(), "token.json"), stored);
  await writePrivate(join(configDir(), "pending_auth.json"), {});
  return stored;
}

/** Devolve um access token válido, renovando com o refresh token quando preciso. */
export async function getAccessToken(): Promise<string> {
  const path = join(configDir(), "token.json");
  const tok = await readJson<StoredToken>(path);
  if (!tok) throw new Error("YouTube não autorizado ainda. Rode: npm run auth");
  if (tok.expires_at - 60_000 > Date.now()) return tok.access_token;
  if (!tok.refresh_token) throw new Error("Token expirado e sem refresh token. Rode: npm run auth");
  const { clientId, clientSecret } = await loadClient();
  try {
    const t = await tokenRequest({
      refresh_token: tok.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    });
    const next: StoredToken = { ...tok, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 };
    await writePrivate(path, next);
    return next.access_token;
  } catch (e) {
    throw new Error(
      `${(e as Error).message}\nA autorização venceu (no modo "Teste" do Google ela dura 7 dias). Rode: npm run auth`,
    );
  }
}
