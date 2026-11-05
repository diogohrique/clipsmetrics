#!/usr/bin/env node
// Uso: npm run relatorio -- <channelId>
import { buildSeriesReports } from "./core/series.js";
import { fetchPublicShorts } from "./sources/youtubePublic.js";

const channelId = process.argv[2] ?? process.env.CLIPMETRICS_YT_CHANNEL;
if (!channelId) {
  console.error("Uso: npm run relatorio -- <channelId>");
  process.exit(1);
}

const videos = await fetchPublicShorts(channelId);
const reports = buildSeriesReports(videos);
console.log(`${videos.length} Shorts lidos, ${reports.length} séries encontradas.\n`);
for (const r of reports) {
  console.log(`== Caso ${r.caseName} (${r.platform}) — ${r.parts.length} partes, ${r.totalViews} views, média ${r.avgViews}`);
  for (const p of r.parts) {
    const vsFirst = p.vsFirst === null ? "  -  " : `${Math.round(p.vsFirst * 100)}%`.padStart(5);
    console.log(`  Parte ${String(p.part).padStart(2)}  ${String(p.views).padStart(7)} views  vs P1 ${vsFirst}`);
  }
  if (r.missingParts.length) console.log(`  Faltando: ${r.missingParts.join(", ")}`);
  if (r.biggestDrop) console.log(`  Maior queda: Parte ${r.biggestDrop.part} (${Math.round(r.biggestDrop.vsPrevious * 100)}% da anterior)`);
  console.log();
}
