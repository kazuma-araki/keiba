/**
 * 「馬体重増減 × クラス変動/距離変更」仮説の診断: 単体では(このセッションの過去の
 * 検証で)クラス変動自体は残差と相関しなかったが、「クラスが上がる馬が馬体重を
 * 増やして(絞れず)きた」「距離短縮に合わせて絞ってきた」等、組み合わせて初めて
 * 見える効果がないかを確認する。
 *
 * クラス変動(classDelta: 今日のクラス階級 - 直近走のクラス階級)と、今回の馬体重増減
 * (bodyWeightChange)を、それぞれ3階級(減量/変化なし/増量、降級/同級/昇級)に分けた
 * 3×3のマスごとに、現行モデル(タイム指数×騎手係数)の残差の平均を見る。
 * 距離変更(今日の距離 - 直近走の距離)についても同様の3×3マスを別途見る。
 *
 *   npx ts-node bodyWeightClassDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null; bodyWeightChange: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry {
  dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade;
  classTier: number;
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

function weightBucket(kg: number): -1 | 0 | 1 {
  if (kg <= -6) return -1;
  if (kg >= 6) return 1;
  return 0;
}
function classDeltaBucket(delta: number): -1 | 0 | 1 {
  if (delta < 0) return -1;
  if (delta > 0) return 1;
  return 0;
}
function distanceDeltaBucket(delta: number): -1 | 0 | 1 {
  if (delta <= -200) return -1;
  if (delta >= 200) return 1;
  return 0;
}

interface Cell { residualSum: number; count: number; }
function newCell(): Cell { return { residualSum: 0, count: 0 }; }

function evaluatePeriod(allRecords: RaceFactRecord[], trainFilter: (r: RaceFactRecord) => boolean, testFilter: (r: RaceFactRecord) => boolean): { classWeightGrid: Map<string, Cell>; distanceWeightGrid: Map<string, Cell> } {
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
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
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

  interface RaceGroup {
    today: { trackType: string; distance: number; classTier: number };
    entrants: { horseName: string; finishRank: number; dateNum: number; jockeyName: string | null; bodyWeightChange: number | null }[];
  }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = { today: { trackType: r.trackType, distance: r.distance, classTier: extractClassTier(r.raceClassText, r.grade) }, entrants: [] };
      races.set(key, race);
    }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), jockeyName: r.jockeyName, bodyWeightChange: r.bodyWeightChange });
  }

  const classWeightGrid = new Map<string, Cell>(); // key: `${classDeltaBucket}|${weightBucket}`
  const distanceWeightGrid = new Map<string, Cell>(); // key: `${distanceDeltaBucket}|${weightBucket}`

  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => {
        const history = lastFourBefore(e.horseName, e.dateNum);
        const timeScore = timeIndexScore(history, today, gradeOnlyStats);
        const score = timeScore == null ? null : timeScore + ALPHA_JOCKEY * jockeyZ(e.jockeyName);
        const recent = history[0] ?? null;
        return { ...e, score, recentClassTier: recent?.classTier ?? null, recentDistance: recent?.distance ?? null };
      })
      .filter((e): e is typeof e & { score: number; recentClassTier: number; recentDistance: number; bodyWeightChange: number } =>
        e.score !== null && e.recentClassTier !== null && e.recentDistance !== null && e.bodyWeightChange !== null);

    if (scored.length < 3) continue;
    const n = scored.length;
    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    const predictedOf = new Map(byScoreDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));
    const byFinishAsc = [...scored].sort((a, b) => a.finishRank - b.finishRank);
    const actualOf = new Map(byFinishAsc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));

    for (const e of scored) {
      const id = e.horseName + '#' + e.dateNum;
      const residual = actualOf.get(id)! - predictedOf.get(id)!;

      const cKey = `${classDeltaBucket(today.classTier - e.recentClassTier)}|${weightBucket(e.bodyWeightChange)}`;
      const cCell = classWeightGrid.get(cKey) ?? newCell();
      cCell.residualSum += residual; cCell.count++;
      classWeightGrid.set(cKey, cCell);

      const dKey = `${distanceDeltaBucket(today.distance - e.recentDistance)}|${weightBucket(e.bodyWeightChange)}`;
      const dCell = distanceWeightGrid.get(dKey) ?? newCell();
      dCell.residualSum += residual; dCell.count++;
      distanceWeightGrid.set(dKey, dCell);
    }
  }

  return { classWeightGrid, distanceWeightGrid };
}

const classLabels: Record<number, string> = { [-1]: '降級', 0: '同級', 1: '昇級' };
const distLabels: Record<number, string> = { [-1]: '距離短縮(-200m以下)', 0: '距離変化小', 1: '距離延長(+200m以上)' };

function fmtCell(cell: Cell | undefined): string {
  return cell ? `${(cell.residualSum / cell.count).toFixed(4)}(n=${cell.count})` : 'N/A';
}

function printGrids(label: string, grids: { classWeightGrid: Map<string, Cell>; distanceWeightGrid: Map<string, Cell> }): void {
  console.log(`\n=== ${label} ===`);
  console.log('[クラス変動 × 馬体重増減]  減量 / 変化なし / 増量');
  for (const cd of [-1, 0, 1] as const) {
    const row = [-1, 0, 1].map(wb => fmtCell(grids.classWeightGrid.get(`${cd}|${wb}`)));
    console.log(`${classLabels[cd].padEnd(6)}: ${row.join('  /  ')}`);
  }
  console.log('[距離変更 × 馬体重増減]  減量 / 変化なし / 増量');
  for (const dd of [-1, 0, 1] as const) {
    const row = [-1, 0, 1].map(wb => fmtCell(grids.distanceWeightGrid.get(`${dd}|${wb}`)));
    console.log(`${distLabels[dd].padEnd(20)}: ${row.join('  /  ')}`);
  }
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

  for (const p of periods) {
    const grids = evaluatePeriod(allRecords, p.train, p.test);
    printGrids(p.label, grids);
  }
}

main();
