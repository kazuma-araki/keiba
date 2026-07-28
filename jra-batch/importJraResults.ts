/**
 * JRAの「年度別全成績（PDF）」を総当たりで取得し、レース×出走馬単位の生データを
 * race_facts_<年>.jsonl に追記していく（1行1レコードのJSON Lines）。
 *
 * このスクリプトは生データの収集だけを行う。基準タイム・スピード指数などの集計は
 * computeBaselines.ts が race_facts_*.jsonl を読み込んで別バッチとして行う。
 * 生データさえ残しておけば、集計の切り口（クラス別・年別など）は後から何度でも
 * 作り直せる。
 *
 * 【実行方法】
 *   npm install
 *   npx ts-node importJraResults.ts 2025
 *   npx ts-node importJraResults.ts 2025 --test   （動作確認モード。1競馬場・数日分だけに絞る）
 *   （年を省略すると現在年になる）
 *
 * 【蓄積・再実行について】
 * - 開催回×競馬場×日目ごとに取り込み済みかどうかを manifest_<年>.json に記録する。
 *   同じ組み合わせは再実行時にフェッチせずスキップするため、同じコマンドを
 *   何度再実行しても重複データが増えることはない。
 * - ただし404（該当PDFなし）はmanifestに載せない。今年（現在進行中のシーズン）は
 *   「まだ開催されていないだけ」の可能性があるため、毎回律儀に再チェックする。
 *   過去年については404が404のままなので多少無駄にはなるが、正しさを優先している。
 * - JRAは毎週開催があるため、このスクリプトは週次などで同じコマンドを再実行する
 *   運用を想定している（新しく増えた開催分だけ取得・追記される）。
 *
 * 【注意】
 * - Node.js 18以降を想定（グローバルfetchを使用）。
 * - JRAサーバーへの配慮として、1リクエストごとにDELAY_MSだけ間隔を空けている。
 *   実行前に値を見直してから流してほしい（manifestでスキップされた分は待たない）。
 * - 開催回・日目は存在しない組み合わせの方が多い（総当たりなので404が大半になる）。
 *   404は静かにスキップする想定で作っている。404以外のHTTPエラーやタイムアウトは
 *   区別してログに出す。
 * - PDFのテキスト抽出は pdf-parse 2.x（内部的に pdfjs-dist）の PDFParse クラスを使用。
 *   日本語部分の文字化け対策として pdfjs-dist 同梱のCMap・標準フォントを明示的に渡している。
 * - 実行を途中で止めても（Ctrl+C以外の異常終了時も）、その時点までの取り込み結果は
 *   JSONL・manifestともに残る。
 */

import * as fs from 'fs';
import * as path from 'path';
import { PDFParse } from 'pdf-parse';
import { parseDayResultText, ParsedRaceResult, ParseDiagnostics, createParseDiagnostics, mergeDiagnostics } from './parseResultText';

const TRACK_CODES: Record<string, string> = {
  sapporo: '札幌',
  hakodate: '函館',
  fukushima: '福島',
  niigata: '新潟',
  tokyo: '東京',
  nakayama: '中山',
  chukyo: '中京',
  kyoto: '京都',
  hanshin: '阪神',
  kokura: '小倉',
};

const MAX_KAISAI = 6; // 開催回の総当たり上限（余裕を持たせた値）
const MAX_DAY = 12; // 開催日目の総当たり上限
const DELAY_MS = 1000; // リクエスト間隔（サーバーへの配慮。必要に応じて調整）
const FETCH_TIMEOUT_MS = 15000; // 1リクエストあたりのタイムアウト

