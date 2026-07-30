import type { PastRace } from '../type/keibaType';
import jockeyZScoreData from '../data/jockeyZScore.json';
import distanceIntervalStats from '../data/distanceIntervalStats.json';

/**
 * 過去走ごとの「基準比較指数」を平均する際の重み付けロジック。
 * 単純平均だと、新しさ・基準タイムの信頼度・今日のレースとの条件差を
 * 一切考慮できないため、以下の3軸をかけ合わせて重みを決める。
 */

// 新しさ：前走(index 0)を最も重視し、古いほど軽くする
const RECENCY_WEIGHTS = [1.0, 0.8, 0.6, 0.4];

// 基準タイムの信頼度：このサンプル数以上あれば満額の重みを与える
const RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT = 50;

// サーフェス（芝/ダ/障害）が今日のレースと異なる過去走の重み（0〜1）。
// 別サーフェスの経験も無関係ではないが、そのまま同列には扱えないため大きく割り引く。
const DIFFERENT_SURFACE_WEIGHT = 0.3;

// 距離差による重みの減衰（1mあたりの減衰量）と下限
const DISTANCE_DECAY_PER_METER = 1 / 800; // 800m差でおよそ0.2まで減衰
const MIN_DISTANCE_WEIGHT = 0.2;

// 騎手勝率（jra-batchのjockeyBlendBacktest.tsで4期間ウォークフォワード検証済み）を
// avgBaselineSpeedIndexにどれだけ加味するかの重み。alpha=0.1で単勝的中率が
// 4期間すべてで安定して改善したため採用（回収率は市場並みで、それ自体を
// 押し上げる効果は無いが、的中率の改善は再現性がある）。
const ALPHA_JOCKEY = 0.1;
const jockeyZScoreMap = jockeyZScoreData as Record<string, number>;

/**
 * 騎手名から、train期間の勝率を平均・標準偏差でzスコア化した値を引く。
 * 未収録（騎乗数不足・新人・未知の騎手）の場合は0（平均的）として扱う。
 */
export function computeJockeyZ(jockeyName: string | null | undefined): number {
  if (!jockeyName) return 0;
  return jockeyZScoreMap[jockeyName] ?? 0;
}

// 距離変更（延長ほど減点・短縮ほど加点）・間隔（休み明けほど加点）を
// avgBaselineSpeedIndexにどれだけ加味するかの重み。jra-batchの
// distanceIntervalBlendBacktest.tsで4期間ウォークフォワード検証済み
// （複勝回収率が4期間すべて、上位3件の大穴を除いても現行モデルを上回る組み合わせ）。
const ALPHA_INTERVAL = 0.1;
const ALPHA_DISTANCE = 0.05;

/**
 * 前走の距離・日付から、距離変更・間隔のzスコアを計算する。
 * 前走が無い（初出走等）場合や日付が読み取れない場合は0（平均的）として扱う。
 */
export function computeDistanceIntervalZ(
  recentRace: PastRace | null,
  today: TodayRaceCondition & { dateStr?: string }
): { distanceDeltaZ: number; intervalZ: number } {
  if (!recentRace) return { distanceDeltaZ: 0, intervalZ: 0 };

  const distanceDelta = today.distance - recentRace.distance;
  const distanceDeltaZ = (distanceDelta - distanceIntervalStats.ddMean) / distanceIntervalStats.ddStd;

  let intervalZ = 0;
  const recentEpochDays = dateStrToEpochDays(recentRace.dateStr);
  const todayEpochDays = today.dateStr ? dateStrToEpochDays(today.dateStr) : null;
  if (recentEpochDays != null && todayEpochDays != null) {
    const interval = todayEpochDays - recentEpochDays;
    intervalZ = (interval - distanceIntervalStats.ivMean) / distanceIntervalStats.ivStd;
  }

  return { distanceDeltaZ, intervalZ };
}

function dateStrToEpochDays(dateStr: string): number | null {
  const m = dateStr.match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  return Math.floor(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / 86400000);
}

