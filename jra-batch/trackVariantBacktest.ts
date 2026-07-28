/**
 * 「日別トラックバリアント」: 同じ馬場状態カテゴリ(良/稍重/重/不良)の中でも、
 * その日・その競馬場全体の走破タイムが基準よりどれだけ速い/遅いかを連続値で求め、
 * 過去走のスコアに補正として反映する。
 *
 * 具体的には、ある日・ある競馬場で行われた全レース・全出走馬の「基準タイムに対する
 * z-score(speedIndex)」を平均したものを、その日のバリアントとする。過去走を評価する際、
 * その過去走のspeedIndexからその日のバリアントを差し引いてから、既存の重み付け
 * (新しさ×信頼度×サーフェス一致×距離一致)を適用する。
 *
 * 「乖離を狙う」「選別ベット」で学んだ教訓を踏まえ、必ず4つの独立した期間
 * (ウォークフォワード)で、補正あり/なしを比較する。
 *
 *   npx ts-node trackVariantBacktest.ts
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
function dayLocationKey(r: RaceFactRecord): string {
  return `${r.raceDate}|${r.location}`;
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

interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; dayKey: string; }
interface Bucket { count: number; wins: number; cost: number; returned: number; }
function newBucket(): Bucket { return { count: 0, wins: 0, cost: 0, returned: 0 }; }
function printBucket(label: string, b: Bucket): void {
  const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  console.log(`  ${label}: 件数${b.count}  勝率${winRate.toFixed(2)}%  回収率${roi.toFixed(1)}%`);
}

function evaluatePeriod(
  allRecords: RaceFactRecord[],
  trainFilter: (r: RaceFactRecord) => boolean,
  testFilter: (r: RaceFactRecord) => boolean
): { totalRaces: number; baseline: Bucket; adjusted: Bucket } {
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

  // 日別トラックバリアント：train基準の生speedIndexを、日・競馬場ごとに平均する
  const dayVariantSums = new Map<string, { sum: number; count: number }>();
  for (const r of allRecords) {
    const stats = lookupGradeOnly(gradeOnlyStats, r.location, r.trackType, r.distance, r.condition, r.grade);
    if (!stats || stats.variance <= 0) continue;
    const speedIndex = (stats.mean - r.totalSeconds / r.distance) / Math.sqrt(stats.variance);
    const key = dayLocationKey(r);
    const entry = dayVariantSums.get(key) ?? { sum: 0, count: 0 };
    entry.sum += speedIndex; entry.count++;
    dayVariantSums.set(key, entry);
  }
  const dayVariant = new Map<string, number>();
  for (const [k, v] of dayVariantSums) dayVariant.set(k, v.sum / v.count);

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of allRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
      dayKey: dayLocationKey(r),
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);

  function scoreOf(horseName: string, dateNum: number, today: { trackType: string; distance: number }, useVariant: boolean): number | null {
    const list = horseHistory.get(horseName);
    if (!list) return null;
    const history = list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
    let weightedSum = 0, weightSum = 0;
    history.forEach((e, slotIndex) => {
      const stats = lookupGradeOnly(gradeOnlyStats, e.location, e.trackType, e.distance, e.condition, e.grade);
      if (!stats || stats.variance <= 0) return;
      let speedIndex = (stats.mean - e.secondsPerMeter) / Math.sqrt(stats.variance);
      if (useVariant) speedIndex -= dayVariant.get(e.dayKey) ?? 0;
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

  const baselineBucket = newBucket();
  const adjustedBucket = newBucket();
  let totalRaces = 0;

  for (const { today, entrants } of races.values()) {
    const base = entrants
      .map(e => ({ ...e, score: scoreOf(e.horseName, e.dateNum, today, false) }))
      .filter((e): e is typeof e & { score: number; odds: number } => e.score !== null && e.odds !== null && e.odds > 0);
    const adj = entrants
      .map(e => ({ ...e, score: scoreOf(e.horseName, e.dateNum, today, true) }))
      .filter((e): e is typeof e & { score: number; odds: number } => e.score !== null && e.odds !== null && e.odds > 0);
    if (base.length < 2 || adj.length < 2) continue;
    totalRaces++;

    const baseTop1 = [...base].sort((a, b) => b.score - a.score)[0];
    baselineBucket.count++; baselineBucket.cost += UNIT_STAKE;
    if (baseTop1.finishRank === 1) { baselineBucket.wins++; baselineBucket.returned += baseTop1.odds * UNIT_STAKE; }

    const adjTop1 = [...adj].sort((a, b) => b.score - a.score)[0];
    adjustedBucket.count++; adjustedBucket.cost += UNIT_STAKE;
    if (adjTop1.finishRank === 1) { adjustedBucket.wins++; adjustedBucket.returned += adjTop1.odds * UNIT_STAKE; }
  }

  return { totalRaces, baseline: baselineBucket, adjusted: adjustedBucket };
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;

  const periods = [
    { label: 'train=Q1 / test=Q2(4-6月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2 / test=Q3(7-9月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3 / test=Q4(10-12月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: 'train=2025通年 / test=2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];

  console.log('モデル1位を単勝で買った場合の回収率比較(トラックバリアント補正 あり/なし):\n');
  let sumBase = newBucket(), sumAdj = newBucket();
  for (const p of periods) {
    const result = evaluatePeriod(allRecords, p.train, p.test);
    console.log(`--- ${p.label} (検証レース数=${result.totalRaces}) ---`);
    printBucket('補正なし(現行)', result.baseline);
    printBucket('補正あり(トラックバリアント)', result.adjusted);
    sumBase.count += result.baseline.count; sumBase.wins += result.baseline.wins; sumBase.cost += result.baseline.cost; sumBase.returned += result.baseline.returned;
    sumAdj.count += result.adjusted.count; sumAdj.wins += result.adjusted.wins; sumAdj.cost += result.adjusted.cost; sumAdj.returned += result.adjusted.returned;
  }
  console.log('\n--- 全期間合計 ---');
  printBucket('補正なし(現行)', sumBase);
  printBucket('補正あり(トラックバリアント)', sumAdj);
}

main();
