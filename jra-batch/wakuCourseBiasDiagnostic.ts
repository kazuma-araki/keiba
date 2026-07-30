/**
 * 「枠番バイアス」仮説の診断: 内枠/外枠の有利・不利はコース形状(競馬場・トラック種別・
 * 距離)ごとに大きく異なる、というのが競馬でよく言われる定説。枠番(waku, 1〜8)と
 * 現行モデル(タイム指数×騎手係数)の残差の相関を、コース×トラック種別×距離の
 * セグメントごとに見る。プールした全体だけでは特定コースの効果が他コースの逆効果と
 * 打ち消し合って埋もれる可能性があるため、必ずセグメント別に見る。
 *
 * 複数セグメントを総当たりするため、多重検定で「たまたま」大きく見えるセグメントが
 * 出やすい。上位候補は必ず期間別(4期間ウォークフォワード)で再現するか確認してから
 * 採否を判断する。
 *
 *   npx ts-node wakuCourseBiasDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number;
  jockeyName: string | null; waku: number | null;
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
const MIN_CELL_SIZE = 200;

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
  location: string; trackType: string; distance: number;
  residual: number; waku: number;
}

function computeScoredEntrants(allRecords: RaceFactRecord[], trainFilter: (r: RaceFactRecord) => boolean, testFilter: (r: RaceFactRecord) => boolean): ScoredEntrant[] {
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
    today: { trackType: string; distance: number; location: string };
    entrants: { horseName: string; finishRank: number; dateNum: number; jockeyName: string | null; waku: number | null }[];
  }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = { today: { trackType: r.trackType, distance: r.distance, location: r.location }, entrants: [] };
      races.set(key, race);
    }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), jockeyName: r.jockeyName, waku: r.waku });
  }

  const out: ScoredEntrant[] = [];
  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => {
        const history = lastFourBefore(e.horseName, e.dateNum);
        const timeScore = timeIndexScore(history, today, gradeOnlyStats);
        const score = timeScore == null ? null : timeScore + ALPHA_JOCKEY * jockeyZ(e.jockeyName);
        return { ...e, score };
      })
      .filter((e): e is typeof e & { score: number; waku: number } => e.score !== null && e.waku !== null);

    if (scored.length < 3) continue;
    const n = scored.length;
    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    const predictedPercentileOf = new Map(byScoreDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));
    const byFinishAsc = [...scored].sort((a, b) => a.finishRank - b.finishRank);
    const actualPercentileOf = new Map(byFinishAsc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));

    for (const e of scored) {
      const id = e.horseName + '#' + e.dateNum;
      out.push({
        horseName: e.horseName, finishRank: e.finishRank, dateNum: e.dateNum,
        location: today.location, trackType: today.trackType, distance: today.distance,
        residual: actualPercentileOf.get(id)! - predictedPercentileOf.get(id)!, waku: e.waku,
      });
    }
  }
  return out;
}

function pearson(entrants: ScoredEntrant[], xOf: (e: ScoredEntrant) => number): { r: number; n: number } {
  const n = entrants.length;
  if (n === 0) return { r: NaN, n };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const e of entrants) {
    const x = xOf(e), y = e.residual;
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y;
  }
  const cov = sumXY / n - (sumX / n) * (sumY / n);
  const stdX = Math.sqrt(sumX2 / n - (sumX / n) ** 2);
  const stdY = Math.sqrt(sumY2 / n - (sumY / n) ** 2);
  return { r: cov / (stdX * stdY), n };
}

function cellKey(e: ScoredEntrant): string {
  return `${e.location}|${e.trackType}|${e.distance}`;
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const entrants = computeScoredEntrants(allRecords, r => r.year === 2025, r => r.year === 2026);
  console.log(`全体プール: ${JSON.stringify(pearson(entrants, e => e.waku))}`);

  const cells = new Map<string, ScoredEntrant[]>();
  for (const e of entrants) {
    const k = cellKey(e);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(e);
  }

  const results = [...cells.entries()]
    .map(([k, list]) => ({ key: k, ...pearson(list, e => e.waku) }))
    .filter(r => r.n >= MIN_CELL_SIZE)
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  console.log(`\n=== コース×トラック×距離セグメント別 相関係数(n>=${MIN_CELL_SIZE}のみ, |r|降順上位20) ===`);
  for (const r of results.slice(0, 20)) {
    console.log(`${r.key}: r=${r.r.toFixed(4)} (n=${r.n})`);
  }
  console.log(`\n対象セグメント数(n>=${MIN_CELL_SIZE}): ${results.length}`);

  // サンプル数の大きい上位候補を4期間ウォークフォワードで再現性チェック
  const candidateKeys = results.filter(r => r.n >= 400).slice(0, 8).map(r => r.key);
  const Q2_START = 20250401, Q3_START = 20250701, Q4_START = 20251001;
  const periods = [
    { label: 'train=Q1/test=Q2', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q2_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q2_START && dateToNum(r.raceDate) < Q3_START },
    { label: 'train=Q1-Q2/test=Q3', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q3_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q3_START && dateToNum(r.raceDate) < Q4_START },
    { label: 'train=Q1-Q3/test=Q4', train: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) < Q4_START, test: (r: RaceFactRecord) => r.year === 2025 && dateToNum(r.raceDate) >= Q4_START },
  ];
  console.log(`\n=== 上位候補(n>=400)の期間別再現性チェック ===`);
  for (const key of candidateKeys) {
    const rows: string[] = [];
    for (const p of periods) {
      const periodEntrants = computeScoredEntrants(allRecords, p.train, p.test);
      const subset = periodEntrants.filter(e => cellKey(e) === key);
      const { r, n } = pearson(subset, e => e.waku);
      rows.push(`${p.label}:r=${isNaN(r) ? 'N/A' : r.toFixed(3)}(n=${n})`);
    }
    console.log(`${key} [2026:${results.find(r => r.key === key)!.r.toFixed(3)}]  ${rows.join('  ')}`);
  }
}

main();
