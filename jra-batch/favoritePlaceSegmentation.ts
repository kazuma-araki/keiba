/**
 * favoritePlaceBacktest.tsで確認した「複勝は1〜2番人気がフェイバリット・ロングショット・
 * バイアスでほぼ理論公正価格で払い戻される（実回収率84〜90%）」という構造が、
 * レースの属性によってさらに強くなる区間があるかを調べる。
 *
 * 切り口はすべて「レース前から分かる」もの（結果を見て後から選んだ切り口ではない）:
 *   - グレード（重賞 G1/G2/G3 か平場か）
 *   - 出走頭数（少頭数／中頭数／多頭数）
 *   - トラック種別（芝／ダート）
 *   - 距離（短距離／マイル／中距離／長距離）
 *   - 1番人気自身の単勝オッズの絶対水準（オッズが低い＝堅い人気か、そこそこ人気か）
 *
 *   npx ts-node favoritePlaceSegmentation.ts
 */

import * as fs from 'fs';
import * as path from 'path';

type RaceGrade = 'G1' | 'G2' | 'G3' | null;

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; horseName: string; finishRank: number;
  distance: number; trackType: string; grade: RaceGrade;
  odds: number | null; winPayout: number | null; placePayouts: number[];
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

const UNIT_STAKE = 100;
interface Bucket { races: number; hits: number; cost: number; returned: number; }
function newBucket(): Bucket { return { races: 0, hits: 0, cost: 0, returned: 0 }; }
function addBet(b: Bucket, horse: RaceFactRecord): void {
  b.races++; b.cost += UNIT_STAKE;
  if (horse.finishRank >= 1 && horse.finishRank <= 3 && horse.placePayouts.length >= horse.finishRank) {
    b.hits++; b.returned += horse.placePayouts[horse.finishRank - 1];
  }
}
function fmtBucket(b: Bucket): string {
  const hitRate = b.races > 0 ? (b.hits / b.races) * 100 : 0;
  const roi = b.cost > 0 ? (b.returned / b.cost) * 100 : 0;
  return `的中率=${hitRate.toFixed(1)}% 回収率=${roi.toFixed(1)}% (n=${b.races})`;
}

function gradeLabel(g: RaceGrade): string { return g ?? '平場(重賞以外)'; }
function fieldSizeLabel(n: number): string {
  if (n <= 8) return '少頭数(〜8頭)';
  if (n <= 12) return '中頭数(9-12頭)';
  if (n <= 16) return '多頭数(13-16頭)';
  return '超多頭数(17頭〜)';
}
function distanceLabel(d: number): string {
  if (d <= 1400) return '短距離(〜1400m)';
  if (d <= 1800) return 'マイル(1401-1800m)';
  if (d <= 2200) return '中距離(1801-2200m)';
  return '長距離(2201m〜)';
}
function oddsLevelLabel(o: number): string {
  if (o < 1.5) return '超堅(オッズ1.5未満)';
  if (o < 2.5) return '堅い(1.5-2.5)';
  if (o < 4.0) return 'やや堅い(2.5-4.0)';
  return '混戦(4.0以上)';
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const races = new Map<string, RaceFactRecord[]>();
  for (const r of allRecords) {
    if (r.odds == null || r.odds <= 0 || !(r.finishRank > 0)) continue;
    const key = raceKeyOf(r);
    (races.get(key) ?? races.set(key, []).get(key)!).push(r);
  }

  const byGrade = new Map<string, Bucket>();
  const byFieldSize = new Map<string, Bucket>();
  const byTrackType = new Map<string, Bucket>();
  const byDistance = new Map<string, Bucket>();
  const byOddsLevel = new Map<string, Bucket>();

  for (const horses of races.values()) {
    if (horses.length < 5) continue;
    const byOdds = [...horses].sort((a, b) => a.odds! - b.odds!);
    const favorite = byOdds[0]; // 1番人気のみを対象に切り分ける
    if (!favorite) continue;

    const gKey = gradeLabel(favorite.grade);
    (byGrade.get(gKey) ?? byGrade.set(gKey, newBucket()).get(gKey)!);
    addBet(byGrade.get(gKey)!, favorite);

    const fKey = fieldSizeLabel(horses.length);
    (byFieldSize.get(fKey) ?? byFieldSize.set(fKey, newBucket()).get(fKey)!);
    addBet(byFieldSize.get(fKey)!, favorite);

    const tKey = favorite.trackType;
    (byTrackType.get(tKey) ?? byTrackType.set(tKey, newBucket()).get(tKey)!);
    addBet(byTrackType.get(tKey)!, favorite);

    const dKey = distanceLabel(favorite.distance);
    (byDistance.get(dKey) ?? byDistance.set(dKey, newBucket()).get(dKey)!);
    addBet(byDistance.get(dKey)!, favorite);

    const oKey = oddsLevelLabel(favorite.odds!);
    (byOddsLevel.get(oKey) ?? byOddsLevel.set(oKey, newBucket()).get(oKey)!);
    addBet(byOddsLevel.get(oKey)!, favorite);
  }

  console.log('=== 1番人気・複勝の回収率（切り口別） ===\n');
  console.log('--- グレード別 ---');
  for (const [k, b] of byGrade) console.log(`${k}: ${fmtBucket(b)}`);
  console.log('\n--- 出走頭数別 ---');
  for (const [k, b] of byFieldSize) console.log(`${k}: ${fmtBucket(b)}`);
  console.log('\n--- トラック種別 ---');
  for (const [k, b] of byTrackType) console.log(`${k}: ${fmtBucket(b)}`);
  console.log('\n--- 距離別 ---');
  for (const [k, b] of byDistance) console.log(`${k}: ${fmtBucket(b)}`);
  console.log('\n--- 1番人気自身のオッズ水準別 ---');
  for (const [k, b] of byOddsLevel) console.log(`${k}: ${fmtBucket(b)}`);
}

main();
