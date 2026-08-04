/**
 * 「市場人気だから買う」ではなく、市場が本命視する『理由』を要素分解する。
 *
 * 市場1番人気とモデル1位評価馬が一致しないレースに絞り、両者を測定可能な項目
 * (騎手勝率z・斤量・馬体重増減・直近着順パーセンタイル・距離変更/間隔・
 * 基準タイムの厚み(サンプル数)・経験値(過去走数))で比較する。
 * 市場本命の方が系統的に優れている項目があれば、それが「モデルが見落としている
 * 市場の判断根拠」の候補になる。
 *
 *   npx ts-node favoriteReasonAnalysis.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null; odds: number | null; weight: number | null; bodyWeightChange: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry {
  dateNum: number; epochDay: number | null; secondsPerMeter: number; location: string; trackType: string;
  distance: number; condition: string; grade: RaceGrade; classTier: number; finishRank: number; finishPercentile: number | null;
}

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const ALPHA_JOCKEY = 0.1;
const ALPHA_INTERVAL = 0.1;
const ALPHA_DISTANCE = 0.05;

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
function dateToEpochDays(raceDate: string): number | null {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  return Math.floor(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / 86400000);
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
function gradeKey(loc: string, t: string, d: number, c: string, g: RaceGrade): string {
  return `${loc}|${t}|${d}|${c}|${g ?? 'NONE'}`;
}
function lookupGrade(stats: Record<string, BaselineStats>, loc: string, t: string, d: number, c: string, g: RaceGrade): BaselineStats | null {
  const exact = stats[gradeKey(loc, t, d, c, g)];
  if (exact) return exact;
  if (g !== null) {
    const fb = stats[gradeKey(loc, t, d, c, null)];
    if (fb) return fb;
  }
  return null;
}
function speedIndexOf(stats: BaselineStats | null, spm: number): { speedIndex: number; sampleCount: number } | null {
  if (!stats || stats.variance <= 0) return null;
  return { speedIndex: (stats.mean - spm) / Math.sqrt(stats.variance), sampleCount: stats.count };
}
function timeIndexScore(entries: HistoryEntry[], today: { trackType: string; distance: number }, stats: Record<string, BaselineStats>): { score: number | null; avgSampleCount: number | null } {
  let weightedSum = 0, weightSum = 0, sampleSum = 0, sampleCnt = 0;
  entries.forEach((e, slotIndex) => {
    const result = speedIndexOf(lookupGrade(stats, e.location, e.trackType, e.distance, e.condition, e.grade), e.secondsPerMeter);
    if (!result) return;
    const recency = RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
    const reliability = Math.min(1, result.sampleCount / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
    const surface = e.trackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
    const distDiff = Math.abs(e.distance - today.distance);
    const distanceW = Math.max(MIN_DISTANCE_WEIGHT, 1 - distDiff * DISTANCE_DECAY_PER_METER);
    const weight = recency * reliability * surface * distanceW;
    weightedSum += weight * result.speedIndex;
    weightSum += weight;
    sampleSum += result.sampleCount; sampleCnt++;
  });
  return { score: weightSum > 0 ? weightedSum / weightSum : null, avgSampleCount: sampleCnt > 0 ? sampleSum / sampleCnt : null };
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const trainRecords = allRecords.filter(r => r.year === 2025);
  const testRecords = allRecords.filter(r => r.year === 2026);

  const gradeStats: Record<string, BaselineStats> = {};
  {
    const grouped = new Map<string, number[]>();
    for (const r of trainRecords) {
      const key = gradeKey(r.location, r.trackType, r.distance, r.condition, r.grade);
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(r.totalSeconds / r.distance);
    }
    for (const [k, v] of grouped) gradeStats[k] = computeStats(v);
  }

  const jockeyRides = new Map<string, { rides: number; wins: number }>();
  for (const r of trainRecords) {
    if (!r.jockeyName) continue;
    const g = jockeyRides.get(r.jockeyName) ?? { rides: 0, wins: 0 };
    g.rides++;
    if (r.finishRank === 1) g.wins++;
    jockeyRides.set(r.jockeyName, g);
  }
  const eligibleWinRates: number[] = [];
  const jockeyWinRate = new Map<string, number>();
  for (const [name, g] of jockeyRides) {
    if (g.rides < MIN_RIDES) continue;
    const wr = g.wins / g.rides;
    jockeyWinRate.set(name, wr);
    eligibleWinRates.push(wr);
  }
  const wrMean = eligibleWinRates.reduce((s, v) => s + v, 0) / eligibleWinRates.length;
  const wrStd = Math.sqrt(eligibleWinRates.reduce((s, v) => s + (v - wrMean) ** 2, 0) / eligibleWinRates.length);
  function jockeyZ(name: string | null): number {
    if (!name) return 0;
    const wr = jockeyWinRate.get(name);
    if (wr === undefined) return 0;
    return (wr - wrMean) / wrStd;
  }

  const trainDistanceDeltas: number[] = [];
  const trainIntervals: number[] = [];
  {
    const tmp = new Map<string, { dateNum: number; epochDay: number | null; distance: number }[]>();
    for (const r of trainRecords) {
      const entry = { dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), distance: r.distance };
      (tmp.get(r.horseName) ?? tmp.set(r.horseName, []).get(r.horseName)!).push(entry);
    }
    for (const list of tmp.values()) {
      list.sort((a, b) => a.dateNum - b.dateNum);
      for (let i = 1; i < list.length; i++) {
        trainDistanceDeltas.push(list[i].distance - list[i - 1].distance);
        if (list[i].epochDay != null && list[i - 1].epochDay != null) trainIntervals.push(list[i].epochDay! - list[i - 1].epochDay!);
      }
    }
  }
  const ddMean = trainDistanceDeltas.reduce((s, v) => s + v, 0) / trainDistanceDeltas.length;
  const ddStd = Math.sqrt(trainDistanceDeltas.reduce((s, v) => s + (v - ddMean) ** 2, 0) / trainDistanceDeltas.length);
  const ivMean = trainIntervals.reduce((s, v) => s + v, 0) / trainIntervals.length;
  const ivStd = Math.sqrt(trainIntervals.reduce((s, v) => s + (v - ivMean) ** 2, 0) / trainIntervals.length);

  // 着順パーセンタイル(フィールド内)を全レコードから作る
  const byRace = new Map<string, RaceFactRecord[]>();
  for (const r of allRecords) {
    const key = raceKeyOf(r);
    (byRace.get(key) ?? byRace.set(key, []).get(key)!).push(r);
  }
  const percentileOf = new Map<string, number | null>();
  const fieldSizeOf = new Map<string, number>();
  for (const [key, entrants] of byRace) {
    fieldSizeOf.set(key, entrants.length);
    const n = entrants.length;
    for (const e of entrants) percentileOf.set(`${e.horseName}#${key}`, n > 1 ? (e.finishRank - 1) / (n - 1) : null);
  }

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of allRecords) {
    const key = raceKeyOf(r);
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
      classTier: extractClassTier(r.raceClassText, r.grade), finishRank: r.finishRank, finishPercentile: percentileOf.get(`${r.horseName}#${key}`) ?? null,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);
  function historyBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    return list.filter(e => e.dateNum < dateNum);
  }

  interface Scored {
    horseName: string; finishRank: number; odds: number; score: number; weight: number | null; bodyWeightChange: number | null;
    jz: number; weightedFinishPct: number | null; distanceDeltaZ: number; intervalZ: number; avgSampleCount: number | null; experience: number;
  }
  const races = new Map<string, { key: string; entrants: Scored[] }>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    if (r.odds == null || r.odds <= 0) continue;
    const dateNum = dateToNum(r.raceDate);
    const epochDay = dateToEpochDays(r.raceDate);
    const fullHistory = historyBefore(r.horseName, dateNum);
    const history = fullHistory.slice(-4).reverse();
    const today = { trackType: r.trackType, distance: r.distance };
    const { score: timeScore, avgSampleCount } = timeIndexScore(history, today, gradeStats);
    if (timeScore == null) continue;
    const jz = jockeyZ(r.jockeyName);
    const recent = history[0] ?? null;
    const distanceDeltaZ = recent ? (r.distance - recent.distance - ddMean) / ddStd : 0;
    const intervalZ = recent && recent.epochDay != null && epochDay != null ? ((epochDay - recent.epochDay) - ivMean) / ivStd : 0;
    const score = timeScore + ALPHA_JOCKEY * jz + ALPHA_INTERVAL * intervalZ - ALPHA_DISTANCE * distanceDeltaZ;

    let wSum = 0, wPctSum = 0;
    history.forEach((h, i) => {
      if (h.finishPercentile == null) return;
      const w = RECENCY_WEIGHTS[i] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
      wSum += w; wPctSum += w * h.finishPercentile;
    });
    const weightedFinishPct = wSum > 0 ? wPctSum / wSum : null;

    const entry: Scored = {
      horseName: r.horseName, finishRank: r.finishRank, odds: r.odds, score, weight: r.weight, bodyWeightChange: r.bodyWeightChange,
      jz, weightedFinishPct, distanceDeltaZ, intervalZ, avgSampleCount, experience: fullHistory.length,
    };
    let race = races.get(key);
    if (!race) { race = { key, entrants: [] }; races.set(key, race); }
    race.entrants.push(entry);
  }

  // 集計用
  interface Diffs { jz: number[]; weight: number[]; bwc: number[]; finishPct: number[]; distZ: number[]; ivZ: number[]; sampleCount: number[]; experience: number[]; }
  const diffs: Diffs = { jz: [], weight: [], bwc: [], finishPct: [], distZ: [], ivZ: [], sampleCount: [], experience: [] };
  let agreeCount = 0, disagreeCount = 0;
  let favWinsWhenDisagree = 0, modelTopWinsWhenDisagree = 0;
  let favPlaceWhenDisagree = 0, modelTopPlaceWhenDisagree = 0;

  for (const { entrants } of races.values()) {
    if (entrants.length < 4) continue;
    const byOdds = [...entrants].sort((a, b) => a.odds - b.odds);
    const byScore = [...entrants].sort((a, b) => b.score - a.score);
    const fav = byOdds[0];
    const modelTop = byScore[0];
    if (fav.horseName === modelTop.horseName) { agreeCount++; continue; }
    disagreeCount++;

    if (fav.finishRank === 1) favWinsWhenDisagree++;
    if (modelTop.finishRank === 1) modelTopWinsWhenDisagree++;
    if (fav.finishRank <= 3) favPlaceWhenDisagree++;
    if (modelTop.finishRank <= 3) modelTopPlaceWhenDisagree++;

    diffs.jz.push(fav.jz - modelTop.jz);
    if (fav.weight != null && modelTop.weight != null) diffs.weight.push(fav.weight - modelTop.weight);
    if (fav.bodyWeightChange != null && modelTop.bodyWeightChange != null) diffs.bwc.push(Math.abs(fav.bodyWeightChange) - Math.abs(modelTop.bodyWeightChange));
    if (fav.weightedFinishPct != null && modelTop.weightedFinishPct != null) diffs.finishPct.push(fav.weightedFinishPct - modelTop.weightedFinishPct);
    diffs.distZ.push(Math.abs(fav.distanceDeltaZ) - Math.abs(modelTop.distanceDeltaZ));
    diffs.ivZ.push(Math.abs(fav.intervalZ) - Math.abs(modelTop.intervalZ));
    if (fav.avgSampleCount != null && modelTop.avgSampleCount != null) diffs.sampleCount.push(fav.avgSampleCount - modelTop.avgSampleCount);
    diffs.experience.push(fav.experience - modelTop.experience);
  }

  function meanOf(a: number[]): number { return a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
  function medianOf(a: number[]): number { const s = [...a].sort((x, y) => x - y); return s.length > 0 ? s[Math.floor(s.length / 2)] : NaN; }

  console.log(`一致レース数=${agreeCount}  不一致レース数=${disagreeCount}`);
  console.log(`\n=== 不一致レースでの成績比較 ===`);
  console.log(`市場本命: 勝率${(favWinsWhenDisagree / disagreeCount * 100).toFixed(1)}%  複勝率${(favPlaceWhenDisagree / disagreeCount * 100).toFixed(1)}%`);
  console.log(`モデル1位: 勝率${(modelTopWinsWhenDisagree / disagreeCount * 100).toFixed(1)}%  複勝率${(modelTopPlaceWhenDisagree / disagreeCount * 100).toFixed(1)}%`);

  console.log(`\n=== 市場本命 − モデル1位、項目別の差(平均/中央値) ===`);
  console.log(`騎手勝率zスコア差: 平均${meanOf(diffs.jz).toFixed(3)}  中央値${medianOf(diffs.jz).toFixed(3)}  (プラス=本命の方が騎手強い, n=${diffs.jz.length})`);
  console.log(`斤量差(kg): 平均${meanOf(diffs.weight).toFixed(3)}  中央値${medianOf(diffs.weight).toFixed(3)}  (プラス=本命の方が重い, n=${diffs.weight.length})`);
  console.log(`|馬体重増減|の差(kg): 平均${meanOf(diffs.bwc).toFixed(3)}  中央値${medianOf(diffs.bwc).toFixed(3)}  (プラス=本命の方が増減大きい, n=${diffs.bwc.length})`);
  console.log(`直近4走着順%差: 平均${meanOf(diffs.finishPct).toFixed(3)}  中央値${medianOf(diffs.finishPct).toFixed(3)}  (マイナス=本命の方が着順良い, n=${diffs.finishPct.length})`);
  console.log(`|距離変更z|の差: 平均${meanOf(diffs.distZ).toFixed(3)}  中央値${medianOf(diffs.distZ).toFixed(3)}  (マイナス=本命の方が距離変更小さい, n=${diffs.distZ.length})`);
  console.log(`|間隔z|の差: 平均${meanOf(diffs.ivZ).toFixed(3)}  中央値${medianOf(diffs.ivZ).toFixed(3)}  (マイナス=本命の方が間隔標準的, n=${diffs.ivZ.length})`);
  console.log(`基準タイムのサンプル数差: 平均${meanOf(diffs.sampleCount).toFixed(1)}  中央値${medianOf(diffs.sampleCount).toFixed(1)}  (プラス=本命の方が厚いデータ条件で走ってきた, n=${diffs.sampleCount.length})`);
  console.log(`過去走数の差: 平均${meanOf(diffs.experience).toFixed(2)}  中央値${medianOf(diffs.experience).toFixed(2)}  (プラス=本命の方が経験豊富, n=${diffs.experience.length})`);
}

main();
