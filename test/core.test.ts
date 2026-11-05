import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeriesReports, parseSeriesTitle } from "../src/core/series.ts";
import { checkTikTokDurations, rollingSum, yppProgress } from "../src/core/monetization.ts";
import type { Video } from "../src/core/types.ts";

test("lê títulos do YouTube e do TikTok", () => {
  assert.deepEqual(parseSeriesTitle("O pai de Liana relembra | Caso Champinha Parte 1 #shorts"), {
    caseName: "Champinha", caseKey: "champinha", part: 1,
  });
  assert.deepEqual(parseSeriesTitle("Caso Irmãs Yoshifusa Parte 12: a carta"), {
    caseName: "Irmãs Yoshifusa", caseKey: "irmas yoshifusa", part: 12,
  });
  assert.equal(parseSeriesTitle("Corpo Encontrado! #shorts"), null);
});

const v = (id: string, title: string, views: number, platform: Video["platform"] = "youtube"): Video => ({ id, title, views, platform });

test("relatório de série: retenção, faltando, maior queda", () => {
  const [r] = buildSeriesReports([
    v("a", "x | Caso Champinha Parte 1 #shorts", 1000),
    v("b", "y | Caso Champinha Parte 2 #shorts", 800),
    v("c", "z | Caso Champinha Parte 4 #shorts", 200),
    v("d", "sem série #shorts", 5000),
  ]);
  assert.equal(r.caseName, "Champinha");
  assert.deepEqual(r.parts.map((p) => p.vsFirst), [1, 0.8, 0.2]);
  assert.deepEqual(r.missingParts, [3]);
  assert.deepEqual(r.biggestDrop, { part: 4, vsPrevious: 0.25 });
  assert.equal(r.totalViews, 2000);
});

test("separa a mesma série por rede e fica com a repostagem mais vista", () => {
  const reports = buildSeriesReports([
    v("a", "Caso Eloá Parte 1: mãe", 100, "tiktok"),
    v("b", "Caso Eloá Parte 1: mãe", 300, "tiktok"),
    v("c", "m | Caso Eloá Parte 1 #shorts", 50),
  ]);
  assert.equal(reports.length, 2);
  assert.equal(reports.find((r) => r.platform === "tiktok")!.parts[0].views, 300);
});

test("janela móvel de 90 dias e views que expiram", () => {
  const daily = Array.from({ length: 100 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10),
    value: 10,
  }));
  const asOf = daily[99].date;
  assert.equal(rollingSum(daily, 90, asOf), 900);
  const p = yppProgress({ subscribers: 371, shortsDaily: daily, asOf });
  assert.equal(p.shortsPath.views90d, 900);
  assert.equal(p.expiringNext7d, 70);
  assert.equal(p.eligible, false);
  assert.equal(p.subscribers.pct, 37.1);
});

test("duração mínima do TikTok", () => {
  const r = checkTikTokDurations([
    { id: "1", title: "a", views: 0, platform: "tiktok", durationSec: 59 },
    { id: "2", title: "b", views: 0, platform: "tiktok", durationSec: 75 },
    { id: "3", title: "c", views: 0, platform: "tiktok" },
  ]);
  assert.deepEqual(r.map((x) => x.qualifies), [false, true, null]);
});

test("duração ISO 8601 do YouTube", async () => {
  const { parseIsoDuration } = await import("../src/sources/youtubeAnalytics.ts");
  assert.equal(parseIsoDuration("PT59S"), 59);
  assert.equal(parseIsoDuration("PT1M5S"), 65);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
});

test("partes recentes ficam fora da maior queda e da média", () => {
  const now = Date.parse("2026-11-05T16:00:00Z");
  const mk = (id: string, part: number, views: number, publishedAt: string): Video => ({
    id, platform: "youtube", title: `x | Caso Teste Parte ${part} #shorts`, views, publishedAt,
  });
  const [r] = buildSeriesReports(
    [mk("a", 1, 1000, "2026-11-04T09:00:00Z"), mk("b", 2, 900, "2026-11-04T12:00:00Z"), mk("c", 3, 0, "2026-11-05T15:00:00Z")],
    { now },
  );
  assert.equal(r.parts[2].recent, true);
  assert.deepEqual(r.biggestDrop, { part: 2, vsPrevious: 0.9 });
  assert.equal(r.avgViews, 950);
});
