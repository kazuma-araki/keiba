import type { PastRace } from '../type/keibaType';

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
