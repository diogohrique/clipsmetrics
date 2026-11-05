# clipmetrics

Analytics para canais de cortes e canais sem rosto (YouTube Shorts, TikTok, Instagram Reels), com conexão ao Claude e ao ChatGPT por MCP.

O que diferencia este app das ferramentas genéricas (Metricool, mLabs, Reportei):

- **Séries e partes**: agrupa os vídeos por "Caso X Parte N" e mostra quanto público cada parte mantém em relação à Parte 1 e à anterior.
- **Monetização**: progresso no YPP com a janela móvel de 90 dias (incluindo as views que saem da janela na semana seguinte) e checagem da duração mínima para o Programa de Recompensas do TikTok.
- **Várias contas**: pensado para quem opera vários canais, com preço por portfólio. Ainda não implementado.
- **Atribuição à origem**: qual vídeo-fonte rendeu os melhores cortes. O campo `sourceId` já existe nos dados, mas a integração ainda não foi feita.

## Estado atual (v0.1, MVP de uso próprio)

| Peça | Status |
|---|---|
| Núcleo: séries, retenção entre partes, YPP, duração no TikTok | pronto e com testes |
| Fonte provisória do YouTube: página pública de Shorts via `yt-dlp` (views arredondadas, sem retenção) | pronta |
| Servidor MCP local (stdio) com 4 ferramentas | pronto |
| Fonte oficial: YouTube Analytics API (OAuth, views engajadas por dia, retenção) | próxima etapa |
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

Ferramentas: `listar_series`, `relatorio_serie`, `progresso_monetizacao_youtube`, `checar_duracao_tiktok`.

## Regras de monetização usadas (conferidas em nov/2026)

- **YPP**: 1.000 inscritos e mais 10M de views de Shorts em 90 dias, ou 4.000 h de exibição de vídeos longos em 12 meses.
- **TikTok, Programa de Recompensas**: 10 mil seguidores e 100 mil views em 30 dias; só contam vídeos com **mais de 1 minuto**.

Os valores ficam em `src/core/monetization.ts` e podem ser alterados, porque as plataformas mudam as regras.

## Cuidados com as políticas das APIs

- A política do YouTube restringe "métricas derivadas" (projeções, razões de retenção) para apps de terceiros até que passem por auditoria (Derived Metrics Policy, jun/2026). Enquanto o app for só de uso próprio, isso não pesa. Antes de abrir para outros usuários, é preciso pedir a auditoria.
- Os dados de analytics do YouTube só podem ser mostrados a quem autorizou o acesso. A autorização deve ser reconfirmada a cada 30 dias, e os dados apagados em até 7 dias depois da revogação.
