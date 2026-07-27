import React, { useState } from 'react';
import { parseCsvToHorses, scrapedHorsesToHorseData, scrapedHorsesToCsvText } from '../utils/horseParser';
import { parseJraHtml } from '../utils/getInfo';
import { LOW_CONFIDENCE_THRESHOLD } from '../utils/baseline';
import { computeWeightedBaselineSpeedIndex } from '../utils/raceWeighting';
import type { TodayRaceCondition } from '../utils/raceWeighting';
import type { HorseData, PastRace } from '../type/keibaType';
import './keibaPage.css';

type SortKey = 'none' | 'deviation';

export default function AnalyzerDashboard() {
  const [rawText, setRawText] = useState('');
  const [horses, setHorses] = useState<HorseData[]>([]);
  const [sortBy, setSortBy] = useState<SortKey>('none');
  // 今日のレース条件：出走メンバーの過去走を「今日と同じ条件に近いほど重視」して
  // 集計するために使う（ブラウザ内で完結する計算で、通信は発生しない）
  const [todayTrackType, setTodayTrackType] = useState<TodayRaceCondition['trackType']>('芝');
  const [todayDistance, setTodayDistance] = useState<number>(1600);

  const handleAnalyse = () => {
    const parsedData = parseCsvToHorses(rawText);
    setHorses(parsedData);
    setSortBy('none');
  };

const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const htmlText = event.target?.result as string;
    const scrapedRecords = parseJraHtml(htmlText);

    if (scrapedRecords.length === 0) {
      alert('有効な競馬データが検出できませんでした。JRAの出馬表（過去4走モード）のページであるか確認してください。');
      return;
    }

    // テキストエリアへの表示・手動編集用にCSV文字列は作るが、
    // これは「見せるだけ」で、解析には使わない
    setRawText(scrapedHorsesToCsvText(scrapedRecords));

    // 構造化データから直接HorseDataへ変換（文字列化・再パースを挟まない）
    setHorses(scrapedHorsesToHorseData(scrapedRecords));
    setSortBy('none');
  };
  reader.readAsText(file, 'Shift_JIS');
};

  const getProcessedHorses = () => {
    if (!horses || horses.length === 0) return [];

    const horsesWithStats = horses.map(horse => {
    const validRaces = horse.races.filter(
        (r): r is PastRace => r !== null && r.secondsPerMeter > 0
    );

    // 失速傾向：有効な過去走のうち半数以上が失速判定なら「失速しやすい馬」とみなす
    const slowFinishCount = validRaces.filter(r => r.isSlowFinish).length;
    const isSlowFinisher = validRaces.length > 0 && slowFinishCount / validRaces.length >= 0.5;

    const fastFinishCount = validRaces.filter(r => r.isFastFinish).length;
    const isFastFinisher = validRaces.length > 0 && fastFinishCount / validRaces.length >= 0.5;

    // 基準タイム比較指数：過去走ごとのbaselineSpeedIndexを、新しさ×基準の
    // 信頼度（サンプル数）×今日のレースとのサーフェス/距離一致度で重み付けして平均する。
    // 単純平均だと、芝ダ混在・距離バラバラな過去4走がそのまま同列に扱われてしまうため。
    const weightedBaseline = computeWeightedBaselineSpeedIndex(horse.races, {
      trackType: todayTrackType,
      distance: todayDistance,
    });
    const avgBaselineSpeedIndex = weightedBaseline?.value ?? null;
    const avgBaselineSpeedIndexConfidence = weightedBaseline?.confidencePercent ?? null;

    return { ...horse, isSlowFinisher, isFastFinisher, avgBaselineSpeedIndex, avgBaselineSpeedIndexConfidence };
    });

    // 偏差値は「今回の出走メンバー内での相対比較」という枠組みは維持しつつ、
    // 中身は条件補正していない生の秒/m平均ではなく、コース・距離・
    // 馬場状態・グレードで正規化済みのavgBaselineSpeedIndexを使う。
    const baselineAverages = horsesWithStats
      .map(h => h.avgBaselineSpeedIndex)
      .filter((v): v is number => v !== null);
    const groupAvg = baselineAverages.length > 0 ? baselineAverages.reduce((a, b) => a + b, 0) / baselineAverages.length : 0;
    const stdDev = Math.sqrt(baselineAverages.map(x => Math.pow(x - groupAvg, 2)).reduce((a, b) => a + b, 0) / (baselineAverages.length || 1));

    const withDeviation = horsesWithStats.map(h => ({
      ...h,
      deviation: h.avgBaselineSpeedIndex == null ? 0 : 50 + ((h.avgBaselineSpeedIndex - groupAvg) * 10 / (stdDev || 1))
    }));

    if (sortBy === 'deviation') return [...withDeviation].sort((a, b) => b.deviation - a.deviation);
    return withDeviation;
  };

  const processedHorses = getProcessedHorses();

  return (
    <div className="analyzer-container">
      {/* 入力エリア（条件に関わらず常に表示） */}
      <div className="input-area">
        <div className="today-condition">
          <span className="sort-label">今日のレース条件:</span>
          <select
            value={todayTrackType}
            onChange={(e) => setTodayTrackType(e.target.value as TodayRaceCondition['trackType'])}
          >
            <option value="芝">芝</option>
            <option value="ダ">ダート</option>
            <option value="障害">障害</option>
          </select>
          <input
            type="number"
            value={todayDistance}
            onChange={(e) => setTodayDistance(Number(e.target.value) || 0)}
            min={800}
            max={4300}
            step={100}
          />
          <span>m</span>
        </div>
        <input type="file" onChange={handleFileChange} />
        <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} />
        <button onClick={handleAnalyse}>手動解析</button>
      </div>

      {/* 結果エリア：データがある場合のみ表示 */}
      {processedHorses.length > 0 ? (
        <div className="result-container">
          <div className="sort-controls">
            <span className="sort-label">並び替え:</span>
            <button className={`btn-sort ${sortBy === 'none' ? 'active' : ''}`} onClick={() => setSortBy('none')}>馬番順</button>
            <button className={`btn-sort ${sortBy === 'deviation' ? 'active' : ''}`} onClick={() => setSortBy('deviation')}>📈 偏差値順</button>
          </div>

          <div className="result-card">
            <table className="table-main">
              <thead>
                <tr>
                  <th className="table-th">馬名</th>
                  <th className="table-th">統計データ</th>
                  <th className="table-th">基本情報</th>
                  {[...Array(4)].map((_, i) => (
                    <th key={i} className="table-th">{i === 0 ? '前走' : `${i + 1}走前`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {processedHorses.map((horse, index) => (
                  <tr key={index} className="table-tr">
                    <td className="table-td-name">{horse.name}</td>
                <td className="table-td-calc">
                <div className="calc-group">
                    <span className="calc-label">偏差値</span>
                    <span className={`calc-value ${(horse.deviation ?? 0) > 60 ? 'high-score' : ''}`}>
                    {horse.deviation ? horse.deviation.toFixed(1) : '-'}
                    </span>
                    {horse.deviation != null && horse.avgBaselineSpeedIndexConfidence != null && (
                    <span className="calc-confidence">
                        信頼度 {horse.avgBaselineSpeedIndexConfidence.toFixed(0)}%
                    </span>
                    )}
                </div>
                {horse.isSlowFinisher && (
                <div className="calc-group">
                    <span className="race-slowdown-badge">⚠️ 失速傾向</span>
                </div>
                )}
                {horse.isFastFinisher && (
                <div className="calc-group">
                    <span className="race-acceleration-badge">🚀 好走傾向</span>
                </div>
                )}
                </td>
                    <td className="table-td-info">{horse.info}</td>
                   {[...Array(4)].map((_, raceIdx) => {
                    const race = horse.races[raceIdx];
                    if (!race) return <td key={raceIdx} className="table-td-empty">データなし</td>;
                    return (
                        <td key={raceIdx} className="table-td-race">
                        <div className="race-speed">{race.secondsPerMeter.toFixed(4)} <span className="race-speed-unit">秒/m</span></div>
                        <div className="race-meta">{race.location}・{race.trackType}{race.distance}m{race.grade ? `（${race.grade}）` : ''}</div>
                        <div className="race-condition-badge">馬場: {race.condition}</div>
                        <div className="race-time">タイム: {race.timeStr}</div>
                        {race.baselineSpeedIndex != null ? (
                        <div className="race-condition-badge">
                            基準比較: {race.baselineSpeedIndex.toFixed(2)}
                            {race.baselineSampleCount != null && race.baselineSampleCount < LOW_CONFIDENCE_THRESHOLD ? `（参考値 n=${race.baselineSampleCount}）` : ''}
                        </div>
                        ) : (
                        <div className="race-condition-badge">基準比較: -（該当データなし）</div>
                        )}
                        {race.last3FBaselineIndex != null ? (
                        <div className="race-condition-badge">
                            上がり3F基準比較: {race.last3FBaselineIndex.toFixed(2)}
                            {race.last3FBaselineSampleCount != null && race.last3FBaselineSampleCount < LOW_CONFIDENCE_THRESHOLD ? `（参考値 n=${race.last3FBaselineSampleCount}）` : ''}
                        </div>
                        ) : (
                        <div className="race-condition-badge">上がり3F基準比較: -（該当データなし）</div>
                        )}
                        {race.isSlowFinish && (
                        <div className="race-slowdown-badge">
                            ⚠️ 失速 (+{race.last3FExcessSeconds?.toFixed(2)}秒)
                        </div>
                        )}
                        {race.isFastFinish && (
                        <div className="race-acceleration-badge">
                            🚀 好走の上がり ({race.last3FExcessSeconds?.toFixed(2)}秒)
                        </div>
                        )}
                        </td>
                    );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty-message">データが読み込まれていません。ファイルを選択するか、テキストを入力して解析してください。</div>
      )}
    </div>
  );
}