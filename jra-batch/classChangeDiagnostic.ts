/**
 * 「クラス変動」仮説の軽量診断: 前走までのクラスに対して今日のレースが
 * 昇級/同級/降級のどれかを見て、それが現行モデルの予測誤差(残差)と
 * 相関するかどうかだけを確認する。本格的にモデルへ組み込む価値があるかを
 * 判断するための使い捨てスクリプト（backtest.tsの一部ロジックを流用・複製）。
 *
 *   npx ts-node classChangeDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade;
  horseName: string; finishRank: number; totalSeconds: number;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry {
  dateNum: number; secondsPerMeter: number; location: string; trackType: string;
  distance: number; condition: string; grade: RaceGrade; classTier: number;
}

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;

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
function speedIndexOf(stats: BaselineStats | null, spm: number): { speedIndex: number; sampleCount: number } | null {
  if (!stats || stats.variance <= 0) return null;
  return { speedIndex: (stats.mean - spm) / Math.sqrt(stats.variance), sampleCount: stats.count };
}
function weightedScore(entries: HistoryEntry[], today: { trackType: string; distance: number }, stats: Record<string, BaselineStats>): number | null {
  let weightedSum = 0, weightSum = 0;
  entries.forEach((e, slotIndex) => {
    const result = speedIndexOf(lookupGradeOnly(stats, e.location, e.trackType, e.distance, e.condition, e.grade), e.secondsPerMeter);
    if (!result) return;
    const recency = RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
    const reliability = result.sampleCount == null ? 0 : Math.min(1, result.sampleCount / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
    const surface = e.trackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
    const distDiff = Math.abs(e.distance - today.distance);
    const distanceW = Math.max(MIN_DISTANCE_WEIGHT, 1 - distDiff * DISTANCE_DECAY_PER_METER);
    const weight = recency * reliability * surface * distanceW;
    weightedSum += weight * result.speedIndex;
    weightSum += weight;
  });
  return weightSum > 0 ? weightedSum / weightSum : null;
}

function main(): void {
  const trainYears = [2025];
  const testYears = [2026];
  const allRecords = loadRecords(Array.from(new Set([...trainYears, ...testYears])));
  const trainRecords = allRecords.filter(r => trainYears.includes(r.year));
  const testRecords = allRecords.filter(r => testYears.includes(r.year));

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
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition,
      grade: r.grade, classTier: extractClassTier(r.raceClassText, r.grade),
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);

  function lastFourBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    return list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
  }

  interface RaceGroup {
    today: { trackType: string; distance: number; classTier: number };
    entrants: { horseName: string; finishRank: number; dateNum: number }[];
  }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = { today: { trackType: r.trackType, distance: r.distance, classTier: extractClassTier(r.raceClassText, r.grade) }, entrants: [] };
      races.set(key, race);
    }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate) });
  }

  // classDelta(今日のclassTier - 直近レースのclassTier)ごとに、
  // 「モデル予測順位パーセンタイル」と「実際の着順パーセンタイル」の残差を集計する。
  // 残差が負 = モデルの予想より好走、正 = 予想より凡走。
  const buckets = new Map<number, { residualSum: number; actualSum: number; count: number }>();
  let pearsonN = 0, sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => {
        const history = lastFourBefore(e.horseName, e.dateNum);
        const score = weightedScore(history, today, gradeOnlyStats);
        const recentClassTier = history.length > 0 ? history[0].classTier : null;
        return { ...e, score, recentClassTier };
      })
      .filter((e): e is typeof e & { score: number; recentClassTier: number } => e.score !== null && e.recentClassTier !== null);

    if (scored.length < 3) continue; // パーセンタイル計算に最低限必要な頭数

    const n = scored.length;
    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    const predictedPercentileOf = new Map(byScoreDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));
    const byFinishAsc = [...scored].sort((a, b) => a.finishRank - b.finishRank);
    const actualPercentileOf = new Map(byFinishAsc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));

    for (const e of scored) {
      const id = e.horseName + '#' + e.dateNum;
      const predicted = predictedPercentileOf.get(id)!;
      const actual = actualPercentileOf.get(id)!;
      const residual = actual - predicted;
      const classDelta = Math.max(-2, Math.min(2, today.classTier - e.recentClassTier));

      const bucket = buckets.get(classDelta) ?? { residualSum: 0, actualSum: 0, count: 0 };
      bucket.residualSum += residual;
      bucket.actualSum += actual;
      bucket.count++;
      buckets.set(classDelta, bucket);

      const x = today.classTier - e.recentClassTier;
      const y = residual;
      pearsonN++; sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y;
    }
  }

  console.log('classDelta(今日のクラス階級 - 直近走のクラス階級) 別の集計:');
  console.log('delta | 件数 | 平均残差(負=好走寄り) | 平均実着順パーセンタイル(0=1着,1=最下位)');
  for (const delta of [-2, -1, 0, 1, 2]) {
    const b = buckets.get(delta);
    if (!b) continue;
    console.log(`${delta >= 0 ? '+' + delta : delta}    | ${b.count} | ${(b.residualSum / b.count).toFixed(4)} | ${(b.actualSum / b.count).toFixed(4)}`);
  }

  const cov = sumXY / pearsonN - (sumX / pearsonN) * (sumY / pearsonN);
  const stdX = Math.sqrt(sumX2 / pearsonN - (sumX / pearsonN) ** 2);
  const stdY = Math.sqrt(sumY2 / pearsonN - (sumY / pearsonN) ** 2);
  const pearson = cov / (stdX * stdY);
  console.log(`\nclassDelta と 残差 のピアソン相関係数: ${pearson.toFixed(4)} (n=${pearsonN})`);
  console.log('(正の相関 = クラスが上がるほど予想より凡走しがち = classDeltaに予測力あり)');
}

main();
