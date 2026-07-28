/**
 * 穴馬(モデルvs市場の乖離)検証の的中件数を増やすため、2つの独立したtrain/test期間で
 * 評価し、結果をプールする。
 *   期間A: train=2025年前半(〜6月) / test=2025年後半(7月〜)
 *   期間B: train=2025年通年 / test=2026年
 * 各期間は自分より前のデータだけを基準に使うので、期間をまたいだリークは無い。
 *
 *   npx ts-node valueBetBacktestPooled.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number; odds: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const UNIT_STAKE = 100;

function loadRecords(years: number[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const year of years) {
    const file = path.join(__dirname, `race_facts_${year}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.distance > 0 && r.condition !== '不明' && r.totalSeconds > 0) records.push(r);
    }
  }
  return records;
}
function dateToNum(raceDate: string): number {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  return m ? parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10) : 0;
}
function raceKeyOf(r: RaceFactRecord): string {
  return `${r.year}-${r.kaisai}-${r.location}-${r.day}-${r.raceNumber}`;
}
function computeStats(values: number[]): BaselineStats {
  const count = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / count;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
  return { count, mean, variance };
}
function gradeOnlyKey(loc: string, t: string, d: number, c: string, g: RaceGrade): string {
  return `${loc}|${t}|${d}|${c}|${g ?? 'NONE'}`;
}
function lookupGradeOnly(stats: Record<string, BaselineStats>, loc: string, t: string, d: number, c: string, g: RaceGrade): BaselineStats | null {
  const exact = stats[gradeOnlyKey(loc, t, d, c, g)];
  if (exact) return exact;
  if (g !== null) {
    const fb = stats[gradeOnlyKey(loc, t, d, c, null)];
    if (fb) return fb;
  }
  return null;
}

interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }

interface Bucket { count: number; wins: number; cost: number; returned: number; }
function newBucket(): Bucket { return { count: 0, wins: 0, cost: 0, returned: 0 }; }
function addBucket(a: Bucket, b: Bucket): void { a.count += b.count; a.wins += b.wins; a.cost += b.cost; a.returned += b.returned; }
function printBucket(label: string, b: Bucket): void {
  const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  console.log(`  ${label}: 件数${b.count}  勝率${winRate.toFixed(2)}%  回収率${roi.toFixed(1)}%  (投資${b.cost.toLocaleString()}円→回収${Math.round(b.returned).toLocaleString()}円)`);
}

const gapThresholds = [2, 4, 6, 8];

// 1つのtrain/test期間を評価し、各バケツを返す
function evaluatePeriod(
  allRecords: RaceFactRecord[],
  trainFilter: (r: RaceFactRecord) => boolean,
  testFilter: (r: RaceFactRecord) => boolean
) {
  const trainRecords = allRecords.filter(trainFilter);
  const testRecords = allRecords.filter(testFilter);

  const gradeOnlyStats: Record<string, BaselineStats> = {};
  {
    const grouped = new Map<string, number[]>();
    for (const r of trainRecords) {
      const key = gradeOnlyKey(r.location, r.trackType, r.distance, r.condition, r.grade);
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(r.totalSeconds / r.distance);
    }
    for (const [k, v] of grouped) gradeOnlyStats[k] = computeStats(v);
  }

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of allRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);

  function scoreOf(horseName: string, dateNum: number, today: { trackType: string; distance: number }): number | null {
    const list = horseHistory.get(horseName);
    if (!list) return null;
    const history = list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
    let weightedSum = 0, weightSum = 0;
    history.forEach((e, slotIndex) => {
      const stats = lookupGradeOnly(gradeOnlyStats, e.location, e.trackType, e.distance, e.condition, e.grade);
      if (!stats || stats.variance <= 0) return;
      const speedIndex = (stats.mean - e.secondsPerMeter) / Math.sqrt(stats.variance);
      const recency = RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
      const reliability = Math.min(1, stats.count / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
      const surface = e.trackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
      const distanceW = Math.max(MIN_DISTANCE_WEIGHT, 1 - Math.abs(e.distance - today.distance) * DISTANCE_DECAY_PER_METER);
      const weight = recency * reliability * surface * distanceW;
      weightedSum += weight * speedIndex;
      weightSum += weight;
    });
    return weightSum > 0 ? weightedSum / weightSum : null;
  }

  interface RaceGroup { today: { trackType: string; distance: number }; entrants: { horseName: string; finishRank: number; dateNum: number; odds: number | null }[]; }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] }; races.set(key, race); }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), odds: r.odds });
  }

  const modelTop1 = newBucket();
  const marketFavorite = newBucket();
  const gapBuckets = new Map<number, Bucket>(gapThresholds.map(t => [t, newBucket()]));

  let totalRaces = 0;
  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => ({ ...e, score: scoreOf(e.horseName, e.dateNum, today) }))
      .filter((e): e is typeof e & { score: number; odds: number } => e.score !== null && e.odds !== null && e.odds > 0);
    if (scored.length < 4) continue;
    totalRaces++;

    const byModelDesc = [...scored].sort((a, b) => b.score - a.score);
    const modelRankOf = new Map(byModelDesc.map((e, i) => [e.horseName, i + 1]));
    const byOddsAsc = [...scored].sort((a, b) => a.odds - b.odds);
    const marketRankOf = new Map(byOddsAsc.map((e, i) => [e.horseName, i + 1]));

    const top1 = byModelDesc[0];
    modelTop1.count++; modelTop1.cost += UNIT_STAKE;
    if (top1.finishRank === 1) { modelTop1.wins++; modelTop1.returned += top1.odds * UNIT_STAKE; }

    const fav = byOddsAsc[0];
    marketFavorite.count++; marketFavorite.cost += UNIT_STAKE;
    if (fav.finishRank === 1) { marketFavorite.wins++; marketFavorite.returned += fav.odds * UNIT_STAKE; }

    for (const e of scored) {
      const gap = marketRankOf.get(e.horseName)! - modelRankOf.get(e.horseName)!;
      for (const t of gapThresholds) {
        if (gap < t) continue;
        const b = gapBuckets.get(t)!;
        b.count++; b.cost += UNIT_STAKE;
        if (e.finishRank === 1) { b.wins++; b.returned += e.odds * UNIT_STAKE; }
      }
    }
  }

  return { totalRaces, modelTop1, marketFavorite, gapBuckets };
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const SPLIT_2025 = 20250701; // 2025年前半/後半の境目

  console.log('=== 期間A: train=2025年前半(〜6月) / test=2025年後半(7月〜) ===');
  const periodA = evaluatePeriod(
    allRecords,
    r => r.year === 2025 && dateToNum(r.raceDate) < SPLIT_2025,
    r => r.year === 2025 && dateToNum(r.raceDate) >= SPLIT_2025
  );
  console.log(`検証対象レース数: ${periodA.totalRaces}`);
  printBucket('モデル1位', periodA.modelTop1);
  printBucket('市場1番人気', periodA.marketFavorite);
  for (const t of gapThresholds) printBucket(`乖離${t}以上`, periodA.gapBuckets.get(t)!);

  console.log('\n=== 期間B: train=2025年通年 / test=2026年 ===');
  const periodB = evaluatePeriod(
    allRecords,
    r => r.year === 2025,
    r => r.year === 2026
  );
  console.log(`検証対象レース数: ${periodB.totalRaces}`);
  printBucket('モデル1位', periodB.modelTop1);
  printBucket('市場1番人気', periodB.marketFavorite);
  for (const t of gapThresholds) printBucket(`乖離${t}以上`, periodB.gapBuckets.get(t)!);

  console.log('\n=== 統合(期間A+期間Bをプール) ===');
  console.log(`検証対象レース数: ${periodA.totalRaces + periodB.totalRaces}`);
  const pooledModelTop1 = newBucket(); addBucket(pooledModelTop1, periodA.modelTop1); addBucket(pooledModelTop1, periodB.modelTop1);
  const pooledMarketFav = newBucket(); addBucket(pooledMarketFav, periodA.marketFavorite); addBucket(pooledMarketFav, periodB.marketFavorite);
  printBucket('モデル1位', pooledModelTop1);
  printBucket('市場1番人気', pooledMarketFav);
  for (const t of gapThresholds) {
    const pooled = newBucket();
    addBucket(pooled, periodA.gapBuckets.get(t)!);
    addBucket(pooled, periodB.gapBuckets.get(t)!);
    printBucket(`乖離${t}以上`, pooled);
  }
}

main();
