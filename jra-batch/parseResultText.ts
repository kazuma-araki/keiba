/**
 * JRAの「年度別全成績（PDF）」1日分のテキストを、レース単位（コース・距離・
 * 馬場状態・出走馬タイム）に分解する。
 *
 * 【実データで確認できたこと】
 * - 「コースレコード／中央レコード」直後に並ぶ2つの馬場状態表記（例:「重\n重」）は
 *   [芝,ダート]のペアではなく、同じ値が2回印字されているだけ。
 *   このレース自身のサーフェス（芝／ダート）の、その時点での実際の馬場状態を表す。
 *   （ダートの値は日中の天候で 重→不良→重 のように変化するが、この値自体は
 *    各ダートレースの実施タイミングと矛盾なく対応していた）
 * - ヘッダー行内、天候直後にある単独の「良」等は、その日の芝の状態を通しで
 *   表示しているだけで、個別レースの馬場状態としては使わない。
 * - 障害レースは「コースレコード」のみ1行で、「中央レコード」の行が無い別フォーマット。
 * - 距離・レース名は、条件戦は「第N競走 クラス名 距離」が同じ行だが、
 *   重賞・特別戦は「第N競走」の後に改行を挟んでレース名・距離が来ることがあるため、
 *   同一行を前提にせず、「第N競走」〜「発走」の間から距離らしき数値を拾う。
 * - 着差が僅かで着タイムが前の馬と同表記になる場合「〃」（同上）が入るため、
 *   直前の実タイムを引き継ぐ処理が必要。
 */

import * as fs from 'fs';
import * as path from 'path';

// 騎手名の抽出は正規表現だけでは境界（馬主名との切れ目）が定まらず、
// 特定の漢字がPDFのフォント変換で文字化けする問題もあるため、
// netkeibaの騎手リーディングから取得した実在の騎手名簿と完全一致させる方式を取る
// （jockeyRoster_2025.json / jockeyRoster_2026.json、jra-batch内に同梱）。
interface JockeyRosterEntry { id: string; name: string; wins: number | null; winRate: number | null; placeRate: number | null; }

function loadJockeyNames(): string[] {
  const files = ['jockeyRoster_2025.json', 'jockeyRoster_2026.json'];
  const names = new Set<string>();
  for (const file of files) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) continue;
    const entries: JockeyRosterEntry[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const e of entries) names.add(e.name);
  }
  // 長い名前から先にマッチさせるため長さ降順に並べておく
  return Array.from(names).sort((a, b) => b.length - a.length);
}

const JOCKEY_NAMES = loadJockeyNames();
const JOCKEY_NAME_SET = new Set(JOCKEY_NAMES);
const MAX_JOCKEY_NAME_LENGTH = JOCKEY_NAMES.reduce((max, n) => Math.max(max, n.length), 0);

// 斤量の直後（馬名・性齢・毛色より後ろ）を起点に、名簿と完全一致する
// 最長の騎手名を左から順に探す。馬主名側で偶然一致するリスクを避けるため、
// 検索範囲は斤量表記が収まる程度の短い窓に絞る。
const JOCKEY_SEARCH_WINDOW = 40;

// PDFのフォント変換で、特定の（稀な）漢字1文字だけが記号に化けることがある
// （例:「鮫島克駿」→「)島克駿」「%島克駿」等、化け方自体は一定しない）。
// 完全一致で見つからない場合だけ、1文字までの不一致を許容する2段目の照合を行う。
function findJockeyNameFuzzy(window: string): string | null {
  for (let start = 0; start < window.length; start++) {
    for (const name of JOCKEY_NAMES) {
      if (name.length < 3 || start + name.length > window.length) continue;
      let diff = 0;
      for (let k = 0; k < name.length && diff <= 1; k++) {
        if (window[start + k] !== name[k]) diff++;
      }
      if (diff === 1) return name;
    }
  }
  return null;
}

function findJockeyName(rowText: string, searchStart: number): string | null {
  // 姓名の間に空白・タブが入ることがある（短い名前の均等割り付けの都合）ため、
  // 名簿側（空白なし）と揃えるよう検索窓から空白類を除去してから照合する。
  const window = rowText.slice(searchStart, searchStart + JOCKEY_SEARCH_WINDOW).replace(/[ \t　]/g, '');
  for (let start = 0; start < window.length; start++) {
    for (let len = Math.min(MAX_JOCKEY_NAME_LENGTH, window.length - start); len >= 2; len--) {
      const candidate = window.slice(start, start + len);
      if (JOCKEY_NAME_SET.has(candidate)) return candidate;
    }
  }
  return findJockeyNameFuzzy(window);
}

