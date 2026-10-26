/*
 * edit-distance.js
 * ----------------
 * 以動態規劃（Dynamic Programming）計算 Levenshtein 編輯距離，並在此基礎上
 * 實作：
 *   1. distance(a, b, maxDist)  —— 快速版（兩列滾動陣列 + 提早終止），
 *                                  用於拼字校正與模糊比對時大量比較字詞。
 *   2. matrix(a, b)             —— 完整 DP 表格 + 回溯路徑 + 對齊操作，
 *                                  用於介面上視覺化展示演算法。
 *   3. SpellCorrector           —— 以語料庫詞彙（含詞頻）為字典的拼字校正器。
 *
 * 遞迴式（插入、刪除、替換成本皆為 1）：
 *   D[i][0] = i,  D[0][j] = j
 *   D[i][j] = min( D[i-1][j]   + 1,                 // 刪除 a[i]
 *                  D[i][j-1]   + 1,                 // 插入 b[j]
 *                  D[i-1][j-1] + (a[i] == b[j] ? 0 : 1) )  // 相同 / 替換
 *
 * 可選的相鄰字元交換（Damerau–Levenshtein 的 OSA 版本）：
 *   若 a[i]==b[j-1] 且 a[i-1]==b[j]，另外考慮 D[i-2][j-2] + 1
 *   —— 打字最常見的錯誤就是兩個字母順序顛倒（nausae → nausea），
 *   純 Levenshtein 會算成距離 2，加入交換後為 1。拼字校正預設開啟。
 *
 * 純 JavaScript，無外部套件。對外公開為 window.EditDistance。
 */
(function (global) {
  "use strict";

  // -------------------------------------------------------------------
  // 快速版：只保留兩列，並在整列最小值已超過 maxDist 時提早結束
  // -------------------------------------------------------------------
  function distance(a, b, maxDist, transpose) {
    if (a === b) return 0;
    const n = a.length, m = b.length;
    if (maxDist === undefined || maxDist === null) maxDist = Infinity;
    if (Math.abs(n - m) > maxDist) return maxDist + 1;
    if (n === 0) return m;
    if (m === 0) return n;

    let prev2 = new Array(m + 1);  // 第 i-2 列（只有交換需要）
    let prev = new Array(m + 1);   // 第 i-1 列
    let curr = new Array(m + 1);   // 第 i 列
    for (let j = 0; j <= m; j++) prev[j] = j;

    for (let i = 1; i <= n; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const bj = b.charCodeAt(j - 1);
        const cost = ai === bj ? 0 : 1;
        let v = prev[j - 1] + cost;              // 相同 / 替換
        if (prev[j] + 1 < v) v = prev[j] + 1;    // 刪除
        if (curr[j - 1] + 1 < v) v = curr[j - 1] + 1; // 插入
        if (transpose && i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj &&
            prev2[j - 2] + 1 < v) {
          v = prev2[j - 2] + 1;                  // 相鄰交換
        }
        curr[j] = v;
        if (v < rowMin) rowMin = v;
      }
      // 每列最小值不會遞減（交換項 D[i-2][j-2]+1 ≥ D[i-1][j-1]），可提早終止
      if (rowMin > maxDist) return maxDist + 1;
      const t = prev2; prev2 = prev; prev = curr; curr = t;
    }
    return prev[m];
  }

  // -------------------------------------------------------------------
  // 完整版：回傳整張 DP 表、回溯路徑與逐字對齊操作
  // -------------------------------------------------------------------
  function matrix(a, b, transpose) {
    const n = a.length, m = b.length;
    const D = [];
    for (let i = 0; i <= n; i++) {
      D.push(new Array(m + 1).fill(0));
      D[i][0] = i;
    }
    for (let j = 0; j <= m; j++) D[0][j] = j;

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + cost);
        if (transpose && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          D[i][j] = Math.min(D[i][j], D[i - 2][j - 2] + 1);
        }
      }
    }

    // 回溯：從 D[n][m] 走回 D[0][0]，優先選對角線（相同/替換）
    const path = [];
    const ops = [];
    let i = n, j = m;
    path.push([i, j]);
    while (i > 0 || j > 0) {
      if (transpose && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] &&
          a[i - 1] !== b[j - 1] && D[i][j] === D[i - 2][j - 2] + 1) {
        ops.push({ op: "swap", from: a[i - 2] + a[i - 1], to: b[j - 2] + b[j - 1] });
        path.push([i - 1, j - 1]);
        i -= 2; j -= 2;
        path.push([i, j]);
        continue;
      }
      if (i > 0 && j > 0) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        if (D[i][j] === D[i - 1][j - 1] + cost) {
          ops.push({ op: cost === 0 ? "match" : "sub", from: a[i - 1], to: b[j - 1] });
          i--; j--;
          path.push([i, j]);
          continue;
        }
      }
      if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
        ops.push({ op: "del", from: a[i - 1], to: "" });
        i--;
      } else {
        ops.push({ op: "ins", from: "", to: b[j - 1] });
        j--;
      }
      path.push([i, j]);
    }
    ops.reverse();
    path.reverse();
    return { distance: D[n][m], table: D, path, ops };
  }

  // 依字長決定可容忍的編輯距離（短字只允許 1，長字允許 2）
  function defaultMaxDist(len) {
    if (len <= 3) return 0;
    if (len <= 7) return 1;
    return 2;
  }

  // -------------------------------------------------------------------
  // 拼字校正器：字典 = 語料庫中出現過的字（小寫）與其出現次數
  // -------------------------------------------------------------------
  function SpellCorrector(transpose) {
    this.transpose = transpose !== false; // 預設允許相鄰交換
    this.freq = new Map();     // word -> count
    this.byLength = new Map(); // length -> [words]，依長度分桶，加速候選篩選
  }

  SpellCorrector.prototype.build = function (freqMap) {
    this.freq = freqMap;
    this.byLength = new Map();
    freqMap.forEach((_, w) => {
      const L = w.length;
      if (!this.byLength.has(L)) this.byLength.set(L, []);
      this.byLength.get(L).push(w);
    });
  };

  SpellCorrector.prototype.has = function (word) {
    return this.freq.has(word);
  };

  /**
   * 找出與 word 編輯距離 ≤ maxDist 的候選字，依（距離小 → 詞頻高）排序。
   */
  SpellCorrector.prototype.candidates = function (word, maxDist, limit) {
    word = word.toLowerCase();
    if (maxDist === undefined) maxDist = defaultMaxDist(word.length);
    limit = limit || 5;
    const out = [];
    for (let L = word.length - maxDist; L <= word.length + maxDist; L++) {
      const bucket = this.byLength.get(L);
      if (!bucket) continue;
      for (const w of bucket) {
        if (w === word) continue;
        const d = distance(word, w, maxDist, this.transpose);
        if (d <= maxDist) out.push({ word: w, distance: d, freq: this.freq.get(w) });
      }
    }
    out.sort((x, y) => x.distance - y.distance || y.freq - x.freq || (x.word < y.word ? -1 : 1));
    return out.slice(0, limit);
  };

  SpellCorrector.prototype.correct = function (word, maxDist) {
    const c = this.candidates(word, maxDist, 1);
    return c.length ? c[0] : null;
  };

  global.EditDistance = {
    distance,
    matrix,
    defaultMaxDist,
    SpellCorrector,
  };
})(window);
