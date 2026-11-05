# clipmetrics

Analytics para canais de cortes e canais sem rosto (YouTube Shorts, TikTok, Instagram Reels), com conexão ao Claude e ao ChatGPT por MCP.

O que diferencia este app das ferramentas genéricas (Metricool, mLabs, Reportei):

- **Séries e partes**: agrupa os vídeos por "Caso X Parte N" e mostra quanto público cada parte mantém em relação à Parte 1 e à anterior.
- **Monetização**: progresso no YPP com a janela móvel de 90 dias (incluindo as views que saem da janela na semana seguinte) e checagem da duração mínima para o Programa de Recompensas do TikTok.
- **Várias contas**: pensado para quem opera vários canais, com preço por portfólio. Ainda não implementado.
- **Atribuição à origem**: qual vídeo-fonte rendeu os melhores cortes. O campo `sourceId` já existe nos dados, mas a integração ainda não foi feita.

## Estado atual (v0.2, MVP de uso próprio)

| Peça | Status |
|---|---|
| Núcleo: séries, retenção entre partes, YPP, duração no TikTok | pronto e com testes |
| Fonte provisória do YouTube: página pública de Shorts via `yt-dlp` (views arredondadas, sem retenção) | pronta |
| Servidor MCP local (stdio) com 6 ferramentas | pronto |
| Fonte oficial do YouTube: Data API (views exatas em tempo real) + Analytics API (views engajadas por dia, % assistido) via OAuth | pronta |
| Servidor MCP remoto (Streamable HTTP + OAuth 2.1) para usar no claude.ai | depois |
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
