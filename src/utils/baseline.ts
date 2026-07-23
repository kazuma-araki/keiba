import baselineData from '../data/baseline.json';
import last3fBaselineData from '../data/last3fBaseline.json';

/**
 * jra-batch（コース×距離×馬場状態×重賞グレードごとの秒/m基準タイム、および
 * 同条件の参考上がり3F基準）が生成した静的JSONをそのままバンドルして使う。
 * 外部への通信は発生しない（＝実行時の従量課金は発生しない）。データを更新したい
 * 場合は jra-batch/computeBaselines.ts の出力をこのファイルに上書きコピーする。
 */

export interface BaselineStats {
  count: number;
  mean: number; // 秒/mの平均（上がり3F基準は秒そのものの平均）
  variance: number;
}

const BASELINE: Record<string, BaselineStats> = baselineData;
const LAST3F_BASELINE: Record<string, BaselineStats> = last3fBaselineData;

// バケツのサンプル数がこれ未満の場合は「参考値」として扱う目安
export const LOW_CONFIDENCE_THRESHOLD = 20;

function buildKey(location: string, trackType: string, distance: number, condition: string, grade: string | null): string {
  return `${location}|${trackType}|${distance}|${condition}|${grade ?? 'NONE'}`;
}

/**
 * 指定条件に一致する基準タイムを探す。該当グレードのバケツが無ければ
 * 非重賞（NONE）にフォールバックする。それも無ければ null（正規化不能）。
 */
export function lookupBaseline(
  location: string,
  trackType: string,
  distance: number,
  condition: string,
  grade: string | null
): BaselineStats | null {
  const exact = BASELINE[buildKey(location, trackType, distance, condition, grade)];
  if (exact) return exact;

  if (grade !== null) {
    const fallback = BASELINE[buildKey(location, trackType, distance, condition, null)];
    if (fallback) return fallback;
  }

  return null;
}

/**
 * 基準タイムに対してどれだけ速い/遅いかをスコア化する（zスコア相当）。
 * プラスが大きいほど基準より速い（好走）。バケツが見つからない場合はnull。
 */
export function computeBaselineSpeedIndex(
  secondsPerMeter: number,
  location: string,
  trackType: string,
  distance: number,
  condition: string,
  grade: string | null
): { speedIndex: number; sampleCount: number } | null {
  const stats = lookupBaseline(location, trackType, distance, condition, grade);
  if (!stats || stats.variance <= 0) return null;

  const speedIndex = (stats.mean - secondsPerMeter) / Math.sqrt(stats.variance);
  return { speedIndex, sampleCount: stats.count };
}

/**
 * 上がり3F基準：同条件のレース全体の参考上がり3Fと比べたzスコア。
 * 個々の馬の上がり3Fと、レース単位の基準値を比べる点に注意（①の説明を参照）。
 * baseline.jsonと同じキー構造のlast3fBaseline.jsonを参照する。
 */
export function lookupLast3FBaseline(
  location: string,
  trackType: string,
  distance: number,
  condition: string,
  grade: string | null
): BaselineStats | null {
  const exact = LAST3F_BASELINE[buildKey(location, trackType, distance, condition, grade)];
  if (exact) return exact;

  if (grade !== null) {
    const fallback = LAST3F_BASELINE[buildKey(location, trackType, distance, condition, null)];
    if (fallback) return fallback;
  }

  return null;
}

export function computeLast3FBaselineIndex(
  last3F: number,
  location: string,
  trackType: string,
  distance: number,
  condition: string,
  grade: string | null
): { speedIndex: number; sampleCount: number } | null {
  const stats = lookupLast3FBaseline(location, trackType, distance, condition, grade);
  if (!stats || stats.variance <= 0) return null;

  const speedIndex = (stats.mean - last3F) / Math.sqrt(stats.variance);
  return { speedIndex, sampleCount: stats.count };
}
