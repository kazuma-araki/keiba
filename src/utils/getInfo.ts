import * as cheerio from 'cheerio';
import type { PastRace } from "../type/keibaType";
import { computeBaselineSpeedIndex, computeLast3FBaselineIndex } from "./baseline";

export interface ScrapedHorse {
  horseName: string;
  race1: string;
  race2: string;
  race3: string;
  race4: string;
}

// 上がり3Fとみなす距離（m）。JRAの「上がり3F」は基本的に600m固定。
const LAST_SPURT_DISTANCE = 600;
// この秒数以上、前半の平均ペースより上がり3Fが遅ければ「失速」と判定する。
// 必要に応じて調整可能。
const SLOW_FINISH_THRESHOLD_SECONDS = 0.5;
// この秒数以上、前半の平均ペースより上がり3Fが速ければ「加速（好走の上がり）」と判定する。
// マイナス値で指定（last3FExcessSecondsがこれを下回ったら加速判定）
const FAST_FINISH_THRESHOLD_SECONDS = -0.5;

// jra-batch側の基準タイムと突き合わせるための競馬場名（10場）。
// raceTextの「日付の次のトークン」には開催回・日目などが付着することがあるため、
// この既知の場名リストで本来の場所名だけを抜き出す。
const KNOWN_TRACKS = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'];
function normalizeLocationForBaseline(raw: string): string | null {
  return KNOWN_TRACKS.find(t => raw.includes(t)) ?? null;
}

// 重賞グレードの検出（G1/G2/G3、全角Ｇ＋ローマ数字、半角G+アラビア数字/ローマ数字のいずれにも対応）
function detectGrade(raceText: string): 'G1' | 'G2' | 'G3' | null {
  const match = raceText.match(/[GＧ]\s*(Ⅰ|Ⅱ|Ⅲ|III|II|I|3|2|1)(?!\d)/);
  if (!match) return null;
  const marker = match[1];
  if (marker === 'Ⅰ' || marker === 'I' || marker === '1') return 'G1';
  if (marker === 'Ⅱ' || marker === 'II' || marker === '2') return 'G2';
  if (marker === 'Ⅲ' || marker === 'III' || marker === '3') return 'G3';
  return null;
}

/**
 * JRA出馬表HTMLから出走馬と過去4走のテキストデータを抽出する
 */
