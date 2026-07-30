/**
 * runningStyleDiagnostic.tsで見た「早め位置取り度合い」と残差の相関が、プールした
 * 全体では弱く不安定だったため、トラック種別(芝/ダート)・馬場状態・距離帯で
 * 切り分けても同じか、特定の条件でだけ強く出るかを確認する。
 * 切り口はすべてレース前から分かる属性（結果を見て後から選んだものではない）。
 *
 *   npx ts-node runningStyleSegmentation.ts
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

interface ScoredEntrant {
  horseName: string; finishRank: number; dateNum: number;
  trackType: string; condition: string; distance: number;
  residual: number; style: number;
}

function computeScoredEntrants(allRecords: RaceFactRecord[], trainYears: number[], testYears: number[]): ScoredEntrant[] {
  const trainRecords = allRecords.filter(r => trainYears.includes(r.year));
  const testRecords = allRecords.filter(r => testYears.includes(r.year));
  return computeScoredEntrantsFromSplit(allRecords, trainRecords, testRecords);
}

function computeScoredEntrantsFromSplit(allRecords: RaceFactRecord[], trainRecords: RaceFactRecord[], testRecords: RaceFactRecord[]): ScoredEntrant[] {
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
    today: { trackType: string; distance: number; condition: string };
    entrants: { horseName: string; finishRank: number; dateNum: number; jockeyName: string | null }[];
  }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = { today: { trackType: r.trackType, distance: r.distance, condition: r.condition }, entrants: [] };
      races.set(key, race);
    }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), jockeyName: r.jockeyName });
  }

  const out: ScoredEntrant[] = [];
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
      out.push({
        horseName: e.horseName, finishRank: e.finishRank, dateNum: e.dateNum,
        trackType: today.trackType, condition: today.condition, distance: today.distance,
        residual: actual - predicted, style: e.style,
      });
    }
  }
  return out;
}

function pearson(entrants: ScoredEntrant[]): { r: number; n: number } {
  const n = entrants.length;
  if (n < 30) return { r: NaN, n };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const e of entrants) {
    sumX += e.style; sumY += e.residual; sumXY += e.style * e.residual;
    sumX2 += e.style * e.style; sumY2 += e.residual * e.residual;
  }
  const cov = sumXY / n - (sumX / n) * (sumY / n);
  const stdX = Math.sqrt(sumX2 / n - (sumX / n) ** 2);
  const stdY = Math.sqrt(sumY2 / n - (sumY / n) ** 2);
  return { r: cov / (stdX * stdY), n };
}

function distanceBucket(d: number): string {
  if (d <= 1400) return '短距離(〜1400m)';
  if (d <= 1800) return 'マイル(1401-1800m)';
  if (d <= 2200) return '中距離(1801-2200m)';
  return '長距離(2201m〜)';
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const entrants = computeScoredEntrants(allRecords, [2025], [2026]);
  console.log(`全体(train=2025/test=2026): ${JSON.stringify(pearson(entrants))}`);

  console.log('\n--- トラック種別 ---');
  for (const t of ['芝', 'ダ', '障害']) {
    const subset = entrants.filter(e => e.trackType === t);
    console.log(`${t}: r=${pearson(subset).r.toFixed(4)} (n=${subset.length})`);
  }

  console.log('\n--- 馬場状態 ---');
  for (const c of ['良', '稍重', '重', '不良']) {
    const subset = entrants.filter(e => e.condition === c);
    console.log(`${c}: r=${pearson(subset).r.toFixed(4)} (n=${subset.length})`);
  }

  console.log('\n--- 距離帯 ---');
  for (const bucket of ['短距離(〜1400m)', 'マイル(1401-1800m)', '中距離(1801-2200m)', '長距離(2201m〜)']) {
    const subset = entrants.filter(e => distanceBucket(e.distance) === bucket);
    console.log(`${bucket}: r=${pearson(subset).r.toFixed(4)} (n=${subset.length})`);
  }

  console.log('\n--- トラック種別 × 馬場状態（クロス） ---');
  for (const t of ['芝', 'ダ']) {
    for (const c of ['良', '稍重', '重', '不良']) {
      const subset = entrants.filter(e => e.trackType === t && e.condition === c);
      if (subset.length < 30) continue;
      console.log(`${t}×${c}: r=${pearson(subset).r.toFixed(4)} (n=${subset.length})`);
    }
  }
}

main();

// ダ×良でr=-0.08と目立った値が出たが、n=402と小さく、8通りの組み合わせを総当たりした
// 中の1つのため、以前の施策(クラス変動・トラック変動等)と同様「たまたま良く見えるだけ」の
// 可能性が高い。4期間で再現するか確認する（再現しなければ不採用）。
function computeScoredEntrantsByFilter(
  allRecords: RaceFactRecord[],
  trainFilter: (r: RaceFactRecord) => boolean,
  testFilter: (r: RaceFactRecord) => boolean
): ScoredEntrant[] {
  // computeScoredEntrantsのyearベースのtrain/test分けをフィルタ関数ベースに置き換えた版。
  // ロジックは同一（このファイル内でコピーすると重複が大きいため、年フィルタで代用できない
  // 四半期分割の時だけ、対象年の全レコードを渡してフィルタをtrain/testとして適用する）。
  const trainRecords = allRecords.filter(trainFilter);
  const testRecords = allRecords.filter(testFilter);
  return computeScoredEntrantsFromSplit(allRecords, trainRecords, testRecords);
}

function main2(): void {
  const allRecords = loadRecords([2025, 2026]);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'train=Q1 / test=Q2', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2 / test=Q3', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3 / test=Q4', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
    { label: 'train=2025 / test=2026', train: (r: RaceFactRecord) => r.year === 2025, test: (r: RaceFactRecord) => r.year === 2026 },
  ];
  console.log('=== ダ×良 の期間別再現性チェック ===');
  for (const p of periods) {
    const entrants = computeScoredEntrantsByFilter(allRecords, p.train, p.test);
    const subset = entrants.filter(e => e.trackType === 'ダ' && e.condition === '良');
    const { r, n } = pearson(subset);
    console.log(`${p.label}: r=${isNaN(r) ? 'N/A(n不足)' : r.toFixed(4)} (n=${n})`);
  }
}

main2();