export interface ParsedHorseResult {
  name: string;
  finishRank: number; // 着順（タイム不明で除外された馬は含めない中での順位）
  // 枠番（1〜8）。名前マッチ直前の数字列の先頭1桁から取得（枠番は必ず1桁のため
  // 区切り文字が無くても一意に分解できる）。
  waku: number | null;
  // 馬番。同じ数字列の残り1〜2桁。
  umaban: number | null;
  timeStr: string;
  totalSeconds: number;
  // 単勝オッズ。行内の「タイム→着差→単勝オッズ」という並びのうち、
  // 小数点付きの数値としては行内最後に出現するのがオッズなので、
  // 「行内で最後にマッチした小数」を採用している（人気の丸数字は文字化けするため使わない）。
  odds: number | null;
  // 騎手名。名簿と一致しなかった場合はnull（診断カウンタで頻度を追跡する）。
  jockeyName: string | null;
  // 斤量（kg）。減量記号（▲△☆◇）がある場合は減量後の実斤量、無ければ基礎重量そのもの。
  weight: number | null;
  // 馬体重（kg）。
  bodyWeight: number | null;
  // 前走からの馬体重増減（kg）。初出走・比較対象なし等で「―」表記の場合はnull。
  bodyWeightChange: number | null;
}

export type RaceGrade = 'G1' | 'G2' | 'G3' | null;

export interface ParsedRaceResult {
  year: number;
  kaisai: number; // 開催回
  day: number; // 開催日目
  raceNumber: number; // 第N競走
  location: string;
  raceDate: string; // 例: "2026年1月24日"
  distance: number;
  trackType: '芝' | 'ダ' | '障害';
  condition: string; // 良・稍重・重・不良・不明
  raceClassText: string; // レース条件・レース名の生テキスト（軽くクリーニング済み）
  grade: RaceGrade; // 重賞グレード（G1/G2/G3）。該当なしはnull
  // レース全体の参考上がり3F（秒）。「上り 4F ××．×―3F ××．×」の行から取得。
  // 個々の出走馬ごとの上がり3Fではなく、そのレース全体の指標値である点に注意。
  referenceLast3F: number | null;
  // 馬連の払戻金額（円、100円あたり）。どの馬番の組み合わせで的中したかは
  // 丸数字表記がPDFのフォント変換で文字化けし読み取れないが、着順(finishRank)から
  // 1着・2着の馬は別途特定できるため、組み合わせ自体の抽出は不要。
  // 発売なし・抽出失敗時はnull。
  quinellaPayout: number | null;
  // 単勝・複勝・枠連・馬単・ワイド・3連複・3連単の払戻金額（円、100円あたり）。
  // 複勝・ワイドは1レースにつき複数（着順3頭・組み合わせ3通り、出走頭数が
  // 少ないレースではそれ未満）あるため配列。並び順は着順（複勝＝1着→2着→3着の
  // 馬の複勝配当、ワイド＝(1着-2着)→(1着-3着)→(2着-3着)の組み合わせ配当）で、
  // JRAの払戻金セクションの掲載順そのまま。枠連は枠番の組み合わせが必要なため
  // （枠番は本パーサーでは未抽出）、配当額のみ保持し馬番系の的中判定には使わない。
  payouts: PayoutData;
  // コーナーごとの通過順位（先頭〜後方の馬番グループ列。同着はグループ内にまとめる）。
  // 障害レース（コーナー通過順位の見出しが無い）や見出しの整合性チェックに失敗した
  // レースでは空配列。
  cornerPositions: CornerPosition[];
  horses: ParsedHorseResult[];
}

export interface CornerPosition {
  corner: number;
  // 先頭(1着相当)から後方へ向けての馬番グループ列。同着（同じ塊）はグループ内にまとめる。
  order: number[][];
}

export interface PayoutData {
  win: number | null;
  place: number[];
  bracketQuinella: number | null;
  quinella: number | null;
  exacta: number | null;
  wide: number[];
  trio: number | null;
  trifecta: number | null;
}

function emptyPayoutData(): PayoutData {
  return { win: null, place: [], bracketQuinella: null, quinella: null, exacta: null, wide: [], trio: null, trifecta: null };
}

// 払戻金セクションのラベル。実データでは「単　勝」のように文字間にタブ/空白が
// 入ることがあるため、ラベル自体の文字間にも\s*を挟んで照合する。
// 順序はJRAの掲載順（この順で単調増加する前提でラベルの開始位置を境目に
// 各ラベル〜次ラベルの間にある「金額円」をすべて拾う）。
const PAYOUT_LABELS: { key: keyof Omit<PayoutData, 'place' | 'wide'> | 'place' | 'wide'; label: string }[] = [
  { key: 'win', label: '単勝' },
  { key: 'place', label: '複勝' },
  { key: 'bracketQuinella', label: '枠連' },
  { key: 'quinella', label: '馬連' },
  { key: 'exacta', label: '馬単' },
  { key: 'wide', label: 'ワイド' },
  { key: 'trio', label: '3連複' },
  { key: 'trifecta', label: '3連単' },
];