/**
 * avgBaselineSpeedIndexに騎手係数・距離変更・間隔を加味したブレンドスコアを計算する。
 * avgBaselineSpeedIndexがnull（過去走データが無い等）の場合はnullのまま返す。
 */
export function computeBlendedSpeedIndex(
  avgBaselineSpeedIndex: number | null,
  jockeyName: string | null | undefined,
  distanceIntervalZ?: { distanceDeltaZ: number; intervalZ: number } | null
): number | null {
  if (avgBaselineSpeedIndex == null) return null;
  const diz = distanceIntervalZ ?? { distanceDeltaZ: 0, intervalZ: 0 };
  return (
    avgBaselineSpeedIndex +
    ALPHA_JOCKEY * computeJockeyZ(jockeyName) +
    ALPHA_INTERVAL * diz.intervalZ -
    ALPHA_DISTANCE * diz.distanceDeltaZ
  );
}

export interface TodayRaceCondition {
  trackType: '芝' | 'ダ' | '障害';
  distance: number;
}

function recencyWeight(slotIndex: number): number {
  return RECENCY_WEIGHTS[slotIndex] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
}

function reliabilityWeight(sampleCount: number | null): number {
  if (sampleCount == null) return 0;
  return Math.min(1, sampleCount / RELIABILITY_FULL_CONFIDENCE_SAMPLE_COUNT);
}

function surfaceMatchWeight(raceTrackType: PastRace['trackType'], today: TodayRaceCondition): number {
  return raceTrackType === today.trackType ? 1 : DIFFERENT_SURFACE_WEIGHT;
}

function distanceMatchWeight(raceDistance: number, today: TodayRaceCondition): number {
  const diff = Math.abs(raceDistance - today.distance);
  return Math.max(MIN_DISTANCE_WEIGHT, 1 - diff * DISTANCE_DECAY_PER_METER);
}

/**
 * 過去走1件分の重みを算出する。slotIndexは「前走=0, 2走前=1, ...」という
 * 元のスロット位置（パース失敗で詰めていない配列でのインデックス）。
 */
export function computeRaceWeight(race: PastRace, slotIndex: number, today: TodayRaceCondition): number {
  return (
    recencyWeight(slotIndex) *
    reliabilityWeight(race.baselineSampleCount) *
    surfaceMatchWeight(race.trackType, today) *
    distanceMatchWeight(race.distance, today)
  );
}

// 全4走が「新しさ満額×信頼度満額×条件完全一致」だった場合の理論上の重み合計。
// 実際の重み合計をこれで割ることで、0〜100%の信頼度として表示できる。
const MAX_POSSIBLE_WEIGHT_SUM = RECENCY_WEIGHTS.reduce((sum, w) => sum + w, 0);

export interface WeightedBaselineResult {
  value: number;
  // avgBaselineSpeedIndexがどれだけ厚みのあるデータに基づくかの目安（0〜100%）。
  // 低いほど「過去走の大半が今日と条件違い、または基準タイムのサンプルが薄い」ことを示す。
  confidencePercent: number;
}

/**
 * 過去走配列（nullスロットを含む）から、重み付き平均のbaselineSpeedIndexを計算する。
 * baselineSpeedIndexが無い（該当基準なし）走は重み0として扱われ、寄与しない。
 */
export function computeWeightedBaselineSpeedIndex(
  races: (PastRace | null)[],
  today: TodayRaceCondition
): WeightedBaselineResult | null {
  let weightedSum = 0;
  let weightSum = 0;

  races.forEach((race, slotIndex) => {
    if (!race || race.secondsPerMeter <= 0 || race.baselineSpeedIndex == null) return;
    const weight = computeRaceWeight(race, slotIndex, today);
    weightedSum += weight * race.baselineSpeedIndex;
    weightSum += weight;
  });

  if (weightSum <= 0) return null;

  return {
    value: weightedSum / weightSum,
    confidencePercent: Math.min(100, (weightSum / MAX_POSSIBLE_WEIGHT_SUM) * 100),
  };
}
