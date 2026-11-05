import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Video } from "../core/types.js";

const run = promisify(execFile);

/**
 * Fonte provisória: lê a página pública de Shorts do canal com yt-dlp.
 * Não precisa de OAuth, mas as views vêm arredondadas (ex.: 1,1 mil) e sem data/retenção.
 * Será substituída pela YouTube Analytics API (OAuth) na próxima etapa.
 */
export async function fetchPublicShorts(channelId: string, opts: { ytDlp?: string } = {}): Promise<Video[]> {
  if (!/^UC[\w-]{22}$/.test(channelId)) throw new Error(`channelId inválido: ${channelId}`);
  const { stdout } = await run(
    opts.ytDlp ?? "yt-dlp",
    ["--flat-playlist", "-J", `https://www.youtube.com/channel/${channelId}/shorts`],
    { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
  );
  const data = JSON.parse(stdout) as { entries?: Array<Record<string, unknown>> };
  return (data.entries ?? []).map((e) => ({
    id: String(e.id),
    platform: "youtube" as const,
    title: String(e.title ?? ""),
    url: typeof e.url === "string" ? e.url : undefined,
    views: typeof e.view_count === "number" ? e.view_count : 0,
    durationSec: typeof e.duration === "number" ? e.duration : undefined,
  }));
}
