export type Platform = "youtube" | "tiktok" | "instagram";

/** Um vídeo publicado, normalizado entre as redes. */
export interface Video {
  id: string;
  platform: Platform;
  title: string;
  url?: string;
  views: number;
  publishedAt?: string; // ISO 8601
  durationSec?: number;
  /** Views "engajadas" do YouTube Shorts (contagem antiga, a que vale para o YPP). */
  engagedViews?: number;
  /** % média assistida (0-100), quando a fonte fornece. */
  avgViewPercentage?: number;
  /** Id do vídeo de origem (ex.: episódio do canal fonte), marcado manualmente ou vindo do OpusClip. */
  sourceId?: string;
}

export interface SeriesPartRef {
  caseName: string;
  /** Chave normalizada para agrupar (sem acento, minúscula). */
  caseKey: string;
  part: number;
}