function labelRegexSource(label: string): string {
  return label.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
}

/**
 * 「払戻金」～「票数」（または末尾）の範囲から、ラベルごとの払戻額（円）を抽出する。
 * 組み合わせの丸数字表記自体はフォント変換で文字化けするため使わず、
 * ラベルの直後から次のラベルの直前までに現れる「数字＋円」だけを拾う
 * （複勝・ワイドのように件数が可変でも、この方式なら件数を仮定せず正しく拾える）。
 */
function extractPayouts(block: string): PayoutData {
  const result = emptyPayoutData();
  const startMatch = block.match(/払\s*戻\s*金/);
  if (!startMatch || startMatch.index == null) return result;

  const sectionStart = startMatch.index + startMatch[0].length;
  const rest = block.slice(sectionStart);
  const endMatch = rest.match(/票\s*数|ハロンタイム/);
  const section = endMatch && endMatch.index != null ? rest.slice(0, endMatch.index) : rest.slice(0, 400);

  const labelMatches = PAYOUT_LABELS
    .map(({ key, label }) => {
      const m = section.match(new RegExp(labelRegexSource(label)));
      return m && m.index != null ? { key, start: m.index, end: m.index + m[0].length } : null;
    })
    .filter((m): m is { key: typeof PAYOUT_LABELS[number]['key']; start: number; end: number } => m !== null)
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < labelMatches.length; i++) {
    const { key, end } = labelMatches[i];
    const nextStart = i + 1 < labelMatches.length ? labelMatches[i + 1].start : section.length;
    const segment = section.slice(end, nextStart);
    const amounts = Array.from(segment.matchAll(/(\d[\d，]*)円/g)).map(m => parseInt(m[1].replace(/，/g, ''), 10));

    if (key === 'place' || key === 'wide') {
      result[key] = amounts;
    } else {
      result[key] = amounts[0] ?? null;
    }
  }

  return result;
}

// コーナー通過順位のパース。
//
// 「通過コーナー順 X→Y→…」の見出しの矢印の個数だけを使い、実際に追跡されている
// コーナー番号は「1,2,3,4の末尾N個」と推定する（丸数字グリフがフォント変換で
// 稀に文字化けするため、見出し中の数字そのものは信用しない。ラベル行の中身も
// 同じ理由で読まず、「1文字だけの行」という長さだけで判定する）。
//
// 実データで確認できたレイアウト（生テキストを目視確認して確定）:
//   - 追跡コーナーは奇数(1,3)グループと偶数(2,4)グループに分かれて表示される。
//   - 各グループの要素数が2の場合: ラベル行が2つ連続し、その後にデータ行が2つ連続する
//     （1行目のデータが1つ目のラベルに、2行目のデータが2つ目のラベルに対応）。
//   - 要素数が1のグループが2つ連続する場合（＝追跡コーナーが2つだけの「3→4」等）:
//     「ラベル データ ラベル データ」が1行に同居する。データの区切りは出走頭数
//     （馬番参照がちょうどheadCount個集まった時点）で判定する。
//   - 要素数1のグループの次が要素数2のグループの場合（「2→3→4」等）:
//     要素数1の方は単独で「ラベル データ」が1行に収まる。
function inferTrackedCorners(headerBody: string): number[] {
  const tokenCount = (headerBody.match(/→/g)?.length ?? 0) + 1;
  return [1, 2, 3, 4].slice(4 - tokenCount);
}
function groupsFromCorners(corners: number[]): number[][] {
  const odd = corners.filter(c => c % 2 === 1);
  const even = corners.filter(c => c % 2 === 0);
  return [odd, even].filter(g => g.length > 0);
}
interface CountToken { count: number; end: number; }
function tokenizeCountsFrom(text: string): CountToken[] {
  const re = /（[\d，]+）|\d+/g;
  const tokens: CountToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const isGroup = m[0].startsWith('（');
    const count = isGroup ? (m[0].match(/\d+/g) || []).length : 1;
    tokens.push({ count, end: m.index + m[0].length });
  }
  return tokens;
}
function stripLeadingLabel(text: string): string {
  return text.replace(/^\s*\S\s*/, '');
}
// 「ラベル データ ラベル データ」が1行に同居するケースの分割。
function splitCombinedCornerLine(line: string, headCount: number): string[] {
  const segments: string[] = [];
  let remaining = stripLeadingLabel(line);
  for (let seg = 0; seg < 2; seg++) {
    if (seg > 0) remaining = stripLeadingLabel(remaining);
    const tokens = tokenizeCountsFrom(remaining);
    let tokenIdx = 0, count = 0;
    while (tokenIdx < tokens.length && count < headCount) {
      count += tokens[tokenIdx].count;
      tokenIdx++;
    }
    const segEnd = tokenIdx > 0 ? tokens[tokenIdx - 1].end : 0;
    segments.push(remaining.slice(0, segEnd).trim());
    remaining = remaining.slice(segEnd);
  }
  return segments;
}
function parseCornerLines(lines: string[], groups: number[][], headCount: number): Map<number, string> {
  const result = new Map<number, string>();
  let cursor = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    let labelLineCount = 0;
    while (labelLineCount < group.length && cursor + labelLineCount < lines.length && lines[cursor + labelLineCount].length === 1) {
      labelLineCount++;
    }
    if (labelLineCount === group.length) {
      cursor += labelLineCount;
      for (const corner of group) {
        result.set(corner, (lines[cursor] ?? '').trim());
        cursor++;
      }
    } else if (group.length === 1) {
      const line = lines[cursor] ?? '';
      const nextGroup = groups[gi + 1];
      if (nextGroup && nextGroup.length === 1) {
        const segments = splitCombinedCornerLine(line, headCount);
        result.set(group[0], segments[0] ?? '');
        result.set(nextGroup[0], segments[1] ?? '');
        cursor++;
        gi++; // 次のグループは同じ行で処理済み
      } else {
        result.set(group[0], stripLeadingLabel(line).trim());
        cursor++;
      }
    }
  }
  return result;
}
function parseGroupString(dataStr: string): number[][] {
  // 「（12，16）13（10，4，11）」のような文字列を、丸括弧の同着グループ・単独馬番の
  // 配列（先頭から後方への順）に変換する。「－」「，」（グループ外）「＝」は区切りとして無視する。
  const groups: number[][] = [];
  const re = /（([\d，]+)）|(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dataStr)) !== null) {
    if (m[1]) groups.push(m[1].split('，').map(n => parseInt(n, 10)));
    else if (m[2]) groups.push([parseInt(m[2], 10)]);
  }
  return groups;
}