// 【動作確認用】コマンドライン引数に --test を付けたときだけ、
// 1つの競馬場・1開催・数日分だけに絞って試す。
const TEST_MODE_CONFIG = {
  trackCode: 'kokura', // 絞り込む競馬場（TRACK_CODESのキー）
  kaisai: 1,
  maxDay: 2, // この日数までしか試さない
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface FetchResult {
  text: string | null;
  status: number | null; // ネットワークエラー・タイムアウト時はnull
}

// JRAのPDFは日本語部分がType0/Identity-H合成フォントで埋め込まれており、
// pdfjs-dist側にCMap・標準フォントのリソースを渡さないとグリフを正しく
// Unicodeへ変換できず、日本語部分だけ文字化けする（数字・英字は化けない）。
// pdf-parseが依存としてインストールする pdfjs-dist に同梱されたリソースをそのまま使う。
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const toResourceUrl = (p: string) => p.split(path.sep).join('/') + '/';
const CMAP_URL = toResourceUrl(path.join(PDFJS_ROOT, 'cmaps'));
const STANDARD_FONT_DATA_URL = toResourceUrl(path.join(PDFJS_ROOT, 'standard_fonts'));

async function fetchPdfText(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { text: null, status: res.status };

    const buffer = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({
      data: buffer,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    });
    try {
      // pageJoinerはデフォルトだと"-- N of M --"のような文字列をページ区切りに
      // 挿入してしまい、距離・タイムの数値抽出用の正規表現に混入する恐れがあるため無効化する。
      const result = await parser.getText({ pageJoiner: '' });
      return { text: result.text, status: res.status };
    } finally {
      await parser.destroy();
    }
  } finally {
    clearTimeout(timer);
  }
}

// race_facts_<年>.jsonl の1行分（レース×出走馬）
interface RaceFactRecord {
  year: number;
  kaisai: number;
  day: number;
  raceNumber: number;
  location: string;
  raceDate: string;
  distance: number;
  trackType: ParsedRaceResult['trackType'];
  condition: string;
  raceClassText: string;
  grade: ParsedRaceResult['grade'];
  // レース全体の参考上がり3F（秒）。同じレースの馬全員で同じ値になる（レース単位の値のため）。
  raceLast3F: number | null;
  // 馬連配当（円、100円あたり）。同じレースの馬全員で同じ値になる（レース単位の値のため）。
  quinellaPayout: number | null;
  horseName: string;
  finishRank: number;
  timeStr: string;
  totalSeconds: number;
  odds: number | null;
}

function racesToFactRecords(races: ParsedRaceResult[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const race of races) {
    if (race.distance <= 0 || race.condition === '不明') continue;
    for (const horse of race.horses) {
      if (horse.totalSeconds <= 0) continue;
      records.push({
        year: race.year,
        kaisai: race.kaisai,
        day: race.day,
        raceNumber: race.raceNumber,
        location: race.location,
        raceDate: race.raceDate,
        distance: race.distance,
        trackType: race.trackType,
        condition: race.condition,
        raceClassText: race.raceClassText,
        grade: race.grade,
        raceLast3F: race.referenceLast3F,
        quinellaPayout: race.quinellaPayout,
        horseName: horse.name,
        finishRank: horse.finishRank,
        timeStr: horse.timeStr,
        totalSeconds: horse.totalSeconds,
        odds: horse.odds,
      });
    }
  }
  return records;
}

function appendRaceFacts(jsonlPath: string, records: RaceFactRecord[]): void {
  if (records.length === 0) return;
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(jsonlPath, lines);
}

// manifest: 「開催回-競馬場コード-開催日目」の取り込み済みキー一覧
type Manifest = Set<string>;

function manifestKey(kaisai: number, code: string, day: number): string {
  return `${kaisai}-${code}-${day}`;
}

function loadManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) return new Set();
  const keys = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as string[];
  return new Set(keys);
}

function saveManifest(manifestPath: string, manifest: Manifest): void {
  fs.writeFileSync(manifestPath, JSON.stringify(Array.from(manifest).sort(), null, 2));
}

