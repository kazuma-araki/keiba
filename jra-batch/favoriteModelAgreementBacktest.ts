/**
 * 「市場の人気馬」と「タイム指数×騎手係数モデルの予想」を組み合わせた複勝戦略を検証する。
 *
 * 以前却下した「乖離ベット」（モデルと市場のギャップが大きいほど狙う＝価値馬狙い）とは
 * 逆方向の仮説：モデルと市場が「一致」している時だけ買う（＝2つの独立した情報源が
 * 同じ結論を出しているケースは、片方だけより信頼できるはず）を検証する。
 *
 * 比較する4パターン（すべて複勝、対象は各パターンの条件に合致するレースのみ）:
 *   A. 市場1番人気 かつ モデルも1位 → その馬に複勝（一致ケース）
 *   B. 市場1番人気 だがモデルは1位としていない → その馬(市場1番人気)に複勝（不一致・市場追従）
 *   C. 市場1番人気 だがモデルは1位としていない → モデル1位の馬に複勝（不一致・モデル追従）
 *   D. 市場1番人気 かつ モデルも上位3位以内 → その馬に複勝（一致をやや緩めた場合）
 *
 * favoriteOddsThresholdBacktest.tsで確認済みの「市場1番人気のオッズが低いほど良い」
 * 効果とどう絡むかも見るため、オッズ帯別にも分解する。
 *
 *   npx ts-node favoriteModelAgreementBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  odds: number | null; jockeyName: string | null; placePayouts: number[];
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const ALPHA_JOCKEY = 0.1;
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

interface Entrant { horseName: string; finishRank: number; dateNum: number; odds: number; score: number | null; }
interface RaceGroup { today: { trackType: string; distance: number }; entrants: Entrant[]; placePayouts: number[]; }

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
      if (r.odds == null || r.odds <= 0) continue;
      const key = raceKeyOf(r);
      let race = races.get(key);
      if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [], placePayouts: r.placePayouts }; races.set(key, race); }
      const dateNum = dateToNum(r.raceDate);
      const history = lastFourBefore(r.horseName, dateNum);
      const timeScore = timeIndexScore(history, race.today, gradeOnlyStats);
      const score = timeScore == null ? null : timeScore + ALPHA_JOCKEY * jockeyZ(r.jockeyName);
      race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum, odds: r.odds, score });
    }
    return [...races.values()];
  }

  return { buildRaces };
}

interface Bucket { races: number; hits: number; cost: number; returned: number; hitPayouts: number[]; }
function newBucket(): Bucket { return { races: 0, hits: 0, cost: 0, returned: 0, hitPayouts: [] }; }
function bet(b: Bucket, e: Entrant, placePayouts: number[]): void {
  b.races++; b.cost += UNIT_STAKE;
  if (e.finishRank >= 1 && e.finishRank <= 3 && placePayouts.length >= e.finishRank) {
    const payout = placePayouts[e.finishRank - 1];
    b.hits++; b.returned += payout; b.hitPayouts.push(payout);
  }
}
function fmtBucket(b: Bucket): string {
  const hitRate = b.races > 0 ? (b.hits / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  const top3 = [...b.hitPayouts].sort((a, c) => c - a).slice(0, 3).reduce((s, v) => s + v, 0);
  const roiEx = b.cost > 0 ? ((b.returned - top3) / b.cost) * 100 : 0;
  return `的中率=${hitRate.toFixed(1)}% 回収率=${roi.toFixed(1)}%(上位3件除くと${roiEx.toFixed(1)}%) (n=${b.races})`;
}

interface Results {
  agree: Bucket; // A: 市場1位=モデル1位が一致 → その馬
  disagreeMarket: Bucket; // B: 不一致 → 市場1番人気に賭ける
  disagreeModel: Bucket; // C: 不一致 → モデル1位に賭ける
  agreeTop3: Bucket; // D: 市場1位がモデル上位3位以内 → その馬
  agreeOddsUnder1_8: Bucket; // A かつ 市場1番人気オッズ<1.8
}
function newResults(): Results {
  return { agree: newBucket(), disagreeMarket: newBucket(), disagreeModel: newBucket(), agreeTop3: newBucket(), agreeOddsUnder1_8: newBucket() };
}

function evaluate(races: RaceGroup[]): Results {
  const out = newResults();
  for (const race of races) {
    const scored = race.entrants.filter((e): e is Entrant & { score: number } => e.score !== null);
    if (scored.length < 5) continue;
    const marketFavorite = [...scored].sort((a, b) => a.odds - b.odds)[0];
    const byModel = [...scored].sort((a, b) => b.score - a.score);
    const modelTop1 = byModel[0];
    const modelTop3Names = new Set(byModel.slice(0, 3).map(e => e.horseName));

    if (marketFavorite.horseName === modelTop1.horseName) {
      bet(out.agree, marketFavorite, race.placePayouts);
      if (marketFavorite.odds < 1.8) bet(out.agreeOddsUnder1_8, marketFavorite, race.placePayouts);
    } else {
      bet(out.disagreeMarket, marketFavorite, race.placePayouts);
      bet(out.disagreeModel, modelTop1, race.placePayouts);
    }

    if (modelTop3Names.has(marketFavorite.horseName)) {
      bet(out.agreeTop3, marketFavorite, race.placePayouts);
    }
  }
  return out;
}

function printResults(label: string, r: Results): void {
  console.log(`\n=== ${label} ===`);
  console.log(`A. 市場1位=モデル1位(一致)に複勝: ${fmtBucket(r.agree)}`);
  console.log(`B. 不一致時、市場1番人気に複勝　: ${fmtBucket(r.disagreeMarket)}`);
  console.log(`C. 不一致時、モデル1位に複勝　　: ${fmtBucket(r.disagreeModel)}`);
  console.log(`D. 市場1位がモデル上位3位以内に複勝: ${fmtBucket(r.agreeTop3)}`);
  console.log(`E. 一致 かつ 市場1番人気オッズ<1.8: ${fmtBucket(r.agreeOddsUnder1_8)}`);
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const trainRecords = allRecords.filter(r => r.year === 2025);
  const testRecords = allRecords.filter(r => r.year === 2026);
  const model = prepareModel(trainRecords, allRecords);
  const races = model.buildRaces(testRecords);
  printResults('train=2025通年 / test=2026', evaluate(races));

  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'train=Q1 / test=Q2', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2 / test=Q3', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3 / test=Q4', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
  ];
  console.log('\n\n########## 4期間ウォークフォワード ##########');
  for (const p of periods) {
    const tr = allRecords.filter(p.train);
    const te = allRecords.filter(p.test);
    const m = prepareModel(tr, allRecords);
    printResults(p.label, evaluate(m.buildRaces(te)));
  }
}

main();