/**
 * レースブロック全体からコーナー通過順位を抽出する。見出しが無い（障害レース等）、
 * または抽出結果の馬番集合が出走頭数と整合しない場合はnullを返し、診断カウンタに計上する。
 */
function extractCornerPositions(block: string, headCount: number, diagnostics?: ParseDiagnostics): CornerPosition[] {
  if (diagnostics) diagnostics.totalRacesForCorner++;

  const headerMatch = block.match(/「通過コーナー順\s*([^」]+)」/);
  if (!headerMatch) {
    if (diagnostics) diagnostics.cornerNoHeader++;
    return [];
  }
  const corners = inferTrackedCorners(headerMatch[1]);
  const groups = groupsFromCorners(corners);

  const headerLineEnd = block.indexOf('\n', headerMatch.index! + headerMatch[0].length);
  const rest = headerLineEnd >= 0 ? block.slice(headerLineEnd + 1) : '';
  const endMatch = rest.match(/勝馬の|市場取引馬/);
  const section = endMatch && endMatch.index != null ? rest.slice(0, endMatch.index) : rest.slice(0, 500);
  const lines = section.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const dataByCorner = parseCornerLines(lines, groups, headCount);

  const result: CornerPosition[] = [];
  for (const corner of corners) {
    const dataStr = dataByCorner.get(corner);
    if (dataStr == null) { if (diagnostics) diagnostics.cornerCountMismatch++; return []; }
    const order = parseGroupString(dataStr);
    const horseCount = order.reduce((s, g) => s + g.length, 0);
    const uniqueCount = new Set(order.flat()).size;
    if (horseCount !== headCount || uniqueCount !== headCount) {
      if (diagnostics) diagnostics.cornerCountMismatch++;
      return [];
    }
    result.push({ corner, order });
  }
  return result;
}

/**
 * レースブロックが正規表現でうまく解釈できず捨てられた件数を集計する診断情報。
 * ヒューリスティックなパース処理のため、想定外のPDFレイアウトに当たると
 * 黙ってレースをスキップしてしまう。件数の推移を見て異常を検知するために使う。
 */
