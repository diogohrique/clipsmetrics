import type { Video } from "./types.js";

/**
 * Regras de monetização. Ficam configuráveis porque as plataformas mudam os números
 * e podem variar por país. Valores padrão conferidos em nov/2026 (ver README).
 */
export const YPP_DEFAULT = {
  subscribers: 1000,
  shortsViews90d: 10_000_000,
  longWatchHours365d: 4000,
};

export const TIKTOK_REWARDS_DEFAULT = {
  followers: 10_000,
  views30d: 100_000,
  /** Só vídeos com MAIS de 1 minuto geram receita no Programa de Recompensas. */
  minDurationSec: 60,
};

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

/** Soma dos últimos `days` dias (janela móvel) até `asOf` (inclusive). */
export function rollingSum(points: DailyPoint[], days: number, asOf: string): number {
  const end = Date.parse(asOf + "T00:00:00Z");
  const start = end - (days - 1) * 86_400_000;
  return points.reduce((s, p) => {
    const t = Date.parse(p.date + "T00:00:00Z");
    return t >= start && t <= end ? s + p.value : s;
  }, 0);
}

export interface YppProgress {
  subscribers: { current: number; target: number; pct: number; done: boolean };
  shortsPath: { views90d: number; target: number; pct: number; done: boolean };
  longPath?: { watchHours365d: number; target: number; pct: number; done: boolean };
  eligible: boolean;
  /** Views que vão "sair" da janela de 90 dias nos próximos 7 dias. */
  expiringNext7d?: number;
  notes: string[];
}

const pct = (a: number, b: number) => Math.min(100, Math.round((a / b) * 1000) / 10);

export function yppProgress(input: {
  subscribers: number;
  /** Views engajadas diárias de Shorts (YouTube Analytics: engagedViews filtrado por Shorts). */
  shortsDaily?: DailyPoint[];
  /** Alternativa quando só se tem o total da janela (ex.: copiado do YouTube Studio). */
  shortsViews90d?: number;
  longWatchHours365d?: number;
  asOf: string;
  rules?: typeof YPP_DEFAULT;
}): YppProgress {
  const r = input.rules ?? YPP_DEFAULT;
  const notes: string[] = [];
  let views90d = input.shortsViews90d ?? 0;
  let expiringNext7d: number | undefined;

  if (input.shortsDaily) {
    views90d = rollingSum(input.shortsDaily, 90, input.asOf);
    // Dias 84..90 atrás (contando de asOf) saem da janela na próxima semana.
    const end = Date.parse(input.asOf + "T00:00:00Z");
    const from = end - 89 * 86_400_000;
    const to = end - 83 * 86_400_000;
    expiringNext7d = input.shortsDaily.reduce((s, p) => {
      const t = Date.parse(p.date + "T00:00:00Z");
      return t >= from && t <= to ? s + p.value : s;
    }, 0);
  } else if (input.shortsViews90d === undefined) {
    notes.push("Sem dados de views de Shorts: informe shortsDaily ou shortsViews90d.");
  }

  const subs = { current: input.subscribers, target: r.subscribers, pct: pct(input.subscribers, r.subscribers), done: input.subscribers >= r.subscribers };
  const shortsPath = { views90d, target: r.shortsViews90d, pct: pct(views90d, r.shortsViews90d), done: views90d >= r.shortsViews90d };
  const longPath =
    input.longWatchHours365d !== undefined
      ? { watchHours365d: input.longWatchHours365d, target: r.longWatchHours365d, pct: pct(input.longWatchHours365d, r.longWatchHours365d), done: input.longWatchHours365d >= r.longWatchHours365d }
      : undefined;

  const eligible = subs.done && (shortsPath.done || (longPath?.done ?? false));
  return { subscribers: subs, shortsPath, longPath, eligible, expiringNext7d, notes };
}

export interface TikTokDurationCheck {
  id: string;
  title: string;
  durationSec?: number;
  qualifies: boolean | null; // null = duração desconhecida
}

/** Marca quais vídeos têm duração para entrar no Programa de Recompensas do TikTok. */
export function checkTikTokDurations(videos: Video[], rules = TIKTOK_REWARDS_DEFAULT): TikTokDurationCheck[] {
  return videos.map((v) => ({
    id: v.id,
    title: v.title,
    durationSec: v.durationSec,
    qualifies: v.durationSec === undefined ? null : v.durationSec > rules.minDurationSec,
  }));
}
