/**
 * favoriteReasonAnalysis.tsで、市場本命とモデル1位が食い違うレースでは
 * 「モデル1位の方が基準タイムの厚み(サンプル数)が薄い」という系統的な差が
 * 見つかった。今は信頼度%(avgBaselineSpeedIndexConfidence相当)を表示するだけで
 * 順位付けには使っていないため、信頼度が低いほどタイム指数を0(平均的)へ
 * 縮約(shrinkage)する形でモデルに反映し、実際にROIが上がるか検証する。
 *
 * timeScore_shrunk = timeScore × (confidence比率)^power
 * powerを0(縮約なし=現行)〜3まで振って、4期間ウォークフォワードで確認する。
 *
 *   npx ts-node confidenceShrinkageBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null; winPayout: number | null; placePayouts: number[];
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry { dateNum: number; epochDay: number | null; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; classTier: number; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const ALPHA_JOCKEY = 0.1;
const ALPHA_INTERVAL = 0.1;
const ALPHA_DISTANCE = 0.05;
const UNIT_STAKE = 100;
// RECENCY_WEIGHTSの合計＝「全4走が新しさ満額×信頼度満額×条件完全一致」だった場合の理論上の最大重み
const MAX_POSSIBLE_WEIGHT_SUM = RECENCY_WEIGHTS.reduce((s, w) => s + w, 0);

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
// 現行のcomputeWeightedBaselineSpeedIndexと同じロジック＋信頼度%を返す
function timeIndexScoreWithConfidence(entries: HistoryEntry[], today: { trackType: string; distance: number }, stats: Record<string, BaselineStats>): { score: number | null; confidence: number } {
  let weightedSum = 0, weightSum = 0;
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
  });
  return {
    score: weightSum > 0 ? weightedSum / weightSum : null,
    confidence: Math.min(1, weightSum / MAX_POSSIBLE_WEIGHT_SUM),
  };
}

interface Entrant { horseName: string; finishRank: number; dateNum: number; winPayout: number | null; placePayouts: number[]; score: (power: number) => number | null; }
interface RaceGroup { entrants: Entrant[]; }

function prepareModel(trainRecords: RaceFactRecord[], historyRecords: RaceFactRecord[]): { buildRaces: (records: RaceFactRecord[]) => RaceGroup[] } {
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

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of historyRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
      classTier: extractClassTier(r.raceClassText, r.grade),
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);
  function lastFourBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    return list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
  }

  function buildRaces(records: RaceFactRecord[]): RaceGroup[] {
    const races = new Map<string, RaceGroup>();
    for (const r of records) {
      const key = raceKeyOf(r);
      let race = races.get(key);
      if (!race) { race = { entrants: [] }; races.set(key, race); }
      const dateNum = dateToNum(r.raceDate);
      const epochDay = dateToEpochDays(r.raceDate);
      const history = lastFourBefore(r.horseName, dateNum);
      const today = { trackType: r.trackType, distance: r.distance };
      const { score: timeScore, confidence } = timeIndexScoreWithConfidence(history, today, gradeStats);
      const jz = jockeyZ(r.jockeyName);
      const recent = history[0] ?? null;
      const distanceDeltaZ = recent ? (r.distance - recent.distance - ddMean) / ddStd : 0;
      const intervalZ = recent && recent.epochDay != null && epochDay != null ? ((epochDay - recent.epochDay) - ivMean) / ivStd : 0;
      const otherTerms = ALPHA_JOCKEY * jz + ALPHA_INTERVAL * intervalZ - ALPHA_DISTANCE * distanceDeltaZ;

      race.entrants.push({
        horseName: r.horseName, finishRank: r.finishRank, dateNum, winPayout: r.winPayout, placePayouts: r.placePayouts,
        score: (power) => timeScore == null ? null : timeScore * Math.pow(confidence, power) + otherTerms,
      });
    }
    return [...races.values()];
  }

  return { buildRaces };
}

interface Bucket { races: number; hits: number; cost: number; returned: number; hitPayouts: number[]; }
function newBucket(): Bucket { return { races: 0, hits: 0, cost: 0, returned: 0, hitPayouts: [] }; }
function fmtBucket(b: Bucket): string {
  const hitRate = b.races > 0 ? (b.hits / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  const top3 = [...b.hitPayouts].sort((a, c) => c - a).slice(0, 3).reduce((s, v) => s + v, 0);
  const roiEx = b.cost > 0 ? ((b.returned - top3) / b.cost) * 100 : 0;
  return `的中率=${hitRate.toFixed(2)}% 回収率=${roi.toFixed(1)}%(上位3件除くと${roiEx.toFixed(1)}%) (n=${b.races})`;
}

function evaluate(races: RaceGroup[], power: number): { win: Bucket; place: Bucket } {
  const win = newBucket(), place = newBucket();
  for (const race of races) {
    const scored = race.entrants
      .map(e => ({ ...e, finalScore: e.score(power) }))
      .filter((e): e is typeof e & { finalScore: number } => e.finalScore !== null)
      .sort((a, b) => b.finalScore - a.finalScore);
    if (scored.length === 0) continue;
    const top = scored[0];

    if (top.winPayout != null) {
      win.races++; win.cost += UNIT_STAKE;
      if (top.finishRank === 1) { win.hits++; win.returned += top.winPayout; win.hitPayouts.push(top.winPayout); }
    }
    if (top.placePayouts.length > 0) {
      place.races++; place.cost += UNIT_STAKE;
      if (top.finishRank >= 1 && top.finishRank <= top.placePayouts.length) {
        const payout = top.placePayouts[top.finishRank - 1];
        place.hits++; place.returned += payout; place.hitPayouts.push(payout);
      }
    }
  }
  return { win, place };
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'Q2', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'Q3', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'Q4', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: '2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];
  const periodRaces = periods.map(p => {
    const tr = allRecords.filter(p.train);
    const te = allRecords.filter(p.test);
    const m = prepareModel(tr, allRecords);
    return { label: p.label, races: m.buildRaces(te) };
  });

  const powers = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  interface Row { power: number; placeRoisEx: number[]; winRois: number[]; placeHitRates: number[]; }
  const rows: Row[] = [];
  for (const power of powers) {
    const placeRoisEx: number[] = [], winRois: number[] = [], placeHitRates: number[] = [];
    for (const pr of periodRaces) {
      const { win, place } = evaluate(pr.races, power);
      const top3 = [...place.hitPayouts].sort((a, c) => c - a).slice(0, 3).reduce((s, v) => s + v, 0);
      const placeRoiEx = place.cost > 0 ? ((place.returned - top3) / place.cost) * 100 : 0;
      const winRoi = win.cost > 0 ? (win.returned / win.cost) * 100 : 0;
      placeRoisEx.push(placeRoiEx); winRois.push(winRoi);
      placeHitRates.push(place.races > 0 ? (place.hits / place.races) * 100 : 0);
    }
    rows.push({ power, placeRoisEx, winRois, placeHitRates });
  }

  console.log(`期間順: ${periods.map(p => p.label).join(' / ')}\n`);
  console.log('--- 複勝回収率(上位3件除外) ---');
  for (const r of rows) console.log(`power=${r.power}: ${r.placeRoisEx.map(v => v.toFixed(1)).join(' / ')}  最小=${Math.min(...r.placeRoisEx).toFixed(1)}  平均=${(r.placeRoisEx.reduce((s,v)=>s+v,0)/r.placeRoisEx.length).toFixed(1)}`);

  console.log('\n--- 単勝回収率(生) ---');
  for (const r of rows) console.log(`power=${r.power}: ${r.winRois.map(v => v.toFixed(1)).join(' / ')}  最小=${Math.min(...r.winRois).toFixed(1)}  平均=${(r.winRois.reduce((s,v)=>s+v,0)/r.winRois.length).toFixed(1)}`);

  console.log('\n--- 複勝的中率 ---');
  for (const r of rows) console.log(`power=${r.power}: ${r.placeHitRates.map(v => v.toFixed(1)).join(' / ')}`);
}

main();