export interface ParseDiagnostics {
  totalBlocks: number;
  skippedNoMeeting: number;
  skippedNoRaceNum: number;
  skippedNoDistance: number;
  skippedNoCondition: number;
  skippedNoHorses: number;
  // 競走中止・除外等で正式にタイムが記録されない馬がいる場合は自然に発生するため、
  // 0でないからといって直ちにパース不具合とは限らない（大きく乖離する場合の目安として使う）。
  horseCountMismatch: number;
  // 騎手名簿と一致しなかった出走馬の頭数（抽出成功率＝1-jockeyNotMatched/totalHorseRowsで確認する）。
  jockeyNotMatched: number;
  totalHorseRows: number;
  // コーナー通過順位が見出しごと見つからなかった件数（障害レース等、そもそも掲載が無い）。
  cornerNoHeader: number;
  // 見出しはあったが、各コーナーで抽出した馬番の集合が出走頭数と整合しなかった件数
  // （出走取消等での頭数差、まれな表記ゆれなど）。
  cornerCountMismatch: number;
  totalRacesForCorner: number;
}

export function createParseDiagnostics(): ParseDiagnostics {
  return {
    totalBlocks: 0,
    skippedNoMeeting: 0,
    skippedNoRaceNum: 0,
    skippedNoDistance: 0,
    skippedNoCondition: 0,
    skippedNoHorses: 0,
    horseCountMismatch: 0,
    jockeyNotMatched: 0,
    totalHorseRows: 0,
    cornerNoHeader: 0,
    cornerCountMismatch: 0,
    totalRacesForCorner: 0,
  };
}

export function mergeDiagnostics(target: ParseDiagnostics, source: ParseDiagnostics): void {
  target.totalBlocks += source.totalBlocks;
  target.skippedNoMeeting += source.skippedNoMeeting;
  target.skippedNoRaceNum += source.skippedNoRaceNum;
  target.skippedNoDistance += source.skippedNoDistance;
  target.skippedNoCondition += source.skippedNoCondition;
  target.skippedNoHorses += source.skippedNoHorses;
  target.horseCountMismatch += source.horseCountMismatch;
  target.jockeyNotMatched += source.jockeyNotMatched;
  target.totalHorseRows += source.totalHorseRows;
  target.cornerNoHeader += source.cornerNoHeader;
  target.cornerCountMismatch += source.cornerCountMismatch;
  target.totalRacesForCorner += source.totalRacesForCorner;
}

const CONDITION_WORDS = ['良', '稍重', '重', '不良'];
const NO_FINISH_WORDS = /競走中止|除外|取消|失格|中止/;

