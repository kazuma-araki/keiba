/**
 * 「騎手」仮説の軽量診断: train期間の騎手勝率が、現行モデル(タイム指数)の
 * 予測誤差(残差)と相関するかどうかを、4つの独立した期間でウォークフォワード
 * 確認する(単一期間の結果はこれまで何度も再現しなかったため)。
 * classChangeDiagnostic.ts / selectiveBetWalkForward.ts と同じ手法・期間区切りを流用。
 *
 * 「上手い騎手は強い馬に乗る」という交絡を避けるため、単純に
 * 「騎手の勝率」と「実際の着順」を相関させるのではなく、必ず
 * タイム指数モデルの予測順位パーセンタイルとの残差(=タイム指数だけでは
 * 説明できない部分)を使う。騎乗数がMIN_RIDES未満の騎手は勝率が
 * 統計的に不安定なため除外する。
 *
 *   npx ts-node jockeyDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const MIN_RIDES = 30;

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
function weightedScore(entries: HistoryEntry[], today: { trackType: string; distance: number }, stats: Record<string, BaselineStats>): number | null {
  let weightedSum = 0, weightSum = 0;
  entries.forEach((e, slotIndex) => {
    const result = speedIndexOf(lookupGradeOnly(stats, e.location, e.trackType, e.distance, e.condition, e.grade), e.secondsPerMeter);
    if (!result) return;
    const recency = RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
    const reliability = result.sampleCount == null ? 0 : Math.min(1, result.sampleCount / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
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

  // 騎手勝率はこの期間のtrainRecordsだけから集計する(未来情報の混入を防ぐ)
  const jockeyStats = new Map<string, { rides: number; wins: number }>();
  for (const r of trainRecords) {
    if (!r.jockeyName || !(r.finishRank > 0)) continue;
    const g = jockeyStats.get(r.jockeyName) ?? { rides: 0, wins: 0 };
    g.rides++;
    if (r.finishRank === 1) g.wins++;
    jockeyStats.set(r.jockeyName, g);
  }

  // horseHistoryはtrain+testの全期間の中から、日付が今日より前のものだけを使う
  const historyRecords = [...trainRecords, ...testRecords];
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
        const score = weightedScore(history, today, gradeOnlyStats);
        const js = e.jockeyName ? jockeyStats.get(e.jockeyName) : undefined;
        const jockeyWinRate = js && js.rides >= MIN_RIDES ? js.wins / js.rides : null;
        return { ...e, score, jockeyWinRate };
      })
      .filter((e): e is typeof e & { score: number; jockeyWinRate: number } => e.score !== null && e.jockeyWinRate !== null);

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

      const quintile = e.jockeyWinRate < 0.05 ? 0 : e.jockeyWinRate < 0.10 ? 1 : e.jockeyWinRate < 0.15 ? 2 : e.jockeyWinRate < 0.20 ? 3 : 4;
      const bucket = buckets.get(quintile) ?? { residualSum: 0, actualSum: 0, count: 0 };
      bucket.residualSum += residual;
      bucket.actualSum += actual;
      bucket.count++;
      buckets.set(quintile, bucket);

      const x = e.jockeyWinRate;
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

  const labels: Record<number, string> = { 0: '0-5%', 1: '5-10%', 2: '10-15%', 3: '15-20%', 4: '20%+' };
  const results = periods.map(p => ({ label: p.label, result: evaluatePeriod(allRecords, p.train, p.test) }));

  for (const { label, result } of results) {
    console.log(`\n=== ${label} (n=${result.n}) ===`);
    console.log('勝率帯    | 件数 | 平均残差(負=好走寄り) | 平均実着順パーセンタイル');
    for (let q = 0; q <= 4; q++) {
      const b = result.buckets.get(q);
      if (!b) continue;
      console.log(`${labels[q].padEnd(9)} | ${b.count} | ${(b.residualSum / b.count).toFixed(4)} | ${(b.actualSum / b.count).toFixed(4)}`);
    }
    console.log(`ピアソン相関係数: ${result.pearson.toFixed(4)}`);
  }

  console.log('\n=== まとめ ===');
  for (const { label, result } of results) {
    console.log(`${label}: r=${result.pearson.toFixed(4)} (n=${result.n})`);
  }
  console.log('(全期間で負の相関が安定して出れば、騎手勝率に交絡を除いた予測力ありと判断できる)');
}

main();
