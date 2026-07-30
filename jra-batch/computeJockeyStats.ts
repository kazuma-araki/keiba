/**
 * race_facts_<年>.jsonl から騎手ごとの成績(騎乗数・勝率・複勝率)を集計する。
 * netkeiba側の集計(jockeyRoster_*.json)は期間や対象レースの境界が
 * 自前のtrain/test分割と一致しない可能性があるため、診断・モデル用には
 * 自前データから同じ切り口で集計し直す。
 *
 *   npx ts-node computeJockeyStats.ts 2025
 */

import * as fs from 'fs';
import * as path from 'path';

interface RaceFactRecord {
  year: number;
  horseName: string;
  finishRank: number;
  jockeyName: string | null;
}

interface JockeyStats {
  rides: number;
  wins: number;
  places: number;
  winRate: number;
  placeRate: number;
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

function main(): void {
  const years = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(a => parseInt(a, 10));
  if (years.length === 0) {
    console.error('対象年を指定してください（例: npx ts-node computeJockeyStats.ts 2025）');
    process.exit(1);
  }

  const records = loadRecords(years);
  const grouped = new Map<string, { rides: number; wins: number; places: number }>();
  for (const r of records) {
    if (!r.jockeyName || !(r.finishRank > 0)) continue;
    const g = grouped.get(r.jockeyName) ?? { rides: 0, wins: 0, places: 0 };
    g.rides++;
    if (r.finishRank === 1) g.wins++;
    if (r.finishRank <= 3) g.places++;
    grouped.set(r.jockeyName, g);
  }

  const output: Record<string, JockeyStats> = {};
  for (const [name, g] of grouped) {
    output[name] = { rides: g.rides, wins: g.wins, places: g.places, winRate: g.wins / g.rides, placeRate: g.places / g.rides };
  }

  const yearsLabel = years.join('-');
  const outPath = path.join(__dirname, `jockeyStats_${yearsLabel}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  const sorted = Object.entries(output).sort((a, b) => b[1].rides - a[1].rides);
  console.log(`対象年: ${yearsLabel}`);
  console.log(`騎手数: ${sorted.length}`);
  console.log('騎乗数上位10名:');
  for (const [name, s] of sorted.slice(0, 10)) {
    console.log(`  ${name}: 騎乗${s.rides} 勝率${(s.winRate * 100).toFixed(1)}% 複勝率${(s.placeRate * 100).toFixed(1)}%`);
  }
  console.log(`出力先: ${outPath}`);
}

main();
