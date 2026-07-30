/**
 * 既存データ(新規取得なし)だけで組める残りの組み合わせを一括で検証する。
 * 各出走馬について以下の特徴量を計算し、4期間ウォークフォワードで
 * 「残差(タイム指数×騎手係数モデルで説明できない部分)」との相関・セグメント別傾向を見る。
 *
 *   - style: 早め位置取り度合い(0=先頭寄り〜1=最後方寄り、直近走の平均)
 *   - waku: 枠番(1〜8)
 *   - classDelta: 今日のクラス階級 − 直近走のクラス階級
 *   - distanceDelta: 今日の距離 − 直近走の距離(m)
 *   - bodyWeightChange: 今回の馬体重増減(kg)
 *   - intervalDays: 直近走からの間隔(日数)。休み明け/連闘の指標。
 *   - weightRelative: 今回の斤量 − 同レース出走馬の斤量平均(kg)
 *   - oddsGap: モデル順位 − 市場人気順位(乖離ベット、参考として再掲)
 *
 * まず単変数の相関を4期間分並べ、その後に「新規」の組み合わせ(interval×体重増減、
 * interval×クラス変動、脚質×クラス変動、脚質×距離変更、脚質×枠番、斤量×クラス変動、
 * 斤量×距離変更)をセグメント別×4期間で見る。
 *
 * 総当たりに近い検証のため多重検定のリスクが高い。全4期間で符号・大きさが
 * 安定しているものだけを採用候補とする(このセッションで確立した基準)。
 *
 *   npx ts-node comboSweepDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null; odds: number | null; weight: number | null; bodyWeightChange: number | null;
  waku: number | null; earlyPositionGroup: number | null; earlyPositionGroupTotal: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry {
  dateNum: number; epochDay: number | null; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade;
  classTier: number; earlyPositionPercentile: number | null;
}

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const ALPHA_JOCKEY = 0.1;

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
// 実際の経過日数（うるう年考慮）で間隔を計算するため、年月日をUTCエポック日に変換する
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

interface Entrant {
  residual: number;
  style: number | null;
  waku: number | null;
  classDelta: number | null;
  distanceDelta: number | null;
  bodyWeightChange: number | null;
  intervalDays: number | null;
  weightRelative: number | null;
  oddsGap: number | null;
}

function computeEntrants(allRecords: RaceFactRecord[], trainFilter: (r: RaceFactRecord) => boolean, testFilter: (r: RaceFactRecord) => boolean): Entrant[] {
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

  const historyRecords = [...trainRecords, ...testRecords];
  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of historyRecords) {
    const earlyPositionPercentile =
      r.earlyPositionGroup != null && r.earlyPositionGroupTotal != null && r.earlyPositionGroupTotal > 1
        ? (r.earlyPositionGroup - 1) / (r.earlyPositionGroupTotal - 1)
        : null;
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
      classTier: extractClassTier(r.raceClassText, r.grade), earlyPositionPercentile,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);
  function lastFourBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    return list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
  }

  interface RaceGroup {
    today: { trackType: string; distance: number; classTier: number };
    entrants: { horseName: string; finishRank: number; dateNum: number; epochDay: number | null; jockeyName: string | null; odds: number | null; weight: number | null; bodyWeightChange: number | null; waku: number | null }[];
  }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = { today: { trackType: r.trackType, distance: r.distance, classTier: extractClassTier(r.raceClassText, r.grade) }, entrants: [] };
      races.set(key, race);
    }
    race.entrants.push({
      horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate),
      jockeyName: r.jockeyName, odds: r.odds, weight: r.weight, bodyWeightChange: r.bodyWeightChange, waku: r.waku,
    });
  }

  const out: Entrant[] = [];
  for (const { today, entrants } of races.values()) {
    const weightValues = entrants.map(e => e.weight).filter((w): w is number => w !== null);
    const weightMean = weightValues.length > 0 ? weightValues.reduce((s, v) => s + v, 0) / weightValues.length : null;

    const scored = entrants
      .map(e => {
        const history = lastFourBefore(e.horseName, e.dateNum);
        const timeScore = timeIndexScore(history, today, gradeOnlyStats);
        const score = timeScore == null ? null : timeScore + ALPHA_JOCKEY * jockeyZ(e.jockeyName);
        const styleValues = history.map(h => h.earlyPositionPercentile).filter((v): v is number => v !== null);
        const style = styleValues.length > 0 ? styleValues.reduce((s, v) => s + v, 0) / styleValues.length : null;
        const recent = history[0] ?? null;
        const classDelta = recent ? today.classTier - recent.classTier : null;
        const distanceDelta = recent ? today.distance - recent.distance : null;
        const intervalDays = recent && recent.epochDay != null && e.epochDay != null ? e.epochDay - recent.epochDay : null;
        return { ...e, score, style, classDelta, distanceDelta, intervalDays };
      })
      .filter((e): e is typeof e & { score: number } => e.score !== null);

    if (scored.length < 3) continue;
    const n = scored.length;
    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    const predictedOf = new Map(byScoreDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));
    const byFinishAsc = [...scored].sort((a, b) => a.finishRank - b.finishRank);
    const actualOf = new Map(byFinishAsc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));

    // 市場人気順位(オッズ昇順)。乖離ベット参考用。
    const oddsRanked = [...scored].filter(e => e.odds != null && e.odds > 0).sort((a, b) => a.odds! - b.odds!);
    const marketRankOf = new Map(oddsRanked.map((e, i) => [e.horseName + '#' + e.dateNum, i]));
    const modelRankOf = new Map(byScoreDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i]));

    for (const e of scored) {
      const id = e.horseName + '#' + e.dateNum;
      const residual = actualOf.get(id)! - predictedOf.get(id)!;
      const weightRelative = e.weight != null && weightMean != null ? e.weight - weightMean : null;
      const marketRank = marketRankOf.get(id);
      const modelRank = modelRankOf.get(id);
      const oddsGap = marketRank != null && modelRank != null ? modelRank - marketRank : null;

      out.push({
        residual, style: e.style, waku: e.waku, classDelta: e.classDelta, distanceDelta: e.distanceDelta,
        bodyWeightChange: e.bodyWeightChange, intervalDays: e.intervalDays, weightRelative, oddsGap,
      });
    }
  }
  return out;
}

function pearson(entrants: Entrant[], xOf: (e: Entrant) => number | null): { r: number; n: number } {
  const pts = entrants.map(e => ({ x: xOf(e), y: e.residual })).filter((p): p is { x: number; y: number } => p.x !== null);
  const n = pts.length;
  if (n < 30) return { r: NaN, n };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const p of pts) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; sumY2 += p.y * p.y; }
  const cov = sumXY / n - (sumX / n) * (sumY / n);
  const stdX = Math.sqrt(sumX2 / n - (sumX / n) ** 2);
  const stdY = Math.sqrt(sumY2 / n - (sumY / n) ** 2);
  return { r: cov / (stdX * stdY), n };
}

function bucket3(v: number, lowMax: number, highMin: number): -1 | 0 | 1 {
  if (v <= lowMax) return -1;
  if (v >= highMin) return 1;
  return 0;
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'Q1→Q2', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'Q1-Q2→Q3', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'Q1-Q3→Q4', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: '2025→2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];

  const entrantsByPeriod = periods.map(p => ({ label: p.label, entrants: computeEntrants(allRecords, p.train, p.test) }));

  console.log('=== 単変数の相関(残差との) ===');
  const singleVars: { name: string; xOf: (e: Entrant) => number | null }[] = [
    { name: 'style(脚質傾向)', xOf: e => e.style },
    { name: 'waku(枠番)', xOf: e => e.waku },
    { name: 'classDelta(クラス変動)', xOf: e => e.classDelta },
    { name: 'distanceDelta(距離変更,100m単位)', xOf: e => e.distanceDelta != null ? e.distanceDelta / 100 : null },
    { name: 'bodyWeightChange(馬体重増減)', xOf: e => e.bodyWeightChange },
    { name: 'intervalDays(間隔,週単位)', xOf: e => e.intervalDays != null ? e.intervalDays / 7 : null },
    { name: 'weightRelative(斤量-レース平均)', xOf: e => e.weightRelative },
    { name: 'oddsGap(モデル順位-市場順位、参考)', xOf: e => e.oddsGap },
  ];
  for (const v of singleVars) {
    const line = entrantsByPeriod.map(p => {
      const { r, n } = pearson(p.entrants, v.xOf);
      return `${p.label}:${isNaN(r) ? 'N/A' : r.toFixed(4)}(n=${n})`;
    }).join('  ');
    console.log(`${v.name.padEnd(30)}: ${line}`);
  }

  // === 距離変更 × 間隔 のグリッド(4期間) ===
  function intervalBucket(days: number): -1 | 0 | 1 {
    if (days <= 21) return -1; // 連闘〜3週以内
    if (days >= 90) return 1; // 3ヶ月以上の休み明け
    return 0;
  }
  const distLabels: Record<number, string> = { [-1]: '短縮(-200m以下)', 0: '変化小', 1: '延長(+200m以上)' };
  const intervalLabels: Record<number, string> = { [-1]: '短間隔(〜21日)', 0: '通常(22-89日)', 1: '休み明け(90日〜)' };

  console.log('\n=== 距離変更 × 間隔：平均残差(負=好走寄り) ===');
  for (const p of entrantsByPeriod) {
    console.log(`--- ${p.label} ---`);
    const grid = new Map<string, { sum: number; count: number }>();
    for (const e of p.entrants) {
      if (e.distanceDelta == null || e.intervalDays == null) continue;
      const key = `${bucket3(e.distanceDelta, -200, 200)}|${intervalBucket(e.intervalDays)}`;
      const cell = grid.get(key) ?? { sum: 0, count: 0 };
      cell.sum += e.residual; cell.count++;
      grid.set(key, cell);
    }
    for (const dd of [-1, 0, 1] as const) {
      const row = [-1, 0, 1].map(ib => {
        const cell = grid.get(`${dd}|${ib}`);
        return cell ? `${(cell.sum / cell.count).toFixed(4)}(n=${cell.count})` : 'N/A';
      });
      console.log(`  ${distLabels[dd].padEnd(16)}: ${row.join('  /  ')}`);
    }
  }
  console.log(`  (列は左から ${intervalLabels[-1]} / ${intervalLabels[0]} / ${intervalLabels[1]})`);
}

main();
