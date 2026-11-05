#!/usr/bin/env node
import { access } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildSeriesReports, normalizeKey } from "./core/series.js";
import { checkTikTokDurations, yppProgress } from "./core/monetization.js";
import { fetchPublicShorts } from "./sources/youtubePublic.js";
import { configDir } from "./sources/googleAuth.js";
import { daysAgo, getAllVideos, getChannel, getLongWatchHours, getShortsDaily, getVideoStats } from "./sources/youtubeAnalytics.js";
import type { Video } from "./core/types.js";

const DEFAULT_CHANNEL = process.env.CLIPMETRICS_YT_CHANNEL ?? "";
/** Data inicial para buscar vídeos na API (pega todo o histórico relevante). */
const HISTORY_START = process.env.CLIPMETRICS_HISTORY_START ?? "2025-01-01";
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function hasOAuth(): Promise<boolean> {
  try {
    await access(join(configDir(), "token.json"));
    return true;
  } catch {
    return false;
  }
}

/** Vídeos do canal: API oficial se autorizada (views exatas + retenção), senão página pública. */
async function getVideos(channelId?: string): Promise<{ source: string; videos: Video[] }> {
  if (!channelId && (await hasOAuth())) {
    const videos = await cached("api:videos", () => getAllVideos(HISTORY_START, daysAgo(1)));
    return { source: "YouTube Data API (views exatas) + Analytics API (retenção)", videos };
  }
  const id = channelId || DEFAULT_CHANNEL;
  if (!id) throw new Error("Autorize o YouTube (npm run auth), informe channelId ou defina CLIPMETRICS_YT_CHANNEL.");
  const videos = await cached(`pub:${id}`, () => fetchPublicShorts(id));
  return { source: "página pública (views arredondadas)", videos };
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const channelArg = z
  .string()
  .optional()
  .describe("Id de outro canal do YouTube (UC...), lido pela página pública. Omita para usar o seu canal autorizado.");

const server = new McpServer({ name: "clipmetrics", version: "0.2.0" });

server.registerTool(
  "resumo_canal",
  {
    title: "Resumo do canal e progresso no YPP",
    description:
      "Inscritos, views de Shorts nos últimos 90 dias (públicas e engajadas, a que conta para o YPP), horas de vídeos longos em 12 meses, progresso no Programa de Parcerias e views que saem da janela de 90 dias na próxima semana. Requer o YouTube autorizado.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const today = daysAgo(1); // a API consolida com ~1-2 dias de atraso
    const [ch, daily, longHours] = await Promise.all([
      cached("api:channel", getChannel),
      cached("api:daily", () => getShortsDaily(daysAgo(120), today)),
      cached("api:long", () => getLongWatchHours(daysAgo(365), today)),
    ]);
    const ypp = yppProgress({ subscribers: ch.subscribers, shortsDaily: daily.engaged, longWatchHours365d: longHours, asOf: today });
    const last7 = daily.engaged.slice(-7).reduce((s, p) => s + p.value, 0);
    const views90d = daily.views.filter((p) => p.date > daysAgo(91)).reduce((s, p) => s + p.value, 0);
    return json({
      canal: ch,
      dadosAte: today,
      shorts: { views90d, engagedViews90d: ypp.shortsPath.views90d, engagedViewsUltimos7d: last7, mediaDiaria7d: Math.round(last7 / 7) },
      ypp,
    });
  },
);

server.registerTool(
  "top_videos",
  {
    title: "Vídeos mais vistos com retenção",
    description:
      "Lista os vídeos com mais views num período, com views engajadas, % médio assistido e duração. Bom para descobrir que tipo de corte segura o público.",
    inputSchema: {
      dias: z.number().int().min(1).max(365).default(28).describe("Período em dias (padrão 28)"),
      limite: z.number().int().min(1).max(50).default(15),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ dias, limite }) => {
    const videos = await cached(`api:top:${dias}`, () => getVideoStats(daysAgo(dias), daysAgo(1), 200));
    return json(
      videos.slice(0, limite).map((v) => ({
        titulo: v.title,
        url: v.url,
        views: v.views,
        engagedViews: v.engagedViews,
        pctAssistido: v.avgViewPercentage,
        duracaoSeg: v.durationSec,
        publicado: v.publishedAt?.slice(0, 10),
      })),
    );
  },
);

server.registerTool(
  "listar_series",
  {
    title: "Listar séries do canal",
    description:
      "Agrupa os vídeos em séries pelo título ('Caso X Parte N') e mostra, por série: partes, views totais, média, melhor parte, maior queda entre partes e partes faltando.",
    inputSchema: { channelId: channelArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ channelId }) => {
    const { source, videos } = await getVideos(channelId);
    const reports = buildSeriesReports(videos);
    return json({ fonte: source, series: reports.map(({ parts, ...r }) => ({ ...r, partsFound: parts.length })) });
  },
);

server.registerTool(
  "relatorio_serie",
  {
    title: "Relatório de uma série",
    description:
      "Detalha uma série parte a parte: views, retenção de público em relação à Parte 1 (vsFirst) e à anterior (vsPrevious) e % médio assistido. vsFirst 0.5 = a parte teve metade das views da Parte 1.",
    inputSchema: { caso: z.string().describe("Nome do caso, ex.: 'Champinha'"), channelId: channelArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ caso, channelId }) => {
    const key = normalizeKey(caso);
    const { source, videos } = await getVideos(channelId);
    const reports = buildSeriesReports(videos);
    const found = reports.find((r) => r.caseKey === key) ?? reports.find((r) => r.caseKey.includes(key));
    if (!found) return json({ erro: `Série '${caso}' não encontrada`, disponiveis: reports.map((r) => r.caseName) });
    return json({ fonte: source, ...found });
  },
);

server.registerTool(
  "progresso_monetizacao_youtube",
  {
    title: "Calculadora do Programa de Parcerias do YouTube",
    description:
      "Calcula o progresso no YPP a partir de números informados (para qualquer canal). Para o seu canal autorizado, prefira resumo_canal, que busca tudo sozinho.",
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
