/**
 * favoriteModelAgreementBacktest.tsで「市場1番人気=モデル1位が一致するレースだけ買う」
 * (複勝回収率84-86%、本命オッズ<1.8ならさらに90-93%)という頑健な選別フィルターが
 * 見つかった。単勝・複勝は配当が低く面白みに欠けるため、同じ「一致」フィルターを
 * 使って、配当の高い馬連・馬単で回収率が上げられるかを検証する。
 *
 * 比較する戦略（すべて「一致」＝市場1番人気とモデル1位が同一馬のレースのみが対象）:
 *   A. モデル上位2頭(=市場本命+モデル2位)を馬連で
 *   B. 同じ2頭を馬単、本命→2着評価馬の順で固定
 *   C. 同じ2頭を馬単、2着評価馬→本命の順で固定（逆張り）
 *   D. 参考: 市場本命+市場2番人気の馬連(モデル不使用、一致フィルターなし全レース対象)
 *   E. 参考: モデル上位2頭box(市場一致フィルター無し、全レース対象)
 *
 *   npx ts-node agreementComboBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null; odds: number | null; quinellaPayout: number | null; exactaPayout: number | null;
  widePayouts: number[]; trioPayout: number | null;
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

interface ScoredEntrant { horseName: string; finishRank: number; odds: number | null; finalScore: number; }
interface RaceGroup { quinellaPayout: number | null; exactaPayout: number | null; widePayouts: number[]; trioPayout: number | null; entrants: ScoredEntrant[]; }
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
      if (!race) { race = { quinellaPayout: r.quinellaPayout, exactaPayout: r.exactaPayout, widePayouts: r.widePayouts, trioPayout: r.trioPayout, entrants: [] }; races.set(key, race); }
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
  const avgPayout = b.hits > 0 ? b.hitPayouts.reduce((s, v) => s + v, 0) / b.hits : 0;
  return `的中率=${hitRate.toFixed(1)}% 回収率=${roi.toFixed(1)}%(上位3件除くと${roiEx.toFixed(1)}%) 的中時平均配当=${avgPayout.toFixed(0)}円 (n=${b.races})`;
}

function evaluate(races: RaceGroup[], strategy: 'A' | 'B' | 'C' | 'D' | 'E'): Bucket {
  const bucket = newBucket();
  for (const race of races) {
    const withOdds = race.entrants.filter((e): e is ScoredEntrant & { odds: number } => e.odds != null && e.odds > 0);
    if (withOdds.length < 2) continue;
    const byOddsAsc = [...withOdds].sort((a, b) => a.odds - b.odds);
    const marketFav = byOddsAsc[0];
    const byScoreDesc = [...race.entrants].sort((a, b) => b.finalScore - a.finalScore);
    const modelTop1 = byScoreDesc[0];
    const agree = modelTop1.horseName === marketFav.horseName;

    let legA: ScoredEntrant | undefined, legB: ScoredEntrant | undefined, betType: 'quinella' | 'exacta' = 'quinella';
    let orderMatters = false; // exactaで(legA→legB)の順が必要かどうか

    if (strategy === 'A') {
      if (!agree) continue;
      legA = marketFav; legB = byScoreDesc.find(e => e.horseName !== marketFav.horseName);
      betType = 'quinella';
    } else if (strategy === 'B') {
      if (!agree) continue;
      legA = marketFav; legB = byScoreDesc.find(e => e.horseName !== marketFav.horseName);
      betType = 'exacta'; orderMatters = true; // 本命→モデル2位 の順で1着・2着
    } else if (strategy === 'C') {
      if (!agree) continue;
      legB = marketFav; legA = byScoreDesc.find(e => e.horseName !== marketFav.horseName);
      betType = 'exacta'; orderMatters = true; // モデル2位→本命 の順で1着・2着
    } else if (strategy === 'D') {
      legA = marketFav; legB = byOddsAsc[1];
      betType = 'quinella';
    } else if (strategy === 'E') {
      legA = byScoreDesc[0]; legB = byScoreDesc[1];
      betType = 'quinella';
    }
    if (!legA || !legB) continue;

    bucket.races++; bucket.cost += UNIT_STAKE;
    const ranks = new Set([legA.finishRank, legB.finishRank]);
    const hit = betType === 'quinella'
      ? (ranks.has(1) && ranks.has(2))
      : (orderMatters ? (legA.finishRank === 1 && legB.finishRank === 2) : (ranks.has(1) && ranks.has(2)));
    if (hit) {
      const payout = betType === 'quinella' ? race.quinellaPayout : race.exactaPayout;
      if (payout != null) {
        bucket.hits++; bucket.returned += payout; bucket.hitPayouts.push(payout);
      }
    }
  }
  return bucket;
}

// 3頭box：一致フィルターの有無・3頭の選び方(市場 or モデル)を切り替えられるようにする
function evaluateBox3(
  races: RaceGroup[],
  betType: 'quinella' | 'wide' | 'trio',
  pick: 'agreeFavPlusModel2' | 'marketTop3' | 'modelTop3'
): Bucket {
  const bucket = newBucket();
  for (const race of races) {
    const withOdds = race.entrants.filter((e): e is ScoredEntrant & { odds: number } => e.odds != null && e.odds > 0);
    if (withOdds.length < 3) continue;
    const byOddsAsc = [...withOdds].sort((a, b) => a.odds - b.odds);
    const byScoreDesc = [...race.entrants].sort((a, b) => b.finalScore - a.finalScore);

    let three: ScoredEntrant[] | undefined;
    if (pick === 'agreeFavPlusModel2') {
      const marketFav = byOddsAsc[0];
      const modelTop1 = byScoreDesc[0];
      if (modelTop1.horseName !== marketFav.horseName) continue; // 一致フィルター
      const rest = byScoreDesc.filter(e => e.horseName !== marketFav.horseName).slice(0, 2);
      if (rest.length < 2) continue;
      three = [marketFav, ...rest];
    } else if (pick === 'marketTop3') {
      three = byOddsAsc.slice(0, 3);
    } else {
      three = byScoreDesc.slice(0, 3);
    }
    if (!three || three.length < 3) continue;

    const ranks = three.map(e => e.finishRank);
    bucket.races++;

    if (betType === 'trio') {
      bucket.cost += UNIT_STAKE; // 3頭で3連複は1通りのみ
      if (ranks.includes(1) && ranks.includes(2) && ranks.includes(3) && race.trioPayout != null) {
        bucket.hits++; bucket.returned += race.trioPayout; bucket.hitPayouts.push(race.trioPayout);
      }
    } else {
      bucket.cost += 3 * UNIT_STAKE; // 3頭から2頭選ぶ組み合わせ=3通り
      if (betType === 'quinella') {
        if (ranks.includes(1) && ranks.includes(2) && race.quinellaPayout != null) {
          bucket.hits++; bucket.returned += race.quinellaPayout; bucket.hitPayouts.push(race.quinellaPayout);
        }
      } else { // wide: 実際の上位3頭のうち、three内に収まるペアごとに加算（複数的中もあり得る）
        const actual1 = race.entrants.find(e => e.finishRank === 1);
        const actual2 = race.entrants.find(e => e.finishRank === 2);
        const actual3 = race.entrants.find(e => e.finishRank === 3);
        const names = new Set(three.map(e => e.horseName));
        let raceHit = false;
        const pairs: [typeof actual1, typeof actual2, number][] = [
          [actual1, actual2, 0], [actual1, actual3, 1], [actual2, actual3, 2],
        ];
        for (const [p, q, payoutIdx] of pairs) {
          if (p && q && names.has(p.horseName) && names.has(q.horseName) && race.widePayouts[payoutIdx] != null) {
            raceHit = true;
            bucket.returned += race.widePayouts[payoutIdx]; bucket.hitPayouts.push(race.widePayouts[payoutIdx]);
          }
        }
        if (raceHit) bucket.hits++;
      }
    }
  }
  return bucket;
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const trainRecords = allRecords.filter(r => r.year === 2025);
  const testRecords = allRecords.filter(r => r.year === 2026);
  const model = prepareModel(trainRecords, allRecords);
  const races = model.buildRaces(testRecords);

  const strategies: { key: 'A' | 'B' | 'C' | 'D' | 'E'; label: string }[] = [
    { key: 'A', label: 'A.一致時: 本命+モデル2位を馬連           ' },
    { key: 'B', label: 'B.一致時: 本命→モデル2位の順で馬単       ' },
    { key: 'C', label: 'C.一致時: モデル2位→本命の順で馬単       ' },
    { key: 'D', label: 'D.参考: 本命+市場2番人気を馬連(全レース) ' },
    { key: 'E', label: 'E.参考: モデル上位2頭box馬連(全レース)   ' },
  ];

  const boxStrategies: { betType: 'quinella' | 'wide' | 'trio'; pick: 'agreeFavPlusModel2' | 'marketTop3' | 'modelTop3'; label: string }[] = [
    { betType: 'quinella', pick: 'agreeFavPlusModel2', label: 'F.一致時: 本命+モデル2,3位 馬連3頭box  ' },
    { betType: 'wide', pick: 'agreeFavPlusModel2', label: 'G.一致時: 本命+モデル2,3位 ワイド3頭box' },
    { betType: 'trio', pick: 'agreeFavPlusModel2', label: 'H.一致時: 本命+モデル2,3位 3連複3頭box ' },
    { betType: 'quinella', pick: 'marketTop3', label: 'I.参考: 市場人気上位3頭 馬連3頭box(全)  ' },
    { betType: 'wide', pick: 'marketTop3', label: 'J.参考: 市場人気上位3頭 ワイド3頭box(全)' },
    { betType: 'trio', pick: 'marketTop3', label: 'K.参考: 市場人気上位3頭 3連複3頭box(全) ' },
  ];

  console.log('=== train=2025通年 / test=2026 ===');
  for (const s of strategies) console.log(`${s.label}: ${fmtBucket(evaluate(races, s.key))}`);
  for (const s of boxStrategies) console.log(`${s.label}: ${fmtBucket(evaluateBox3(races, s.betType, s.pick))}`);

  console.log('\n\n########## 4期間ウォークフォワード ##########');
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'Q2', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'Q3', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'Q4', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: '2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];
  for (const p of periods) {
    const tr = allRecords.filter(p.train);
    const te = allRecords.filter(p.test);
    const m = prepareModel(tr, allRecords);
    const pr = m.buildRaces(te);
    console.log(`\n=== test=${p.label} ===`);
    for (const s of strategies) console.log(`${s.label}: ${fmtBucket(evaluate(pr, s.key))}`);
    for (const s of boxStrategies) console.log(`${s.label}: ${fmtBucket(evaluateBox3(pr, s.betType, s.pick))}`);
  }
}

main();
