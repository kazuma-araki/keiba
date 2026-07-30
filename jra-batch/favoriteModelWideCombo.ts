/**
 * 「市場の本命(1番人気) × モデルが評価する馬」の組み合わせをワイド（3着以内に
 * 共に入れば的中、順序不問）で買う戦略を検証する。複勝(1頭・低配当)より高い配当を
 * 狙いつつ、favoriteOddsThresholdBacktest.tsで確認した「市場本命は複勝的中率が高い」
 * という土台を活かす設計。
 *
 * 2頭目（モデル側の馬）の選び方を3パターン比較する:
 *   1. モデル1位（本命自身がモデル1位ならモデル2位を採用し、必ず異なる2頭にする）
 *   2. モデルの中で本命に次いで2番目に評価が高い馬（本命がモデル何位でも関係なくモデル順で2番目）
 *   3. 本命を除いた中でモデル最高評価（1と近いが、本命がモデル1位でない場合は同じになる）
 * 実際には1と3はほぼ同じ結果になるため、主に1（と比較用の「本命+市場2番人気」）を見る。
 *
 *   npx ts-node favoriteModelWideCombo.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  odds: number | null; jockeyName: string | null; widePayouts: number[];
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
interface RaceGroup { today: { trackType: string; distance: number }; entrants: Entrant[]; widePayouts: number[]; }
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
      if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [], widePayouts: r.widePayouts }; races.set(key, race); }
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
function fmtBucket(b: Bucket): string {
  const hitRate = b.races > 0 ? (b.hits / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  const top3 = [...b.hitPayouts].sort((a, c) => c - a).slice(0, 3).reduce((s, v) => s + v, 0);
  const roiEx = b.cost > 0 ? ((b.returned - top3) / b.cost) * 100 : 0;
  const avgHitPayout = b.hits > 0 ? b.returned / b.hits : 0;
  return `的中率=${hitRate.toFixed(1)}% 回収率=${roi.toFixed(1)}%(上位3件除くと${roiEx.toFixed(1)}%) 的中時平均配当=${avgHitPayout.toFixed(0)}円 (n=${b.races})`;
}

// legA, legBの2頭がどちらも実際の上位3着以内に入っていればワイド的中。
// widePayoutsは(1-2着)(1-3着)(2-3着)の順で並んでいるので、両者の着順から該当ペイアウトを引く。
function wideBet(b: Bucket, legA: Entrant, legB: Entrant, widePayouts: number[]): void {
  b.races++; b.cost += UNIT_STAKE;
  const ranks = [legA.finishRank, legB.finishRank].sort((x, y) => x - y);
  const bothTop3 = ranks[0] >= 1 && ranks[0] <= 3 && ranks[1] >= 1 && ranks[1] <= 3 && ranks[0] !== ranks[1];
  if (!bothTop3) return;
  const payoutIdx = ranks[0] === 1 && ranks[1] === 2 ? 0 : ranks[0] === 1 && ranks[1] === 3 ? 1 : 2;
  const payout = widePayouts[payoutIdx];
  if (payout == null) return;
  b.hits++; b.returned += payout; b.hitPayouts.push(payout);
}

interface Results {
  favoriteAndModelTop: Bucket; // 市場本命 × モデル最高評価(本命以外)
  favoriteAndModel2nd: Bucket; // 市場本命 × 市場2番人気
  favoriteAndModelTopOddsUnder1_8: Bucket;
}
function newResults(): Results {
  return { favoriteAndModelTop: newBucket(), favoriteAndModel2nd: newBucket(), favoriteAndModelTopOddsUnder1_8: newBucket() };
}

function evaluate(races: RaceGroup[]): Results {
  const out = newResults();
  for (const race of races) {
    const scored = race.entrants.filter((e): e is Entrant & { score: number } => e.score !== null);
    if (scored.length < 5 || race.widePayouts.length === 0) continue;

    const byOdds = [...scored].sort((a, b) => a.odds - b.odds);
    const favorite = byOdds[0];
    const secondFavorite = byOdds[1];
    const byModel = [...scored].sort((a, b) => b.score - a.score);
    const modelTopExcludingFavorite = byModel.find(e => e.horseName !== favorite.horseName);

    if (modelTopExcludingFavorite) {
      wideBet(out.favoriteAndModelTop, favorite, modelTopExcludingFavorite, race.widePayouts);
      if (favorite.odds < 1.8) wideBet(out.favoriteAndModelTopOddsUnder1_8, favorite, modelTopExcludingFavorite, race.widePayouts);
    }
    if (secondFavorite) wideBet(out.favoriteAndModel2nd, favorite, secondFavorite, race.widePayouts);
  }
  return out;
}

function printResults(label: string, r: Results): void {
  console.log(`\n=== ${label} ===`);
  console.log(`市場本命×モデル最高評価(本命以外)のワイド: ${fmtBucket(r.favoriteAndModelTop)}`);
  console.log(`市場本命×市場2番人気のワイド(比較用)　　: ${fmtBucket(r.favoriteAndModel2nd)}`);
  console.log(`市場本命×モデル最高評価、本命オッズ<1.8 : ${fmtBucket(r.favoriteAndModelTopOddsUnder1_8)}`);
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const trainRecords = allRecords.filter(r => r.year === 2025);
  const testRecords = allRecords.filter(r => r.year === 2026);
  const model = prepareModel(trainRecords, allRecords);
  printResults('train=2025通年 / test=2026', evaluate(model.buildRaces(testRecords)));

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
