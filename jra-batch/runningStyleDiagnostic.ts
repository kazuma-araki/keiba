/**
 * 「脚質」仮説の軽量診断(まずは単純な仮説のみ): 各馬の過去走から求めた
 * 「早め位置取り度合い」(0=先頭寄り, 1=最後方寄り; 最初に追跡されたコーナーでの
 * 順位グループを基に算出)の直近傾向が、現行モデル(タイム指数+騎手係数)の
 * 予測誤差(残差)と相関するかどうかを、classChangeDiagnostic.ts/jockeyDiagnostic.tsと
 * 同じ手法(残差相関・4期間ウォークフォワード)で確認する。
 *
 * ここで意味のある相関が見えなければ、より複雑な「展開」(レース全体の脚質構成から
 * ペースを予測し、脚質との相性を見る)には進まない(計画のステップ7参照)。
 *
 *   npx ts-node runningStyleDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null;
  earlyPositionGroup: number | null; earlyPositionGroupTotal: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry {
  dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade;
  earlyPositionPercentile: number | null;
}

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;
const ALPHA_JOCKEY = 0.1; // jockeyBlendBacktest.tsで検証済みの値

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

interface PeriodResult { pearson: number; n: number; buckets: Map<number, { residualSum: number; actualSum: number; count: number }>; }

function evaluatePeriod(
  allRecords: RaceFactRecord[],
  trainFilter: (r: RaceFactRecord) => boolean,
  testFilter: (r: RaceFactRecord) => boolean
): PeriodResult {
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
      dateNum: dateToNum(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
      earlyPositionPercentile,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);
  function lastFourBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    return list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
  }
  function runningStyleTendency(history: HistoryEntry[]): number | null {
    const values = history.map(h => h.earlyPositionPercentile).filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    return values.reduce((s, v) => s + v, 0) / values.length;
  }

  interface RaceGroup {
    today: { trackType: string; distance: number };
    entrants: { horseName: string; finishRank: number; dateNum: number; jockeyName: string | null }[];
  }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] };
      races.set(key, race);
    }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), jockeyName: r.jockeyName });
  }

  const buckets = new Map<number, { residualSum: number; actualSum: number; count: number }>();
  let pearsonN = 0, sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => {
        const history = lastFourBefore(e.horseName, e.dateNum);
        const timeScore = timeIndexScore(history, today, gradeOnlyStats);
        const score = timeScore == null ? null : timeScore + ALPHA_JOCKEY * jockeyZ(e.jockeyName);
        const style = runningStyleTendency(history);
        return { ...e, score, style };
      })
      .filter((e): e is typeof e & { score: number; style: number } => e.score !== null && e.style !== null);

    if (scored.length < 3) continue;

    const n = scored.length;
    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    const predictedPercentileOf = new Map(byScoreDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));
    const byFinishAsc = [...scored].sort((a, b) => a.finishRank - b.finishRank);
    const actualPercentileOf = new Map(byFinishAsc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));

    for (const e of scored) {
      const id = e.horseName + '#' + e.dateNum;
      const predicted = predictedPercentileOf.get(id)!;
      const actual = actualPercentileOf.get(id)!;
      const residual = actual - predicted;

      const quintile = Math.min(4, Math.floor(e.style * 5));
      const bucket = buckets.get(quintile) ?? { residualSum: 0, actualSum: 0, count: 0 };
      bucket.residualSum += residual;
      bucket.actualSum += actual;
      bucket.count++;
      buckets.set(quintile, bucket);

      const x = e.style;
      const y = residual;
      pearsonN++; sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y;
    }
  }

  const cov = sumXY / pearsonN - (sumX / pearsonN) * (sumY / pearsonN);
  const stdX = Math.sqrt(sumX2 / pearsonN - (sumX / pearsonN) ** 2);
  const stdY = Math.sqrt(sumY2 / pearsonN - (sumY / pearsonN) ** 2);
  const pearson = cov / (stdX * stdY);
  return { pearson, n: pearsonN, buckets };
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'train=Q1 / test=Q2(4-6月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2 / test=Q3(7-9月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3 / test=Q4(10-12月)', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: 'train=2025通年 / test=2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];

  const labels: Record<number, string> = { 0: '0-20%(先頭寄り)', 1: '20-40%', 2: '40-60%', 3: '60-80%', 4: '80-100%(最後方寄り)' };
  const results = periods.map(p => ({ label: p.label, result: evaluatePeriod(allRecords, p.train, p.test) }));

  for (const { label, result } of results) {
    console.log(`\n=== ${label} (n=${result.n}) ===`);
    console.log('早め位置取り度合いの階級 | 件数 | 平均残差(負=好走寄り) | 平均実着順パーセンタイル');
    for (let q = 0; q <= 4; q++) {
      const b = result.buckets.get(q);
      if (!b) continue;
      console.log(`${labels[q].padEnd(20)} | ${b.count} | ${(b.residualSum / b.count).toFixed(4)} | ${(b.actualSum / b.count).toFixed(4)}`);
    }
    console.log(`ピアソン相関係数: ${result.pearson.toFixed(4)}`);
  }

  console.log('\n=== まとめ ===');
  for (const { label, result } of results) {
    console.log(`${label}: r=${result.pearson.toFixed(4)} (n=${result.n})`);
  }
  console.log('(正の相関 = 早め位置取りの馬ほど予想より凡走しがち = 逃げ・先行馬は苦戦しやすい傾向)');
  console.log('(負の相関 = 早め位置取りの馬ほど予想より好走しがち = 逃げ・先行馬が有利な傾向)');
}

main();
