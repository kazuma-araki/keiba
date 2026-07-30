/**
 * 「券種間の価格差」仮説の検証: 単勝オッズ（全頭分ある、市場で最も資金が集まり
 * 効率的とされる）から、Harville式の逐次確率モデルで複勝・馬連・馬単・ワイド・
 * 3連複・3連単の「理論上の公正な確率・配当」を計算し、実際の払戻金と比較する。
 *
 * 【考え方】
 * 単勝オッズだけから、各馬の勝率(デビグ後)を求め、Harvilleの式
 *   P(1着=i) = p_i
 *   P(2着=j | 1着=i) = p_j / (1 - p_i)
 *   P(3着=k | 1着=i,2着=j) = p_k / (1 - p_i - p_j)
 * を使って、実際に的中した組み合わせ（着順から特定できる）の理論的中確率を求める。
 * 理論上の公正配当（控除なし）= 100 / 理論的中確率。
 *
 * 実際の払戻金 ÷ 理論上の公正配当 の比率が、その券種の「単勝市場が示す確率に対して
 * 相対的に高いか安いか」を表す。この比率が券種によって系統的に高い/低いなら、
 * 自分の予想モデルの精度とは無関係に、券種間の価格差だけで説明できる構造的な
 * 歪みがあるということになる（実際にオッズ板全体を取得したわけではなく単勝オッズの
 * みからの理論値なので、あくまで診断・仮説検証であり、これ自体を賭け戦略には使わない）。
 *
 *   npx ts-node crossPoolArbitrage.ts
 */

import * as fs from 'fs';
import * as path from 'path';

interface RaceFactRecord {
  year: number; kaisai: number; day: number; raceNumber: number;
  location: string; raceDate: string; horseName: string; finishRank: number;
  odds: number | null;
  winPayout: number | null; placePayouts: number[]; quinellaPayout: number | null;
  exactaPayout: number | null; widePayouts: number[]; trioPayout: number | null; trifectaPayout: number | null;
}

