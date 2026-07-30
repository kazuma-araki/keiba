/**
 * 単勝・複勝・馬連・馬単・ワイド・3連複・3連単について、モデル(タイム指数+騎手係数の
 * ブレンドスコア、jockeyBlendBacktest.tsで検証済みのalpha=0.1)上位K頭のボックス/個別
 * 買いをシミュレーションし、回収率・的中率を比較する。
 *
 * 枠連は枠番データを未抽出のため対象外（別セッションで枠番抽出をしてから追加する）。
 *
 * 【的中判定の考え方】
 * 実際にどの馬番が的中したかの組み合わせ表記はPDFのフォント変換で文字化けするため
 * 使わない。代わりに、各出走馬の finishRank（着順）とモデル順位だけで的中判定できる
 * ことを利用する：
 *   - 馬連・馬単：実際の1着・2着馬の両方がモデル上位K頭に含まれていればヒット
 *     （ボックスは全順列/組み合わせを買うため、順序自体は問わない）
 *   - 3連複・3連単：実際の1・2・3着馬の3頭すべてがモデル上位K頭に含まれていればヒット
 *   - ワイド：実際の上位3頭のペア（1-2着 / 1-3着 / 2-3着）ごとに、両方がモデル上位K頭に
 *     含まれていればそのペア分だけヒット（複数ペア同時ヒットもあり得る）
 *   - 複勝：モデル上位K頭を個別に複勝で買う。各馬のfinishRankが3着以内ならその着順の
 *     複勝配当（placePayouts[finishRank-1]、1着→2着→3着の順で並んでいる前提）を返す
 *   - 単勝：モデル1位のみを単勝で買う（K=1固定、比較用のベースライン）
 *
 * 【実行方法】
 *   npx ts-node betTypeBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null;
  winPayout: number | null; placePayouts: number[]; quinellaPayout: number | null;
  exactaPayout: number | null; widePayouts: number[]; trioPayout: number | null; trifectaPayout: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const ALPHA_JOCKEY = 0.1; // jockeyBlendBacktest.tsで検証済みの値
const UNIT_STAKE = 100;
const BOX_SIZES = [2, 3, 4, 5, 6];
const BOX_SIZES_TRIPLE = [3, 4, 5, 6]; // 3連複・3連単は最低3頭必要
const PLACE_TOP_N = [1, 2, 3];

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

interface Entrant {
  horseName: string; finishRank: number; dateNum: number; jockeyName: string | null; score: number | null;
}
interface RaceGroup {
  today: { trackType: string; distance: number };
  entrants: Entrant[];
  winPayout: number | null; placePayouts: number[]; quinellaPayout: number | null;
  exactaPayout: number | null; widePayouts: number[]; trioPayout: number | null; trifectaPayout: number | null;
}

interface Model {
  buildRaces: (records: RaceFactRecord[]) => RaceGroup[];
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
      if (!race) {
        race = {
          today: { trackType: r.trackType, distance: r.distance }, entrants: [],
          winPayout: r.winPayout, placePayouts: r.placePayouts, quinellaPayout: r.quinellaPayout,
          exactaPayout: r.exactaPayout, widePayouts: r.widePayouts, trioPayout: r.trioPayout, trifectaPayout: r.trifectaPayout,
        };
        races.set(key, race);
      }
      const dateNum = dateToNum(r.raceDate);
      const history = lastFourBefore(r.horseName, dateNum);
      const timeScore = timeIndexScore(history, race.today, gradeOnlyStats);
      const score = timeScore == null ? null : timeScore + ALPHA_JOCKEY * jockeyZ(r.jockeyName);
      race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum, jockeyName: r.jockeyName, score });
    }
    return [...races.values()];
  }

  return { buildRaces };
}

// hitRaces: 「このレースで最低1点的中したか」（0か1）を積み上げたもの。的中率(%)の分子に使う。
// hitTickets: 的中した券種の延べ枚数（ワイドは1レースで最大3枚同時的中し得るため、
// hitRacesとは別に持つ。回収率の計算には使わずreturnedを直接使う）。
interface Bucket { races: number; hitRaces: number; hitTickets: number; cost: number; returned: number; hitPayouts: number[]; }
function newBucket(): Bucket { return { races: 0, hitRaces: 0, hitTickets: 0, cost: 0, returned: 0, hitPayouts: [] }; }
function addHit(b: Bucket, payout: number): void {
  b.hitTickets++;
  b.returned += payout;
  b.hitPayouts.push(payout);
}
function fmtBucket(b: Bucket): string {
  const hitRate = b.races > 0 ? (b.hitRaces / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  // 上位3件の的中払戻を除いた場合の回収率（大穴払戻数件による過大評価でないかの目安）。
  const sortedPayouts = [...b.hitPayouts].sort((a, c) => c - a);
  const top3Sum = sortedPayouts.slice(0, 3).reduce((s, v) => s + v, 0);
  const roiExTop3 = b.cost > 0 ? ((b.returned - top3Sum) / b.cost) * 100 : 0;
  return `的中率=${hitRate.toFixed(2)}% 回収率=${roi.toFixed(1)}%(上位3件除くと${roiExTop3.toFixed(1)}%) (n=${b.races})`;
}

function rankedEntrants(race: RaceGroup): Entrant[] {
  return race.entrants
    .filter((e): e is Entrant & { score: number } => e.score !== null)
    .sort((a, b) => b.score - a.score);
}

function combinations2(arr: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}
function combinations3(arr: number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) for (let k = j + 1; k < arr.length; k++) out.push([arr[i], arr[j], arr[k]]);
  return out;
}

interface BetTypeResults {
  win: Bucket;
  place: Map<number, Bucket>; // key: top-N
  quinella: Map<number, Bucket>; // key: box size
  exacta: Map<number, Bucket>;
  wide: Map<number, Bucket>;
  trio: Map<number, Bucket>;
  trifecta: Map<number, Bucket>;
}
function newBetTypeResults(): BetTypeResults {
  return {
    win: newBucket(),
    place: new Map(PLACE_TOP_N.map(n => [n, newBucket()])),
    quinella: new Map(BOX_SIZES.map(k => [k, newBucket()])),
    exacta: new Map(BOX_SIZES.map(k => [k, newBucket()])),
    wide: new Map(BOX_SIZES.map(k => [k, newBucket()])),
    trio: new Map(BOX_SIZES_TRIPLE.map(k => [k, newBucket()])),
    trifecta: new Map(BOX_SIZES_TRIPLE.map(k => [k, newBucket()])),
  };
}

function evaluateRaces(races: RaceGroup[]): BetTypeResults {
  const out = newBetTypeResults();

  for (const race of races) {
    const ranked = rankedEntrants(race);
    if (ranked.length === 0) continue;
    const finishRankOf = new Map(ranked.map((e, i) => [i, e.finishRank])); // modelRankIndex -> finishRank

    // 単勝：モデル1位のみ
    if (race.winPayout != null) {
      out.win.races++; out.win.cost += UNIT_STAKE;
      if (finishRankOf.get(0) === 1) { out.win.hitRaces++; addHit(out.win, race.winPayout); }
    }

    // 複勝：モデル上位1〜3位を個別に
    for (const n of PLACE_TOP_N) {
      if (ranked.length < n || race.placePayouts.length === 0) continue;
      const b = out.place.get(n)!;
      const fr = finishRankOf.get(n - 1)!;
      b.races++; b.cost += UNIT_STAKE;
      if (fr >= 1 && fr <= race.placePayouts.length) { b.hitRaces++; addHit(b, race.placePayouts[fr - 1]); }
    }

    const actual1 = ranked.findIndex(e => e.finishRank === 1);
    const actual2 = ranked.findIndex(e => e.finishRank === 2);
    const actual3 = ranked.findIndex(e => e.finishRank === 3);

    for (const K of BOX_SIZES) {
      if (ranked.length < K) continue;
      const topKIdx = Array.from({ length: K }, (_, i) => i);

      // 馬連・馬単：実際の1着・2着馬が両方ともモデル上位K頭に含まれているか
      const quinellaHit = actual1 >= 0 && actual2 >= 0 && actual1 < K && actual2 < K;
      if (race.quinellaPayout != null) {
        const b = out.quinella.get(K)!;
        b.races++; b.cost += combinations2(topKIdx).length * UNIT_STAKE;
        if (quinellaHit) { b.hitRaces++; addHit(b, race.quinellaPayout); }
      }
      if (race.exactaPayout != null) {
        const b = out.exacta.get(K)!;
        b.races++; b.cost += K * (K - 1) * UNIT_STAKE;
        if (quinellaHit) { b.hitRaces++; addHit(b, race.exactaPayout); }
      }

      // ワイド：実際の上位3頭のペアごとに判定（1レースで最大3ペア同時的中し得る）
      if (actual1 >= 0 && actual2 >= 0 && actual3 >= 0 && race.widePayouts.length > 0) {
        const b = out.wide.get(K)!;
        b.races++; b.cost += combinations2(topKIdx).length * UNIT_STAKE;
        const pairs: [number, number, number][] = [
          [actual1, actual2, 0], [actual1, actual3, 1], [actual2, actual3, 2],
        ];
        let raceHit = false;
        for (const [p, q, payoutIdx] of pairs) {
          if (p < K && q < K && race.widePayouts[payoutIdx] != null) {
            raceHit = true;
            addHit(b, race.widePayouts[payoutIdx]);
          }
        }
        if (raceHit) b.hitRaces++;
      }
    }

    // 3連複・3連単：実際の上位3頭すべてがモデル上位K頭に含まれているか（最低3頭必要）
    for (const K of BOX_SIZES_TRIPLE) {
      if (ranked.length < K || actual1 < 0 || actual2 < 0 || actual3 < 0) continue;
      const topKIdx = Array.from({ length: K }, (_, i) => i);
      const trioHit = actual1 < K && actual2 < K && actual3 < K;

      if (race.trioPayout != null) {
        const b = out.trio.get(K)!;
        b.races++; b.cost += combinations3(topKIdx).length * UNIT_STAKE;
        if (trioHit) { b.hitRaces++; addHit(b, race.trioPayout); }
      }
      if (race.trifectaPayout != null) {
        const b = out.trifecta.get(K)!;
        b.races++; b.cost += K * (K - 1) * (K - 2) * UNIT_STAKE;
        if (trioHit) { b.hitRaces++; addHit(b, race.trifectaPayout); }
      }
    }
  }

  return out;
}

function printResults(label: string, r: BetTypeResults): void {
  console.log(`\n=== ${label} ===`);
  console.log(`単勝(モデル1位): ${fmtBucket(r.win)}`);
  for (const n of PLACE_TOP_N) console.log(`複勝(モデル${n}位): ${fmtBucket(r.place.get(n)!)}`);
  for (const K of BOX_SIZES) console.log(`馬連${K}頭box: ${fmtBucket(r.quinella.get(K)!)}`);
  for (const K of BOX_SIZES) console.log(`馬単${K}頭box: ${fmtBucket(r.exacta.get(K)!)}`);
  for (const K of BOX_SIZES) console.log(`ワイド${K}頭box: ${fmtBucket(r.wide.get(K)!)}`);
  for (const K of BOX_SIZES_TRIPLE) console.log(`3連複${K}頭box: ${fmtBucket(r.trio.get(K)!)}`);
  for (const K of BOX_SIZES_TRIPLE) console.log(`3連単${K}頭box: ${fmtBucket(r.trifecta.get(K)!)}`);
}

function runWalkForward(allRecords: RaceFactRecord[]): void {
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'train=Q1 / test=Q2(4-6月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2 / test=Q3(7-9月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3 / test=Q4(10-12月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: 'train=2025通年 / test=2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];

  console.log('\n\n########## 4期間ウォークフォワード検証（有力候補のみ抜粋） ##########');
  for (const p of periods) {
    const trainRecords = allRecords.filter(p.train);
    const testRecords = allRecords.filter(p.test);
    const model = prepareModel(trainRecords, allRecords);
    const races = model.buildRaces(testRecords);
    const r = evaluateRaces(races);
    console.log(`\n=== ${p.label} ===`);
    console.log(`単勝(モデル1位): ${fmtBucket(r.win)}`);
    console.log(`複勝(モデル1位): ${fmtBucket(r.place.get(1)!)}`);
    console.log(`複勝(モデル2位): ${fmtBucket(r.place.get(2)!)}`);
    console.log(`馬連5頭box: ${fmtBucket(r.quinella.get(5)!)}`);
    console.log(`馬単5頭box: ${fmtBucket(r.exacta.get(5)!)}`);
    console.log(`ワイド4頭box: ${fmtBucket(r.wide.get(4)!)}`);
    console.log(`ワイド6頭box: ${fmtBucket(r.wide.get(6)!)}`);
    console.log(`3連複3頭box: ${fmtBucket(r.trio.get(3)!)}`);
    console.log(`3連単3頭box: ${fmtBucket(r.trifecta.get(3)!)}`);
  }
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const trainRecords = allRecords.filter(r => r.year === 2025);
  const testRecords = allRecords.filter(r => r.year === 2026);
  console.log(`train(2025): ${trainRecords.length}件 / test(2026): ${testRecords.length}件`);

  const model = prepareModel(trainRecords, allRecords);
  const races = model.buildRaces(testRecords);
  const results = evaluateRaces(races);
  printResults('train=2025通年 / test=2026', results);

  runWalkForward(allRecords);
}

main();
