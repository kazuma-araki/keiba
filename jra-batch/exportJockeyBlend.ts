/**
 * jockeyBlendBacktest.tsで検証済みの「タイム指数 + alpha×騎手勝率zスコア」を
 * 本番(Webアプリ)で使うための軽量JSONを書き出す。
 *
 * jockeyStats_<年>.json（computeJockeyStats.tsの出力）から、
 * 騎乗数がMIN_RIDES未満の騎手を除外し、残った騎手の勝率を平均・標準偏差で
 * zスコア化した {騎手名: zスコア} だけの軽いJSONにする
 * (mean/stdはこの時点で織り込み済みなので、アプリ側では騎手名で引くだけでよい)。
 *
 *   npx ts-node exportJockeyBlend.ts 2025
 */

import * as fs from 'fs';
import * as path from 'path';

interface JockeyStats { rides: number; wins: number; places: number; winRate: number; placeRate: number; }

const MIN_RIDES = 30; // jockeyBlendBacktest.tsで検証した閾値と揃える

function main(): void {
  const years = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(a => parseInt(a, 10));
  if (years.length === 0) {
    console.error('対象年を指定してください（例: npx ts-node exportJockeyBlend.ts 2025）');
    process.exit(1);
  }
  const yearsLabel = years.join('-');
  const inputPath = path.join(__dirname, `jockeyStats_${yearsLabel}.json`);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`${inputPath} が見つかりません。先に computeJockeyStats.ts ${yearsLabel.replace('-', ' ')} を実行してください。`);
  }
  const stats: Record<string, JockeyStats> = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  const eligible = Object.entries(stats).filter(([, s]) => s.rides >= MIN_RIDES);
  const winRates = eligible.map(([, s]) => s.winRate);
  const mean = winRates.reduce((sum, v) => sum + v, 0) / winRates.length;
  const std = Math.sqrt(winRates.reduce((sum, v) => sum + (v - mean) ** 2, 0) / winRates.length);

  const output: Record<string, number> = {};
  for (const [name, s] of eligible) {
    output[name] = parseFloat(((s.winRate - mean) / std).toFixed(4));
  }

  const outPath = path.join(__dirname, `jockeyZScore_${yearsLabel}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`対象年: ${yearsLabel}`);
  console.log(`騎手数: ${Object.keys(stats).length} → MIN_RIDES=${MIN_RIDES}以上: ${eligible.length}名`);
  console.log(`勝率 平均${(mean * 100).toFixed(1)}% 標準偏差${(std * 100).toFixed(1)}pt`);
  console.log(`出力先: ${outPath}`);
}

main();
