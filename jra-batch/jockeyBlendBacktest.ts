/**
 * jockeyDiagnostic.tsで確認した「騎手勝率(train期間)と残差の相関」が、
 * 実際に賭け方に組み込んだ時に的中率・回収率の改善につながるかを検証する。
 *
 * ブレンド方法: 騎手勝率をtrain期間全体の平均・標準偏差でz化し、
 *   finalScore = timeIndexScore + alpha * jockeyZ
 * のalphaを0(現行モデルのまま)から段階的に増やす。騎乗数がMIN_RIDES未満/
 * 未知の騎手はjockeyZ=0(平均的)として扱う。
 *
 * 検証は2段階:
 *   1) tuneWeights.tsと同じ3分割(train=2025通年 / validation=2026 1-3月 / holdout=2026 4月-)
 *      でalphaをグリッドサーチし、holdoutで再確認する。
 *   2) これまでの他施策と同様、単一期間の結果は再現しないことが多いため、
 *      4つの独立した期間でのウォークフォワード(Q2/Q3/Q4 2025 + 2026)でも
 *      同じalpha候補が安定して勝つか確認する。
 *
 * 単勝的中率に加えて、real odds(単勝オッズ)を使った回収率も計算する
 * (的中率が上がってもROIが下がるなら「人気馬に寄っただけ」の可能性がある)。
 *
 *   npx ts-node jockeyBlendBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  odds: number | null; jockeyName: string | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const UNIT_STAKE = 100;
const ALPHA_CANDIDATES = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0];

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

interface Bucket { count: number; winHits: number; placeHits: number; cost: number; returned: number; }
function newBucket(): Bucket { return { count: 0, winHits: 0, placeHits: 0, cost: 0, returned: 0 }; }
function fmtBucket(b: Bucket): string {
  const winRate = b.count > 0 ? (b.winHits / b.count) * 100 : 0;
  const placeRate = b.count > 0 ? (b.placeHits / b.count) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  return `単勝的中率=${winRate.toFixed(2)}% 複勝的中率=${placeRate.toFixed(2)}% 回収率=${roi.toFixed(1)}% (n=${b.count})`;
}

interface Entrant { horseName: string; finishRank: number; dateNum: number; jockeyName: string | null; odds: number | null; timeScore: number | null; jz: number; }
interface RaceGroup { today: { trackType: string; distance: number }; entrants: Entrant[]; }

interface Model {
  buildRaces: (records: RaceFactRecord[]) => RaceGroup[];
  jockeyEligibleCount: number;
  wrMean: number;
  wrStd: number;
}

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

  // 騎手勝率はこのモデルのtrainRecordsだけから集計する(未来情報の混入を防ぐ)
  const jockeyRides = new Map<string, { rides: number; wins: number }>();
  for (const r of trainRecords) {
    if (!r.jockeyName || !(r.finishRank > 0)) continue;
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

  function buildRaces(records: RaceFactRecord[]): RaceGroup[] {
    const races = new Map<string, RaceGroup>();
    for (const r of records) {
      const key = raceKeyOf(r);
      let race = races.get(key);
      if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] }; races.set(key, race); }
      const dateNum = dateToNum(r.raceDate);
      const history = lastFourBefore(r.horseName, dateNum);
      const timeScore = timeIndexScore(history, race.today, gradeOnlyStats);
      race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum, jockeyName: r.jockeyName, odds: r.odds, timeScore, jz: jockeyZ(r.jockeyName) });
    }
    return [...races.values()];
  }

  return { buildRaces, jockeyEligibleCount: jockeyWinRate.size, wrMean, wrStd };
}

function evaluate(races: RaceGroup[], alpha: number): { win: Bucket; roi: Bucket } {
  const win = newBucket(), roi = newBucket();
  for (const race of races) {
    const scored = race.entrants
      .filter((e): e is Entrant & { timeScore: number } => e.timeScore !== null)
      .map(e => ({ ...e, finalScore: e.timeScore + alpha * e.jz }));
    if (scored.length === 0) continue;
    const top = [...scored].sort((a, b) => b.finalScore - a.finalScore)[0];

    win.count++;
    if (top.finishRank === 1) win.winHits++;
    if (top.finishRank <= 3) win.placeHits++;

    if (top.odds !== null && top.odds > 0) {
      roi.count++; roi.cost += UNIT_STAKE;
      if (top.finishRank === 1) { roi.winHits++; roi.returned += top.odds * UNIT_STAKE; }
    }
  }
  return { win, roi };
}

function runTuneWeightsStyleSplit(allRecords: RaceFactRecord[]): void {
  const VALIDATION_HOLDOUT_CUTOFF = 20260401;
  const trainRecords = allRecords.filter(r => r.year === 2025);
  const testRecords2026 = allRecords.filter(r => r.year === 2026);
  const validationRecords = testRecords2026.filter(r => dateToNum(r.raceDate) < VALIDATION_HOLDOUT_CUTOFF);
  const holdoutRecords = testRecords2026.filter(r => dateToNum(r.raceDate) >= VALIDATION_HOLDOUT_CUTOFF);
  console.log(`train(2025): ${trainRecords.length}件 / validation(2026 1-3月): ${validationRecords.length}件 / holdout(2026 4月-): ${holdoutRecords.length}件`);

  const model = prepareModel(trainRecords, allRecords);
  console.log(`騎手勝率算出対象: ${model.jockeyEligibleCount}名 (平均${(model.wrMean * 100).toFixed(1)}% 標準偏差${(model.wrStd * 100).toFixed(1)}pt, MIN_RIDES=${MIN_RIDES})`);

  const validationRaces = model.buildRaces(validationRecords);
  const holdoutRaces = model.buildRaces(holdoutRecords);

  console.log('\n=== validation(2026 1-3月)でalphaグリッドサーチ ===');
  const results = ALPHA_CANDIDATES.map(alpha => ({ alpha, ...evaluate(validationRaces, alpha) }));
  for (const r of results) {
    console.log(`alpha=${r.alpha}: ${fmtBucket(r.win)} | 実オッズ回収率側: ${fmtBucket(r.roi)}`);
  }

  const bestByRoi = [...results].sort((a, b) => (b.roi.returned / Math.max(1, b.roi.cost)) - (a.roi.returned / Math.max(1, a.roi.cost)))[0];
  const bestByWinRate = [...results].sort((a, b) => (b.win.winHits / b.win.count) - (a.win.winHits / a.win.count))[0];
  console.log(`\nvalidationで回収率最良: alpha=${bestByRoi.alpha} / 的中率最良: alpha=${bestByWinRate.alpha}`);

  console.log('\n=== holdout(2026 4月-)で確認 ===');
  const holdoutAlphas = Array.from(new Set([0, bestByRoi.alpha, bestByWinRate.alpha]));
  for (const alpha of holdoutAlphas) {
    const r = evaluate(holdoutRaces, alpha);
    console.log(`alpha=${alpha}${alpha === 0 ? '(現行モデル)' : ''}: ${fmtBucket(r.win)} | 実オッズ回収率側: ${fmtBucket(r.roi)}`);
  }
}

function runWalkForward(allRecords: RaceFactRecord[]): void {
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'train=Q1 / test=Q2(4-6月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2 / test=Q3(7-9月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3 / test=Q4(10-12月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: 'train=2025通年 / test=2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];
  const checkAlphas = [0, 0.1, 0.15, 0.2, 0.3];

  console.log('\n\n########## 4期間ウォークフォワード検証 (alpha候補を絞って再現性を確認) ##########');
  const summary: { label: string; alpha: number; win: Bucket; roi: Bucket }[] = [];
  for (const p of periods) {
    const trainRecords = allRecords.filter(p.train);
    const testRecords = allRecords.filter(p.test);
    const model = prepareModel(trainRecords, allRecords);
    const races = model.buildRaces(testRecords);
    console.log(`\n=== ${p.label} (train ${trainRecords.length}件 / test ${testRecords.length}件, 騎手${model.jockeyEligibleCount}名) ===`);
    for (const alpha of checkAlphas) {
      const r = evaluate(races, alpha);
      console.log(`  alpha=${alpha}${alpha === 0 ? '(現行)' : ''}: ${fmtBucket(r.win)} | 実オッズ回収率側: ${fmtBucket(r.roi)}`);
      summary.push({ label: p.label, alpha, win: r.win, roi: r.roi });
    }
  }

  console.log('\n=== まとめ: alpha別の単勝的中率・回収率(実オッズ) ===');
  for (const alpha of checkAlphas) {
    const rows = summary.filter(s => s.alpha === alpha);
    const line = rows.map(s => `${s.label}=${((s.win.winHits / s.win.count) * 100).toFixed(1)}%/${((s.roi.returned / Math.max(1, s.roi.cost)) * 100).toFixed(0)}%`).join('  ');
    console.log(`alpha=${alpha}: ${line}`);
  }
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  runTuneWeightsStyleSplit(allRecords);
  runWalkForward(allRecords);
}

main();
