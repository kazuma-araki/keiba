/**
 * distanceIntervalBlendBacktest.tsで検証済みの「距離変更・間隔」ブレンド
 * (alphaInterval=0.1, alphaDistance=0.05)をWebアプリで使うため、
 * train期間(2025年)における距離変更・間隔の平均・標準偏差を書き出す。
 *
 *   npx ts-node exportDistanceIntervalStats.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractClassTier, type RaceGrade } from './raceClass';

interface RaceFactRecord {
  year: number; horseName: string; raceDate: string; distance: number; condition: string; totalSeconds: number;
  trackType: string; raceClassText: string; grade: RaceGrade;
}

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
function dateToEpochDays(raceDate: string): number | null {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  return Math.floor(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / 86400000);
}
function dateToNum(raceDate: string): number {
  const m = raceDate.match(/(\d+)年(\d+)月(\d+)日/);
  return m ? parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10) : 0;
}

function main(): void {
  const years = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(a => parseInt(a, 10));
  if (years.length === 0) {
    console.error('対象年(train期間)を指定してください（例: npx ts-node exportDistanceIntervalStats.ts 2025）');
    process.exit(1);
  }
  const allRecords = loadRecords(years);

  const horseHistory = new Map<string, { dateNum: number; epochDay: number | null; distance: number }[]>();
  for (const r of allRecords) {
    const entry = { dateNum: dateToNum(r.raceDate), epochDay: dateToEpochDays(r.raceDate), distance: r.distance };
    (horseHistory.get(r.horseName) ?? horseHistory.set(r.horseName, []).get(r.horseName)!).push(entry);
  }

  const distanceDeltas: number[] = [];
  const intervals: number[] = [];
  for (const list of horseHistory.values()) {
    list.sort((a, b) => a.dateNum - b.dateNum);
    for (let i = 1; i < list.length; i++) {
      distanceDeltas.push(list[i].distance - list[i - 1].distance);
      if (list[i].epochDay != null && list[i - 1].epochDay != null) {
        intervals.push(list[i].epochDay! - list[i - 1].epochDay!);
      }
    }
  }

  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a: number[], m: number) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);

  const ddMean = mean(distanceDeltas);
  const ddStd = std(distanceDeltas, ddMean);
  const ivMean = mean(intervals);
  const ivStd = std(intervals, ivMean);

  const output = { ddMean, ddStd, ivMean, ivStd };
  const outPath = path.join(__dirname, 'distanceIntervalStats.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`対象年: ${years.join(',')}`);
  console.log(`距離変更: 平均${ddMean.toFixed(1)}m 標準偏差${ddStd.toFixed(1)}m (n=${distanceDeltas.length})`);
  console.log(`間隔: 平均${ivMean.toFixed(1)}日 標準偏差${ivStd.toFixed(1)}日 (n=${intervals.length})`);
  console.log(`出力先: ${outPath}`);
}

main();
