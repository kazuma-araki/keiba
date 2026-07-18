import React, { useState } from 'react';
import { parseCsvToHorses, scrapedHorsesToHorseData, scrapedHorsesToCsvText } from '../utils/horseParser';
import { parseJraHtml } from '../utils/getInfo';
import type { HorseData, PastRace } from '../type/keibaType';
import './keibaPage.css'; 

type SortKey = 'none' | 'best' | 'avg' | 'deviation';

export default function AnalyzerDashboard() {
  const [rawText, setRawText] = useState('');
  const [horses, setHorses] = useState<HorseData[]>([]);
  const [sortBy, setSortBy] = useState<SortKey>('none');

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
    const speeds = validRaces.map(r => r.secondsPerMeter);
    const bestSpeed = speeds.length > 0 ? Math.min(...speeds) : 999;
    const avgSpeed = speeds.length > 0 ? speeds.reduce((sum, s) => sum + s, 0) / speeds.length : 999;
    
    // 失速傾向：有効な過去走のうち半数以上が失速判定なら「失速しやすい馬」とみなす
    const slowFinishCount = validRaces.filter(r => r.isSlowFinish).length;
    const isSlowFinisher = validRaces.length > 0 && slowFinishCount / validRaces.length >= 0.5;

    const fastFinishCount = validRaces.filter(r => r.isFastFinish).length;
    const isFastFinisher = validRaces.length > 0 && fastFinishCount / validRaces.length >= 0.5;

    return { ...horse, bestSpeed, avgSpeed, isSlowFinisher, isFastFinisher };
    });

    const averages = horsesWithStats.map(h => h.avgSpeed).filter(v => v !== 999);
    const groupAvg = averages.length > 0 ? averages.reduce((a, b) => a + b, 0) / averages.length : 0;
    const stdDev = Math.sqrt(averages.map(x => Math.pow(x - groupAvg, 2)).reduce((a, b) => a + b, 0) / (averages.length || 1));

    const withDeviation = horsesWithStats.map(h => ({
      ...h,
      deviation: h.avgSpeed === 999 ? 0 : 50 + ((groupAvg - h.avgSpeed) * 10 / (stdDev || 1))
    }));

    if (sortBy === 'best') return [...withDeviation].sort((a, b) => a.bestSpeed - b.bestSpeed);
    if (sortBy === 'avg') return [...withDeviation].sort((a, b) => a.avgSpeed - b.avgSpeed);
    if (sortBy === 'deviation') return [...withDeviation].sort((a, b) => b.deviation - a.deviation);
    return withDeviation;
  };

  const processedHorses = getProcessedHorses();

  return (
    <div className="analyzer-container">
      {/* 入力エリア（条件に関わらず常に表示） */}
      <div className="input-area">
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
            <button className={`btn-sort ${sortBy === 'best' ? 'active' : ''}`} onClick={() => setSortBy('best')}>🚀 最高スピード順</button>
            <button className={`btn-sort ${sortBy === 'avg' ? 'active' : ''}`} onClick={() => setSortBy('avg')}>📊 平均スピード順</button>
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
                </div>
                <div className="calc-group">
                    <span className="calc-label">過去最速</span>
                    <span className="calc-value">{horse.bestSpeed === 999 ? '-' : horse.bestSpeed.toFixed(4)}</span>
                </div>
                <div className="calc-group">
                    <span className="calc-label">4走平均</span>
                    <span className="calc-value">{horse.avgSpeed === 999 ? '-' : horse.avgSpeed.toFixed(4)}</span>
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
                        <div className="race-meta">{race.location}・{race.trackType}{race.distance}m</div>
                        <div className="race-condition-badge">馬場: {race.condition}</div>
                        <div className="race-time">タイム: {race.timeStr}</div>
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