export function parseDayResultText(rawText: string, diagnostics?: ParseDiagnostics): ParsedRaceResult[] {
  // 5桁のレースID＋日付（例: "02001 1月24日"）を境目にレース単位で分割する。
  // IDと日付の間にスペースが入らない回（例:「3200111月 8日」）だと、\d{5}が
  // ID全体ではなく1文字ずれた位置（ID末尾+月の先頭）にもマッチしてしまい、
  // 余計な分割点ができてブロックの先頭がID途中からになってしまう。
  // 直前が数字ではない位置からしか分割しないようにして防ぐ。
  const blocks = rawText
    .split(/(?<!\d)(?=\d{5}\s*\d{1,2}月\s*\d{1,2}日)/g)
    .filter(b => /^\d{5}\s*\d{1,2}月\s*\d{1,2}日/.test(b.trim()));

  const results: ParsedRaceResult[] = [];

  for (const block of blocks) {
    if (diagnostics) diagnostics.totalBlocks++;

    const meetingMatch = block.match(/（(\d+)年(\d+)(\S+?)）/);
    if (!meetingMatch) {
      if (diagnostics) diagnostics.skippedNoMeeting++;
      continue;
    }
    const [, yearStr, kaisaiStr, location] = meetingMatch;
    const year = parseInt(yearStr, 10);
    const kaisai = parseInt(kaisaiStr, 10);

    // 月・日を桁数で区切って(1〜2桁)マッチさせる。IDと日付の間にスペースが
    // 無い回でも、先頭5桁(ID)＋月(1〜2桁)という桁数の制約だけで正しく切り分けられる
    // （上のブロック分割修正と合わせて、ブロックが必ずID先頭から始まる前提が効いている）。
    const dateMatch = block.match(/^\d{5}\s*(\d{1,2})月\s*(\d{1,2})日/);
    const raceDate = dateMatch ? `${yearStr}年${dateMatch[1]}月${dateMatch[2]}日` : '不明';

    const dayMatch = block.match(/第(\d+)日/);
    const day = dayMatch ? parseInt(dayMatch[1], 10) : 0;

    // 距離：「第N競走」〜「発走」の間から、距離として妥当な範囲(800〜4300m)の数値を拾う
    const raceNumMatch = block.match(/第(\d+)競走/);
    if (!raceNumMatch) {
      if (diagnostics) diagnostics.skippedNoRaceNum++;
      continue;
    }
    const raceNumber = parseInt(raceNumMatch[1], 10);
    const afterRaceNum = block.slice(raceNumMatch.index! + raceNumMatch[0].length);
    const startIdx = afterRaceNum.indexOf('発走');
    const headerSegment = startIdx >= 0 ? afterRaceNum.slice(0, startIdx) : afterRaceNum.slice(0, 200);

    // フォント変換の都合上、距離の直後に脚注記号らしき文字が1文字くっつくことがある。
    // 記号なら数値として拾われないが、稀にその文字が0〜9の数字に化けることがあり、
    // その場合は本来の距離が妥当範囲を超えて見えてしまう。末尾1桁を落として再判定する。
    const numMatches = headerSegment.match(/[\d，,]{3,6}/g) || [];
    const distanceCandidates: number[] = [];
    for (const raw of numMatches) {
      const digits = raw.replace(/[，,]/g, '');
      const asIs = parseInt(digits, 10);
      if (asIs >= 800 && asIs <= 4300) {
        distanceCandidates.push(asIs);
        continue;
      }
      if (digits.length >= 4) {
        const truncated = parseInt(digits.slice(0, -1), 10);
        if (truncated >= 800 && truncated <= 4300) distanceCandidates.push(truncated);
      }
    }
    const distance = distanceCandidates.length > 0 ? distanceCandidates[0] : 0;
    if (!distance) {
      if (diagnostics) diagnostics.skippedNoDistance++;
      continue;
    }

    // サーフェス判定：「発走HH時MM分」以降で最初に現れる（芝｜ダート｜障害）
    // 発走時刻が1桁時（例:9時）の場合、印字上「発走」との間に空白が入ることがあるため許容する。
    const surfaceMatch = block.match(/発走\s*\d+時\d+分[\s\S]{0,40}?[（(]\s*(芝|ダート|障害)/);
    let trackType: ParsedRaceResult['trackType'] =
      surfaceMatch?.[1] === 'ダート' ? 'ダ' : ((surfaceMatch?.[1] as '芝' | '障害') ?? '芝');
    // クラス名に「障害」を含む場合は、サーフェス表記が「芝」でも障害レース扱いにする
    if (headerSegment.includes('障害')) trackType = '障害';

    // 馬場状態：平地は「中央レコード」直後、障害は「コースレコード」直後（1つだけ）
    let condition = '不明';
    const flatCondMatch = block.match(/中央レコード[\s\S]{0,60}?(良|稍重|重|不良)/);
    if (flatCondMatch) {
      condition = flatCondMatch[1];
    } else {
      const hurdleCondMatch = block.match(/コースレコード\s+[\d：.．]+\s*(良|稍重|重|不良)/);
      if (hurdleCondMatch) condition = hurdleCondMatch[1];
    }
    if (!CONDITION_WORDS.includes(condition)) {
      if (diagnostics) diagnostics.skippedNoCondition++;
      continue; // 信頼できない場合は記録対象から外す
    }

    // レース条件・レース名の生テキスト：距離の数値や、フォント変換の残骸である
    // ASCII記号を取り除いた程度の軽いクリーニングに留める（厳密な分類はしない）。
    const raceClassText = headerSegment
      .replace(/[\d，,]{3,6}/g, ' ')
      .replace(/[!-/:-@[-`{-~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 重賞グレード：「（Ｇ？）」の全角ローマ数字から判定。無ければ null（一般戦・特別戦等）。
    const gradeMatch = raceClassText.match(/[GＧ]\s*(Ⅰ|Ⅱ|Ⅲ)/);
    const grade: RaceGrade =
      gradeMatch?.[1] === 'Ⅰ' ? 'G1' : gradeMatch?.[1] === 'Ⅱ' ? 'G2' : gradeMatch?.[1] === 'Ⅲ' ? 'G3' : null;

    // 参考上がり3F：「上り ... 3F ××．×」の行から取得（レース全体の指標値）。
    // 妥当な範囲(30〜50秒)でなければ信頼できないためnullにする。
    const last3FMatch = block.match(/上り[\s\S]{0,60}?3F\s*([\d．.]+)/);
    const last3FCandidate = last3FMatch ? parseFloat(last3FMatch[1].replace(/．/g, '.')) : null;
    const referenceLast3F =
      last3FCandidate !== null && last3FCandidate >= 30 && last3FCandidate <= 50 ? last3FCandidate : null;

    // 全馬券種の払戻金（円、100円あたり）。「払戻金」ラベル以降だけを対象にしているため、
    // 同じ「馬連」等のラベルがそれより前の「売得金」（投票額）セクションに出てきても
    // 混同しない。
    const payouts = extractPayouts(block);
    const quinellaPayout = payouts.quinella;

    // 出走馬一覧：「（N頭）」より前の範囲だけを対象にする
    const headCountMatch = block.match(/（(\d+)頭）/);
    const horseSection = headCountMatch ? block.slice(0, headCountMatch.index) : block;

    const horses = extractHorseTimes(horseSection, diagnostics);
    if (horses.length > 0) {
      if (diagnostics && headCountMatch) {
        const expectedCount = parseInt(headCountMatch[1], 10);
        if (expectedCount !== horses.length) diagnostics.horseCountMismatch++;
      }
      // コーナー通過順位は出走頭数との整合チェックが要るため、（N頭）表記の数値を使う
      // （タイム不明で除外された馬がいるとhorses.lengthとは一致しないことがあるため）。
      const cornerPositions = headCountMatch
        ? extractCornerPositions(block, parseInt(headCountMatch[1], 10), diagnostics)
        : [];
      results.push({
        year,
        kaisai,
        day,
        raceNumber,
        location,
        raceDate,
        distance,
        trackType,
        condition,
        raceClassText,
        grade,
        referenceLast3F,
        quinellaPayout,
        payouts,
        cornerPositions,
        horses,
      });
    } else if (diagnostics) {
      diagnostics.skippedNoHorses++;
    }
  }

  return results;
}

function extractHorseTimes(section: string, diagnostics?: ParseDiagnostics): ParsedHorseResult[] {
  // 馬名は「カタカナ2〜9文字」＋直後に性別記号(牡/牝/セ)＋年齢＋毛色、という並びで検出する。
  // 短い馬名は均等割り付けのため文字間に空白・タブが挿入されることがあるので許容し、
  // 抽出後に空白を除去して名前を復元する。
  // 性別記号はPDFのフォント変換の都合で稀に別の記号に化けることがある（日によって化け方が
  // 変わりうるため特定の文字には決め打ちしない）ため、直後に続く毛色の漢字で位置を裏取りする。
  const nameRegex = /((?:[ァ-ヶー][ \t　]*){2,9})\S\d{1,2}(?=[鹿栗芦黒青白栃])/g;
  const matches: { name: string; index: number; matchEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = nameRegex.exec(section)) !== null) {
    matches.push({ name: m[1].replace(/[ \t　]/g, ''), index: m.index, matchEnd: m.index + m[0].length });
  }

  const horses: ParsedHorseResult[] = [];
  let lastTime: { timeStr: string; totalSeconds: number } | null = null;

  for (let i = 0; i < matches.length; i++) {
    // 枠番・馬番：馬名マッチの直前にある数字列（例:「7 9」「811」）。枠番は必ず1桁(1〜8)
    // なので、区切り文字の有無によらず「先頭1桁＝枠番、残り1〜2桁＝馬番」で一意に決まる。
    // 直前の馬の行の末尾（オッズ等）と隣接して誤読しないよう、数字の直前が別の数字である
    // 場合は対象外にする。
    // 馬番の直後に、特記事項を示す記号（フォント変換で文字化けする）が挟まることがあり
    // （例:「2 2 !」の「!」）、さらに行の折り返し（例:「714 "\n! ピコアーガイル」）で
    // 改行や別の記号を挟むこともあるため、末尾の非数字は複数文字まで許容する。
    const wakuUmabanWindow = section.slice(Math.max(0, matches[i].index - 18), matches[i].index);
    const wakuUmabanMatch = wakuUmabanWindow.match(/(?<!\d)([1-8])\s*(\d{1,2})[^\d]{0,6}$/);
    const waku = wakuUmabanMatch ? parseInt(wakuUmabanMatch[1], 10) : null;
    const umaban = wakuUmabanMatch ? parseInt(wakuUmabanMatch[2], 10) : null;

    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : section.length;
    const rowText = section.slice(start, end);

    if (NO_FINISH_WORDS.test(rowText)) {
      continue; // 競走中止・除外などタイムが存在しない馬はスキップ
    }

    // 体重増減の数字（例:「482－ 2」）がタイムの数字（例:「1：47．4」）と
    // 区切りなしで連結し「21：47．4」のように見えるケースがあるため、
    // 妥当な分数（0〜4分）になる位置が見つかるまで1文字ずつずらして探索する
    const found: { timeStr: string; totalSeconds: number; matchIndex: number } | null =
      findColonTime(rowText) ?? findDittoTime(rowText, lastTime) ?? findShortTime(rowText);

    if (found) {
      // 単勝オッズ：行内の小数（\d{1,3}．\d）のうち最後の出現がオッズ
      // （タイムの小数部分より必ず後ろに来るため）。
      const oddsMatches = rowText.match(/\d{1,3}[．.]\d/g);
      const odds = oddsMatches ? parseFloat(oddsMatches[oddsMatches.length - 1].replace(/．/g, '.')) : null;

      // 騎手名：性齢のマッチ末尾（＝毛色の直前）を起点に検索する。
      // 間に挟まる毛色・斤量の文字は名簿のどの名前にも一致しないため、
      // そのままスキャンさせても実害はない。
      const jockeySearchStart = matches[i].matchEnd - start;
      const jockeyName = findJockeyName(rowText, jockeySearchStart);
      if (diagnostics) {
        diagnostics.totalHorseRows++;
        if (!jockeyName) diagnostics.jockeyNotMatched++;
      }

      // 斤量：毛色の直後の2桁。減量記号（▲△☆◇）付きの2桁がその後に続けば
      // そちらが減量後の実斤量（例:「57\n54 ▲」なら54）。無ければ最初の2桁がそのまま実斤量。
      const weightWindow = rowText.slice(jockeySearchStart, jockeySearchStart + 20);
      const weightMatch = weightWindow.match(/(\d{2})(?:[^\d]{0,4}(\d{2})[^\d]{0,3}[▲△☆◇])?/);
      const weight = weightMatch ? parseInt(weightMatch[2] ?? weightMatch[1], 10) : null;

      // 馬体重・増減：タイムの直前に「482＋10」「446－ 4」「454± 0」のような形で出現。
      // 増減が「―」（初出走等で比較対象なし）の場合は増減だけnullにする。
      // タイムの数字と増減の数字の間に区切りが無いことがあるため、実際に見つかった
      // タイムの開始位置より前の範囲だけを対象にして、時刻の桁を巻き込まないようにする。
      // 「±」は常に増減0を表す記号であり、直後の「0」は時刻側の分の桁と隣接して区別が
      // つかなくなることがあるため、数字を読み取らず「±」自体の有無だけで判定する。
      const beforeTime = rowText.slice(0, found.matchIndex);
      const bodyWeightMatch = beforeTime.match(/(\d{3})(?:(±)\s*0?|([＋+－\-])\s*(\d{1,2})|\s*([―ー]))(?=[^\d]*$)/);
      const bodyWeight = bodyWeightMatch ? parseInt(bodyWeightMatch[1], 10) : null;
      const bodyWeightChange = bodyWeightMatch
        ? (bodyWeightMatch[2] ? 0
          : bodyWeightMatch[3] ? (bodyWeightMatch[3] === '－' || bodyWeightMatch[3] === '-' ? -1 : 1) * parseInt(bodyWeightMatch[4], 10)
          : null)
        : null;

      // 着順はPDF内の掲載順（＝着順）そのもの。タイム不明で除外した馬は数えない。
      horses.push({
        name: matches[i].name,
        finishRank: horses.length + 1,
        waku,
        umaban,
        timeStr: found.timeStr,
        totalSeconds: found.totalSeconds,
        jockeyName,
        odds,
        weight,
        bodyWeight,
        bodyWeightChange,
      });
      lastTime = found;
    }
    // どれも見つからなければタイム不明としてこの馬はスキップ
  }

  return horses;
}

function findColonTime(rowText: string): { timeStr: string; totalSeconds: number; matchIndex: number } | null {
  const re = /(\d{1,2})[：:](\d{2})[．.](\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowText)) !== null) {
    const minutes = parseInt(m[1], 10);
    if (minutes <= 4) {
      const seconds = parseInt(m[2], 10);
      const tenths = parseInt(m[3], 10);
      return {
        timeStr: `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`,
        totalSeconds: minutes * 60 + seconds + tenths / 10,
        matchIndex: m.index,
      };
    }
    // 分の値が非現実的（体重増減の数字を巻き込んでいる）場合、1文字ずらして再探索
    re.lastIndex = m.index + 1;
  }
  return null;
}

function findDittoTime(
  rowText: string,
  lastTime: { timeStr: string; totalSeconds: number } | null
): { timeStr: string; totalSeconds: number; matchIndex: number } | null {
  const idx = rowText.indexOf('〃');
  if (idx !== -1 && lastTime) {
    return { ...lastTime, matchIndex: idx };
  }
  return null;
}

function findShortTime(rowText: string): { timeStr: string; totalSeconds: number; matchIndex: number } | null {
  // 1分未満のレース（例:「59．4」）は「分：秒」ではなく「秒．コンマ」の表記になる。
  // 斤量の小数（例:「55．5」）と紛らわしいため、妥当な秒数(40〜75秒)の範囲でのみ採用する。
  const re = /(\d{2})[．.](\d)(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowText)) !== null) {
    const seconds = parseInt(m[1], 10);
    const tenths = parseInt(m[2], 10);
    const totalSeconds = seconds + tenths / 10;
    if (totalSeconds >= 40 && totalSeconds <= 75) {
      return { timeStr: `0:${m[1]}.${m[2]}`, totalSeconds, matchIndex: m.index };
    }
  }
  return null;
}