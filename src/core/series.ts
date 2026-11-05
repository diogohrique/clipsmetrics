import type { SeriesPartRef, Video } from "./types.js";

// Aceita "… | Caso Champinha Parte 3 #shorts" (YouTube) e "Caso Champinha Parte 3: …" (TikTok/Instagram).
const SERIES_RE = /\bCaso\s+(.+?)\s+Parte\s+(\d{1,3})\b/i;

export function normalizeKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseSeriesTitle(title: string): SeriesPartRef | null {
  const m = SERIES_RE.exec(title);
  if (!m) return null;
  const caseName = m[1].trim();
  return { caseName, caseKey: normalizeKey(caseName), part: Number(m[2]) };
}

export interface PartStats {
  part: number;
  videoId: string;
  title: string;
  url?: string;
  views: number;
  /** views da parte / views da Parte 1 (1 = manteve o público). */
  vsFirst: number | null;
  /** views da parte / views da parte anterior publicada. */
  vsPrevious: number | null;
  durationSec?: number;
}

export interface SeriesReport {
  caseName: string;
  caseKey: string;
  platform: Video["platform"];
  parts: PartStats[];
  totalViews: number;
  avgViews: number;
  /** Partes que faltam entre 1 e a maior parte encontrada. */
  missingParts: number[];
  /** Parte com maior queda em relação à anterior (onde o público abandona). */
  biggestDrop: { part: number; vsPrevious: number } | null;
  /** Parte com mais views. */
  best: { part: number; views: number } | null;
}

function round(n: number, d = 3): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Agrupa vídeos por série (caso + rede) e calcula a retenção de público entre partes. */
export function buildSeriesReports(videos: Video[]): SeriesReport[] {
  const groups = new Map<string, { ref: SeriesPartRef; video: Video }[]>();
  for (const video of videos) {
    const ref = parseSeriesTitle(video.title);
    if (!ref) continue;
    const key = `${video.platform}:${ref.caseKey}`;
    const list = groups.get(key) ?? [];
    list.push({ ref, video });
    groups.set(key, list);
  }

  const reports: SeriesReport[] = [];
  for (const items of groups.values()) {
    // Se a mesma parte aparece duas vezes (repostagem), fica a de mais views.
    const byPart = new Map<number, { ref: SeriesPartRef; video: Video }>();
    for (const it of items) {
      const cur = byPart.get(it.ref.part);
      if (!cur || it.video.views > cur.video.views) byPart.set(it.ref.part, it);
    }
    const sorted = [...byPart.values()].sort((a, b) => a.ref.part - b.ref.part);
    const first = byPart.get(1)?.video.views ?? null;

    const parts: PartStats[] = sorted.map((it, i) => {
      const prev = i > 0 ? sorted[i - 1].video.views : null;
      return {
        part: it.ref.part,
        videoId: it.video.id,
        title: it.video.title,
        url: it.video.url,
        views: it.video.views,
        vsFirst: first ? round(it.video.views / first) : null,
        vsPrevious: prev ? round(it.video.views / prev) : null,
        durationSec: it.video.durationSec,
      };
    });

    const maxPart = sorted[sorted.length - 1].ref.part;
    const missingParts: number[] = [];
    for (let p = 1; p <= maxPart; p++) if (!byPart.has(p)) missingParts.push(p);

    let biggestDrop: SeriesReport["biggestDrop"] = null;
    for (const p of parts) {
      if (p.vsPrevious !== null && (biggestDrop === null || p.vsPrevious < biggestDrop.vsPrevious)) {
        biggestDrop = { part: p.part, vsPrevious: p.vsPrevious };
      }
    }
    const bestPart = parts.reduce((a, b) => (b.views > a.views ? b : a));
    const totalViews = parts.reduce((s, p) => s + p.views, 0);

    reports.push({
      caseName: sorted[0].ref.caseName,
      caseKey: sorted[0].ref.caseKey,
      platform: sorted[0].video.platform,
      parts,
      totalViews,
      avgViews: Math.round(totalViews / parts.length),
      missingParts,
      biggestDrop,
      best: { part: bestPart.part, views: bestPart.views },
    });
  }
  return reports.sort((a, b) => b.totalViews - a.totalViews);
}
