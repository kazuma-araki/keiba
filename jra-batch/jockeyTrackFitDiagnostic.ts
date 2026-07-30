/**
 * 「騎手のコース・トラック適性」仮説の診断: これまでの騎手係数は「全体一律」の勝率
 * だったが、実際には芝巧者・ダート巧者のような得意不得意があるはず。
 * 騎手勝率をトラック種別(芝/ダート)ごとに集計し直し、全体一律の係数と比べて
 * 残差との相関が強くなるかを4期間ウォークフォワードで確認する。
 *
 *   npx ts-node jockeyTrackFitDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES_OVERALL = 30;
const MIN_RIDES_BY_TRACK = 20; // トラック種別で分けると母数が減るため、閾値をやや緩める

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
function timeIndexScore(entries: HistoryEntry[], today: { trackType: string; distance: number }, stats: Record<string, BaselineStats>): number | null {
  let weightedSum = 0, weightSum = 0;
  entries.forEach((e, slotIndex) => {
    const result = speedIndexOf(lookupGradeOnly(stats, e.location, e.trackType, e.distance, e.condition, e.grade), e.secondsPerMeter);
    if (!result) return;
    const recency = RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
    const reliability = Math.min(1, result.sampleCount / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
    const surface = e.trackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
    const distDiff = Math.abs(e.distance - today.distance);
    const distanceW = Math.max(MIN_DISTANCE_WEIGHT, 1 - distDiff * DISTANCE_DECAY_PER_METER);
    const weight = recency * reliability * surface * distanceW;
    weightedSum += weight * result.speedIndex;
    weightSum += weight;
  });
  return weightSum > 0 ? weightedSum / weightSum : null;
}

interface JockeyModel { zOverall: (name: string | null) => number; zByTrack: (name: string | null, trackType: string) => number; }

function buildJockeyModel(trainRecords: RaceFactRecord[]): JockeyModel {
  // 全体一律の勝率(現行モデルと同じ)
  const overallRides = new Map<string, { rides: number; wins: number }>();
  for (const r of trainRecords) {
    if (!r.jockeyName || !(r.finishRank > 0)) continue;
    const g = overallRides.get(r.jockeyName) ?? { rides: 0, wins: 0 };
    g.rides++; if (r.finishRank === 1) g.wins++;
    overallRides.set(r.jockeyName, g);
  }
  const overallRates = new Map<string, number>();
  const overallList: number[] = [];
  for (const [name, g] of overallRides) {
    if (g.rides < MIN_RIDES_OVERALL) continue;
    const wr = g.wins / g.rides;
    overallRates.set(name, wr);
    overallList.push(wr);
  }
  const oMean = overallList.reduce((s, v) => s + v, 0) / overallList.length;
  const oStd = Math.sqrt(overallList.reduce((s, v) => s + (v - oMean) ** 2, 0) / overallList.length);

  // トラック種別ごとの勝率
  const byTrackRides = new Map<string, Map<string, { rides: number; wins: number }>>();
  for (const r of trainRecords) {
    if (!r.jockeyName || !(r.finishRank > 0)) continue;
    const trackMap = byTrackRides.get(r.trackType) ?? new Map();
    const g = trackMap.get(r.jockeyName) ?? { rides: 0, wins: 0 };
    g.rides++; if (r.finishRank === 1) g.wins++;
    trackMap.set(r.jockeyName, g);
    byTrackRides.set(r.trackType, trackMap);
  }
  const byTrackRates = new Map<string, Map<string, number>>();
  const byTrackMeanStd = new Map<string, { mean: number; std: number }>();
  for (const [track, trackMap] of byTrackRides) {
    const rates = new Map<string, number>();
    const list: number[] = [];
    for (const [name, g] of trackMap) {
      if (g.rides < MIN_RIDES_BY_TRACK) continue;
      const wr = g.wins / g.rides;
      rates.set(name, wr);
      list.push(wr);
    }
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    const std = Math.sqrt(list.reduce((s, v) => s + (v - mean) ** 2, 0) / list.length);
    byTrackRates.set(track, rates);
    byTrackMeanStd.set(track, { mean, std });
  }

  return {
    zOverall: (name) => {
      if (!name) return 0;
      const wr = overallRates.get(name);
      if (wr === undefined) return 0;
      return (wr - oMean) / oStd;
    },
    zByTrack: (name, trackType) => {
      if (!name) return 0;
      const rates = byTrackRates.get(trackType);
      const meanStd = byTrackMeanStd.get(trackType);
      if (!rates || !meanStd) return 0;
      const wr = rates.get(name);
      if (wr === undefined) return 0;
      return (wr - meanStd.mean) / meanStd.std;
    },
  };
}

interface ScoredEntrant { horseName: string; finishRank: number; dateNum: number; residualOverall: number; residualByTrack: number; }

function evaluatePeriod(allRecords: RaceFactRecord[], trainFilter: (r: RaceFactRecord) => boolean, testFilter: (r: RaceFactRecord) => boolean): { rOverall: number; rByTrack: number; n: number } {
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
  const jockeyModel = buildJockeyModel(trainRecords);

  const historyRecords = [...trainRecords, ...testRecords];
  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of historyRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);
  function lastFourBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    return list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
  }

  interface RaceGroup { today: { trackType: string; distance: number }; entrants: { horseName: string; finishRank: number; dateNum: number; jockeyName: string | null }[]; }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] }; races.set(key, race); }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), jockeyName: r.jockeyName });
  }

  const allEntrants: { residual: number; jz: number }[] = [];
  let sumX1 = 0, sumY1 = 0, sumXY1 = 0, sumX1sq = 0, sumY1sq = 0;
  let sumX2 = 0, sumY2 = 0, sumXY2 = 0, sumX2sq = 0, sumY2sq = 0;
  let n = 0;

  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => {
        const history = lastFourBefore(e.horseName, e.dateNum);
        const timeScore = timeIndexScore(history, today, gradeOnlyStats);
        return { ...e, timeScore };
      })
      .filter((e): e is typeof e & { timeScore: number } => e.timeScore !== null);
    if (scored.length < 3) continue;
    const m = scored.length;

    // 残差A: タイム指数のみ(騎手係数抜き)のランクを基準にした残差
    const byTimeDesc = [...scored].sort((a, b) => b.timeScore - a.timeScore);
    const predictedTimeOnly = new Map(byTimeDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (m - 1)]));
    const byFinishAsc = [...scored].sort((a, b) => a.finishRank - b.finishRank);
    const actualPercentileOf = new Map(byFinishAsc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (m - 1)]));

    for (const e of scored) {
      const id = e.horseName + '#' + e.dateNum;
      const actual = actualPercentileOf.get(id)!;
      const predicted = predictedTimeOnly.get(id)!;
      const residualTimeOnly = actual - predicted; // タイム指数だけでは説明できない部分
      const zOverall = jockeyModel.zOverall(e.jockeyName);
      const zByTrack = jockeyModel.zByTrack(e.jockeyName, today.trackType);

      n++;
      sumX1 += zOverall; sumY1 += residualTimeOnly; sumXY1 += zOverall * residualTimeOnly; sumX1sq += zOverall * zOverall; sumY1sq += residualTimeOnly * residualTimeOnly;
      sumX2 += zByTrack; sumY2 += residualTimeOnly; sumXY2 += zByTrack * residualTimeOnly; sumX2sq += zByTrack * zByTrack; sumY2sq += residualTimeOnly * residualTimeOnly;
    }
  }

  const rOf = (sumX: number, sumY: number, sumXY: number, sumXsq: number, sumYsq: number, n: number) => {
    const cov = sumXY / n - (sumX / n) * (sumY / n);
    const stdX = Math.sqrt(sumXsq / n - (sumX / n) ** 2);
    const stdY = Math.sqrt(sumYsq / n - (sumY / n) ** 2);
    return cov / (stdX * stdY);
  };

  return {
    rOverall: rOf(sumX1, sumY1, sumXY1, sumX1sq, sumY1sq, n),
    rByTrack: rOf(sumX2, sumY2, sumXY2, sumX2sq, sumY2sq, n),
    n,
  };
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'train=Q1 / test=Q2', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2 / test=Q3', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3 / test=Q4', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: 'train=2025 / test=2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];

  console.log('騎手係数(全体一律 vs トラック種別別)と「タイム指数だけでは説明できない残差」の相関比較\n');
  for (const p of periods) {
    const { rOverall, rByTrack, n } = evaluatePeriod(allRecords, p.train, p.test);
    console.log(`${p.label} (n=${n}): 全体一律r=${rOverall.toFixed(4)}  トラック別r=${rByTrack.toFixed(4)}  ${Math.abs(rByTrack) > Math.abs(rOverall) ? '← トラック別の方が強い' : ''}`);
  }
}

main();
