/**
 * 「モデルの確信度が高いレースだけに絞って賭ける」選別ベットを検証する。
 * 確信度の指標は2種類試す:
 *   1. スコア差: モデル1位と2位の偏差値相当スコアの差（大きいほど「頭一つ抜けている」）
 *   2. 信頼度%: 1位の馬のavgBaselineSpeedIndexConfidence相当（新しさ×基準の厚み×
 *      今日の条件との一致度。データの裏付けがどれだけ厚いかの指標で、他馬との差とは別物）
 *
 * 「乖離を狙う」検証で学んだ教訓(1期間だけで判断すると過学習/ノイズを拾う)を踏まえ、
 * 必ず2つの独立した期間(2025年後半・2026年)の両方で確認する。
 *
 *   npx ts-node selectiveBetBacktest.ts
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
const MAX_POSSIBLE_WEIGHT_SUM = RECENCY_WEIGHTS.reduce((s, w) => s + w, 0);
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
interface ScoreResult { score: number; confidencePercent: number; }

interface Bucket { count: number; wins: number; cost: number; returned: number; }
function newBucket(): Bucket { return { count: 0, wins: 0, cost: 0, returned: 0 }; }
function printBucket(label: string, b: Bucket): void {
  const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  console.log(`  ${label}: 件数${b.count}  勝率${winRate.toFixed(2)}%  回収率${roi.toFixed(1)}%`);
}

const scoreGapThresholds = [0, 0.3, 0.6, 1.0, 1.5];
const confidenceThresholds = [0, 20, 40, 60, 80];

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

  function scoreOf(horseName: string, dateNum: number, today: { trackType: string; distance: number }): ScoreResult | null {
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
    if (weightSum <= 0) return null;
    return { score: weightedSum / weightSum, confidencePercent: Math.min(100, (weightSum / MAX_POSSIBLE_WEIGHT_SUM) * 100) };
  }

  interface RaceGroup { today: { trackType: string; distance: number }; entrants: { horseName: string; finishRank: number; dateNum: number; odds: number | null }[]; }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] }; races.set(key, race); }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), odds: r.odds });
  }

  const overall = newBucket();
  const gapBuckets = new Map<number, Bucket>(scoreGapThresholds.map(t => [t, newBucket()]));
  const confBuckets = new Map<number, Bucket>(confidenceThresholds.map(t => [t, newBucket()]));

  let totalRaces = 0;
  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => ({ ...e, result: scoreOf(e.horseName, e.dateNum, today) }))
      .filter((e): e is typeof e & { result: ScoreResult; odds: number } => e.result !== null && e.odds !== null && e.odds > 0);
    if (scored.length < 2) continue;
    totalRaces++;

    const byScoreDesc = [...scored].sort((a, b) => b.result.score - a.result.score);
    const top1 = byScoreDesc[0];
    const top2 = byScoreDesc[1];
    const scoreGap = top1.result.score - top2.result.score;
    const confidence = top1.result.confidencePercent;
    const isWin = top1.finishRank === 1;
    const payout = isWin ? top1.odds * UNIT_STAKE : 0;

    overall.count++; overall.cost += UNIT_STAKE; if (isWin) { overall.wins++; overall.returned += payout; }

    for (const t of scoreGapThresholds) {
      if (scoreGap < t) continue;
      const b = gapBuckets.get(t)!;
      b.count++; b.cost += UNIT_STAKE; if (isWin) { b.wins++; b.returned += payout; }
    }
    for (const t of confidenceThresholds) {
      if (confidence < t) continue;
      const b = confBuckets.get(t)!;
      b.count++; b.cost += UNIT_STAKE; if (isWin) { b.wins++; b.returned += payout; }
    }
  }

  return { totalRaces, overall, gapBuckets, confBuckets };
}

function printPeriod(label: string, result: ReturnType<typeof evaluatePeriod>): void {
  console.log(`\n=== ${label} ===`);
  console.log(`検証対象レース数: ${result.totalRaces}`);
  printBucket('絞り込みなし(モデル1位を毎回)', result.overall);
  console.log('  --- スコア差(1位-2位)で絞る ---');
  for (const t of scoreGapThresholds) printBucket(`差${t}以上`, result.gapBuckets.get(t)!);
  console.log('  --- 1位の信頼度%で絞る ---');
  for (const t of confidenceThresholds) printBucket(`信頼度${t}%以上`, result.confBuckets.get(t)!);
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const SPLIT_2025 = 20250701;

  const periodA = evaluatePeriod(
    allRecords,
    r => r.year === 2025 && dateToNum(r.raceDate) < SPLIT_2025,
    r => r.year === 2025 && dateToNum(r.raceDate) >= SPLIT_2025
  );
  printPeriod('期間A: train=2025前半 / test=2025後半', periodA);

  const periodB = evaluatePeriod(
    allRecords,
    r => r.year === 2025,
    r => r.year === 2026
  );
  printPeriod('期間B: train=2025通年 / test=2026', periodB);
}

main();
