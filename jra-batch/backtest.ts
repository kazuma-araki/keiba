/**
 * 現行モデル(グレードのみで基準タイムを分割)・クラス分割モデル・素の自己ベストタイムの
 * 3パターンで、race_facts_*.jsonl の実際の着順に対する的中率を検証する。
 *
 * 【学習/検証分割】
 * 基準タイム(秒/mの平均・分散)は --train で指定した年のみから計算し、
 * --test で指定した年のレースに対してのみ予測・採点する（未来のデータを使って
 * 過去を当てる、というリークを避けるため）。
 *
 * 各出走馬の「直近4走」は、対象レースの日付より前の全履歴(train+test合算)から
 * 動的に組み立てる。これは実運用で出馬表に載っている「過去4走」をそのまま入力する
 * 状況を模している。
 *
 * 【実行方法】
 *   npx ts-node backtest.ts                       （train=2025, test=2026）
 *   npx ts-node backtest.ts --train=2024,2025 --test=2026
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number;
  kaisai: number;
  day: number;
  raceNumber: number;
  location: string;
  raceDate: string;
  distance: number;
  trackType: string;
  condition: string;
  raceClassText: string;
  grade: RaceGrade;
  raceLast3F: number | null;
  horseName: string;
  finishRank: number;
  timeStr: string;
  totalSeconds: number;
}

interface BaselineStats {
  count: number;
  mean: number;
  variance: number;
}

interface HistoryEntry {
  dateNum: number;
  secondsPerMeter: number;
  location: string;
  trackType: string;
  distance: number;
  condition: string;
  grade: RaceGrade;
  classTier: number;
}

interface TodayCondition {
  trackType: string;
  distance: number;
}

// raceWeighting.ts と同じ重み付け定数（jra-batchは他プロジェクトに依存しない
// 自己完結設計のため、小さな重み付けロジックをここに複製している）
const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;

function recencyWeight(slotIndex: number): number {
  return RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
}
function reliabilityWeight(sampleCount: number | null): number {
  if (sampleCount == null) return 0;
  return Math.min(1, sampleCount / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
}
function surfaceMatchWeight(entryTrackType: string, today: TodayCondition): number {
  return entryTrackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
}
function distanceMatchWeight(entryDistance: number, today: TodayCondition): number {
  const diff = Math.abs(entryDistance - today.distance);
  return Math.max(MIN_DISTANCE_WEIGHT, 1 - diff * DISTANCE_DECAY_PER_METER);
}

function parseArgs(argv: string[]): { trainYears: number[]; testYears: number[] } {
  const parseYearsFlag = (flag: string, fallback: number[]): number[] => {
    const arg = argv.find(a => a.startsWith(flag));
    if (!arg) return fallback;
    return arg
      .slice(flag.length)
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  };
  return {
    trainYears: parseYearsFlag('--train=', [2025]),
    testYears: parseYearsFlag('--test=', [2026]),
  };
}

function loadRecords(years: number[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const year of years) {
    const file = path.join(__dirname, `race_facts_${year}.jsonl`);
    if (!fs.existsSync(file)) {
      console.warn(`見つからないためスキップ: ${file}`);
      continue;
    }
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      const r: RaceFactRecord = JSON.parse(line);
      if (r.distance > 0 && r.condition !== '不明' && r.totalSeconds > 0) records.push(r);
    }
  }
  return records;
}

function dateToNum(raceDate: string): number {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
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

// --- グレードのみで分割した基準タイム（現行モデル相当） ---
function gradeOnlyKey(loc: string, trackType: string, distance: number, condition: string, grade: RaceGrade): string {
  return `${loc}|${trackType}|${distance}|${condition}|${grade ?? 'NONE'}`;
}
function buildGradeOnlyStats(trainRecords: RaceFactRecord[]): Record<string, BaselineStats> {
  const grouped = new Map<string, number[]>();
  for (const r of trainRecords) {
    const key = gradeOnlyKey(r.location, r.trackType, r.distance, r.condition, r.grade);
    const spm = r.totalSeconds / r.distance;
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(spm);
  }
  const out: Record<string, BaselineStats> = {};
  for (const [k, v] of grouped) out[k] = computeStats(v);
  return out;
}
function lookupGradeOnly(
  stats: Record<string, BaselineStats>,
  loc: string, trackType: string, distance: number, condition: string, grade: RaceGrade
): BaselineStats | null {
  const exact = stats[gradeOnlyKey(loc, trackType, distance, condition, grade)];
  if (exact) return exact;
  if (grade !== null) {
    const fallback = stats[gradeOnlyKey(loc, trackType, distance, condition, null)];
    if (fallback) return fallback;
  }
  return null;
}

// --- グレード＋クラス階級で分割した基準タイム（クラス分割モデル） ---
function classKey(loc: string, trackType: string, distance: number, condition: string, grade: RaceGrade, classTier: number): string {
  return `${loc}|${trackType}|${distance}|${condition}|${grade ?? 'NONE'}|${classTier}`;
}
function buildClassStats(trainRecords: RaceFactRecord[]): Record<string, BaselineStats> {
  const grouped = new Map<string, number[]>();
  for (const r of trainRecords) {
    const tier = extractClassTier(r.raceClassText, r.grade);
    const key = classKey(r.location, r.trackType, r.distance, r.condition, r.grade, tier);
    const spm = r.totalSeconds / r.distance;
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(spm);
  }
  const out: Record<string, BaselineStats> = {};
  for (const [k, v] of grouped) out[k] = computeStats(v);
  return out;
}
function lookupClass(
  stats: Record<string, BaselineStats>,
  gradeOnlyStats: Record<string, BaselineStats>,
  loc: string, trackType: string, distance: number, condition: string, grade: RaceGrade, classTier: number
): BaselineStats | null {
  const exact = stats[classKey(loc, trackType, distance, condition, grade, classTier)];
  if (exact) return exact;
  if (grade !== null) {
    const relaxGrade = stats[classKey(loc, trackType, distance, condition, null, classTier)];
    if (relaxGrade) return relaxGrade;
  }
  // クラス階級でも見つからない薄いバケツは、グレードのみの基準にフォールバックする
  return lookupGradeOnly(gradeOnlyStats, loc, trackType, distance, condition, grade);
}

function speedIndexOf(stats: BaselineStats | null, secondsPerMeter: number): { speedIndex: number; sampleCount: number } | null {
  if (!stats || stats.variance <= 0) return null;
  return { speedIndex: (stats.mean - secondsPerMeter) / Math.sqrt(stats.variance), sampleCount: stats.count };
}

function weightedScore(
  entries: HistoryEntry[],
  today: TodayCondition,
  lookup: (e: HistoryEntry) => { speedIndex: number; sampleCount: number } | null
): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  entries.forEach((entry, slotIndex) => {
    const result = lookup(entry);
    if (!result) return;
    const weight =
      recencyWeight(slotIndex) *
      reliabilityWeight(result.sampleCount) *
      surfaceMatchWeight(entry.trackType, today) *
      distanceMatchWeight(entry.distance, today);
    weightedSum += weight * result.speedIndex;
    weightSum += weight;
  });
  if (weightSum <= 0) return null;
  return weightedSum / weightSum;
}

interface RaceEntrant {
  horseName: string;
  finishRank: number;
  dateNum: number;
}

interface ModelMetrics {
  totalRaces: number;
  racesWithPrediction: number;
  totalHorses: number;
  scoredHorses: number;
  winHits: number;
  placeHits: number;
  spearmanSum: number;
  spearmanRaceCount: number;
}

function emptyMetrics(): ModelMetrics {
  return { totalRaces: 0, racesWithPrediction: 0, totalHorses: 0, scoredHorses: 0, winHits: 0, placeHits: 0, spearmanSum: 0, spearmanRaceCount: 0 };
}

function spearman(predictedRanks: number[], actualRanks: number[]): number {
  const n = predictedRanks.length;
  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    const d = predictedRanks[i] - actualRanks[i];
    sumSqDiff += d * d;
  }
  return 1 - (6 * sumSqDiff) / (n * (n * n - 1));
}

function evaluateRace(
  entrants: RaceEntrant[],
  scoreOf: (horseName: string, dateNum: number) => number | null,
  metrics: ModelMetrics
): void {
  metrics.totalRaces++;
  metrics.totalHorses += entrants.length;

  const scored = entrants
    .map(e => ({ ...e, score: scoreOf(e.horseName, e.dateNum) }))
    .filter((e): e is RaceEntrant & { score: number } => e.score !== null);

  metrics.scoredHorses += scored.length;
  if (scored.length === 0) return;

  metrics.racesWithPrediction++;
  const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
  const predictedWinner = byScoreDesc[0];
  if (predictedWinner.finishRank === 1) metrics.winHits++;
  if (predictedWinner.finishRank <= 3) metrics.placeHits++;

  if (scored.length >= 2) {
    const predictedRanks = byScoreDesc.map((_, i) => i + 1);
    const actualOrder = [...byScoreDesc].sort((a, b) => a.finishRank - b.finishRank);
    const actualRankOf = new Map(actualOrder.map((e, i) => [e.horseName + '#' + e.dateNum, i + 1]));
    const actualRanks = byScoreDesc.map(e => actualRankOf.get(e.horseName + '#' + e.dateNum)!);
    metrics.spearmanSum += spearman(predictedRanks, actualRanks);
    metrics.spearmanRaceCount++;
  }
}

function printMetrics(label: string, m: ModelMetrics): void {
  const winRate = m.racesWithPrediction > 0 ? (m.winHits / m.racesWithPrediction) * 100 : 0;
  const placeRate = m.racesWithPrediction > 0 ? (m.placeHits / m.racesWithPrediction) * 100 : 0;
  const meanSpearman = m.spearmanRaceCount > 0 ? m.spearmanSum / m.spearmanRaceCount : 0;
  const raceCoverage = m.totalRaces > 0 ? (m.racesWithPrediction / m.totalRaces) * 100 : 0;
  const horseCoverage = m.totalHorses > 0 ? (m.scoredHorses / m.totalHorses) * 100 : 0;
  console.log(`\n--- ${label} ---`);
  console.log(`単勝的中率(予測1位=1着):   ${winRate.toFixed(2)}%  (${m.winHits}/${m.racesWithPrediction})`);
  console.log(`複勝的中率(予測1位が3着内): ${placeRate.toFixed(2)}%  (${m.placeHits}/${m.racesWithPrediction})`);
  console.log(`平均スピアマン相関:         ${meanSpearman.toFixed(4)}  (n=${m.spearmanRaceCount}レース)`);
  console.log(`レースカバレッジ:           ${raceCoverage.toFixed(1)}%  (${m.racesWithPrediction}/${m.totalRaces})`);
  console.log(`馬カバレッジ:               ${horseCoverage.toFixed(1)}%  (${m.scoredHorses}/${m.totalHorses})`);
}

function main(): void {
  const { trainYears, testYears } = parseArgs(process.argv.slice(2));
  console.log(`=== バックテスト: train=[${trainYears.join(',')}] test=[${testYears.join(',')}] ===`);

  const allYears = Array.from(new Set([...trainYears, ...testYears]));
  const allRecords = loadRecords(allYears);
  const trainRecords = allRecords.filter(r => trainYears.includes(r.year));
  const testRecords = allRecords.filter(r => testYears.includes(r.year));

  console.log(`学習用レコード数: ${trainRecords.length} / 検証用レコード数: ${testRecords.length}`);

  const gradeOnlyStats = buildGradeOnlyStats(trainRecords);
  const classStats = buildClassStats(trainRecords);
  console.log(`基準バケツ数: グレードのみ=${Object.keys(gradeOnlyStats).length} / クラス分割=${Object.keys(classStats).length}`);

  // horseName → 日付昇順の過去走履歴（train+test合算）
  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of allRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate),
      secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location,
      trackType: r.trackType,
      distance: r.distance,
      condition: r.condition,
      grade: r.grade,
      classTier: extractClassTier(r.raceClassText, r.grade),
    };
    const list = horseHistory.get(r.horseName);
    if (list) list.push(entry);
    else horseHistory.set(r.horseName, [entry]);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);

  function lastFourBefore(horseName: string, dateNum: number): HistoryEntry[] {
    const list = horseHistory.get(horseName);
    if (!list) return [];
    const before = list.filter(e => e.dateNum < dateNum);
    return before.slice(-4).reverse(); // 直近が先頭(slotIndex 0)
  }

  // test年のレコードをレース単位にグルーピング
  const races = new Map<string, { today: TodayCondition; entrants: RaceEntrant[] }>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] };
      races.set(key, race);
    }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate) });
  }

  const gradeOnlyMetrics = emptyMetrics();
  const classMetrics = emptyMetrics();
  const naiveMetrics = emptyMetrics();

  for (const { today, entrants } of races.values()) {
    evaluateRace(entrants, (horseName, dateNum) => {
      const history = lastFourBefore(horseName, dateNum);
      return weightedScore(history, today, e =>
        speedIndexOf(lookupGradeOnly(gradeOnlyStats, e.location, e.trackType, e.distance, e.condition, e.grade), e.secondsPerMeter)
      );
    }, gradeOnlyMetrics);

    evaluateRace(entrants, (horseName, dateNum) => {
      const history = lastFourBefore(horseName, dateNum);
      return weightedScore(history, today, e =>
        speedIndexOf(lookupClass(classStats, gradeOnlyStats, e.location, e.trackType, e.distance, e.condition, e.grade, e.classTier), e.secondsPerMeter)
      );
    }, classMetrics);

    evaluateRace(entrants, (horseName, dateNum) => {
      const history = lastFourBefore(horseName, dateNum);
      if (history.length === 0) return null;
      const best = Math.min(...history.map(e => e.secondsPerMeter));
      return -best; // 小さい秒/mほど速い＝良い、なので符号反転してスコア化
    }, naiveMetrics);
  }

  printMetrics('現行モデル(グレードのみで基準分割)', gradeOnlyMetrics);
  printMetrics('クラス分割モデル(グレード＋クラス階級で基準分割)', classMetrics);
  printMetrics('素の自己ベストタイム(正規化なし)', naiveMetrics);

  const outPath = path.join(__dirname, 'backtest_results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    trainYears, testYears,
    gradeOnly: gradeOnlyMetrics,
    classTier: classMetrics,
    naive: naiveMetrics,
  }, null, 2));
  console.log(`\n結果を保存しました: ${outPath}`);
}

main();