export function parseJraHtml(htmlText: string): ScrapedHorse[] {
  const $ = cheerio.load(htmlText);
  const records: ScrapedHorse[] = [];

  $('table').each((_, tableEl) => {
    const tableText = $(tableEl).text();
    if (
      tableText.includes('開催') &&
      tableText.includes('タイム') &&
      (tableText.includes('過去5年') || tableText.includes('成績'))
    ) {
      $(tableEl).remove();
    }
  });

  $(':contains("過去5年の成績")').each((_, el) => {
    if ($(el).is('h1, h2, h3, h4, h5, th, td, div')) {
      $(el).closest('div, section').remove();
    }
  });

  $('tr').each((_, el) => {
    if ($(el).find('script, style').length > 0) return;

    const tds = $(el).find('td');
    if (tds.length < 8) return; // 出走馬の行は8列固定

    let horseName = '';

    $(el).find('a').each((_, aEl) => {
      const text = $(aEl).text().replace(/[\s '"”]/g, '').trim();
      if (/^[ァ-ヶー]{2,9}$/.test(text) && !['血統', '写真', '動画', 'レース', '騎手'].includes(text)) {
        horseName = text;
        return false;
      }
    });

    if (!horseName) {
      const horseTd = $(el).find('.horse, .name, .horse_name');
      if (horseTd.length > 0) {
        const rawName = horseTd.text().replace(/[\s '"”]/g, '').trim();
        const match = rawName.match(/^[ァ-ヶー]{2,9}$/);
        if (match) {
          horseName = match[0];
        }
      }
    }

    if (!horseName || horseName.length > 9 || /[^ァ-ヶー]/.test(horseName)) return;

    // 過去走セルは常に「行の末尾4列」に固定されている
    const raceTds = tds.slice(-4);
    const races: string[] = [];
    raceTds.each((_, tdEl) => {
      const tdText = $(tdEl).text().replace(/[\s,，\r\n]+/g, ' ').trim();
      races.push(tdText || 'データなし');
    });

    if (horseName && races.length > 0) {
      records.push({
        horseName,
        race1: races[0] || 'データなし',
        race2: races[1] || 'データなし',
        race3: races[2] || 'データなし',
        race4: races[3] || 'データなし'
      });
    }
  });

  const seen = new Set();
  return records.filter(item => {
    if (seen.has(item.horseName)) return false;
    seen.add(item.horseName);
    return true;
  });
}

/**
 * 過去走のテキストから「1mあたりの秒数」や「1レース内の失速判定」を含めた
 * オブジェクトを生成する
 */
export function parseRaceText(raceText: string): PastRace | null {
  if (raceText.includes('JRAへ転入') || raceText.length < 20) return null;

  try {
    const dateLocationMatch = raceText.match(/^(\d+年\d+月\d+日)\s+(\S+)/);
    const dateStr = dateLocationMatch ? dateLocationMatch[1] : '不明';
    const location = dateLocationMatch ? dateLocationMatch[2] : '不明';

    const distanceTrackMatch = raceText.match(/(\d+)(芝|ダ|障害)m?/);
    if (!distanceTrackMatch) return null;
    const distance = parseInt(distanceTrackMatch[1], 10);
    const trackType = distanceTrackMatch[2] as '芝' | 'ダ' | '障害';

    const timeMatch = raceText.match(/(\d+)[:：](\d+)[.\uFF0E](\d+)/);
    if (!timeMatch) return null;
    const minutes = parseInt(timeMatch[1], 10);
    const seconds = parseInt(timeMatch[2], 10);
    const tenths = parseInt(timeMatch[3], 10);

    const totalSeconds = (minutes * 60) + seconds + (tenths / 10);
    const timeStr = `${minutes}:${seconds}.${tenths}`;

    const secondsPerMeter = parseFloat((totalSeconds / distance).toFixed(5));

    const conditionMatch = raceText.match(/(?:[:\d.]+)\s+(良|稍重|重|不良)/);
    const condition = conditionMatch ? conditionMatch[1] : '不明';

    const last3FMatch = raceText.match(/3F\s+([\d.]+)/);
    const last3F = last3FMatch ? parseFloat(last3FMatch[1]) : null;

    // 【追加】1レース内の失速判定
    // 前半(距離-600m)の平均ペースから、上がり3Fの「期待タイム」を逆算し、
    // 実際の上がり3Fタイムとの差分(秒)を求める。プラスが大きいほど失速。
    let last3FExcessSeconds: number | null = null;
    const frontDistance = distance - LAST_SPURT_DISTANCE;
    if (last3F !== null && frontDistance > 0) {
      const frontSeconds = totalSeconds - last3F;
      const frontPacePerMeter = frontSeconds / frontDistance;
      const expectedLast3F = frontPacePerMeter * LAST_SPURT_DISTANCE;
      last3FExcessSeconds = parseFloat((last3F - expectedLast3F).toFixed(2));
    }
    const isSlowFinish =
      last3FExcessSeconds !== null && last3FExcessSeconds > SLOW_FINISH_THRESHOLD_SECONDS;
    const isFastFinish =
      last3FExcessSeconds !== null && last3FExcessSeconds < FAST_FINISH_THRESHOLD_SECONDS;

    const grade = detectGrade(raceText);

    // 基準タイムとの突き合わせ（jra-batchが生成した静的JSONをバンドルしているだけなので
    // 通信は発生しない＝追加コストなし）。場所名が既知の10場に一致しない場合など、
    // 該当する基準が無ければnullのまま。
    const baselineLocation = normalizeLocationForBaseline(location);
    const baselineResult = baselineLocation
      ? computeBaselineSpeedIndex(secondsPerMeter, baselineLocation, trackType, distance, condition, grade)
      : null;

    // 上がり3F基準との突き合わせ。この馬個別の上がり3Fを、同条件のレース全体の
    // 参考上がり3F基準と比べる（レース単位の基準である点はbaseline.ts参照）。
    const last3FBaselineResult =
      baselineLocation && last3F !== null
        ? computeLast3FBaselineIndex(last3F, baselineLocation, trackType, distance, condition, grade)
        : null;

    return {
      dateStr,
      location,
      condition,
      trackType,
      distance,
      timeStr,
      totalSeconds,
      secondsPerMeter,
      last3F,
      last3FExcessSeconds,
      isSlowFinish,
      isFastFinish,
      grade,
      baselineSpeedIndex: baselineResult?.speedIndex ?? null,
      baselineSampleCount: baselineResult?.sampleCount ?? null,
      last3FBaselineIndex: last3FBaselineResult?.speedIndex ?? null,
      last3FBaselineSampleCount: last3FBaselineResult?.sampleCount ?? null
    };
  } catch (error) {
    console.error('レースのパースに失敗しました:', raceText, error);
    return null;
  }
}