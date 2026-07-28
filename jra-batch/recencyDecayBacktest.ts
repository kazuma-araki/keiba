/**
 * 「新しさの重み」を、順序(前走=1,2走前=2,...)ではなく実際の経過日数に基づく
 * 指数減衰(exp(-経過日数/tau))に変える。休養明け等で「前走」が数ヶ月前だった馬と
 * 中1週で回っている馬を区別できるようにする狙い。
 *
 * tauを複数試し、4つの独立した期間(ウォークフォワード)全てで現行(順序ベース)より
 * 安定して良い値があるかを確認する。
 *
 *   npx ts-node recencyDecayBacktest.ts
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

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4]; // 現行(順序ベース)
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
// 実際の経過日数を正しく計算するため、YYYYMMDDの数値ではなくエポック日数を使う
function dateToEpochDays(raceDate: string): number {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return 0;
  const utcMs = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  return Math.floor(utcMs / 86400000);
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

interface HistoryEntry { dateNum: number; epochDays: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }
interface Bucket { count: number; wins: number; cost: number; returned: number; }
function newBucket(): Bucket { return { count: 0, wins: 0, cost: 0, returned: 0 }; }
function addBucket(a: Bucket, b: Bucket): void { a.count += b.count; a.wins += b.wins; a.cost += b.cost; a.returned += b.returned; }
function printBucket(label: string, b: Bucket): void {
  const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  console.log(`  ${label}: 件数${b.count}  勝率${winRate.toFixed(2)}%  回収率${roi.toFixed(1)}%`);
}

// tau=null は現行の順序ベース重みを使う（比較対象）
const tauCandidates: (number | null)[] = [null, 30, 60, 90, 180, 365];

function evaluatePeriod(
  allRecords: RaceFactRecord[],
  trainFilter: (r: RaceFactRecord) => boolean,
  testFilter: (r: RaceFactRecord) => boolean
): Map<number | null, { totalRaces: number; bucket: Bucket }> {
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
      dateNum: dateToNum(r.raceDate), epochDays: dateToEpochDays(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);

  function scoreOf(horseName: string, dateNum: number, epochDays: number, today: { trackType: string; distance: number }, tau: number | null): number | null {
    const list = horseHistory.get(horseName);
    if (!list) return null;
    const history = list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
    let weightedSum = 0, weightSum = 0;
    history.forEach((e, slotIndex) => {
      const stats = lookupGradeOnly(gradeOnlyStats, e.location, e.trackType, e.distance, e.condition, e.grade);
      if (!stats || stats.variance <= 0) return;
      const speedIndex = (stats.mean - e.secondsPerMeter) / Math.sqrt(stats.variance);
      const recency = tau === null
        ? (RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1])
        : Math.exp(-(epochDays - e.epochDays) / tau);
      const reliability = Math.min(1, stats.count / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
      const surface = e.trackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
      const distanceW = Math.max(MIN_DISTANCE_WEIGHT, 1 - Math.abs(e.distance - today.distance) * DISTANCE_DECAY_PER_METER);
      const weight = recency * reliability * surface * distanceW;
      weightedSum += weight * speedIndex;
      weightSum += weight;
    });
    return weightSum > 0 ? weightedSum / weightSum : null;
  }

  interface RaceGroup { today: { trackType: string; distance: number }; entrants: { horseName: string; finishRank: number; dateNum: number; epochDays: number; odds: number | null }[]; }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] }; races.set(key, race); }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), epochDays: dateToEpochDays(r.raceDate), odds: r.odds });
  }

  const results = new Map<number | null, { totalRaces: number; bucket: Bucket }>();
  for (const tau of tauCandidates) results.set(tau, { totalRaces: 0, bucket: newBucket() });

  for (const { today, entrants } of races.values()) {
    for (const tau of tauCandidates) {
      const scored = entrants
        .map(e => ({ ...e, score: scoreOf(e.horseName, e.dateNum, e.epochDays, today, tau) }))
        .filter((e): e is typeof e & { score: number; odds: number } => e.score !== null && e.odds !== null && e.odds > 0);
      if (scored.length < 2) continue;
      const r = results.get(tau)!;
      r.totalRaces++;
      const top1 = [...scored].sort((a, b) => b.score - a.score)[0];
      r.bucket.count++; r.bucket.cost += UNIT_STAKE;
      if (top1.finishRank === 1) { r.bucket.wins++; r.bucket.returned += top1.odds * UNIT_STAKE; }
    }
  }

  return results;
}

function tauLabel(tau: number | null): string {
  return tau === null ? '現行(順序ベース)' : `tau=${tau}日`;
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;

  const periods = [
    { label: 'Q2(4-6月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'Q3(7-9月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'Q4(10-12月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: '2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];

  const allResults = periods.map(p => ({ label: p.label, result: evaluatePeriod(allRecords, p.train, p.test) }));

  console.log('モデル1位を単勝で買った場合の回収率(tauごと):\n');
  const header = ['重み設定', ...allResults.map(r => r.label), '合計'].join(' | ');
  console.log(header);
  for (const tau of tauCandidates) {
    const row = [tauLabel(tau)];
    const pooled = newBucket();
    for (const { result } of allResults) {
      const { bucket } = result.get(tau)!;
      addBucket(pooled, bucket);
      const roi = bucket.cost > 0 ? (bucket.returned / bucket.cost) * 100 : 0;
      row.push(`${roi.toFixed(1)}%`);
    }
    const pooledRoi = pooled.cost > 0 ? (pooled.returned / pooled.cost) * 100 : 0;
    row.push(`${pooledRoi.toFixed(1)}%`);
    console.log(row.join(' | '));
  }

  console.log('\n勝率(tauごと、outlierの影響を受けにくい指標):\n');
  console.log(header);
  for (const tau of tauCandidates) {
    const row = [tauLabel(tau)];
    const pooled = newBucket();
    for (const { result } of allResults) {
      const { bucket } = result.get(tau)!;
      addBucket(pooled, bucket);
      const winRate = bucket.count > 0 ? (bucket.wins / bucket.count) * 100 : 0;
      row.push(`${winRate.toFixed(2)}%`);
    }
    const pooledWinRate = pooled.count > 0 ? (pooled.wins / pooled.count) * 100 : 0;
    row.push(`${pooledWinRate.toFixed(2)}%`);
    console.log(row.join(' | '));
  }
}

main();
