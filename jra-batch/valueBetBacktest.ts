/**
 * 「モデルの評価が市場(オッズ)の評価より大幅に強気な馬」＝穴馬狙いの単勝ベットが
 * 過去データ上プラス収支だったかを検証する。
 *
 * 各レースは自分自身のオッズだけを使う(他レース・他の馬への転用はしない)。
 * 「勝つ確率」ではなく「モデル順位 vs 市場順位(オッズ昇順)の乖離」で穴馬を定義し、
 * 乖離が大きい馬に単勝100円を賭け続けた場合の通算回収率を計算する。
 *
 * train(2025)/test(2026)分割・重み付けロジックはbacktest.ts等と同じ
 * (jra-batchの自己完結設計のため重み付け定数をここでも複製している)。
 *
 *   npx ts-node valueBetBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; grade: RaceGrade; horseName: string; finishRank: number; totalSeconds: number; odds: number | null;
}
interface BaselineStats { count: number; mean: number; variance: number; }

const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;
const DIFFERENT_SURFACE_WEIGHT = 0.3;
const DISTANCE_DECAY_PER_METER = 1 / 800;
const MIN_DISTANCE_WEIGHT = 0.2;
const UNIT_STAKE = 100;

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

  interface RaceGroup { today: { trackType: string; distance: number }; entrants: { horseName: string; finishRank: number; dateNum: number; odds: number | null }[]; }
  const races = new Map<string, RaceGroup>();
  for (const r of testRecords) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) { race = { today: { trackType: r.trackType, distance: r.distance }, entrants: [] }; races.set(key, race); }
    race.entrants.push({ horseName: r.horseName, finishRank: r.finishRank, dateNum: dateToNum(r.raceDate), odds: r.odds });
  }

  interface Bucket { count: number; wins: number; cost: number; returned: number; }
  const newBucket = (): Bucket => ({ count: 0, wins: 0, cost: 0, returned: 0 });
  const gapThresholds = [2, 4, 6, 8];
  const gapBuckets = new Map<number, Bucket>(gapThresholds.map(t => [t, newBucket()]));
  const modelTop1 = newBucket();
  const marketFavorite = newBucket();

  let totalRaces = 0;
  for (const { today, entrants } of races.values()) {
    const scored = entrants
      .map(e => ({ ...e, score: scoreOf(e.horseName, e.dateNum, today) }))
      .filter((e): e is typeof e & { score: number; odds: number } => e.score !== null && e.odds !== null && e.odds > 0);
    if (scored.length < 4) continue; // 乖離を測るのに十分な頭数がいるレースのみ対象
    totalRaces++;

    const byModelDesc = [...scored].sort((a, b) => b.score - a.score);
    const modelRankOf = new Map(byModelDesc.map((e, i) => [e.horseName, i + 1]));
    const byOddsAsc = [...scored].sort((a, b) => a.odds - b.odds);
    const marketRankOf = new Map(byOddsAsc.map((e, i) => [e.horseName, i + 1]));

    // モデル1位への単勝(市場評価に関わらず)
    const top1 = byModelDesc[0];
    modelTop1.count++; modelTop1.cost += UNIT_STAKE;
    if (top1.finishRank === 1) { modelTop1.wins++; modelTop1.returned += top1.odds * UNIT_STAKE; }

    // 市場1番人気への単勝(比較用ベースライン)
    const fav = byOddsAsc[0];
    marketFavorite.count++; marketFavorite.cost += UNIT_STAKE;
    if (fav.finishRank === 1) { marketFavorite.wins++; marketFavorite.returned += fav.odds * UNIT_STAKE; }

    // 穴馬候補：モデル順位 vs 市場順位の乖離が閾値以上の馬すべてに単勝
    for (const e of scored) {
      const gap = marketRankOf.get(e.horseName)! - modelRankOf.get(e.horseName)!;
      for (const t of gapThresholds) {
        if (gap < t) continue;
        const b = gapBuckets.get(t)!;
        b.count++; b.cost += UNIT_STAKE;
        if (e.finishRank === 1) { b.wins++; b.returned += e.odds * UNIT_STAKE; }
      }
    }
  }

  function printBucket(label: string, b: Bucket): void {
    const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
    const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
    console.log(`  ${label}: 件数${b.count}  勝率${winRate.toFixed(2)}%  回収率${roi.toFixed(1)}%  (投資${b.cost.toLocaleString()}円→回収${Math.round(b.returned).toLocaleString()}円)`);
  }

  console.log(`検証対象レース数: ${totalRaces}\n`);
  console.log('ベースライン:');
  printBucket('モデル1位を毎回単勝(市場評価は無視)', modelTop1);
  printBucket('市場1番人気を毎回単勝', marketFavorite);
  console.log('\n穴馬狙い(モデル順位が市場順位よりN位以上強気な馬すべてに単勝):');
  for (const t of gapThresholds) {
    printBucket(`乖離${t}以上`, gapBuckets.get(t)!);
  }
}

main();
