import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildSeriesReports, normalizeKey } from "./core/series.js";
import { checkTikTokDurations, yppProgress } from "./core/monetization.js";
import {
  daysAgo,
  getAllVideos,
  getChannel,
  getLongWatchHours,
  getShortsDaily,
  getVideoStats,
  type TokenProvider,
} from "./sources/youtubeAnalytics.js";
import type { Video } from "./core/types.js";

/**
 * Ferramentas do clipmetrics, compartilhadas entre o servidor local (stdio) e o remoto (Cloudflare).
 */
export interface ToolDeps {
  /** Token do YouTube do usuário autorizado, ou null se não autorizado. */
  youtube: TokenProvider | null;
  /** Leitura de outro canal pela página pública (só no servidor local, que tem yt-dlp). */
  publicShorts?: (channelId: string) => Promise<Video[]>;
  /** Canal padrão para a leitura pública quando não há OAuth. */
  defaultChannel?: string;
  /** Cache por chave; cada servidor decide o escopo (por processo, por usuário). */
  cache: Map<string, { at: number; value: unknown }>;
  historyStart?: string;
}

const CACHE_MS = 10 * 60_000;
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerTools(server: McpServer, deps: ToolDeps) {
  const cached = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const hit = deps.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await fn();
    deps.cache.set(key, { at: Date.now(), value });
    return value;
  };

  const needYoutube = (): TokenProvider => {
    if (!deps.youtube) throw new Error("YouTube não autorizado. Localmente, rode: npm run auth");
    return deps.youtube;
  };

  const getVideos = async (channelId?: string): Promise<{ source: string; videos: Video[] }> => {
    if (!channelId && deps.youtube) {
      const yt = deps.youtube;
      const videos = await cached("api:videos", () => getAllVideos(yt, deps.historyStart ?? "2025-01-01", daysAgo(1)));
      return { source: "YouTube Data API (views exatas) + Analytics API (retenção)", videos };
    }
    const id = channelId || deps.defaultChannel;
    if (!id) throw new Error("Autorize o YouTube ou informe channelId.");
    if (!deps.publicShorts) throw new Error("Ler outros canais pela página pública só funciona no servidor local.");
    const pub = deps.publicShorts;
    const videos = await cached(`pub:${id}`, () => pub(id));
    return { source: "página pública (views arredondadas)", videos };
  };

  const channelArg = z
    .string()
    .optional()
    .describe("Id de outro canal do YouTube (UC...), lido pela página pública. Omita para usar o seu canal autorizado.");

  server.registerTool(
    "resumo_canal",
    {
      title: "Resumo do canal e progresso no YPP",
      description:
        "Inscritos, views de Shorts nos últimos 90 dias (públicas e engajadas, a que conta para o YPP), horas de vídeos longos em 12 meses, progresso no Programa de Parcerias e views que saem da janela de 90 dias na próxima semana.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const yt = needYoutube();
      const today = daysAgo(1); // a Analytics consolida com ~1-2 dias de atraso
      const [ch, daily, longHours] = await Promise.all([
        cached("api:channel", () => getChannel(yt)),
        cached("api:daily", () => getShortsDaily(yt, daysAgo(120), today)),
        cached("api:long", () => getLongWatchHours(yt, daysAgo(365), today)),
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
        "Lista os vídeos com mais views num período, com views engajadas, % médio assistido (acima de 100 = replays) e duração. Bom para descobrir que tipo de corte segura o público.",
      inputSchema: {
        dias: z.number().int().min(1).max(365).default(28).describe("Período em dias (padrão 28)"),
        limite: z.number().int().min(1).max(50).default(15),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ dias, limite }) => {
      const yt = needYoutube();
      const videos = await cached(`api:top:${dias}`, () => getVideoStats(yt, daysAgo(dias), daysAgo(1), 200));
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
        "Agrupa os vídeos em séries pelo título ('Caso X Parte N') e mostra, por série: partes, views totais, média, melhor parte, maior queda entre partes e partes faltando. Partes com menos de 24 h ficam fora das médias.",
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
}
