export interface PastRace {
  dateStr: string;
  location: string;
  condition: string;
  trackType: '芝' | 'ダ' | '障害' | '不明';
  distance: number;
  timeStr: string;
  totalSeconds: number;
  secondsPerMeter: number;
  last3F: number | null;
  // 【追加】上がり3Fが「それまでの平均ペースで走った場合の期待タイム」より
  // 何秒遅かったか。プラスが大きいほど後半に失速している。
  // distanceが600m以下、またはlast3Fが取得できない場合はnull。
  last3FExcessSeconds: number | null;
  // last3FExcessSeconds が一定の閾値を超えていたら true（1レース単位の失速判定）
  isSlowFinish: boolean;
  // last3FExcessSeconds が一定の閾値を下回っていたら true（1レース単位の加速判定＝好走の上がり）
  isFastFinish: boolean;
  // 重賞グレード（G1/G2/G3）。レーステキストから検出できなければnull（一般戦・特別戦等）。
  grade: 'G1' | 'G2' | 'G3' | null;
  // 同条件（競馬場・トラック種別・距離・馬場状態・グレード）の基準タイムに対するzスコア。
  // プラスが大きいほど基準より速い。該当する基準タイムが無い場合はnull。
  baselineSpeedIndex: number | null;
  // baselineSpeedIndexの算出根拠となった基準タイムのサンプル数（少ないほど参考値）。
  baselineSampleCount: number | null;
  // 同条件のレース全体の参考上がり3Fに対するzスコア（この馬個別のではなくレース単位の基準と比較）。
  // プラスが大きいほど基準より速い上がり。該当する基準が無ければnull。
  last3FBaselineIndex: number | null;
  last3FBaselineSampleCount: number | null;
}

export interface HorseData {
  name: string;
  info: string;
  // 【変更】パースに失敗した過去走はnullのままスロットを保持する。
  // 「前走・2走前・3走前・4走前」という位置の意味を守るため、
  // 失敗分を詰めて(compactして)配列を短くしないようにする。
  races: (PastRace | null)[];
  // オプショナルな分析用プロパティ
  bestSpeed?: number;
  avgSpeed?: number;
  deviation?: number;
  avg3F?: number;
  hasFrontalCollapse?: boolean; // 先行大敗検知
  isSlowFinisher?: boolean;     // 失速傾向判定
  isFastFinisher?: boolean;     // 好走の上がり（加速）傾向判定
  // 過去走のbaselineSpeedIndexの平均（コース・距離・馬場状態・グレードで正規化済み）。
  // 今回の出走メンバー内だけで比較するdeviationと違い、条件が異なる過去走同士も比較できる。
  avgBaselineSpeedIndex?: number | null;
  // avgBaselineSpeedIndexの信頼度（0〜100%）。新しさ×基準の信頼度×今日の条件との
  // 一致度で決まる重みの合計が、理論上の最大値に対してどれだけあるかを表す。
  // 低いほど「過去走の大半が今日と条件違い、または基準タイムが薄い」ことを意味する。
  avgBaselineSpeedIndexConfidence?: number | null;
}