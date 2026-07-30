/**
 * favoritePlaceSegmentation.tsで「1番人気自身の単勝オッズが低いほど複勝回収率が
 * 上がる（オッズ1.5未満で98.0%）」ことが分かったため、閾値をより細かく刻んで
 * どこまで回収率が伸びるか、また4期間+外れ値除去で頑健かを確認する。
 *
 *   npx ts-node favoriteOddsThresholdBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; horseName: string; finishRank: number;
  odds: number | null; winPayout: number | null; placePayouts: number[];
}

function loadRecords(years: number[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const year of years) {
    const file = path.join(__dirname, `race_facts_${year}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line));
    }
  }
  return records;
}
function raceKeyOf(r: RaceFactRecord): string {
  return `${r.year}-${r.kaisai}-${r.location}-${r.day}-${r.raceNumber}`;
}
function dateToNum(raceDate: string): number {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  return m ? parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10) : 0;
}

const UNIT_STAKE = 100;
interface Bucket { races: number; hits: number; cost: number; returned: number; hitPayouts: number[]; }
function newBucket(): Bucket { return { races: 0, hits: 0, cost: 0, returned: 0, hitPayouts: [] }; }
function fmtBucket(b: Bucket): string {
  const hitRate = b.races > 0 ? (b.hits / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  const top3 = [...b.hitPayouts].sort((a, c) => c - a).slice(0, 3).reduce((s, v) => s + v, 0);
  const roiEx = b.cost > 0 ? ((b.returned - top3) / b.cost) * 100 : 0;
  return `的中率=${hitRate.toFixed(1)}% 回収率=${roi.toFixed(1)}%(上位3件除くと${roiEx.toFixed(1)}%) (n=${b.races})`;
}

const ODDS_THRESHOLDS = [1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0];

function evaluateThreshold(records: RaceFactRecord[], maxOdds: number): Bucket {
  const races = new Map<string, RaceFactRecord[]>();
  for (const r of records) {
    if (r.odds == null || r.odds <= 0 || !(r.finishRank > 0)) continue;
    const key = raceKeyOf(r);
    (races.get(key) ?? races.set(key, []).get(key)!).push(r);
  }
  const b = newBucket();
  for (const horses of races.values()) {
    if (horses.length < 5) continue;
    const favorite = [...horses].sort((a, c) => a.odds! - c.odds!)[0];
    if (!favorite || favorite.odds! >= maxOdds) continue;
    b.races++; b.cost += UNIT_STAKE;
    if (favorite.finishRank >= 1 && favorite.finishRank <= 3 && favorite.placePayouts.length >= favorite.finishRank) {
      const payout = favorite.placePayouts[favorite.finishRank - 1];
      b.hits++; b.returned += payout; b.hitPayouts.push(payout);
    }
  }
  return b;
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);

  console.log('=== オッズ閾値別の回収率（2025-2026通期） ===');
  for (const th of ODDS_THRESHOLDS) {
    console.log(`オッズ<${th}: ${fmtBucket(evaluateThreshold(allRecords, th))}`);
  }

  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods: { label: string; filter: (r: RaceFactRecord) => boolean }[] = [
    { label: '2025 Q1', filter: r => r.year === 2025 && dateToNum(r.raceDate) < Q2_START },
    { label: '2025 Q2', filter: r => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: '2025 Q3', filter: r => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: '2025 Q4', filter: r => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: '2026年', filter: r => r.year === 2026 },
  ];

  console.log('\n=== 有力候補（オッズ<1.5, <1.8）の期間別頑健性 ===');
  for (const th of [1.5, 1.8]) {
    console.log(`\n--- オッズ<${th} ---`);
    for (const p of periods) {
      const records = allRecords.filter(p.filter);
      console.log(`${p.label}: ${fmtBucket(evaluateThreshold(records, th))}`);
    }
  }
}

main();
