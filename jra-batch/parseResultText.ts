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

export interface ParsedHorseResult {
  name: string;
  finishRank: number; // 着順（タイム不明で除外された馬は含めない中での順位）
  timeStr: string;
  totalSeconds: number;
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
  horses: ParsedHorseResult[];
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
}

const CONDITION_WORDS = ['良', '稍重', '重', '不良'];
const NO_FINISH_WORDS = /競走中止|除外|取消|失格|中止/;

export function parseDayResultText(rawText: string, diagnostics?: ParseDiagnostics): ParsedRaceResult[] {
  // 5桁のレースID＋日付（例: "02001 1月24日"）を境目にレース単位で分割する
  const blocks = rawText
    .split(/(?=\d{5}\s*\d+月\s*\d+日)/g)
    .filter(b => /^\d{5}\s*\d+月\s*\d+日/.test(b.trim()));

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

    const dateMatch = block.match(/(\d+)月\s*(\d+)日/);
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

    // 出走馬一覧：「（N頭）」より前の範囲だけを対象にする
    const headCountMatch = block.match(/（(\d+)頭）/);
    const horseSection = headCountMatch ? block.slice(0, headCountMatch.index) : block;

    const horses = extractHorseTimes(horseSection);
    if (horses.length > 0) {
      if (diagnostics && headCountMatch) {
        const expectedCount = parseInt(headCountMatch[1], 10);
        if (expectedCount !== horses.length) diagnostics.horseCountMismatch++;
      }
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
        horses,
      });
    } else if (diagnostics) {
      diagnostics.skippedNoHorses++;
    }
  }

  return results;
}

function extractHorseTimes(section: string): ParsedHorseResult[] {
  // 馬名は「カタカナ2〜9文字」＋直後に性別記号(牡/牝/セ)＋年齢＋毛色、という並びで検出する。
  // 短い馬名は均等割り付けのため文字間に空白・タブが挿入されることがあるので許容し、
  // 抽出後に空白を除去して名前を復元する。
  // 性別記号はPDFのフォント変換の都合で稀に別の記号に化けることがある（日によって化け方が
  // 変わりうるため特定の文字には決め打ちしない）ため、直後に続く毛色の漢字で位置を裏取りする。
  const nameRegex = /((?:[ァ-ヶー][ \t　]*){2,9})\S\d{1,2}(?=[鹿栗芦黒青白栃])/g;
  const matches: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = nameRegex.exec(section)) !== null) {
    matches.push({ name: m[1].replace(/[ \t　]/g, ''), index: m.index });
  }

  const horses: ParsedHorseResult[] = [];
  let lastTime: { timeStr: string; totalSeconds: number } | null = null;

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : section.length;
    const rowText = section.slice(start, end);

    if (NO_FINISH_WORDS.test(rowText)) {
      continue; // 競走中止・除外などタイムが存在しない馬はスキップ
    }

    // 体重増減の数字（例:「482－ 2」）がタイムの数字（例:「1：47．4」）と
    // 区切りなしで連結し「21：47．4」のように見えるケースがあるため、
    // 妥当な分数（0〜4分）になる位置が見つかるまで1文字ずつずらして探索する
    const found: { timeStr: string; totalSeconds: number } | null =
      findColonTime(rowText) ?? findDittoTime(rowText, lastTime) ?? findShortTime(rowText);

    if (found) {
      // 着順はPDF内の掲載順（＝着順）そのもの。タイム不明で除外した馬は数えない。
      horses.push({
        name: matches[i].name,
        finishRank: horses.length + 1,
        timeStr: found.timeStr,
        totalSeconds: found.totalSeconds,
      });
      lastTime = found;
    }
    // どれも見つからなければタイム不明としてこの馬はスキップ
  }

  return horses;
}

function findColonTime(rowText: string): { timeStr: string; totalSeconds: number } | null {
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
): { timeStr: string; totalSeconds: number } | null {
  if (/〃/.test(rowText) && lastTime) {
    return { ...lastTime };
  }
  return null;
}

function findShortTime(rowText: string): { timeStr: string; totalSeconds: number } | null {
  // 1分未満のレース（例:「59．4」）は「分：秒」ではなく「秒．コンマ」の表記になる。
  // 斤量の小数（例:「55．5」）と紛らわしいため、妥当な秒数(40〜75秒)の範囲でのみ採用する。
  const re = /(\d{2})[．.](\d)(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowText)) !== null) {
    const seconds = parseInt(m[1], 10);
    const tenths = parseInt(m[2], 10);
    const totalSeconds = seconds + tenths / 10;
    if (totalSeconds >= 40 && totalSeconds <= 75) {
      return { timeStr: `0:${m[1]}.${m[2]}`, totalSeconds };
    }
  }
  return null;
}