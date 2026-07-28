/**
 * 「信頼度%で選別ベット」の閾値を、4つの独立した期間でウォークフォワード検証する。
 * 新規スクレイピングなしで検証期間を2→4に増やすため、2025年を四半期で区切り、
 * 常に「それより前のデータだけ」を学習に使う。
 *
 *   train=Q1(1〜3月)        → test=Q2(4〜6月)
 *   train=Q1+Q2(1〜6月)     → test=Q3(7〜9月)
 *   train=Q1+Q2+Q3(1〜9月)  → test=Q4(10〜12月)
 *   train=2025年通年        → test=2026年
 *
 * 信頼度%の閾値も0,10,...,90と細かく刻み、どの期間でも安定して回収率が
 * 改善する閾値があるかを確認する。
 *
 *   npx ts-node selectiveBetWalkForward.ts
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

const confidenceThresholds = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

function evaluatePeriod(
  allRecords: RaceFactRecord[],
  trainFilter: (r: RaceFactRecord) => boolean,
  testFilter: (r: RaceFactRecord) => boolean
): { totalRaces: number; confBuckets: Map<number, Bucket> } {
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
    const isWin = top1.finishRank === 1;
    const payout = isWin ? top1.odds * UNIT_STAKE : 0;

    for (const t of confidenceThresholds) {
      if (top1.result.confidencePercent < t) continue;
      const b = confBuckets.get(t)!;
      b.count++; b.cost += UNIT_STAKE; if (isWin) { b.wins++; b.returned += payout; }
    }
  }

  return { totalRaces, confBuckets };
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

  const allResults = periods.map(p => ({ label: p.label, result: evaluatePeriod(allRecords, p.train, p.test) }));

  console.log('信頼度%閾値ごとの回収率(各期間):\n');
  const header = ['閾値', ...allResults.map(r => r.label)].join(' | ');
  console.log(header);
  for (const t of confidenceThresholds) {
    const row = [`${t}%以上`];
    for (const { result } of allResults) {
      const b = result.confBuckets.get(t)!;
      const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
      row.push(`${roi.toFixed(1)}%(n=${b.count})`);
    }
    console.log(row.join(' | '));
  }
}

main();
