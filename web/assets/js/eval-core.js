/*
 * eval-core.js
 * ------------
 * 檢索評估指標（作業三・任務五）。純函式、沒有 DOM，網頁與 Node 都能使用。
 *
 * 相關性標籤 qrels：{ 查詢 id: { 文件 id: 等級 } }，等級 2 = 高度相關、
 * 1 = 部分相關、0 = 不相關；沒有被標註的文件一律視為不相關（0）。
 *
 *   P@k     = 前 k 筆中相關文件的比例（等級 ≥ 1 才算相關）
 *   R@k     = 所有相關文件中，有幾成出現在前 k 筆
 *   RR      = 1 / 第一筆相關文件的名次（沒有則為 0）；所有查詢平均即 MRR
 *   AP      = 每找到一篇相關文件時的 precision 平均（除以相關文件總數）；平均即 MAP
 *   nDCG@k  = DCG@k / IDCG@k，DCG = Σ (2^g − 1) / log2(i + 1)，會用到 0/1/2 的分級
 *
 * 對外公開為 window.EvalCore。
 */
(function (global) {
  "use strict";

  const isRel = (g) => (g || 0) >= 1;

  function gradesOf(rankedIds, judg) {
    return rankedIds.map((id) => judg[id] || 0);
  }
  function numRelevant(judg) {
    return Object.values(judg).filter(isRel).length;
  }

  function precisionAt(rankedIds, judg, k) {
    if (!k) return 0;
    return gradesOf(rankedIds.slice(0, k), judg).filter(isRel).length / k;
  }
  function recallAt(rankedIds, judg, k) {
    const R = numRelevant(judg);
    if (!R) return 0;
    return gradesOf(rankedIds.slice(0, k), judg).filter(isRel).length / R;
  }
  function reciprocalRank(rankedIds, judg) {
    for (let i = 0; i < rankedIds.length; i++) if (isRel(judg[rankedIds[i]])) return 1 / (i + 1);
    return 0;
  }
  function averagePrecision(rankedIds, judg) {
    const R = numRelevant(judg);
    if (!R) return 0;
    let hit = 0, sum = 0;
    rankedIds.forEach((id, i) => {
      if (isRel(judg[id])) { hit++; sum += hit / (i + 1); }
    });
    return sum / R;
  }
  function dcg(grades) {
    return grades.reduce((s, g, i) => s + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  }
  function ndcgAt(rankedIds, judg, k) {
    const ideal = Object.values(judg).filter((g) => g > 0).sort((a, b) => b - a).slice(0, k);
    const idcg = dcg(ideal);
    if (!idcg) return 0;
    return dcg(gradesOf(rankedIds.slice(0, k), judg)) / idcg;
  }

  // 單一查詢的所有指標
  function evaluateRun(rankedIds, judg, ks) {
    ks = ks || {};
    const out = {
      p5: precisionAt(rankedIds, judg, 5),
      p10: precisionAt(rankedIds, judg, 10),
      r10: recallAt(rankedIds, judg, 10),
      r20: recallAt(rankedIds, judg, 20),
      rr: reciprocalRank(rankedIds, judg),
      ap: averagePrecision(rankedIds, judg),
      ndcg10: ndcgAt(rankedIds, judg, 10),
    };
    if (ks.k) {
      out.pk = precisionAt(rankedIds, judg, ks.k);
      out.rk = recallAt(rankedIds, judg, ks.k);
      out.ndcgk = ndcgAt(rankedIds, judg, ks.k);
    }
    return out;
  }

  // 多個查詢取平均（macro average）
  function mean(rows, key) {
    if (!rows.length) return 0;
    return rows.reduce((s, r) => s + (r[key] || 0), 0) / rows.length;
  }

  // 兩份排名前 k 筆的重疊數，與名次變化
  function overlapAt(a, b, k) {
    const sb = new Set(b.slice(0, k));
    return a.slice(0, k).filter((id) => sb.has(id)).length;
  }

  // 前 k 筆的 Spearman footrule 距離（正規化到 0–1，0 = 完全相同），未進入另一份前 k 名者以 k+1 計
  function footruleAt(a, b, k) {
    const pa = new Map(a.slice(0, k).map((id, i) => [id, i + 1]));
    const pb = new Map(b.slice(0, k).map((id, i) => [id, i + 1]));
    const ids = new Set([...pa.keys(), ...pb.keys()]);
    let d = 0;
    ids.forEach((id) => { d += Math.abs((pa.get(id) || k + 1) - (pb.get(id) || k + 1)); });
    const max = k * (k + 1); // 兩份前 k 名完全不重疊時的距離
    return max ? d / max : 0;
  }

  global.EvalCore = {
    precisionAt, recallAt, reciprocalRank, averagePrecision, ndcgAt, dcg,
    evaluateRun, mean, numRelevant, overlapAt, footruleAt, isRel,
  };
})(typeof window !== "undefined" ? window : globalThis);
