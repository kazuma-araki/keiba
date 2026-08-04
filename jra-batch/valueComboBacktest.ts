/**
 * agreementComboBacktest.tsのH戦略(一致時:本命+モデル2,3位 3連複3頭box)の的中30件を
 * 中身検証したところ、27件は普通の配当(中央値800円)だが3件だけ4,860〜7,700円の
 * 大穴で、その3件が総リターンの47%を占めていた。上位3件を除くと回収率39.2%まで
 * 落ちる＝「大穴に頼らないと存続できない」設計だった。
 *
 * その3件は、モデルが市場オッズ7-8位(25-40倍)の馬を上位評価していて、それが実際に
 * 馬券に絡んだケースだった。これが偶然ではなく再現性があるなら、「本命＋乖離馬」を
 * 明示的に狙う設計にして、もっと多くのデータでプールして検証する価値がある
 * (valueBetBacktestPooled.tsと同じ2期間プール手法。ただし単勝ではなく
 * 「市場本命+乖離馬」の馬連・ワイドで検証する)。
 *
 * 乖離 = 市場オッズ順位 - モデル順位（プラスが大きいほど「モデルは評価しているが
 * 市場では人気薄」）。市場本命自身とは別の馬の中で、乖離が閾値以上かつ
 * 最大の馬を「乖離馬」として選ぶ。
 *
 *   npx ts-node valueComboBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null; odds: number | null; quinellaPayout: number | null; widePayouts: number[];
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
const gapThresholds = [2, 4, 6, 8];

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

interface Bucket { races: number; hits: number; cost: number; returned: number; hitPayouts: number[]; }
function newBucket(): Bucket { return { races: 0, hits: 0, cost: 0, returned: 0, hitPayouts: [] }; }
function addBucket(a: Bucket, b: Bucket): void { a.races += b.races; a.hits += b.hits; a.cost += b.cost; a.returned += b.returned; a.hitPayouts.push(...b.hitPayouts); }
function fmtBucket(b: Bucket): string {
  const hitRate = b.races > 0 ? (b.hits / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  const top3 = [...b.hitPayouts].sort((a, c) => c - a).slice(0, 3).reduce((s, v) => s + v, 0);
  const roiEx = b.cost > 0 ? ((b.returned - top3) / b.cost) * 100 : 0;
  return `的中率=${hitRate.toFixed(2)}% 回収率=${roi.toFixed(1)}%(上位3件除くと${roiEx.toFixed(1)}%) (n=${b.races})`;
}

function evaluatePeriod(
  allRecords: RaceFactRecord[],
  trainFilter: (r: RaceFactRecord) => boolean,
  testFilter: (r: RaceFactRecord) => boolean
): { totalRaces: number; quinellaByGap: Map<number, Bucket>; wideByGap: Map<number, Bucket>; baselineQuinella: Bucket } {
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

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of allRecords) {
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

  interface RaceGroup { quinellaPayout: number | null; widePayouts: number[]; entrants: { horseName: string; finishRank: number; odds: number | null; finalScore: number }[]; }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) { race = { quinellaPayout: r.quinellaPayout, widePayouts: r.widePayouts, entrants: [] }; races.set(key, race); }
    const dateNum = dateToNum(r.raceDate);
    const epochDay = dateToEpochDays(r.raceDate);
    const history = lastFourBefore(r.horseName, dateNum);
    const today = { trackType: r.trackType, distance: r.distance };
    const timeScore = timeIndexScore(history, today, gradeOnlyStats);
    if (timeScore == null) continue;
    const jz = jockeyZ(r.jockeyName);
    const recent = history[0] ?? null;
    const distanceDeltaZ = recent ? (r.distance - recent.distance - ddMean) / ddStd : 0;
    const intervalZ = recent && recent.epochDay != null && epochDay != null ? ((epochDay - recent.epochDay) - ivMean) / ivStd : 0;
    const finalScore = timeScore + ALPHA_JOCKEY * jz + ALPHA_INTERVAL * intervalZ - ALPHA_DISTANCE * distanceDeltaZ;
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, odds: r.odds, finalScore });
  }

  const quinellaByGap = new Map<number, Bucket>(gapThresholds.map(t => [t, newBucket()]));
  const wideByGap = new Map<number, Bucket>(gapThresholds.map(t => [t, newBucket()]));
  const baselineQuinella = newBucket(); // 参考: 本命+市場2番人気(乖離不使用)
  let totalRaces = 0;

  for (const race of races.values()) {
    const withOdds = race.entrants.filter((e): e is typeof e & { odds: number } => e.odds != null && e.odds > 0);
    if (withOdds.length < 4) continue;
    totalRaces++;

    const byOddsAsc = [...withOdds].sort((a, b) => a.odds - b.odds);
    const marketRankOf = new Map(byOddsAsc.map((e, i) => [e.horseName, i + 1]));
    const byScoreDesc = [...withOdds].sort((a, b) => b.finalScore - a.finalScore);
    const modelRankOf = new Map(byScoreDesc.map((e, i) => [e.horseName, i + 1]));
    const fav = byOddsAsc[0];

    // 参考: 本命+市場2番人気
    baselineQuinella.races++; baselineQuinella.cost += UNIT_STAKE;
    if (race.quinellaPayout != null) {
      const second = byOddsAsc[1];
      if ((fav.finishRank === 1 && second.finishRank === 2) || (fav.finishRank === 2 && second.finishRank === 1)) {
        baselineQuinella.hits++; baselineQuinella.returned += race.quinellaPayout; baselineQuinella.hitPayouts.push(race.quinellaPayout);
      }
    }

    // 本命以外の中で乖離(市場順位-モデル順位)が最大の馬を求める
    const others = withOdds.filter(e => e.horseName !== fav.horseName);
    let bestGapHorse: typeof fav | null = null, bestGap = -Infinity;
    for (const e of others) {
      const gap = marketRankOf.get(e.horseName)! - modelRankOf.get(e.horseName)!;
      if (gap > bestGap) { bestGap = gap; bestGapHorse = e; }
    }
    if (!bestGapHorse) continue;

    for (const t of gapThresholds) {
      if (bestGap < t) continue;
      const qb = quinellaByGap.get(t)!;
      qb.races++; qb.cost += UNIT_STAKE;
      if (race.quinellaPayout != null) {
        const ranks = [fav.finishRank, bestGapHorse.finishRank];
        if (ranks.includes(1) && ranks.includes(2)) { qb.hits++; qb.returned += race.quinellaPayout; qb.hitPayouts.push(race.quinellaPayout); }
      }
      const wb = wideByGap.get(t)!;
      wb.races++; wb.cost += UNIT_STAKE;
      if (race.widePayouts.length > 0) {
        const finRanks = [fav.finishRank, bestGapHorse.finishRank].sort((a, b) => a - b);
        // widePayouts: [1-2着, 1-3着, 2-3着] の順
        let payoutIdx: number | null = null;
        if (finRanks[0] === 1 && finRanks[1] === 2) payoutIdx = 0;
        else if (finRanks[0] === 1 && finRanks[1] === 3) payoutIdx = 1;
        else if (finRanks[0] === 2 && finRanks[1] === 3) payoutIdx = 2;
        if (payoutIdx != null && race.widePayouts[payoutIdx] != null) {
          wb.hits++; wb.returned += race.widePayouts[payoutIdx]; wb.hitPayouts.push(race.widePayouts[payoutIdx]);
        }
      }
    }
  }

  return { totalRaces, quinellaByGap, wideByGap, baselineQuinella };
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const SPLIT_2025 = 20250701;

  const periodA = evaluatePeriod(allRecords, r => r.year === 2025 && dateToNum(r.raceDate) < SPLIT_2025, r => r.year === 2025 && dateToNum(r.raceDate) >= SPLIT_2025);
  const periodB = evaluatePeriod(allRecords, r => r.year === 2025, r => r.year === 2026);

  console.log(`=== 期間A: train=2025前半 / test=2025後半 (n=${periodA.totalRaces}) ===`);
  console.log(`参考(本命+市場2番人気)馬連: ${fmtBucket(periodA.baselineQuinella)}`);
  for (const t of gapThresholds) {
    console.log(`乖離${t}以上 馬連: ${fmtBucket(periodA.quinellaByGap.get(t)!)}`);
    console.log(`乖離${t}以上 ワイド: ${fmtBucket(periodA.wideByGap.get(t)!)}`);
  }

  console.log(`\n=== 期間B: train=2025通年 / test=2026 (n=${periodB.totalRaces}) ===`);
  console.log(`参考(本命+市場2番人気)馬連: ${fmtBucket(periodB.baselineQuinella)}`);
  for (const t of gapThresholds) {
    console.log(`乖離${t}以上 馬連: ${fmtBucket(periodB.quinellaByGap.get(t)!)}`);
    console.log(`乖離${t}以上 ワイド: ${fmtBucket(periodB.wideByGap.get(t)!)}`);
  }

  console.log(`\n=== 統合(期間A+期間Bをプール, n=${periodA.totalRaces + periodB.totalRaces}) ===`);
  const pooledBaseline = newBucket(); addBucket(pooledBaseline, periodA.baselineQuinella); addBucket(pooledBaseline, periodB.baselineQuinella);
  console.log(`参考(本命+市場2番人気)馬連: ${fmtBucket(pooledBaseline)}`);
  for (const t of gapThresholds) {
    const pq = newBucket(); addBucket(pq, periodA.quinellaByGap.get(t)!); addBucket(pq, periodB.quinellaByGap.get(t)!);
    console.log(`乖離${t}以上 馬連: ${fmtBucket(pq)}`);
    const pw = newBucket(); addBucket(pw, periodA.wideByGap.get(t)!); addBucket(pw, periodB.wideByGap.get(t)!);
    console.log(`乖離${t}以上 ワイド: ${fmtBucket(pw)}`);
  }
}

main();
