/**
 * finishRankDiagnostic.tsで見つかった「直近4走の着順パーセンタイル(新しさ重み付け)」
 * という単変数シグナル(4期間とも符号・大きさが安定、5分位でも単調)を、
 * distanceIntervalBlendBacktest.tsと同じ要領で現行の本番モデル
 * (タイム指数×騎手係数×距離変更×間隔、alphaInterval=0.1, alphaDistance=0.05)に追加し、
 * 実際の単勝・複勝ROIが改善するかを検証する。
 *
 * finalScore = timeScore + ALPHA_JOCKEY*jockeyZ + ALPHA_INTERVAL*intervalZ
 *              - ALPHA_DISTANCE*distanceDeltaZ + alphaFinish*finishZ
 *   （直近の着順が悪い(パーセンタイル大)ほど次走は好走する、という相関だったため符号はプラス）
 *
 *   npx ts-node finishPercentileBlendBacktest.ts
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
interface HistoryEntry {
  dateNum: number; epochDay: number | null; secondsPerMeter: number; location: string; trackType: string;
  distance: number; condition: string; grade: RaceGrade; classTier: number; finishPercentile: number | null;
}

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const ALPHA_JOCKEY = 0.1;
const ALPHA_INTERVAL = 0.1; // 本番採用済みの値で固定
const ALPHA_DISTANCE = 0.05; // 本番採用済みの値で固定
const UNIT_STAKE = 100;

function loadRecords(years: number[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const year of years) {
    const file = path.join(__dirname, `race_facts_${year}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.distance > 0 && r.condition !== '不明' && r.totalSeconds > 0 && r.finishRank > 0) records.push(r);
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
function weightedFinishPercentileOf(entries: HistoryEntry[]): number | null {
  let wSum = 0, wPctSum = 0;
  entries.forEach((e, i) => {
    if (e.finishPercentile == null) return;
    const w = RECENCY_WEIGHTS[i] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
    wSum += w; wPctSum += w * e.finishPercentile;
  });
  return wSum > 0 ? wPctSum / wSum : null;
}

interface Entrant { horseName: string; finishRank: number; dateNum: number; winPayout: number | null; placePayouts: number[]; score: (alphaFinish: number) => number | null; }
interface RaceGroup { entrants: Entrant[]; }

interface Model { buildRaces: (records: RaceFactRecord[]) => RaceGroup[]; }

function prepareModel(trainRecords: RaceFactRecord[], historyRecords: RaceFactRecord[]): Model {
  const gradeOnlyStats: Record<string, BaselineStats> = {};
  {
    const grouped = new Map<string, number[]>();
    for (const r of trainRecords) {
      const key = gradeOnlyKey(r.location, r.trackType, r.distance, r.condition, r.grade);
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(r.totalSeconds / r.distance);
    }
    for (const [k, v] of grouped) gradeOnlyStats[k] = computeStats(v);
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

  // train期間の実際のdistanceDelta・intervalDays分布から平均・標準偏差を求め、zスコア化する
  const trainDistanceDeltas: number[] = [];
  const trainIntervals: number[] = [];
  {
    const tmpHistory = new Map<string, { dateNum: number; epochDay: number | null; distance: number }[]>();
    for (const r of trainRecords) {
      const entry = { dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), distance: r.distance };
      (tmpHistory.get(r.horseName) ?? tmpHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
    }
    for (const list of tmpHistory.values()) {
      list.sort((a, b) => a.dateNum - b.dateNum);
      for (let i = 1; i < list.length; i++) {
        trainDistanceDeltas.push(list[i].distance - list[i - 1].distance);
        if (list[i].epochDay != null && list[i - 1].epochDay != null) {
          trainIntervals.push(list[i].epochDay! - list[i - 1].epochDay!);
        }
      }
    }
  }
  const ddMean = trainDistanceDeltas.reduce((s, v) => s + v, 0) / trainDistanceDeltas.length;
  const ddStd = Math.sqrt(trainDistanceDeltas.reduce((s, v) => s + (v - ddMean) ** 2, 0) / trainDistanceDeltas.length);
  const ivMean = trainIntervals.reduce((s, v) => s + v, 0) / trainIntervals.length;
  const ivStd = Math.sqrt(trainIntervals.reduce((s, v) => s + (v - ivMean) ** 2, 0) / trainIntervals.length);

  // 着順パーセンタイル：フィールドサイズ・順位を確定させるため、まずレース単位でグルーピング
  const byRace = new Map<string, RaceFactRecord[]>();
  for (const r of historyRecords) {
    const key = raceKeyOf(r);
    (byRace.get(key) ?? byRace.set(key, []).get(key)!).push(r);
  }
  const percentileOf = new Map<string, number | null>();
  for (const [, entrants] of byRace) {
    const n = entrants.length;
    for (const e of entrants) {
      const pct = n > 1 ? (e.finishRank - 1) / (n - 1) : null;
      percentileOf.set(`${e.horseName}#${raceKeyOf(e)}`, pct);
    }
  }

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of historyRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
      classTier: extractClassTier(r.raceClassText, r.grade),
      finishPercentile: percentileOf.get(`${r.horseName}#${raceKeyOf(r)}`) ?? null,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);
  function lastFourBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    return list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
  }

  // train期間のweightedFinishPercentile分布から平均・標準偏差を求め、zスコア化する
  const trainFinishPercentiles: number[] = [];
  for (const r of trainRecords) {
    const history = lastFourBefore(r.horseName, dateToNum(r.raceDate));
    const fp = weightedFinishPercentileOf(history);
    if (fp != null) trainFinishPercentiles.push(fp);
  }
  const fpMean = trainFinishPercentiles.reduce((s, v) => s + v, 0) / trainFinishPercentiles.length;
  const fpStd = Math.sqrt(trainFinishPercentiles.reduce((s, v) => s + (v - fpMean) ** 2, 0) / trainFinishPercentiles.length);

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
      const timeScore = timeIndexScore(history, today, gradeOnlyStats);
      const jz = jockeyZ(r.jockeyName);
      const recent = history[0] ?? null;
      const distanceDeltaZ = recent ? (r.distance - recent.distance - ddMean) / ddStd : 0;
      const intervalZ = recent && recent.epochDay != null && epochDay != null ? ((epochDay - recent.epochDay) - ivMean) / ivStd : 0;
      const fp = weightedFinishPercentileOf(history);
      const finishZ = fp != null ? (fp - fpMean) / fpStd : 0;

      race.entrants.push({
        horseName: r.horseName, finishRank: r.finishRank, dateNum, winPayout: r.winPayout, placePayouts: r.placePayouts,
        score: (alphaFinish) => timeScore == null ? null
          : timeScore + ALPHA_JOCKEY * jz + ALPHA_INTERVAL * intervalZ - ALPHA_DISTANCE * distanceDeltaZ + alphaFinish * finishZ,
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

function evaluate(races: RaceGroup[], alphaFinish: number): { win: Bucket; place: Bucket } {
  const win = newBucket(), place = newBucket();
  for (const race of races) {
    const scored = race.entrants
      .map(e => ({ ...e, finalScore: e.score(alphaFinish) }))
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
  const trainRecords = allRecords.filter(r => r.year === 2025);
  const testRecords = allRecords.filter(r => r.year === 2026);
  const model = prepareModel(trainRecords, allRecords);
  const races = model.buildRaces(testRecords);

  console.log('=== alphaFinishグリッドサーチ(train=2025 / test=2026) ===');
  const alphaCandidates = [-0.5, -0.3, -0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];
  for (const af of alphaCandidates) {
    const { win, place } = evaluate(races, af);
    console.log(`alphaFinish=${af}: 単勝[${fmtBucket(win)}] 複勝[${fmtBucket(place)}]`);
  }

  console.log('\n\n########## 4期間ウォークフォワードで確認 ##########');
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

  interface Row { af: number; placeRois: number[]; placeRoisEx: number[]; winRois: number[]; placeHitRates: number[]; }
  const rows: Row[] = [];
  for (const af of alphaCandidates) {
    const placeRois: number[] = [], placeRoisEx: number[] = [], winRois: number[] = [], placeHitRates: number[] = [];
    for (const pr of periodRaces) {
      const { win, place } = evaluate(pr.races, af);
      const placeRoi = place.cost > 0 ? (place.returned / place.cost) * 100 : 0;
      const top3 = [...place.hitPayouts].sort((a, c) => c - a).slice(0, 3).reduce((s, v) => s + v, 0);
      const placeRoiEx = place.cost > 0 ? ((place.returned - top3) / place.cost) * 100 : 0;
      const winRoi = win.cost > 0 ? (win.returned / win.cost) * 100 : 0;
      placeRois.push(placeRoi); placeRoisEx.push(placeRoiEx); winRois.push(winRoi);
      placeHitRates.push(place.races > 0 ? (place.hits / place.races) * 100 : 0);
    }
    rows.push({ af, placeRois, placeRoisEx, winRois, placeHitRates });
  }

  console.log(`\n期間順: ${periods.map(p => p.label).join(' / ')}`);
  console.log('\n--- 複勝回収率(生) ---');
  for (const r of rows) console.log(`alphaFinish=${r.af}: ${r.placeRois.map(v => v.toFixed(1)).join(' / ')}  最小=${Math.min(...r.placeRois).toFixed(1)}  平均=${(r.placeRois.reduce((s,v)=>s+v,0)/r.placeRois.length).toFixed(1)}`);

  console.log('\n--- 複勝回収率(上位3件除外) ---');
  for (const r of rows) console.log(`alphaFinish=${r.af}: ${r.placeRoisEx.map(v => v.toFixed(1)).join(' / ')}  最小=${Math.min(...r.placeRoisEx).toFixed(1)}  平均=${(r.placeRoisEx.reduce((s,v)=>s+v,0)/r.placeRoisEx.length).toFixed(1)}`);

  console.log('\n--- 単勝回収率(生) ---');
  for (const r of rows) console.log(`alphaFinish=${r.af}: ${r.winRois.map(v => v.toFixed(1)).join(' / ')}  最小=${Math.min(...r.winRois).toFixed(1)}`);

  console.log('\n--- 複勝的中率 ---');
  for (const r of rows) console.log(`alphaFinish=${r.af}: ${r.placeHitRates.map(v => v.toFixed(1)).join(' / ')}`);

  console.log('\n=== 参考: alphaFinish=0(現行本番モデル) との比較 ===');
  const base = rows.find(r => r.af === 0)!;
  console.log(`base 複勝回収率(除外後) 最小=${Math.min(...base.placeRoisEx).toFixed(1)} 平均=${(base.placeRoisEx.reduce((s,v)=>s+v,0)/base.placeRoisEx.length).toFixed(1)}`);
}

main();
