#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildSeriesReports, normalizeKey } from "./core/series.js";
import { checkTikTokDurations, yppProgress } from "./core/monetization.js";
import { fetchPublicShorts } from "./sources/youtubePublic.js";
import type { Video } from "./core/types.js";

const DEFAULT_CHANNEL = process.env.CLIPMETRICS_YT_CHANNEL ?? "";
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; videos: Video[] }>();

async function getShorts(channelId: string): Promise<Video[]> {
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.videos;
  const videos = await fetchPublicShorts(channelId);
  cache.set(channelId, { at: Date.now(), videos });
  return videos;
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const channelArg = z
  .string()
  .optional()
  .describe("Id do canal do YouTube (UC...). Se omitido, usa CLIPMETRICS_YT_CHANNEL.");

function resolveChannel(c?: string): string {
  const id = c || DEFAULT_CHANNEL;
  if (!id) throw new Error("Informe channelId ou defina CLIPMETRICS_YT_CHANNEL.");
  return id;
}

const server = new McpServer({ name: "clipmetrics", version: "0.1.0" });

server.registerTool(
  "listar_series",
  {
    title: "Listar séries do canal",
    description:
      "Agrupa os Shorts do canal em séries pelo título ('Caso X Parte N') e mostra, por série: partes, views totais, média, melhor parte, maior queda entre partes e partes faltando.",
    inputSchema: { channelId: channelArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ channelId }) => {
    const reports = buildSeriesReports(await getShorts(resolveChannel(channelId)));
    return json(
      reports.map(({ parts, ...r }) => ({ ...r, partsFound: parts.length })),
    );
  },
);

server.registerTool(
  "relatorio_serie",
  {
    title: "Relatório de uma série",
    description:
      "Detalha uma série parte a parte: views, retenção em relação à Parte 1 (vsFirst) e à parte anterior (vsPrevious). vsFirst 0.5 = a parte teve metade das views da Parte 1.",
    inputSchema: { caso: z.string().describe("Nome do caso, ex.: 'Champinha'"), channelId: channelArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ caso, channelId }) => {
    const key = normalizeKey(caso);
    const reports = buildSeriesReports(await getShorts(resolveChannel(channelId)));
    const found = reports.find((r) => r.caseKey === key) ?? reports.find((r) => r.caseKey.includes(key));
    if (!found) return json({ erro: `Série '${caso}' não encontrada`, disponiveis: reports.map((r) => r.caseName) });
    return json(found);
  },
);

server.registerTool(
  "progresso_monetizacao_youtube",
  {
    title: "Progresso no Programa de Parcerias do YouTube",
    description:
      "Calcula o progresso para o YPP (1.000 inscritos + 10M de views de Shorts em 90 dias, ou 4.000 h de exibição em vídeos longos em 12 meses). Por enquanto recebe os números do YouTube Studio; com a API conectada, buscará sozinho.",
    inputSchema: {
      inscritos: z.number().int().nonnegative(),
      viewsShorts90d: z.number().int().nonnegative().optional(),
      horasLongos365d: z.number().nonnegative().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ inscritos, viewsShorts90d, horasLongos365d }) =>
    json(
      yppProgress({
        subscribers: inscritos,
        shortsViews90d: viewsShorts90d,
        longWatchHours365d: horasLongos365d,
        asOf: new Date().toISOString().slice(0, 10),
      }),
    ),
);

server.registerTool(
  "checar_duracao_tiktok",
  {
    title: "Checar duração para o Programa de Recompensas do TikTok",
    description: "Diz quais vídeos têm mais de 1 minuto (exigência do Programa de Recompensas para Criadores do TikTok).",
    inputSchema: {
      videos: z.array(z.object({ id: z.string(), titulo: z.string(), duracaoSeg: z.number().optional() })),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ videos }) =>
    json(
      checkTikTokDurations(
        videos.map((v) => ({ id: v.id, title: v.titulo, durationSec: v.duracaoSeg, platform: "tiktok", views: 0 })),
      ),
    ),
);

await server.connect(new StdioServerTransport());
