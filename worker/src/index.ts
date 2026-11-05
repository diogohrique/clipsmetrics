/**
 * clipmetrics remoto: servidor MCP no Cloudflare Workers para usar no claude.ai.
 *
 * - O claude.ai faz OAuth 2.1 com este Worker (registro dinâmico de cliente, PKCE),
 *   via @cloudflare/workers-oauth-provider.
 * - Na autorização, o Worker manda o usuário para o login do Google e guarda o
 *   refresh token do Google nas "props" do grant (criptografadas pelo provider no KV).
 * - Só e-mails em ALLOWED_EMAILS conseguem autorizar.
 * - Só redirecionamentos para hosts em ALLOWED_REDIRECT_HOSTS são aceitos.
 */
import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "../../src/tools.js";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** E-mails Google autorizados, separados por vírgula. */
  ALLOWED_EMAILS: string;
  /** Hosts de redirecionamento aceitos (padrão: claude.ai, claude.com e localhost). */
  ALLOWED_REDIRECT_HOSTS?: string;
}

interface Props {
  email: string;
  googleRefreshToken: string;
}

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
const DEFAULT_REDIRECT_HOSTS = "claude.ai,claude.com,localhost,127.0.0.1";
const STATE_COOKIE = "cm_state";

const list = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5"><h1>${title}</h1><p>${body}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

// ---------- Token do Google (renovado a partir do refresh token, com cache por isolate) ----------

const tokenCache = new Map<string, { token: string; exp: number }>();
const dataCache = new Map<string, Map<string, { at: number; value: unknown }>>();

async function googleToken(env: Env, props: Props): Promise<string> {
  const hit = tokenCache.get(props.email);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: props.googleRefreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `A autorização do Google venceu (${data.error ?? res.status}). No claude.ai, desconecte e conecte o clipmetrics de novo.`,
    );
  }
  tokenCache.set(props.email, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

// ---------- Endpoint MCP (protegido pelo OAuthProvider) ----------

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props: Props }).props;
    let cache = dataCache.get(props.email);
    if (!cache) dataCache.set(props.email, (cache = new Map()));

    const server = new McpServer({ name: "clipmetrics", version: "0.3.0" });
    registerTools(server, { youtube: () => googleToken(env, props), cache });

    // Sem sessão: cada requisição é independente (o Worker não guarda estado entre chamadas).
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// ---------- Rotas públicas: autorização via Google ----------

function getCookie(request: Request, name: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get("cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return page("Cliente desconhecido", "Este aplicativo não está registrado.", 400);

  const host = new URL(oauthReq.redirectUri).hostname.toLowerCase();
  const allowedHosts = list(env.ALLOWED_REDIRECT_HOSTS ?? DEFAULT_REDIRECT_HOSTS);
  if (!allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return page("Destino não permitido", `O endereço de retorno (${host}) não está na lista permitida.`, 403);
  }

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`gstate:${state}`, JSON.stringify(oauthReq), { expirationTtl: 600 });
  const origin = new URL(request.url).origin;
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: google.toString(),
      // Amarra o state ao navegador que iniciou o fluxo (evita login CSRF).
      "set-cookie": `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=600`,
    },
  });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (url.searchParams.get("error")) return page("Autorização cancelada", "O Google não autorizou o acesso.", 400);
  if (!state || getCookie(request, STATE_COOKIE) !== state) {
    return page("Sessão inválida", "Comece a conexão de novo pelo claude.ai.", 400);
  }
  const stored = await env.OAUTH_KV.get(`gstate:${state}`);
  if (!stored) return page("Sessão expirada", "Comece a conexão de novo pelo claude.ai.", 400);
  await env.OAUTH_KV.delete(`gstate:${state}`);
  const oauthReq = JSON.parse(stored) as AuthRequest;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code") ?? "",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`,
      grant_type: "authorization_code",
    }),
  });
  const tok = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; error?: string };
  if (!tokenRes.ok || !tok.access_token) return page("Erro no Google", `Falha ao trocar o código (${tok.error ?? tokenRes.status}).`, 502);
  if (!tok.refresh_token) return page("Erro no Google", "O Google não devolveu o refresh token. Tente conectar de novo.", 502);

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
  const info = (await infoRes.json()) as { email?: string; email_verified?: boolean };
  const email = info.email?.toLowerCase();
  if (!email || !info.email_verified) return page("E-mail não verificado", "Não foi possível confirmar o e-mail da conta Google.", 403);
  if (!list(env.ALLOWED_EMAILS).includes(email)) {
    return page("Acesso não liberado", `A conta ${email} não está autorizada a usar este clipmetrics.`, 403);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: email,
    metadata: { label: email },
    scope: oauthReq.scope,
    props: { email, googleRefreshToken: tok.refresh_token } satisfies Props,
  });
  return new Response(null, {
    status: 302,
    headers: { location: redirectTo, "set-cookie": `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=0` },
  });
}

const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize" && request.method === "GET") return authorize(request, env);
    if (pathname === "/callback" && request.method === "GET") return callback(request, env);
    if (pathname === "/") {
      return page("clipmetrics", "Servidor MCP do clipmetrics. Para usar, adicione <code>/mcp</code> deste endereço como conector personalizado no claude.ai.");
    }
    return new Response("Não encontrado", { status: 404 });
  },
};

// O endereço público (workers.dev ou domínio próprio) só é conhecido na requisição,
// então o provider é criado na primeira chamada para cada origem.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: appHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["clipmetrics"],
      accessTokenTTL: 3600,
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["clipmetrics"],
        bearer_methods_supported: ["header"],
        resource_name: "clipmetrics",
      },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
