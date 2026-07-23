/**
 * importJraResults.ts が蓄積した race_facts_<年>.jsonl から、コース×距離×馬場状態×
 * 重賞グレードごとの基準タイム（秒/mの平均・分散）を計算する。
 *
 * 重賞（G1/G2/G3）は同条件の一般戦よりタイムが大きく異なるため、デフォルトで
 * gradeを含めて分けている（未重賞は"NONE"にまとまる）。それ以外の切り口が
 * 必要な場合だけ --groupBy で明示的に上書きする。
 *
 * 生データ（JSONL）自体は素のレース×出走馬レコードなので、集計の切り口は
 * このスクリプトの --groupBy を変えるだけで何度でも作り直せる。
 *
 * 【実行方法】
 *   npx ts-node computeBaselines.ts                          （全年度のrace_facts_*.jsonlを対象。デフォルトの切り口で集計）
 *   npx ts-node computeBaselines.ts 2024 2025                （対象年を指定。複数可）
 *   npx ts-node computeBaselines.ts 2024 2025 --groupBy=location,trackType,distance,condition,year
 *
 * 【指定できるgroupByフィールド】
 *   year, location, trackType, distance, condition, grade
 *   （grade未指定のレースは "NONE" として扱う）
 */

import * as fs from 'fs';
import * as path from 'path';

const ALLOWED_FIELDS = ['year', 'location', 'trackType', 'distance', 'condition', 'grade'] as const;
type GroupByField = (typeof ALLOWED_FIELDS)[number];

const DEFAULT_GROUP_BY: GroupByField[] = ['location', 'trackType', 'distance', 'condition', 'grade'];

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
  grade: string | null;
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

function parseArgs(argv: string[]): { years: number[]; groupBy: GroupByField[] } {
  const years = argv.filter(a => /^\d{4}$/.test(a)).map(a => parseInt(a, 10));

  const groupByArg = argv.find(a => a.startsWith('--groupBy='));
  let groupBy = DEFAULT_GROUP_BY;
  if (groupByArg) {
    const fields = groupByArg.slice('--groupBy='.length).split(',').map(s => s.trim());
    const invalid = fields.filter(f => !ALLOWED_FIELDS.includes(f as GroupByField));
    if (invalid.length > 0) {
      throw new Error(`--groupByに指定できないフィールドです: ${invalid.join(', ')}（指定可能: ${ALLOWED_FIELDS.join(', ')}）`);
    }
    groupBy = fields as GroupByField[];
  }
  return { years, groupBy };
}

function findFactFiles(dir: string, years: number[]): string[] {
  if (years.length > 0) {
    return years
      .map(y => path.join(dir, `race_facts_${y}.jsonl`))
      .filter(p => {
        if (!fs.existsSync(p)) {
          console.warn(`見つからないためスキップ: ${p}`);
          return false;
        }
        return true;
      });
  }
  return fs
    .readdirSync(dir)
    .filter(f => /^race_facts_\d{4}\.jsonl$/.test(f))
    .map(f => path.join(dir, f));
}

function readRecords(files: string[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      records.push(JSON.parse(line));
    }
  }
  return records;
}

function buildGroupKey(record: RaceFactRecord, groupBy: GroupByField[]): string {
  return groupBy.map(field => String(record[field as keyof RaceFactRecord] ?? 'NONE')).join('|');
}

function computeStats(values: number[]): BaselineStats {
  const count = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / count;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / count;
  return { count, mean, variance };
}

// raceLast3Fはレース単位の値（同じレースの馬全員で同じ値）なので、
// 単純に全レコードから集めると同じレースを出走頭数分だけ重複カウントしてしまう。
// レース識別キー（年・開催回・場所・日目・レース番号）で重複排除してから集計する。
function buildRaceKey(record: RaceFactRecord): string {
  return `${record.year}-${record.kaisai}-${record.location}-${record.day}-${record.raceNumber}`;
}

function computeLast3FBaselines(records: RaceFactRecord[], groupBy: GroupByField[]): Record<string, BaselineStats> {
  const seenRaces = new Set<string>();
  const grouped = new Map<string, number[]>();

  for (const record of records) {
    if (record.raceLast3F == null) continue;
    const raceKey = buildRaceKey(record);
    if (seenRaces.has(raceKey)) continue;
    seenRaces.add(raceKey);

    const key = buildGroupKey(record, groupBy);
    const list = grouped.get(key);
    if (list) {
      list.push(record.raceLast3F);
    } else {
      grouped.set(key, [record.raceLast3F]);
    }
  }

  const output: Record<string, BaselineStats> = {};
  for (const [key, values] of grouped) {
    output[key] = computeStats(values);
  }
  return output;
}

function main(): void {
  const argv = process.argv.slice(2);
  const { years, groupBy } = parseArgs(argv);

  const files = findFactFiles(__dirname, years);
  if (files.length === 0) {
    console.error('対象となるrace_facts_*.jsonlが見つかりません。先にimportJraResults.tsを実行してください。');
    process.exit(1);
  }
  console.log(`対象ファイル: ${files.map(f => path.basename(f)).join(', ')}`);
  console.log(`グループ化キー: ${groupBy.join(', ')}`);

  const records = readRecords(files);
  console.log(`読み込んだレコード数: ${records.length}`);

  const grouped = new Map<string, number[]>();
  for (const record of records) {
    if (record.distance <= 0 || record.totalSeconds <= 0) continue;
    const key = buildGroupKey(record, groupBy);
    const secondsPerMeter = record.totalSeconds / record.distance;
    const list = grouped.get(key);
    if (list) {
      list.push(secondsPerMeter);
    } else {
      grouped.set(key, [secondsPerMeter]);
    }
  }

  const output: Record<string, BaselineStats> = {};
  for (const [key, values] of grouped) {
    output[key] = computeStats(values);
  }

  const yearsLabel = years.length > 0 ? years.join('-') : 'all';
  const outPath = path.join(__dirname, `baseline_${groupBy.join('-')}_${yearsLabel}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`バケツ数: ${Object.keys(output).length}`);
  console.log(`出力先: ${outPath}`);

  const last3FOutput = computeLast3FBaselines(records, groupBy);
  const last3FOutPath = path.join(__dirname, `baseline_last3f_${groupBy.join('-')}_${yearsLabel}.json`);
  fs.writeFileSync(last3FOutPath, JSON.stringify(last3FOutput, null, 2));

  console.log(`上がり3F基準 バケツ数: ${Object.keys(last3FOutput).length}`);
  console.log(`上がり3F基準 出力先: ${last3FOutPath}`);
}

main();
