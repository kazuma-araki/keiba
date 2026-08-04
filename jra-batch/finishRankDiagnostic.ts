/**
 * 過去走の着順（finishRank）に予測力があるかを検証する。
 *
 * 現行モデル（タイム指数×騎手係数）は「秒/mが基準よりどれだけ速いか」だけを見ており、
 * 着順（＝そのレースでの相対的な強さ・勝ち方/負け方の質）を一切使っていない。
 * 例えば同じ0.05秒/m差でも、7着から追い込んでの0.05秒差と、1着で楽勝しての
 * 0.05秒差では意味が違うはずで、着順にはタイム指数だけでは拾えない情報が
 * 残っている可能性がある。
 *
 * comboSweepDiagnostic.tsと同じ手法：タイム指数×騎手係数モデルの「残差」
 * （実際の着順パーセンタイル − モデル予測パーセンタイル、レース内相対）に対して、
 * 過去走の着順から作った特徴量がどれだけ説明力を持つかを4期間ウォークフォワードで見る。
 * 全期間で符号・大きさが安定していれば採用候補、そうでなければ見送り
 * （このリポジトリで確立された基準）。
 *
 *   npx ts-node finishRankDiagnostic.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: RaceGrade; horseName: string;
  finishRank: number; totalSeconds: number; jockeyName: string | null; odds: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }
interface HistoryEntry {
  dateNum: number; epochDay: number | null; secondsPerMeter: number; location: string; trackType: string;
  distance: number; condition: string; grade: RaceGrade; classTier: number;
  finishRank: number; finishPercentile: number | null; // 0=1着, 1=最下位。フィールドサイズ1のレースはnull
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
      if (r.distance > 0 && r.condition !== '不明' && r.totalSeconds > 0 && r.finishRank > 0) records.push(r);
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

interface Entrant {
  residual: number;
  avgFinishPercentile: number | null;   // 直近4走の着順パーセンタイル(0=1着,1=最下位)、単純平均
  weightedFinishPercentile: number | null; // 同、新しさで重み付け(前走ほど重視)
  lastFinishPercentile: number | null;  // 前走のみ
  winRate4: number | null;              // 直近4走の勝率
  placeRate4: number | null;            // 直近4走の複勝率(3着以内)
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

  // 過去走の着順パーセンタイルを求めるため、まず全レコード(train+test)を
  // レース単位でグルーピングしてフィールドサイズ・順位を確定させる
  const historyRecords = [...trainRecords, ...testRecords];
  const byRace = new Map<string, RaceFactRecord[]>();
  for (const r of historyRecords) {
    const key = raceKeyOf(r);
    (byRace.get(key) ?? byRace.set(key, []).get(key)!).push(r);
  }
  const percentileOf = new Map<string, number | null>(); // horseName#raceKey -> percentile
  for (const [, entrants] of byRace) {
    const n = entrants.length;
    for (const e of entrants) {
      const pct = n > 1 ? (e.finishRank - 1) / (n - 1) : null;
      percentileOf.set(`${e.horseName}#${raceKeyOf(e)}`, pct);
    }
  }

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of historyRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
      classTier: extractClassTier(r.raceClassText, r.grade), finishRank: r.finishRank,
      finishPercentile: percentileOf.get(`${r.horseName}#${raceKeyOf(r)}`) ?? null,
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

  const out: Entrant[] = [];
  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => {
        const history = lastFourBefore(e.horseName, e.dateNum);
        const timeScore = timeIndexScore(history, today, gradeOnlyStats);
        const score = timeScore == null ? null : timeScore + ALPHA_JOCKEY * jockeyZ(e.jockeyName);

        const pctValues = history.map(h => h.finishPercentile).filter((v): v is number => v !== null);
        const avgFinishPercentile = pctValues.length > 0 ? pctValues.reduce((s, v) => s + v, 0) / pctValues.length : null;

        let wSum = 0, wPctSum = 0;
        history.forEach((h, i) => {
          if (h.finishPercentile == null) return;
          const w = RECENCY_WEIGHTS[i] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
          wSum += w; wPctSum += w * h.finishPercentile;
        });
        const weightedFinishPercentile = wSum > 0 ? wPctSum / wSum : null;

        const lastFinishPercentile = history[0]?.finishPercentile ?? null;
        const rankValues = history.map(h => h.finishRank);
        const winRate4 = rankValues.length > 0 ? rankValues.filter(r => r === 1).length / rankValues.length : null;
        const placeRate4 = rankValues.length > 0 ? rankValues.filter(r => r <= 3).length / rankValues.length : null;

        return { ...e, score, avgFinishPercentile, weightedFinishPercentile, lastFinishPercentile, winRate4, placeRate4 };
      })
      .filter((e): e is typeof e & { score: number } => e.score !== null);

    if (scored.length < 3) continue;
    const n = scored.length;
    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    const predictedOf = new Map(byScoreDesc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));
    const byFinishAsc = [...scored].sort((a, b) => a.finishRank - b.finishRank);
    const actualOf = new Map(byFinishAsc.map((e, i) => [e.horseName + '#' + e.dateNum, i / (n - 1)]));

    for (const e of scored) {
      const id = e.horseName + '#' + e.dateNum;
      const residual = actualOf.get(id)! - predictedOf.get(id)!;
      out.push({
        residual, avgFinishPercentile: e.avgFinishPercentile, weightedFinishPercentile: e.weightedFinishPercentile,
        lastFinishPercentile: e.lastFinishPercentile, winRate4: e.winRate4, placeRate4: e.placeRate4,
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

  console.log('=== 着順ベースの特徴量の単変数相関(残差との。残差がマイナス=モデル予測より好走) ===');
  const singleVars: { name: string; xOf: (e: Entrant) => number | null }[] = [
    { name: 'avgFinishPercentile(直近4走 着順%平均)', xOf: e => e.avgFinishPercentile },
    { name: 'weightedFinishPercentile(同、新しさ重み付け)', xOf: e => e.weightedFinishPercentile },
    { name: 'lastFinishPercentile(前走のみ)', xOf: e => e.lastFinishPercentile },
    { name: 'winRate4(直近4走 勝率)', xOf: e => e.winRate4 },
    { name: 'placeRate4(直近4走 複勝率)', xOf: e => e.placeRate4 },
  ];
  for (const v of singleVars) {
    const line = entrantsByPeriod.map(p => {
      const { r, n } = pearson(p.entrants, v.xOf);
      return `${p.label}:${isNaN(r) ? 'N/A' : r.toFixed(4)}(n=${n})`;
    }).join('  ');
    console.log(`${v.name.padEnd(38)}: ${line}`);
  }

  console.log('\n=== weightedFinishPercentile を5分位に分けた平均残差(負=好走寄り) ===');
  for (const p of entrantsByPeriod) {
    const vals = p.entrants.map(e => e.weightedFinishPercentile).filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (vals.length < 50) { console.log(`--- ${p.label} --- N/A(データ不足)`); continue; }
    const qBoundaries = [0.2, 0.4, 0.6, 0.8].map(q => vals[Math.floor(vals.length * q)]);
    function qOf(v: number): number {
      for (let i = 0; i < qBoundaries.length; i++) if (v <= qBoundaries[i]) return i;
      return qBoundaries.length;
    }
    const buckets = [0, 0, 0, 0, 0].map(() => ({ sum: 0, count: 0 }));
    for (const e of p.entrants) {
      if (e.weightedFinishPercentile == null) continue;
      const b = buckets[qOf(e.weightedFinishPercentile)];
      b.sum += e.residual; b.count++;
    }
    console.log(`--- ${p.label} ---`);
    console.log('  好走(0)〜不振(4): ' + buckets.map(b => b.count > 0 ? `${(b.sum / b.count).toFixed(4)}(n=${b.count})` : 'N/A').join('  /  '));
  }
}

main();
