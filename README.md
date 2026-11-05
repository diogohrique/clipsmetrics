# clipmetrics

Analytics para canais de cortes e canais sem rosto (YouTube Shorts, TikTok, Instagram Reels), com conexão ao Claude e ao ChatGPT por MCP.

O que diferencia este app das ferramentas genéricas (Metricool, mLabs, Reportei):

- **Séries e partes**: agrupa os vídeos por "Caso X Parte N" e mostra quanto público cada parte mantém em relação à Parte 1 e à anterior.
- **Monetização**: progresso no YPP com a janela móvel de 90 dias (incluindo as views que saem da janela na semana seguinte) e checagem da duração mínima para o Programa de Recompensas do TikTok.
- **Várias contas**: pensado para quem opera vários canais, com preço por portfólio. Ainda não implementado.
- **Atribuição à origem**: qual vídeo-fonte rendeu os melhores cortes. O campo `sourceId` já existe nos dados, mas a integração ainda não foi feita.

## Estado atual (v0.3, MVP de uso próprio)

| Peça | Status |
|---|---|
| Núcleo: séries, retenção entre partes, YPP, duração no TikTok | pronto e com testes |
| Fonte provisória do YouTube: página pública de Shorts via `yt-dlp` (views arredondadas, sem retenção) | pronta |
| Servidor MCP local (stdio) com 6 ferramentas | pronto |
| Fonte oficial do YouTube: Data API (views exatas em tempo real) + Analytics API (views engajadas por dia, % assistido) via OAuth | pronta |
| Servidor MCP remoto no Cloudflare Workers (Streamable HTTP + OAuth 2.1, login Google, lista de e-mails permitidos) | pronto, falta publicar |
| TikTok e Instagram (exigem aprovação de app; o Instagram exige CNPJ) | só após validar a demanda |

## Uso

Requer Node 20 ou mais recente e `yt-dlp` no PATH.

```bash
npm install
npm test
npm run relatorio -- UCy81o2ZJv_AinMAcfxTG5uA
```

Servidor MCP local, por exemplo no Claude Code:

```bash
claude mcp add clipmetrics -e CLIPMETRICS_YT_CHANNEL=UCy81o2ZJv_AinMAcfxTG5uA -- npx tsx /caminho/para/clipmetrics/src/mcp.ts
```

Ferramentas: `resumo_canal`, `top_videos`, `listar_series`, `relatorio_serie`, `progresso_monetizacao_youtube`, `checar_duracao_tiktok`.

### Autorizar o YouTube (API oficial)

1. No Google Cloud, crie um cliente OAuth do tipo **App para computador**. Ative a YouTube Data API v3 e a YouTube Analytics API, com os escopos `youtube.readonly` e `yt-analytics.readonly`.
2. Coloque o JSON baixado em `~/.config/clipmetrics/client_secret.json`, ou defina `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. **Nunca faça commit desse arquivo.**
3. Rode `npm run auth`, abra o link e autorize. O navegador vai para `http://localhost/?...`, uma página que não carrega. Copie o endereço e rode `npm run auth -- "<endereço>"`.
4. O token fica em `~/.config/clipmetrics/token.json`. Com o app em modo "Teste" no Google, a autorização vence a cada 7 dias: basta repetir o passo 3.

Sem autorização, as ferramentas de séries usam a página pública do canal via `yt-dlp` (views arredondadas).

Observações sobre os dados:
- A Analytics API consolida com 1 a 2 dias de atraso. Por isso a lista de vídeos vem da Data API, que é em tempo real, e a retenção entra quando estiver disponível.
- Partes publicadas há menos de 24 h ficam marcadas como `recent` e não entram na média, na melhor parte nem na maior queda.
- `engagedViews` é a contagem antiga de views de Shorts, a que vale para os 10M do YPP.
- Um % assistido acima de 100 significa replays (Shorts em loop).

## Regras de monetização usadas (conferidas em nov/2026)

- **YPP**: 1.000 inscritos e mais 10M de views de Shorts em 90 dias, ou 4.000 h de exibição de vídeos longos em 12 meses.
- **TikTok, Programa de Recompensas**: 10 mil seguidores e 100 mil views em 30 dias; só contam vídeos com **mais de 1 minuto**.

Os valores ficam em `src/core/monetization.ts` e podem ser alterados, porque as plataformas mudam as regras.

## Cuidados com as políticas das APIs

- A política do YouTube restringe "métricas derivadas" (projeções, razões de retenção) para apps de terceiros até que passem por auditoria (Derived Metrics Policy, jun/2026). Enquanto o app for só de uso próprio, isso não pesa. Antes de abrir para outros usuários, é preciso pedir a auditoria.
- Os dados de analytics do YouTube só podem ser mostrados a quem autorizou o acesso. A autorização deve ser reconfirmada a cada 30 dias, e os dados apagados em até 7 dias depois da revogação.

## Servidor remoto (claude.ai)

O código fica em `worker/`. É um Cloudflare Worker que:

- implementa o OAuth 2.1 exigido pelo claude.ai (registro dinâmico de cliente e PKCE), com `@cloudflare/workers-oauth-provider`;
- faz o login no Google e guarda o refresh token do Google criptografado no KV;
- só aceita contas em `ALLOWED_EMAILS` e redirecionamentos para `claude.ai`, `claude.com` e `localhost`;
- usa as mesmas ferramentas do servidor local (`src/tools.ts`), sem a leitura pública via yt-dlp.

### Configuração (uma vez)

1. **Cloudflare**: crie uma conta grátis e anote o **Account ID**, que aparece na página inicial do painel. Crie um **API Token** com o modelo "Edit Cloudflare Workers" e acrescente a permissão *Account → Workers KV Storage → Edit*.
2. **Google Cloud**: em Clientes, crie um cliente OAuth do tipo **Aplicativo da Web**. Em URI de redirecionamento autorizado, coloque `https://clipmetrics.<seu-subdominio>.workers.dev/callback`. O subdomínio aparece em Workers & Pages → Account details.
3. **GitHub** (Settings → Secrets and variables → Actions → New repository secret):
   - `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`
   - `GOOGLE_WEB_CLIENT_ID` e `GOOGLE_WEB_CLIENT_SECRET` (do cliente Web do passo 2)
   - `ALLOWED_EMAILS`: os e-mails que podem usar, separados por vírgula
4. Rode o workflow **Deploy do clipmetrics (Cloudflare)** em Actions → Run workflow. Ele também roda sozinho a cada push em `src/` ou `worker/`.
5. **claude.ai** → Configurações → Conectores → Adicionar conector personalizado, com a URL `https://clipmetrics.<seu-subdominio>.workers.dev/mcp`.

Com o app do Google em modo "Teste", a autorização vence a cada 7 dias. Quando vencer, desconecte e conecte o conector de novo no claude.ai.
