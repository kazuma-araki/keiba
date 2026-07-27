/**
 * raceWeighting.ts の重み定数(RECENCY_WEIGHTS等)をグリッドサーチでチューニングする。
 *
 * 過学習を避けるため3分割する:
 *   - 基準タイム計算(train): 2025年通年
 *   - パラメータ探索用の検証セット(validation): 2026年1〜3月
 *   - 最終確認用のホールドアウト(holdout): 2026年4月以降
 * 検証セットで一番良かった組み合わせを、まだ一度も見ていないホールドアウトで
 * 現行設定と比較することで、「たまたま検証セットに過適合しただけ」ではないかを確認する。
 *
 *   npx ts-node tuneWeights.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
}
interface BaselineStats { count: number; mean: number; variance: number; }

const VALIDATION_HOLDOUT_CUTOFF = 20260401; // これ未満=validation, 以上=holdout

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

// スコア計算の「パラメータに依存しない部分」を事前計算しておく。
// (baseline z-score・サーフェス一致・距離差は重みパラメータと無関係なので使い回せる)
interface PrecomputedSlot {
  slotIndex: number; // 0=直近
  speedIndex: number;
  sampleCount: number;
  surfaceMatch: boolean;
  distanceDiff: number;
}
interface PrecomputedHorse {
  finishRank: number;
  slots: PrecomputedSlot[];
}
interface PrecomputedRace {
  horses: PrecomputedHorse[];
}

interface WeightParams {
  recencyWeights: number[];
  reliabilityFullConfidence: number;
  differentSurfaceWeight: number;
  distanceDecayPerMeter: number;
  minDistanceWeight: number;
}

function scoreHorse(slots: PrecomputedSlot[], p: WeightParams): number | null {
  let weightedSum = 0, weightSum = 0;
  for (const s of slots) {
    const recency = p.recencyWeights[s.slotIndex] ?? p.recencyWeights[p.recencyWeights.length - 1];
    const reliability = Math.min(1, s.sampleCount / p.reliabilityFullConfidence);
    const surface = s.surfaceMatch ? 1 : p.differentSurfaceWeight;
    const distanceW = Math.max(p.minDistanceWeight, 1 - s.distanceDiff * p.distanceDecayPerMeter);
    const weight = recency * reliability * surface * distanceW;
    weightedSum += weight * s.speedIndex;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : null;
}

interface EvalResult { races: number; winHits: number; placeHits: number; spearmanSum: number; spearmanCount: number; }

function evaluate(precomputed: PrecomputedRace[], p: WeightParams): EvalResult {
  const result: EvalResult = { races: 0, winHits: 0, placeHits: 0, spearmanSum: 0, spearmanCount: 0 };
  for (const race of precomputed) {
    const scored = race.horses
      .map(h => ({ finishRank: h.finishRank, score: scoreHorse(h.slots, p) }))
      .filter((h): h is { finishRank: number; score: number } => h.score !== null);
    if (scored.length === 0) continue;
    result.races++;
    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    if (byScoreDesc[0].finishRank === 1) result.winHits++;
    if (byScoreDesc[0].finishRank <= 3) result.placeHits++;
    if (scored.length >= 2) {
      const n = scored.length;
      const predictedRanks = byScoreDesc.map((_, i) => i + 1);
      const actualOrder = [...byScoreDesc].sort((a, b) => a.finishRank - b.finishRank);
      const rankOf = new Map(actualOrder.map((h, i) => [h, i + 1]));
      let sumSqDiff = 0;
      byScoreDesc.forEach((h, i) => { const d = predictedRanks[i] - rankOf.get(h)!; sumSqDiff += d * d; });
      result.spearmanSum += 1 - (6 * sumSqDiff) / (n * (n * n - 1));
      result.spearmanCount++;
    }
  }
  return result;
}

function winRate(r: EvalResult): number { return r.races > 0 ? r.winHits / r.races : 0; }
function placeRate(r: EvalResult): number { return r.races > 0 ? r.placeHits / r.races : 0; }
function meanSpearman(r: EvalResult): number { return r.spearmanCount > 0 ? r.spearmanSum / r.spearmanCount : 0; }

function printResult(label: string, r: EvalResult): void {
  console.log(`${label}: 単勝的中率=${(winRate(r) * 100).toFixed(2)}% 複勝的中率=${(placeRate(r) * 100).toFixed(2)}% 順位相関=${meanSpearman(r).toFixed(4)} (n=${r.races}レース)`);
}

const DEFAULT_PARAMS: WeightParams = {
  recencyWeights: [1.0, 0.8, 0.6, 0.4],
  reliabilityFullConfidence: 50,
  differentSurfaceWeight: 0.3,
  distanceDecayPerMeter: 1 / 800,
  minDistanceWeight: 0.2,
};

const RECENCY_CANDIDATES: Record<string, number[]> = {
  '現行[1,.8,.6,.4]': [1.0, 0.8, 0.6, 0.4],
  'フラット[1,1,1,1]': [1.0, 1.0, 1.0, 1.0],
  '急減衰[1,.6,.3,.1]': [1.0, 0.6, 0.3, 0.1],
  '緩減衰[1,.9,.8,.7]': [1.0, 0.9, 0.8, 0.7],
  '中間[1,.7,.4,.2]': [1.0, 0.7, 0.4, 0.2],
};
const RELIABILITY_CANDIDATES = [20, 50, 100, 200];
const SURFACE_CANDIDATES = [0.0, 0.15, 0.3, 0.5];
const DISTANCE_DECAY_CANDIDATES: Record<string, number> = {
  '1/400(急)': 1 / 400, '1/800(現行)': 1 / 800, '1/1600(緩)': 1 / 1600, '1/3200(超緩)': 1 / 3200,
};
const MIN_DISTANCE_CANDIDATES = [0.0, 0.1, 0.2, 0.4];

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const trainRecords = allRecords.filter(r => r.year === 2025);

  const gradeOnlyStats: Record<string, BaselineStats> = {};
  {
    const grouped = new Map<string, number[]>();
    for (const r of trainRecords) {
      const key = gradeOnlyKey(r.location, r.trackType, r.distance, r.condition, r.grade);
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(r.totalSeconds / r.distance);
    }
    for (const [k, v] of grouped) gradeOnlyStats[k] = computeStats(v);
  }

  interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }
  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of allRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);

  function precomputeSlots(horseName: string, dateNum: number, today: { trackType: string; distance: number }): PrecomputedSlot[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    const before = list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
    const slots: PrecomputedSlot[] = [];
    before.forEach((e, slotIndex) => {
      const stats = lookupGradeOnly(gradeOnlyStats, e.location, e.trackType, e.distance, e.condition, e.grade);
      if (!stats || stats.variance <= 0) return;
      slots.push({
        slotIndex,
        speedIndex: (stats.mean - e.secondsPerMeter) / Math.sqrt(stats.variance),
        sampleCount: stats.count,
        surfaceMatch: e.trackType === today.trackType,
        distanceDiff: Math.abs(e.distance - today.distance),
      });
    });
    return slots;
  }

  function buildPrecomputedRaces(testRecords: RaceFactRecord[]): PrecomputedRace[] {
    const races = new Map<string, { today: { trackType: string; distance: number }; horses: PrecomputedHorse[] }>();
    for (const r of testRecords) {
      const key = raceKeyOf(r);
      let race = races.get(key);
      if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, horses: [] }; races.set(key, race); }
      const dateNum = dateToNum(r.raceDate);
      race.horses.push({ finishRank: r.finishRank, slots: precomputeSlots(r.horseName, dateNum, race.today) });
    }
    return [...races.values()].map(r => ({ horses: r.horses }));
  }

  const testRecords2026 = allRecords.filter(r => r.year === 2026);
  const validationRecords = testRecords2026.filter(r => dateToNum(r.raceDate) < VALIDATION_HOLDOUT_CUTOFF);
  const holdoutRecords = testRecords2026.filter(r => dateToNum(r.raceDate) >= VALIDATION_HOLDOUT_CUTOFF);
  console.log(`validation: ${validationRecords.length}件 / holdout: ${holdoutRecords.length}件`);

  const validationRaces = buildPrecomputedRaces(validationRecords);
  const holdoutRaces = buildPrecomputedRaces(holdoutRecords);

  console.log('\n=== ベースライン(現行設定)をvalidation/holdoutそれぞれで評価 ===');
  printResult('現行設定 @ validation', evaluate(validationRaces, DEFAULT_PARAMS));
  printResult('現行設定 @ holdout   ', evaluate(holdoutRaces, DEFAULT_PARAMS));

  console.log('\n=== グリッドサーチ(validationのみで探索) ===');
  const results: { params: WeightParams; label: string; result: EvalResult }[] = [];
  for (const [recLabel, recencyWeights] of Object.entries(RECENCY_CANDIDATES)) {
    for (const reliabilityFullConfidence of RELIABILITY_CANDIDATES) {
      for (const differentSurfaceWeight of SURFACE_CANDIDATES) {
        for (const [decayLabel, distanceDecayPerMeter] of Object.entries(DISTANCE_DECAY_CANDIDATES)) {
          for (const minDistanceWeight of MIN_DISTANCE_CANDIDATES) {
            const params: WeightParams = { recencyWeights, reliabilityFullConfidence, differentSurfaceWeight, distanceDecayPerMeter, minDistanceWeight };
            const result = evaluate(validationRaces, params);
            results.push({ params, label: `recency=${recLabel} reliability=${reliabilityFullConfidence} surface=${differentSurfaceWeight} decay=${decayLabel} minDist=${minDistanceWeight}`, result });
          }
        }
      }
    }
  }
  results.sort((a, b) => (winRate(b.result) - winRate(a.result)) || (placeRate(b.result) - placeRate(a.result)));
  console.log(`探索した組み合わせ数: ${results.length}`);
  console.log('\n--- validationでの上位10件 ---');
  for (const r of results.slice(0, 10)) printResult(r.label, r.result);

  console.log('\n=== 上位3件をholdoutで最終確認 ===');
  for (const r of results.slice(0, 3)) {
    printResult(`[holdout] ${r.label}`, evaluate(holdoutRaces, r.params));
  }
}

main();
