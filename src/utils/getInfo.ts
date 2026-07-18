import * as cheerio from 'cheerio';
import type { PastRace } from "../type/keibaType";

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
      isFastFinish
    };
  } catch (error) {
    console.error('レースのパースに失敗しました:', raceText, error);
    return null;
  }
}