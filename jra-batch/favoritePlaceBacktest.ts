/**
 * crossPoolArbitrage.tsで見つかった「複勝は人気馬(特に1番人気)がほぼ理論上無傷の
 * 価格で払い戻される」という構造的な発見を、理論比率ではなく実際のROIとして
 * 直接検証する。予想モデルは一切使わず、単勝オッズだけで決まる「市場の人気順」
 * そのものを買い目にする点に注意（モデルの予測力とは無関係な、市場構造だけの検証）。
 *
 *   npx ts-node favoritePlaceBacktest.ts
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

const UNIT_STAKE = 100;

interface Bucket { races: number; hits: number; cost: number; returned: number; }
function newBucket(): Bucket { return { races: 0, hits: 0, cost: 0, returned: 0 }; }
function printBucket(label: string, b: Bucket): void {
  const hitRate = b.races > 0 ? (b.hits / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  console.log(`${label}: 的中率=${hitRate.toFixed(2)}% 回収率=${roi.toFixed(1)}% (n=${b.races}レース)`);
}

function dateToNum(raceDate: string): number {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  return m ? parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10) : 0;
}

function evaluate(records: RaceFactRecord[]): { winByPop: Map<number, Bucket>; placeByPop: Map<number, Bucket> } {
  const races = new Map<string, RaceFactRecord[]>();
  for (const r of records) {
    if (r.odds == null || r.odds <= 0 || !(r.finishRank > 0)) continue;
    const key = raceKeyOf(r);
    (races.get(key) ?? races.set(key, []).get(key)!).push(r);
  }

  const winByPop = new Map<number, Bucket>();
  const placeByPop = new Map<number, Bucket>();
  for (let i = 1; i <= 3; i++) { winByPop.set(i, newBucket()); placeByPop.set(i, newBucket()); }

  for (const horses of races.values()) {
    if (horses.length < 5) continue;
    const byOdds = [...horses].sort((a, b) => a.odds! - b.odds!);
    for (let pop = 1; pop <= 3; pop++) {
      const horse = byOdds[pop - 1];
      if (!horse) continue;

      const wb = winByPop.get(pop)!;
      wb.races++; wb.cost += UNIT_STAKE;
      if (horse.finishRank === 1 && horse.winPayout != null) { wb.hits++; wb.returned += horse.winPayout; }

      const pb = placeByPop.get(pop)!;
      pb.races++; pb.cost += UNIT_STAKE;
      if (horse.finishRank >= 1 && horse.finishRank <= 3 && horse.placePayouts.length >= horse.finishRank) {
        pb.hits++; pb.returned += horse.placePayouts[horse.finishRank - 1];
      }
    }
  }
  return { winByPop, placeByPop };
}

function printPeriod(label: string, records: RaceFactRecord[]): void {
  const { winByPop, placeByPop } = evaluate(records);
  console.log(`\n=== ${label} ===`);
  for (let pop = 1; pop <= 3; pop++) {
    printBucket(`  ${pop}番人気 単勝`, winByPop.get(pop)!);
    printBucket(`  ${pop}番人気 複勝`, placeByPop.get(pop)!);
  }
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);

  console.log('市場の人気順(単勝オッズ基準)そのものを買い目にした場合の実回収率:');
  printPeriod('2025-2026通期', allRecords);

  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  printPeriod('2025 Q1(1-3月)', allRecords.filter(r => r.year === 2025 && dateToNum(r.raceDate) < Q2_START));
  printPeriod('2025 Q2(4-6月)', allRecords.filter(r => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START));
  printPeriod('2025 Q3(7-9月)', allRecords.filter(r => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START));
  printPeriod('2025 Q4(10-12月)', allRecords.filter(r => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START));
  printPeriod('2026年', allRecords.filter(r => r.year === 2026));
}

main();