function parseYearArg(argv: string[]): number {
  const yearArg = argv.find(a => /^\d{4}$/.test(a));
  if (!yearArg) return new Date().getFullYear();
  const year = parseInt(yearArg, 10);
  if (year < 1986 || year > 2100) {
    throw new Error(`対象年が不正です: ${yearArg}（JRAのPDF提供開始以降の西暦4桁で指定してください）`);
  }
  return year;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const year = parseYearArg(argv);
  const testMode = argv.includes('--test');

  const jsonlPath = path.join(__dirname, `race_facts_${year}.jsonl`);
  const manifestPath = path.join(__dirname, `manifest_${year}.json`);
  const manifest = loadManifest(manifestPath);

  const diagnostics = createParseDiagnostics();

  let fetchedDays = 0;
  let skippedAlreadyIngested = 0;
  let skippedDays = 0;
  let totalRecords = 0;

  console.log(`=== ${year}年のJRA成績PDFを取得します ===`);
  if (testMode) {
    console.log(`【動作確認モード】${TEST_MODE_CONFIG.trackCode} 第${TEST_MODE_CONFIG.kaisai}回、${TEST_MODE_CONFIG.maxDay}日目まで`);
  }
  console.log(`取り込み済み台帳: ${manifest.size}件（${manifestPath}）`);

  const targetTracks = testMode
    ? { [TEST_MODE_CONFIG.trackCode]: TRACK_CODES[TEST_MODE_CONFIG.trackCode] }
    : TRACK_CODES;

  for (const [code, name] of Object.entries(targetTracks)) {
    const kaisaiRange = testMode ? [TEST_MODE_CONFIG.kaisai] : Array.from({ length: MAX_KAISAI }, (_, i) => i + 1);
    for (const kaisai of kaisaiRange) {
      const dayLimit = testMode ? TEST_MODE_CONFIG.maxDay : MAX_DAY;
      for (let day = 1; day <= dayLimit; day++) {
        const key = manifestKey(kaisai, code, day);
        if (manifest.has(key)) {
          skippedAlreadyIngested++;
          continue; // 取り込み済み。リクエストせずスキップ（待機もしない）
        }

        const url = `https://www.jra.go.jp/datafile/seiseki/report/${year}/${year}-${kaisai}${code}${day}.pdf`;

        try {
          const { text, status } = await fetchPdfText(url);
          if (!text) {
            skippedDays++;
            if (status !== 404) {
              console.warn(`SKIP (status ${status ?? '不明（タイムアウト等）'}): ${url}`);
            }
            // 404・エラーはmanifestに載せない（今年分は将来開催される可能性があるため）
          } else {
            const dayDiagnostics = createParseDiagnostics();
            const races = parseDayResultText(text, dayDiagnostics);
            mergeDiagnostics(diagnostics, dayDiagnostics);

            const records = racesToFactRecords(races);
            appendRaceFacts(jsonlPath, records);
            totalRecords += records.length;

            manifest.add(key);
            saveManifest(manifestPath, manifest);

            fetchedDays++;
            console.log(`OK: ${name}${kaisai}回${day}日目 (${races.length}レース, ${records.length}件追記)`);
          }
        } catch (e) {
          console.error(`ERROR: ${url}`, (e as Error).message);
          skippedDays++;
        }

        await sleep(DELAY_MS);
      }
    }
  }

  console.log('');
  console.log('=== 完了 ===');
  console.log(`取得成功: ${fetchedDays}日 / 取り込み済みでスキップ: ${skippedAlreadyIngested}日 / 未開催等でスキップ: ${skippedDays}日`);
  console.log(`今回追記した観測件数: ${totalRecords}件`);
  console.log(`出力先: ${jsonlPath}`);
  console.log(`台帳: ${manifestPath}（${manifest.size}件）`);
  console.log('');
  console.log('=== パース診断（レースブロックのスキップ理由・今回フェッチ分のみ） ===');
  console.log(`対象ブロック数: ${diagnostics.totalBlocks}`);
  console.log(`開催情報が読めず除外: ${diagnostics.skippedNoMeeting}`);
  console.log(`レース番号が読めず除外: ${diagnostics.skippedNoRaceNum}`);
  console.log(`距離が読めず除外: ${diagnostics.skippedNoDistance}`);
  console.log(`馬場状態が読めず除外: ${diagnostics.skippedNoCondition}`);
  console.log(`出走馬が1頭も抽出できず除外: ${diagnostics.skippedNoHorses}`);
  console.log(`頭数表記と抽出数の不一致: ${diagnostics.horseCountMismatch}`);
}

main().catch(e => {
  console.error('バッチ処理でエラーが発生しました:', e);
  process.exit(1);
});
