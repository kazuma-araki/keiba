/**
 * 「偏差値上位N頭の馬連ボックス」を買った場合の的中率を検証する。
 * 馬連ボックスは着順の順序を問わず、実際の1着・2着の馬が両方とも
 * 予測上位N頭に含まれていれば的中とみなす。
 *
 * backtest.ts と同じtrain(2025)/test(2026)分割・同じ重み付けロジックを使う
 * (jra-batchは自己完結設計のため、重み付けロジックをここでも複製している)。
 *
 *   npx ts-node quinellaBoxBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; quinellaPayout: number | null; horseName: string; finishRank: number; totalSeconds: number;
}
interface BaselineStats { count: number; mean: number; variance: number; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;

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

interface HistoryEntry { dateNum: number; secondsPerMeter: number; location: string; trackType: string; distance: number; condition: string; grade: RaceGrade; }

function main(): void {
  const trainYears = [2025];
  const testYears = [2026];
  const allRecords = loadRecords(Array.from(new Set([...trainYears, ...testYears])));
  const trainRecords = allRecords.filter(r => trainYears.includes(r.year));
  const testRecords = allRecords.filter(r => testYears.includes(r.year));

  const gradeOnlyStats: Record<string, BaselineStats> = {};
  {
    const grouped = new Map<string, number[]>();
    for (const r of trainRecords) {
      const key = gradeOnlyKey(r.location, r.trackType, r.distance, r.condition, r.grade);
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(r.totalSeconds / r.distance);
    }
    for (const [k, v] of grouped) gradeOnlyStats[k] = computeStats(v);
  }

  const horseHistory = new Map<string, HistoryEntry[]>();
  for (const r of allRecords) {
    const entry: HistoryEntry = {
      dateNum: dateToNum(r.raceDate), secondsPerMeter: r.totalSeconds / r.distance,
      location: r.location, trackType: r.trackType, distance: r.distance, condition: r.condition, grade: r.grade,
    };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }
  for (const list of horseHistory.values()) list.sort((a, b) => a.dateNum - b.dateNum);

  function scoreOf(horseName: string, dateNum: number, today: { trackType: string; distance: number }): number | null {
    const list = horseHistory.get(horseName);
    if (!list) return null;
    const history = list.filter(e => e.dateNum < dateNum).slice(-4).reverse();
    let weightedSum = 0, weightSum = 0;
    history.forEach((e, slotIndex) => {
      const stats = lookupGradeOnly(gradeOnlyStats, e.location, e.trackType, e.distance, e.condition, e.grade);
      if (!stats || stats.variance <= 0) return;
      const speedIndex = (stats.mean - e.secondsPerMeter) / Math.sqrt(stats.variance);
      const recency = RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
      const reliability = Math.min(1, stats.count / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
      const surface = e.trackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
      const distanceW = Math.max(MIN_DISTANCE_WEIGHT, 1 - Math.abs(e.distance - today.distance) * DISTANCE_DECAY_PER_METER);
      const weight = recency * reliability * surface * distanceW;
      weightedSum += weight * speedIndex;
      weightSum += weight;
    });
    return weightSum > 0 ? weightedSum / weightSum : null;
  }

  interface RaceGroup { today: { trackType: string; distance: number }; quinellaPayout: number | null; entrants: { horseName: string; finishRank: number; dateNum: number }[]; }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, quinellaPayout: r.quinellaPayout, entrants: [] }; races.set(key, race); }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate) });
  }

  const boxSizes = [2, 3, 4, 5, 6];
  const results: Record<number, { races: number; hits: number; combos: number; totalCost: number; totalReturn: number }> = {};
  for (const n of boxSizes) results[n] = { races: 0, hits: 0, combos: (n * (n - 1)) / 2, totalCost: 0, totalReturn: 0 };

  const UNIT_STAKE = 100; // 1点あたりの購入額(円)

  let totalRaces = 0;
  for (const { today, entrants, quinellaPayout } of races.values()) {
    if (quinellaPayout == null) continue; // 配当が取れていないレースは回収率計算から除外
    const scored = entrants
      .map(e => ({ ...e, score: scoreOf(e.horseName, e.dateNum, today) }))
      .filter((e): e is typeof e & { score: number } => e.score !== null);
    if (scored.length < 2) continue;
    totalRaces++;

    const byScoreDesc = [...scored].sort((a, b) => b.score - a.score);
    const actualTop2 = new Set(entrants.filter(e => e.finishRank === 1 || e.finishRank === 2).map(e => e.horseName));
    if (actualTop2.size < 2) continue; // 同着等でタイム不明の場合を除外

    for (const n of boxSizes) {
      if (byScoreDesc.length < n) continue;
      const r = results[n];
      r.races++;
      r.totalCost += r.combos * UNIT_STAKE;
      const picks = new Set(byScoreDesc.slice(0, n).map(e => e.horseName));
      const hit = [...actualTop2].every(name => picks.has(name));
      if (hit) {
        r.hits++;
        r.totalReturn += quinellaPayout; // 配当は100円あたりの金額なのでそのまま加算
      }
    }
  }

  console.log(`検証対象レース数: ${totalRaces}\n`);
  console.log('偏差値上位N頭ボックス(馬連)の的中率・実配当ベースの回収率:');
  for (const n of boxSizes) {
    const r = results[n];
    const rate = r.races > 0 ? (r.hits / r.races) * 100 : 0;
    const perTicket = rate / r.combos;
    const roi = r.totalCost > 0 ? (r.totalReturn / r.totalCost) * 100 : 0;
    console.log(`  上位${n}頭box(${r.combos}点買い): 的中率 ${rate.toFixed(2)}%  1点あたり的中率 ${perTicket.toFixed(2)}%  回収率 ${roi.toFixed(1)}%  (投資${r.totalCost.toLocaleString()}円 → 回収${r.totalReturn.toLocaleString()}円)`);
  }
}

main();