function loadRecords(years: number[]): RaceFactRecord[] {
  const records: RaceFactRecord[] = [];
  for (const year of years) {
    const file = path.join(__dirname, `race_facts_${year}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line));
    }
  }
  return records;
}
function raceKeyOf(r: RaceFactRecord): string {
  return `${r.year}-${r.kaisai}-${r.location}-${r.day}-${r.raceNumber}`;
}

// Harville式：残った馬の中でのシーケンシャル確率。orderIdxはp配列内のインデックス列。
function sequentialProb(orderIdx: number[], p: number[]): number {
  let prob = 1;
  let denom = 1;
  const used = new Set<number>();
  for (const idx of orderIdx) {
    prob *= p[idx] / denom;
    denom -= p[idx];
    used.add(idx);
    if (denom <= 0) return 0;
  }
  return prob;
}

function permutations3(idx: number[]): number[][] {
  const out: number[][] = [];
  for (const a of idx) for (const b of idx) for (const c of idx) {
    if (a !== b && b !== c && a !== c) out.push([a, b, c]);
  }
  return out;
}

interface RaceGroup {
  horses: { horseName: string; finishRank: number; odds: number }[];
  winPayout: number | null; placePayouts: number[]; quinellaPayout: number | null;
  exactaPayout: number | null; widePayouts: number[]; trioPayout: number | null; trifectaPayout: number | null;
}

function buildRaces(records: RaceFactRecord[]): RaceGroup[] {
  const races = new Map<string, RaceGroup>();
  for (const r of records) {
    const key = raceKeyOf(r);
    let race = races.get(key);
    if (!race) {
      race = {
        horses: [], winPayout: r.winPayout, placePayouts: r.placePayouts, quinellaPayout: r.quinellaPayout,
        exactaPayout: r.exactaPayout, widePayouts: r.widePayouts, trioPayout: r.trioPayout, trifectaPayout: r.trifectaPayout,
      };
      races.set(key, race);
    }
    if (r.odds != null && r.odds > 0 && r.finishRank > 0) {
      race.horses.push({ horseName: r.horseName, finishRank: r.finishRank, odds: r.odds });
    }
  }
  return [...races.values()];
}

interface RatioStat { ratios: number[]; }
function newStat(): RatioStat { return { ratios: [] }; }
function mean(a: number[]): number { return a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function printStat(label: string, s: RatioStat): void {
  const over1 = s.ratios.filter(r => r > 1).length;
  console.log(`${label}: 平均比=${mean(s.ratios).toFixed(3)} 中央値比=${median(s.ratios).toFixed(3)} 比>1の割合=${(s.ratios.length ? (over1 / s.ratios.length * 100) : 0).toFixed(1)}% (n=${s.ratios.length})`);
}

function main(): void {
  const allRecords = loadRecords([2025, 2026]);
  const races = buildRaces(allRecords);

  const stats = {
    win: newStat(), place: newStat(), quinella: newStat(), exacta: newStat(),
    wide: newStat(), trio: newStat(), trifecta: newStat(),
  };
  const placeByPopularity = new Map<string, RatioStat>([
    ['1番人気', newStat()], ['2-3番人気', newStat()], ['4-6番人気', newStat()], ['7番人気以下', newStat()],
  ]);
  function popularityBucket(rank: number): string {
    if (rank === 1) return '1番人気';
    if (rank <= 3) return '2-3番人気';
    if (rank <= 6) return '4-6番人気';
    return '7番人気以下';
  }

  let skippedTooFewOdds = 0;

  for (const race of races) {
    const n = race.horses.length;
    if (n < 5) { skippedTooFewOdds++; continue; }

    // デビグ：1/オッズを正規化して合計1になるようにする（単純な比例デビグ）
    const rawP = race.horses.map(h => 1 / h.odds);
    const sumP = rawP.reduce((s, v) => s + v, 0);
    const p = rawP.map(v => v / sumP);

    const idxByFinish = new Map<number, number>(); // finishRank -> index
    race.horses.forEach((h, i) => { if (h.finishRank >= 1 && h.finishRank <= 3) idxByFinish.set(h.finishRank, i); });
    const i1 = idxByFinish.get(1), i2 = idxByFinish.get(2), i3 = idxByFinish.get(3);

    // 単勝：理論公正オッズ = 1/p_i1。実オッズ(race.horses[i1].odds)は市場そのものなので
    // ここでは「払戻(オッズ×100)÷理論公正配当」を見る＝デビグ後確率と実オッズの比較。
    if (i1 != null && race.winPayout != null) {
      const theoreticalPayout = 100 / p[i1];
      stats.win.ratios.push(race.winPayout / theoreticalPayout);
    }

    // 人気順（オッズ昇順）を求めておく。複勝プレミアムが人気層によって違うか見るため。
    const popularityRank = new Map<number, number>();
    [...race.horses.keys()].sort((a, b) => race.horses[a].odds - race.horses[b].odds)
      .forEach((idx, rank) => popularityRank.set(idx, rank + 1));

    // 複勝：1着馬の複勝理論確率 ≈ P(1着 or 2着 or 3着になる) = 1 - P(top3に入らない)。
    // Harvilleで正確に出すには他馬との組み合わせが必要なため、近似として
    // 「1着馬が3着以内に入る確率」をP(1着)+P(2着)+P(3着)の合算で計算する。
    if (i1 != null && race.placePayouts.length > 0) {
      const others = race.horses.map((_, i) => i).filter(i => i !== i1);
      let pTop3 = 0;
      // P(1着=i1)
      pTop3 += p[i1];
      // P(2着=i1) = Σ_j p_j * p_i1/(1-p_j)
      // P(3着=i1) = Σ_j Σ_k(≠j) p_j * p_k/(1-p_j) * p_i1/(1-p_j-p_k)
      for (const j of others) {
        pTop3 += p[j] * p[i1] / (1 - p[j]);
        for (const k of others) {
          if (k === j) continue;
          const denom2 = 1 - p[j] - p[k];
          if (denom2 <= 0) continue;
          pTop3 += p[j] * (p[k] / (1 - p[j])) * (p[i1] / denom2);
        }
      }
      const theoreticalPayout = 100 / pTop3;
      const ratio = race.placePayouts[0] / theoreticalPayout;
      stats.place.ratios.push(ratio);
      const rank = popularityRank.get(i1);
      if (rank != null) placeByPopularity.get(popularityBucket(rank))!.ratios.push(ratio);
    }

    if (i1 != null && i2 != null) {
      const pExacta = sequentialProb([i1, i2], p);
      if (pExacta > 0) {
        if (race.exactaPayout != null) stats.exacta.ratios.push(race.exactaPayout / (100 / pExacta));
        if (race.quinellaPayout != null) {
          const pQuinella = pExacta + sequentialProb([i2, i1], p);
          stats.quinella.ratios.push(race.quinellaPayout / (100 / pQuinella));
        }
      }
    }

    if (i1 != null && i2 != null && i3 != null) {
      const pTrifecta = sequentialProb([i1, i2, i3], p);
      if (pTrifecta > 0 && race.trifectaPayout != null) {
        stats.trifecta.ratios.push(race.trifectaPayout / (100 / pTrifecta));
      }
      const trioPerms = permutations3([i1, i2, i3]);
      const pTrio = trioPerms.reduce((s, perm) => s + sequentialProb(perm, p), 0);
      if (pTrio > 0 && race.trioPayout != null) {
        stats.trio.ratios.push(race.trioPayout / (100 / pTrio));
      }

      // ワイド：ペア{a,b}が着順に関係なく3着以内に入る確率 = 「3着以内の残り1頭がx」の
      // ケースをすべてのx（a,b以外の全馬）について足し合わせた周辺確率。
      const pairsAndPayout: [number, number, number][] = [[i1, i2, 0], [i1, i3, 1], [i2, i3, 2]];
      const allIdx = race.horses.map((_, i) => i);
      for (const [a, b, payoutIdx] of pairsAndPayout) {
        if (race.widePayouts[payoutIdx] == null) continue;
        const otherHorses = allIdx.filter(i => i !== a && i !== b);
        let pWide = 0;
        for (const x of otherHorses) {
          pWide += permutations3([a, b, x]).reduce((s, perm) => s + sequentialProb(perm, p), 0);
        }
        if (pWide > 0) stats.wide.ratios.push(race.widePayouts[payoutIdx] / (100 / pWide));
      }
    }
  }

  console.log(`対象レース数: ${races.length} (単勝オッズ5頭未満で除外: ${skippedTooFewOdds})`);
  console.log('\n実払戻 ÷ 単勝オッズ由来の理論公正配当（比が高いほど、その券種は単勝市場基準で「高く」払い戻されている＝相対的に美味しい）');
  printStat('単勝　　', stats.win);
  printStat('複勝(近似)', stats.place);
  printStat('馬連　　', stats.quinella);
  printStat('馬単　　', stats.exacta);
  printStat('ワイド　', stats.wide);
  printStat('3連複　', stats.trio);
  printStat('3連単　', stats.trifecta);

  console.log('\n複勝プレミアムの人気層別内訳（1着馬の人気順で分けた場合）:');
  for (const [label, s] of placeByPopularity) printStat(label, s);
}

main();
