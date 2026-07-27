/**
 * raceClassText（結果PDF・出馬表どちらのテキストにも同じ表記で出現する）から、
 * クラス階級を大まかな序列(0〜4)に落とし込む。
 *
 * 【注意】3勝クラスはPDF上でも「〇〇特別」のような固有名でしか印字されず、
 * オープン特別・Listed・重賞と文字列だけでは区別できない。そのため3勝クラス以上は
 * すべて tier=4 に合流させる（gradeフィールドがあればG1/G2/G3としてさらに絞り込める）。
 */

export type RaceGrade = 'G1' | 'G2' | 'G3' | null;

export const CLASS_TIER_LABELS: Record<number, string> = {
  0: '新馬',
  1: '未勝利',
  2: '1勝クラス',
  3: '2勝クラス',
  4: '3勝クラス以上・OP',
};

export function extractClassTier(raceClassText: string, grade: RaceGrade): number {
  if (grade !== null) return 4;
  if (raceClassText.includes('新馬')) return 0;
  if (raceClassText.includes('未勝利')) return 1;
  if (raceClassText.includes('1勝クラス')) return 2;
  if (raceClassText.includes('2勝クラス')) return 3;
  return 4;
}
