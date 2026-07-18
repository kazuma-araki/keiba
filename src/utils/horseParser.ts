import type { HorseData, PastRace } from "../type/keibaType";
import { parseRaceText } from "./getInfo";
import type { ScrapedHorse } from "./getInfo";

/**
 * 名前・基本情報・過去走テキスト配列(最大4件)から HorseData を組み立てる共通処理。
 * CSVテキスト由来でも、HTMLスクレイピングの構造化データ由来でも、
 * 最終的なレース文字列→PastRaceへの変換はこの1箇所だけを通る。
 */
function buildHorseData(name: string, info: string, raceTexts: string[]): HorseData {
  const races: PastRace[] = [];

  for (const text of raceTexts.slice(0, 4)) {
    if (!text) continue;
    const raceObj = parseRaceText(text);
    if (raceObj) races.push(raceObj);
  }

  return { name, info, races };
}

/**
 * CSVの1行をRFC4180に準拠した形で分割する。
 */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * コピペされたCSVテキスト全体を解析してHorseData配列に変換する。
 * 手動貼り付け経路（テキストエリア＋「手動解析」ボタン）専用。
 */
export function parseCsvToHorses(csvText: string): HorseData[] {
  const lines = csvText.trim().split(/\r?\n/);
  const result: HorseData[] = [];

  const startIndex = lines[0]?.includes('馬名') ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = splitCsvLine(line);
    if (parts.length < 2) continue;

    const name = parts[0].replace(/['"`”]/g, '').trim();
    if (!name || name.includes('平均') || name.includes('最速') || name.length > 9) continue;

    const info = parts[1] || '';
    result.push(buildHorseData(name, info, parts.slice(2)));
  }

  return result;
}

/**
 * parseJraHtml が返す ScrapedHorse[] を、CSV文字列を経由せず
 * 直接 HorseData[] に変換する。ファイルアップロード経路専用。
 */
export function scrapedHorsesToHorseData(scraped: ScrapedHorse[]): HorseData[] {
  return scraped.map(h =>
    buildHorseData(h.horseName, '', [h.race1, h.race2, h.race3, h.race4])
  );
}

/**
 * テキストエリアに表示するためだけのCSV文字列を作る（表示・手動編集用途のみ。
 * パースの入力には使わない）。
 */
export function scrapedHorsesToCsvText(scraped: ScrapedHorse[]): string {
  return scraped
    .map(r => `"${r.horseName}","","${r.race1}","${r.race2}","${r.race3}","${r.race4}"`)
    .join('\n');
}