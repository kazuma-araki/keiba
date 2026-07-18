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
}