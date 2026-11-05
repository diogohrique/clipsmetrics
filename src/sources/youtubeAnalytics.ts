import type { DailyPoint } from "../core/monetization.js";
import type { Video } from "../core/types.js";
import { getAccessToken } from "./googleAuth.js";

const DATA = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";

async function get<T>(url: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${body.error?.message ?? "erro"}`);
  return body;
}

interface ReportTable {
  columnHeaders: { name: string }[];
  rows?: (string | number)[][];
}

async function report(params: Record<string, string>): Promise<Record<string, string | number>[]> {
  const q = new URLSearchParams({ ids: "channel==MINE", ...params });
  const t = await get<ReportTable>(`${ANALYTICS}?${q}`);
  const names = t.columnHeaders.map((c) => c.name);
  return (t.rows ?? []).map((r) => Object.fromEntries(r.map((v, i) => [names[i], v])));
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number, from = new Date()) => isoDay(new Date(from.getTime() - n * 86_400_000));

/** "PT1M5S" -> 65 */
export function parseIsoDuration(s: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s);
  if (!m) return 0;
  const [, d, h, mi, se] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + mi * 60 + se;
}

export interface ChannelInfo {
  id: string;
  title: string;
  subscribers: number;
  totalViews: number;
  videoCount: number;
}

export async function getChannel(): Promise<ChannelInfo> {
  const r = await get<{ items: { id: string; snippet: { title: string }; statistics: Record<string, string> }[] }>(
    `${DATA}/channels?part=snippet,statistics&mine=true`,
  );
  const c = r.items?.[0];
  if (!c) throw new Error("Nenhum canal encontrado para esta conta Google.");
  return {
    id: c.id,
    title: c.snippet.title,
    subscribers: Number(c.statistics.subscriberCount),
    totalViews: Number(c.statistics.viewCount),
    videoCount: Number(c.statistics.videoCount),
  };
}

/**
 * Views diárias de Shorts. `engagedViews` é a contagem antiga (anterior a 31/03/2025),
 * que é a usada para o requisito de 10M de views do YPP.
 */
export async function getShortsDaily(startDate: string, endDate: string): Promise<{ views: DailyPoint[]; engaged: DailyPoint[] }> {
  const rows = await report({
    startDate,
    endDate,
    metrics: "views,engagedViews",
    dimensions: "day",
    filters: "creatorContentType==shorts",
    sort: "day",
  });
  return {
    views: rows.map((r) => ({ date: String(r.day), value: Number(r.views) })),
    engaged: rows.map((r) => ({ date: String(r.day), value: Number(r.engagedViews) })),
  };
}

export async function getLongWatchHours(startDate: string, endDate: string): Promise<number> {
  const rows = await report({
    startDate,
    endDate,
    metrics: "estimatedMinutesWatched",
    dimensions: "creatorContentType",
  });
  const vod = rows.find((r) => r.creatorContentType === "videoOnDemand");
  return vod ? Math.round((Number(vod.estimatedMinutesWatched) / 60) * 10) / 10 : 0;
}

interface VideoResource {
  id: string;
  snippet: { title: string; publishedAt: string };
  contentDetails: { duration: string };
  statistics?: { viewCount?: string };
}

/**
 * Todos os uploads do canal com views exatas em tempo real (Data API), enriquecidos com
 * views engajadas e % assistido da Analytics API quando já consolidados (vídeos de 1–2 dias
 * ainda não aparecem no relatório da Analytics).
 */
export async function getAllVideos(analyticsStart: string, analyticsEnd: string): Promise<Video[]> {
  const ch = await get<{ items: { contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
    `${DATA}/channels?part=contentDetails&mine=true`,
  );
  const uploads = ch.items?.[0]?.contentDetails.relatedPlaylists.uploads;
  if (!uploads) throw new Error("Playlist de uploads não encontrada.");

  const ids: string[] = [];
  let pageToken = "";
  do {
    const r = await get<{ items: { contentDetails: { videoId: string } }[]; nextPageToken?: string }>(
      `${DATA}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    ids.push(...r.items.map((i) => i.contentDetails.videoId));
    pageToken = r.nextPageToken ?? "";
  } while (pageToken && ids.length < 5000);

  const videos: Video[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await get<{ items: VideoResource[] }>(
      `${DATA}/videos?part=snippet,contentDetails,statistics&id=${ids.slice(i, i + 50).join(",")}`,
    );
    for (const v of r.items ?? []) {
      videos.push({
        id: v.id,
        platform: "youtube",
        title: v.snippet.title,
        url: `https://www.youtube.com/shorts/${v.id}`,
        views: Number(v.statistics?.viewCount ?? 0),
        publishedAt: v.snippet.publishedAt,
        durationSec: parseIsoDuration(v.contentDetails.duration),
      });
    }
  }

  // Analytics: até 200 vídeos por consulta; pega os mais vistos do período.
  const stats = await getVideoStats(analyticsStart, analyticsEnd, 200, false);
  const byId = new Map(stats.map((s) => [s.id, s]));
  for (const v of videos) {
    const s = byId.get(v.id);
    if (s) {
      v.engagedViews = s.engagedViews;
      v.avgViewPercentage = s.avgViewPercentage;
    }
  }
  return videos;
}

/** Vídeos com métricas do período (até 200, o máximo da API por consulta) e títulos/duração. */
export async function getVideoStats(startDate: string, endDate: string, maxResults = 200, withMeta = true): Promise<Video[]> {
  const rows = await report({
    startDate,
    endDate,
    metrics: "views,engagedViews,averageViewPercentage,averageViewDuration,subscribersGained",
    dimensions: "video",
    sort: "-views",
    maxResults: String(Math.min(maxResults, 200)),
  });
  const ids = rows.map((r) => String(r.video));
  const meta = new Map<string, { title: string; publishedAt: string; durationSec: number }>();
  for (let i = 0; withMeta && i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await get<{ items: { id: string; snippet: { title: string; publishedAt: string }; contentDetails: { duration: string } }[] }>(
      `${DATA}/videos?part=snippet,contentDetails&id=${chunk.join(",")}`,
    );
    for (const v of r.items ?? []) {
      meta.set(v.id, { title: v.snippet.title, publishedAt: v.snippet.publishedAt, durationSec: parseIsoDuration(v.contentDetails.duration) });
    }
  }
  return rows.map((r) => {
    const id = String(r.video);
    const m = meta.get(id);
    return {
      id,
      platform: "youtube" as const,
      title: m?.title ?? id,
      url: `https://www.youtube.com/shorts/${id}`,
      views: Number(r.views),
      engagedViews: Number(r.engagedViews),
      avgViewPercentage: Number(r.averageViewPercentage),
      durationSec: m?.durationSec,
      publishedAt: m?.publishedAt,
    };
  });
}
