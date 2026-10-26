/*
 * zipf.js
 * -------
 * Zipf 分佈（Rank–Frequency）與詞頻譜（Frequency Spectrum）計算：
 *   - A–D 四種前處理條件的 CF、DF、IDF、詞彙統計與 log–log 迴歸
 *   - 高／中／低頻區段（依 DF 比例與 CF 門檻切分）的分段擬合與殘差分析
 * 圖表與表格的呈現在 zipf-report.js。
 *
 * Zipf 定律：f(r) ≈ C / r^α，取對數後 log f = log C − α · log r，
 * 因此在 log–log 座標上應接近一條斜率為 −α 的直線（英文語料 α ≈ 1）。
 * 這裡用最小平方法對 (log10 r, log10 CF) 做線性迴歸，求 slope、intercept、
 * Zipf exponent k、R² 與 RMSE。
 *
 * 停用詞表與 Porter stemmer 與檢索系統共用（ir-core.js）；Zipf 分析的分詞
 * 會保留數字，以符合作業「去除標點」的定義。
 *
 * 對外公開為 window.Zipf。
 */
(function (global) {
  "use strict";

  function sortCounts(map) {
    return Array.from(map.entries())
      .map(([term, freq]) => ({ term, freq }))
      .sort((a, b) => b.freq - a.freq || (a.term < b.term ? -1 : 1))
      .map((e, i) => Object.assign(e, { rank: i + 1 }));
  }

  // -------------------------------------------------------------------
  // 前處理條件（作業 Part VI）：每個條件都在前一個的基礎上多做一步
  //   A：Tokenization + Case folding（以空白切詞，標點仍黏在字上，例如 "obesity,"）
  //   B：A + 去除標點（保留字中的連字號、撇號與小數點，例如 glp-1、2.5；保留數字）
  //   C：B + 移除停用詞
  //   D：C + Porter stemming（純數字不做詞幹還原）
  // -------------------------------------------------------------------
  const TOKEN_RE = /\p{N}+(?:\.\p{N}+)+|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
  const CONDITIONS = [
    { key: "A", label: "A：Tokenization + Case folding", short: "A 分詞＋小寫" },
    { key: "B", label: "B：+ 去除標點", short: "B 去標點" },
    { key: "C", label: "C：+ 移除停用詞", short: "C 去停用詞" },
    { key: "D", label: "D：+ Porter stemming", short: "D 詞幹還原" },
  ];

  function tokensA(text) {
    return (text || "").toLowerCase().split(/\s+/).filter(Boolean);
  }
  function tokensB(text) {
    return (text || "").toLowerCase().match(TOKEN_RE) || [];
  }
  function removeStop(tokens) {
    return tokens.filter((w) => !IRCore.STOPWORDS.has(w));
  }
  function stemToken(w) {
    return /[a-z]/.test(w) ? IRCore.stem(w) : w;
  }
  // 把使用者輸入的詞轉成某個條件下的索引詞（CF/DF 查詢用）
  function normalizeTerm(word, key) {
    const w = String(word || "").trim().toLowerCase();
    if (!w) return "";
    if (key === "A") return w;
    const t = (w.match(TOKEN_RE) || [w])[0];
    if (key === "B") return t;
    if (IRCore.STOPWORDS.has(t)) return "";
    return key === "D" ? stemToken(t) : t;
  }

  // -------------------------------------------------------------------
  // log10(CF) = a − b · log10(r) 的最小平方法線性迴歸
  //   minFreq = 1：使用全部詞（預設）；minFreq = 2：排除只出現 1 次的詞
  //   回傳 slope、intercept(a)、Zipf exponent k = −slope、R²、RMSE
  // -------------------------------------------------------------------
  function fitZipf(ranked, minFreq, fromRank, toRank) {
    minFreq = minFreq || 1;
    fromRank = fromRank || 1;
    toRank = toRank || ranked.length;
    const xs = [], ys = [];
    for (let i = fromRank - 1; i < Math.min(toRank, ranked.length); i++) {
      const e = ranked[i];
      if (e.freq >= minFreq) {
        xs.push(Math.log10(e.rank));
        ys.push(Math.log10(e.freq));
      }
    }
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    if (!sxx) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    let sse = 0;
    for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
    const r2 = syy ? 1 - sse / syy : 1;
    return {
      slope, intercept, k: -slope, alpha: -slope,
      logC: intercept, C: Math.pow(10, intercept),
      r2, rmse: Math.sqrt(sse / n), points: n,
    };
  }

  // 某段排名的點，相對於整體迴歸線的殘差（log10 單位）
  function residualStats(ranked, fit, fromRank, toRank) {
    let s = 0, s2 = 0, n = 0;
    for (let i = fromRank - 1; i < Math.min(toRank, ranked.length); i++) {
      const e = ranked[i];
      const r = Math.log10(e.freq) - (fit.intercept + fit.slope * Math.log10(e.rank));
      s += r; s2 += r * r; n++;
    }
    return n ? { n, rmse: Math.sqrt(s2 / n), bias: s / n } : { n: 0, rmse: NaN, bias: NaN };
  }

  // -------------------------------------------------------------------
  // 區段界線（高頻／中頻／低頻）：
  //   高頻（太常見）= 排名在「最後一個 DF 比例超過 dfRatio 的詞」之前（含）
  //   低頻（太罕見）= CF ≤ cfMax 的詞（CF 由高到低排序，一定在最後面）
  //   中頻（顯著詞）= 其餘
  // DF 比例不隨 CF 排名單調遞減，所以高頻區可能包含少數 DF 未達門檻的詞；
  // 區段一律依排名切分，與圖上的兩條界線一致。
  // -------------------------------------------------------------------
  function zoneBounds(ranked, numDocs, dfRatio, cfMax) {
    const V = ranked.length;
    let highEnd = 0;
    ranked.forEach((e) => { if (e.df / numDocs > dfRatio && e.rank > highEnd) highEnd = e.rank; });
    let lowStart = ranked.findIndex((e) => e.freq <= cfMax) + 1;
    if (lowStart <= 0) lowStart = V + 1;
    lowStart = Math.max(lowStart, highEnd + 1);
    return { highEnd, lowStart, V };
  }

  // 依區段計算局部迴歸與相對於整體迴歸線的殘差；另附以 10 倍排名切分的細分
  function segmentAnalysis(ranked, fit, bounds) {
    const V = ranked.length;
    const seg = (name, from, to) => {
      if (to < from) return { name, from, to, n: 0, tokens: 0, local: null, resid: { n: 0, rmse: NaN, bias: NaN } };
      let tokens = 0;
      for (let i = from - 1; i < to; i++) tokens += ranked[i].freq;
      return { name, from, to, n: to - from + 1, tokens, local: fitZipf(ranked, 1, from, to), resid: residualStats(ranked, fit, from, to) };
    };
    const segments = [
      seg("高頻（太常見）", 1, bounds.highEnd),
      seg("中頻（顯著詞）", bounds.highEnd + 1, bounds.lowStart - 1),
      seg("低頻（太罕見）", bounds.lowStart, V),
    ];
    const decades = [];
    for (let a = 1; a <= V; a *= 10) {
      const b = Math.min(a * 10, V);
      decades.push(seg(`${a === 1 ? 1 : a + 1}–${b}`, a === 1 ? 1 : a + 1, b));
      if (b === V) break;
    }
    return { segments, decades };
  }

  // 詞頻譜：V(m) = 恰好出現 m 次的「不同詞」數量
  function spectrum(ranked) {
    const spec = new Map();
    ranked.forEach((e) => spec.set(e.freq, (spec.get(e.freq) || 0) + 1));
    return spec;
  }

  function summarize(ranked, totalTokens, numDocs) {
    const V = ranked.length;
    const spec = spectrum(ranked);
    const hapax = spec.get(1) || 0;
    const top10 = ranked.slice(0, 10).reduce((s, e) => s + e.freq, 0);
    const fitAll = fitZipf(ranked, 1);
    const fitNoHapax = fitZipf(ranked, 2);
    const headFit = fitZipf(ranked, 1, 1, 10);
    return {
      numDocs,
      tokens: totalTokens,
      vocab: V,
      avgTokens: numDocs ? totalTokens / numDocs : 0,
      hapax,
      hapaxRatio: V ? hapax / V : 0,
      ttr: totalTokens ? V / totalTokens : 0,
      top10Share: totalTokens ? top10 / totalTokens : 0,
      fit: fitAll,           // 圖上畫的擬合線（全部詞）
      fitAll,
      fitNoHapax,
      headK: headFit ? headFit.k : NaN,
      spectrum: spec,
    };
  }

  /**
   * 對每篇文件的文字做 A–D 四種前處理，計算 CF、DF、詞彙統計與 Zipf 迴歸。
   * 另外以 C（Porter 前）與 D（Porter 後）統計詞幹合併情形。
   * @param {string[]} texts 每篇文件的文字（標題＋摘要）
   */
  function analyze(texts) {
    const N = texts.length;
    const keys = ["A", "B", "C", "D"];
    const cf = {}, df = {}, total = {};
    keys.forEach((k) => { cf[k] = new Map(); df[k] = new Map(); total[k] = 0; });
    const stemForms = new Map();              // stem -> Map(word -> freq)

    const add = (k, tokens) => {
      total[k] += tokens.length;
      const seen = new Set();
      tokens.forEach((w) => {
        cf[k].set(w, (cf[k].get(w) || 0) + 1);
        if (!seen.has(w)) { seen.add(w); df[k].set(w, (df[k].get(w) || 0) + 1); }
      });
    };

    texts.forEach((text) => {
      const a = tokensA(text);
      const b = tokensB(text);
      const c = removeStop(b);
      const d = c.map(stemToken);
      add("A", a); add("B", b); add("C", c); add("D", d);
      c.forEach((w, i) => {
        const s = d[i];
        let forms = stemForms.get(s);
        if (!forms) { forms = new Map(); stemForms.set(s, forms); }
        forms.set(w, (forms.get(w) || 0) + 1);
      });
    });

    // 每種條件：CF、DF、IDF、詞彙統計與 Zipf 迴歸
    const conditions = {};
    CONDITIONS.forEach(({ key, label, short }) => {
      const ranked = sortCounts(cf[key]);
      ranked.forEach((e) => {
        e.df = df[key].get(e.term);
        e.dfRatio = e.df / N;
        e.idf = Math.log10(N / e.df);
        e.ratio = e.freq / e.df;
      });
      conditions[key] = Object.assign({ key, label, short, ranked }, summarize(ranked, total[key], N));
    });

    // 合併最多「不同詞形」的詞幹 —— 最能直接看出 Porter 的效果
    const merges = Array.from(stemForms.entries())
      .filter(([, forms]) => forms.size > 1)
      .map(([s, forms]) => ({
        stem: s,
        freq: conditions.D.ranked.find((e) => e.term === s).freq,
        forms: Array.from(forms.entries()).sort((x, y) => y[1] - x[1]),
      }))
      .sort((x, y) => y.forms.length - x.forms.length || y.freq - x.freq);

    return { numDocs: N, conditions, merges, mergedStemCount: merges.length };
  }

  global.Zipf = { analyze, fitZipf, spectrum, zoneBounds, segmentAnalysis, normalizeTerm, CONDITIONS };
})(window);
