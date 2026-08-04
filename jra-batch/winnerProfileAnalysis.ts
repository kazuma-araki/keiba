/**
 * これまでのモデル改善・バックテストは一旦離れて、実際に上位に来ている馬に
 * どんな傾向があるかを、修正済みのrace_facts_*.jsonl(2025-2026, 75,451件)から
 * 素朴に集計する記述統計。予測モデルへの組み込みを前提にしない、探索的な分析。
 *
 *   npx ts-node winnerProfileAnalysis.ts
 */

import * as fs from 'fs';
import * as path from 'path';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; distance: number; trackType: string;
  condition: string; raceClassText: string; grade: string | null;
  horseName: string; finishRank: number; totalSeconds: number; odds: number | null;
  jockeyName: string | null; weight: number | null; bodyWeight: number | null; bodyWeightChange: number | null;
  waku: number | null; umaban: number | null;
  earlyPositionGroup: number | null; earlyPositionGroupTotal: number | null;
}

function loadRecords(years: number[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const year of years) {
    const file = path.join(__dirname, `race_facts_${year}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line));
    }
  }
  return records;
}
function raceKeyOf(r: RaceFactRecord): string {
  return `${r.year}-${r.kaisai}-${r.location}-${r.day}-${r.raceNumber}`;
}

interface Row { races: number; wins: number; top3: number; }
function newRow(): Row { return { races: 0, wins: 0, top3: 0 }; }
function add(row: Row, finishRank: number): void {
  row.races++;
  if (finishRank === 1) row.wins++;
  if (finishRank >= 1 && finishRank <= 3) row.top3++;
}
function fmt(row: Row): string {
  const winRate = row.races > 0 ? (row.wins / row.races) * 100 : 0;
  const top3Rate = row.races > 0 ? (row.top3 / row.races) * 100 : 0;
  return `勝率${winRate.toFixed(1)}%  複勝率${top3Rate.toFixed(1)}%  (n=${row.races})`;
}

function main(): void {
  const records = loadRecords([2025, 2026]);
  console.log(`対象レコード数: ${records.length}`);

  // レース単位の頭数を先に求めておく(頭数帯・単勝人気の算出に必要)
  const byRace = new Map<string, RaceFactRecord[]>();
  for (const r of records) {
    const key = raceKeyOf(r);
    (byRace.get(key) ?? byRace.set(key, []).get(key)!).push(r);
  }
  const fieldSizeOf = new Map<string, number>();
  const oddsRankOf = new Map<string, number>(); // horseName#raceKey -> 単勝人気順位
  for (const [key, entrants] of byRace) {
    fieldSizeOf.set(key, entrants.length);
    const withOdds = entrants.filter(e => e.odds != null && e.odds > 0);
    const sorted = [...withOdds].sort((a, b) => a.odds! - b.odds!);
    sorted.forEach((e, i) => oddsRankOf.set(`${e.horseName}#${key}`, i + 1));
  }

  console.log('\n=== 1. 枠番別 ===');
  const wakuRows = new Map<number, Row>();
  for (const r of records) {
    if (r.waku == null) continue;
    const row = wakuRows.get(r.waku) ?? newRow();
    add(row, r.finishRank);
    wakuRows.set(r.waku, row);
  }
  for (const w of [...wakuRows.keys()].sort((a, b) => a - b)) console.log(`  ${w}枠: ${fmt(wakuRows.get(w)!)}`);

  console.log('\n=== 2. 単勝人気別(1〜10番人気) ===');
  const popRows = new Map<number, Row>();
  for (const r of records) {
    const key = raceKeyOf(r);
    const rank = oddsRankOf.get(`${r.horseName}#${key}`);
    if (rank == null || rank > 10) continue;
    const row = popRows.get(rank) ?? newRow();
    add(row, r.finishRank);
    popRows.set(rank, row);
  }
  for (const p of [...popRows.keys()].sort((a, b) => a - b)) console.log(`  ${p}番人気: ${fmt(popRows.get(p)!)}`);

  console.log('\n=== 3. 脚質(最初のコーナー通過順位、位置取りパーセンタイル)別 ===');
  console.log('  0=先頭寄り(逃げ・先行) 〜 1=最後方寄り(差し・追込)');
  const styleRows = new Map<string, Row>();
  const styleLabel = (pct: number) => pct < 0.2 ? '先頭(0-20%)' : pct < 0.4 ? '先行(20-40%)' : pct < 0.6 ? '中団(40-60%)' : pct < 0.8 ? '中後方(60-80%)' : '後方(80-100%)';
  for (const r of records) {
    if (r.earlyPositionGroup == null || r.earlyPositionGroupTotal == null || r.earlyPositionGroupTotal <= 1) continue;
    const pct = (r.earlyPositionGroup - 1) / (r.earlyPositionGroupTotal - 1);
    const label = styleLabel(pct);
    const row = styleRows.get(label) ?? newRow();
    add(row, r.finishRank);
    styleRows.set(label, row);
  }
  for (const label of ['先頭(0-20%)', '先行(20-40%)', '中団(40-60%)', '中後方(60-80%)', '後方(80-100%)']) {
    console.log(`  ${label}: ${fmt(styleRows.get(label) ?? newRow())}`);
  }

  console.log('\n=== 3b. 脚質 × 距離帯 ===');
  const distBand = (d: number) => d <= 1400 ? '短距離(〜1400m)' : d <= 1800 ? 'マイル(1401-1800m)' : d <= 2200 ? '中距離(1801-2200m)' : '長距離(2201m〜)';
  const styleDistRows = new Map<string, Row>();
  for (const r of records) {
    if (r.earlyPositionGroup == null || r.earlyPositionGroupTotal == null || r.earlyPositionGroupTotal <= 1) continue;
    const pct = (r.earlyPositionGroup - 1) / (r.earlyPositionGroupTotal - 1);
    const key = `${distBand(r.distance)}|${styleLabel(pct)}`;
    const row = styleDistRows.get(key) ?? newRow();
    add(row, r.finishRank);
    styleDistRows.set(key, row);
  }
  for (const d of ['短距離(〜1400m)', 'マイル(1401-1800m)', '中距離(1801-2200m)', '長距離(2201m〜)']) {
    console.log(`  --- ${d} ---`);
    for (const s of ['先頭(0-20%)', '先行(20-40%)', '中団(40-60%)', '中後方(60-80%)', '後方(80-100%)']) {
      console.log(`    ${s}: ${fmt(styleDistRows.get(`${d}|${s}`) ?? newRow())}`);
    }
  }

  console.log('\n=== 3c. 脚質 × 馬場状態(今回修正済みデータ) ===');
  const styleCondRows = new Map<string, Row>();
  for (const r of records) {
    if (r.earlyPositionGroup == null || r.earlyPositionGroupTotal == null || r.earlyPositionGroupTotal <= 1) continue;
    if (r.condition === '不明') continue;
    const pct = (r.earlyPositionGroup - 1) / (r.earlyPositionGroupTotal - 1);
    const key = `${r.condition}|${styleLabel(pct)}`;
    const row = styleCondRows.get(key) ?? newRow();
    add(row, r.finishRank);
    styleCondRows.set(key, row);
  }
  for (const c of ['良', '稍重', '重', '不良']) {
    console.log(`  --- 馬場:${c} ---`);
    for (const s of ['先頭(0-20%)', '先行(20-40%)', '中団(40-60%)', '中後方(60-80%)', '後方(80-100%)']) {
      console.log(`    ${s}: ${fmt(styleCondRows.get(`${c}|${s}`) ?? newRow())}`);
    }
  }

  console.log('\n=== 4. 馬体重増減別 ===');
  const bwcLabel = (c: number) => c <= -10 ? '大幅減(-10kg以下)' : c < 0 ? '減(-1〜-9kg)' : c === 0 ? '増減無し' : c <= 9 ? '増(+1〜+9kg)' : '大幅増(+10kg以上)';
  const bwcRows = new Map<string, Row>();
  for (const r of records) {
    if (r.bodyWeightChange == null) continue;
    const label = bwcLabel(r.bodyWeightChange);
    const row = bwcRows.get(label) ?? newRow();
    add(row, r.finishRank);
    bwcRows.set(label, row);
  }
  for (const l of ['大幅減(-10kg以下)', '減(-1〜-9kg)', '増減無し', '増(+1〜+9kg)', '大幅増(+10kg以上)']) {
    console.log(`  ${l}: ${fmt(bwcRows.get(l) ?? newRow())}`);
  }

  console.log('\n=== 5. 斤量(レース内平均との差)別 ===');
  const weightMeanByRace = new Map<string, number>();
  for (const [key, entrants] of byRace) {
    const ws = entrants.map(e => e.weight).filter((w): w is number => w != null);
    if (ws.length > 0) weightMeanByRace.set(key, ws.reduce((s, v) => s + v, 0) / ws.length);
  }
  const wRelLabel = (d: number) => d <= -2 ? '軽い(-2kg以下)' : d < 0 ? 'やや軽い(-0.1〜-1.9kg)' : d === 0 ? '平均並み' : d < 2 ? 'やや重い(+0.1〜+1.9kg)' : '重い(+2kg以上)';
  const weightRows = new Map<string, Row>();
  for (const r of records) {
    if (r.weight == null) continue;
    const key = raceKeyOf(r);
    const mean = weightMeanByRace.get(key);
    if (mean == null) continue;
    const label = wRelLabel(r.weight - mean);
    const row = weightRows.get(label) ?? newRow();
    add(row, r.finishRank);
    weightRows.set(label, row);
  }
  for (const l of ['軽い(-2kg以下)', 'やや軽い(-0.1〜-1.9kg)', '平均並み', 'やや重い(+0.1〜+1.9kg)', '重い(+2kg以上)']) {
    console.log(`  ${l}: ${fmt(weightRows.get(l) ?? newRow())}`);
  }

  console.log('\n=== 6. トラック種別 × 馬場状態別の勝率(参考: 母数の確認) ===');
  const trackCondRows = new Map<string, Row>();
  for (const r of records) {
    if (r.condition === '不明') continue;
    const key = `${r.trackType}|${r.condition}`;
    const row = trackCondRows.get(key) ?? newRow();
    add(row, r.finishRank);
    trackCondRows.set(key, row);
  }
  for (const t of ['芝', 'ダ', '障害']) {
    for (const c of ['良', '稍重', '重', '不良']) {
      const row = trackCondRows.get(`${t}|${c}`);
      if (row) console.log(`  ${t}/${c}: ${fmt(row)}`);
    }
  }

  console.log('\n=== 7. 騎手 上位20人(50騎乗以上、勝率順) ===');
  const jockeyRows = new Map<string, Row>();
  for (const r of records) {
    if (!r.jockeyName) continue;
    const row = jockeyRows.get(r.jockeyName) ?? newRow();
    add(row, r.finishRank);
    jockeyRows.set(r.jockeyName, row);
  }
  const jockeyList = [...jockeyRows.entries()].filter(([, row]) => row.races >= 50).sort((a, b) => (b[1].wins / b[1].races) - (a[1].wins / a[1].races));
  for (const [name, row] of jockeyList.slice(0, 20)) console.log(`  ${name}: ${fmt(row)}`);
}

main();
