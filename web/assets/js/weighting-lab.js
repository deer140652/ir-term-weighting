/*
 * weighting-lab.js
 * ----------------
 * 「權重實驗」區塊（作業三：Term Weighting）。
 *   - 方法總覽（靜態表格，在 index.html）
 *   - Raw TF vs Log TF：單篇文件的詞項權重對照、tf 與權重的曲線、整個語料的統計
 *   - 文件頻率與 IDF：常見詞與少見詞的 IDF、查詢詞的權重、df–IDF 曲線
 *   - 排名比較：同一查詢、兩種權重方法的前 10 名並排
 *   - 評估：12 個測試查詢 × 12 種設定的 P@k、R@k、MRR、MAP、nDCG@10 與圖表
 *
 * 網頁只呈現數據與圖表，不自動產生結論。
 *   - 測試查詢與相關性標註：檢視、修改、匯出／匯入 qrels
 *
 * 實驗一律走 IRCore.rank()：與搜尋區相同的前處理與向量空間模型，但不經過
 * 拼字校正、模糊比對與萬用字元，確保比較時只有權重方法這一個變因。
 * 語料與索引透過 app.js 的 window.IRApp 取得。
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "–");
  const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : "–");

  // 圖表顏色（已用 dataviz 驗證器檢查：色覺辨識與對比皆通過）
  const C_A = "#C0601A"; // L2 正規化／Log TF
  const C_B = "#2E6FC7"; // 不正規化／Raw TF

  const PRESETS = IRCore.WEIGHT_PRESETS;
  const NORMS = [{ id: "l2", label: "L2" }, { id: "none", label: "無正規化" }];
  const CONFIGS = [];
  PRESETS.forEach((p) => NORMS.forEach((n) => CONFIGS.push({
    key: `${p.id}|${n.id}`, preset: p, norm: n.id,
    label: `${p.label}｜${n.id === "l2" ? "L2（cosine）" : "無正規化（內積）"}`,
  })));
  const cfgByKey = (k) => CONFIGS.find((c) => c.key === k) || CONFIGS[0];

  let SET = null;          // data/eval-set.json
  let USER_QRELS = {};     // 使用者修改的判斷 { qid: { docId: 等級 } }（含 0）
  let SCOPE = "abstract";
  let READY = false;
  let LAST_EVAL = null;

  // ------------------------------------------------------------------
  // 共用：排名、相關性
  // ------------------------------------------------------------------
  function indexFor(preset, scope) {
    return IRApp.getIndex(scope || SCOPE, { tf: preset.tf, idf: preset.idf });
  }
  function rankIds(cfg, text, scope) {
    return IRCore.rank(text, indexFor(cfg.preset, scope), cfg.norm).map((r) => r.id);
  }
  function rankFull(cfg, text) {
    return IRCore.rank(text, indexFor(cfg.preset), cfg.norm);
  }

  // 有效的相關性判斷：內建 qrels（等級 ≥ 1）＋ pool 中其餘文件為 0，再以使用者修改覆蓋
  function judgments(qid) {
    const out = {};
    if (!SET) return out;
    (SET.pools[qid] || []).forEach((id) => { out[id] = 0; });
    Object.assign(out, SET.qrels[qid] || {});
    Object.assign(out, USER_QRELS[qid] || {});
    return out;
  }
  function qrelsOf(qid) {
    const j = judgments(qid), out = {};
    for (const id in j) if (j[id] > 0) out[id] = j[id];
    return out;
  }
  function findQuery(text) {
    if (!SET) return null;
    const t = text.trim().toLowerCase();
    return SET.queries.find((q) => q.text.toLowerCase() === t) || null;
  }
  function avgDocLen() {
    const st = IRApp.getStats(SCOPE);
    const v = Object.values(st.docLen);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  }
  function docTitle(id) {
    const d = IRApp.docById(id);
    return d ? d.title : id;
  }
  function pmidOf(id) {
    const d = IRApp.docById(id);
    return d ? (d.pmid || d.pmcid || id) : id;
  }

  // ------------------------------------------------------------------
  // 浮動提示框（圖表 hover）
  // ------------------------------------------------------------------
  let TIP = null;
  function tip() {
    if (!TIP) {
      TIP = document.createElement("div");
      TIP.className = "wl-tooltip";
      TIP.hidden = true;
      document.body.appendChild(TIP);
    }
    return TIP;
  }
  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 14, top = y - h - 10;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 16;
    t.style.left = `${left + window.scrollX}px`;
    t.style.top = `${top + window.scrollY}px`;
  }
  function hideTip() { if (TIP) TIP.hidden = true; }
  function bindBarTips(container) {
    container.querySelectorAll("[data-tip]").forEach((el) => {
      el.addEventListener("mousemove", (e) => showTip(el.dataset.tip, e.clientX, e.clientY));
      el.addEventListener("mouseleave", hideTip);
    });
  }

  // ------------------------------------------------------------------
  // 權重計算：文件向量
  // ------------------------------------------------------------------
  function pickHighTfDoc() {
    const st = IRApp.getStats(SCOPE);
    let best = null, bestTf = -1, bestLen = -1;
    st.ids.forEach((id) => {
      const tf = st.docTF[id];
      let m = 0;
      for (const t in tf) if (tf[t] > m) m = tf[t];
      if (m > bestTf || (m === bestTf && st.docLen[id] > bestLen)) { best = id; bestTf = m; bestLen = st.docLen[id]; }
    });
    return best;
  }
  function resolveDocInput(v) {
    v = (v || "").trim();
    if (!v) return null;
    for (const id of [v, "PMID" + v, v.toUpperCase()]) if (IRApp.docById(id)) return id;
    const st = IRApp.getStats(SCOPE);
    return st.ids.find((id) => (IRApp.docById(id) || {}).pmid === v) || null;
  }

  // 同一篇文件在 Raw TF、Log TF、TF-IDF（log TF）三種方法下的權重與 L2 正規化後權重
  function renderDocVector(docId) {
    const st = IRApp.getStats(SCOPE);
    if (!docId || !st.docTF[docId]) docId = pickHighTfDoc();
    if (!docId) { $("#wl-doc-table").innerHTML = `<p class="empty-state small">語料庫是空的。</p>`; return; }
    $("#wl-doc-id").value = pmidOf(docId);
    const N = st.N || 1;
    const tf = st.docTF[docId];
    const rows = Object.keys(tf).map((t) => {
      const lw = IRCore.tfWeight(tf[t], "log"), idf = IRCore.idfWeight(N, st.df[t], "classic");
      return { t, tf: tf[t], df: st.df[t], idf, raw: tf[t], log: lw, tfidf: lw * idf };
    });
    const norm = (k) => Math.sqrt(rows.reduce((s, r) => s + r[k] * r[k], 0)) || 1;
    const nr = norm("raw"), nl = norm("log"), nt = norm("tfidf");
    const rankOf = (k) => { const m = new Map(); rows.slice().sort((a, b) => b[k] - a[k] || (a.t < b.t ? -1 : 1)).forEach((r, i) => m.set(r.t, i + 1)); return m; };
    const rkRaw = rankOf("raw"), rkT = rankOf("tfidf");
    const sortKey = $("#wl-doc-sort").value === "tfidf" ? "tfidf" : "raw";
    const top = rows.slice().sort((a, b) => b[sortKey] - a[sortKey] || (a.t < b.t ? -1 : 1)).slice(0, 12);
    const cell = (v, rk) => `<td class="num">${f3(v)}${rk ? ` <small class="muted">#${rk}</small>` : ""}</td>`;
    $("#wl-doc-table").innerHTML = `
      <p class="lab-footnote"><a href="#" class="term-link" data-open="${esc(docId)}">${esc(docTitle(docId))}</a><br>PMID ${esc(pmidOf(docId))} · ${rows.length} 個不同詞幹、${st.docLen[docId]} 個索引詞 · 向量 L2 長度：Raw ${f3(nr)}、Log ${f3(nl)}、TF-IDF ${f3(nt)}</p>
      <div class="table-scroll"><table class="lab-table compact wl-doc-table">
        <thead>
          <tr><th rowspan="2">詞幹</th><th class="num" rowspan="2">tf</th><th class="num" rowspan="2">df</th><th class="num" rowspan="2">ln(N/df)</th>
            <th class="group-head" colspan="3">權重</th><th class="group-head" colspan="3">L2 正規化後權重（#＝在這篇的名次）</th></tr>
          <tr><th class="num">Raw TF</th><th class="num">Log TF</th><th class="num">TF-IDF</th><th class="num">Raw TF</th><th class="num">Log TF</th><th class="num">TF-IDF</th></tr>
        </thead>
        <tbody>${top.map((r) => `<tr><td><code>${esc(r.t)}</code></td><td class="num">${r.tf}</td><td class="num">${r.df}</td><td class="num">${f3(r.idf)}</td>
          <td class="num">${r.raw}</td><td class="num">${f3(r.log)}</td><td class="num">${f3(r.tfidf)}</td>
          ${cell(r.raw / nr, rkRaw.get(r.t))}${cell(r.log / nl, null)}${cell(r.tfidf / nt, rkT.get(r.t))}</tr>`).join("")}</tbody>
      </table></div>
      <p class="lab-footnote">TF-IDF 為 (1 + ln tf) × ln(N/df)。L2 正規化後權重 = 權重 ÷ 向量 L2 長度（√ 這篇所有詞權重的平方和）。Raw TF 與 Log TF 的詞序相同，所以只列 Raw TF 與 TF-IDF 的名次。</p>`;
    $("#wl-doc-table [data-open]").addEventListener("click", (e) => { e.preventDefault(); IRApp.openDoc(docId, []); });
  }

  function niceTicks(lo, hi, n) {
    const span = hi - lo, step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= step0) || step0;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
    return out;
  }

  // ------------------------------------------------------------------
  // 權重計算：語料統計
  // ------------------------------------------------------------------
  // 每篇文件權重最高的詞在 L2 正規化向量中的權重、與第二名的比值；tf 分佈
  function renderTfStats() {
    const st = IRApp.getStats(SCOPE);
    const N = st.N || 1;
    const K = ["raw", "log", "tfidf"];
    const acc = { top: { raw: 0, log: 0, tfidf: 0 }, ratio: { raw: 0, log: 0, tfidf: 0 }, over: { raw: 0, log: 0, tfidf: 0 } };
    let n = 0, base = 0, occ = 0, occ1 = 0, occ24 = 0, occ5 = 0, maxTfSum = 0;
    st.ids.forEach((id) => {
      const tf = st.docTF[id];
      const terms = Object.keys(tf);
      if (terms.length < 2) return;
      n++;
      base += 1 / Math.sqrt(terms.length);
      const w = {
        raw: terms.map((t) => tf[t]),
        log: terms.map((t) => IRCore.tfWeight(tf[t], "log")),
        tfidf: terms.map((t) => IRCore.tfWeight(tf[t], "log") * IRCore.idfWeight(N, st.df[t], "classic")),
      };
      K.forEach((k) => {
        const v = w[k].slice().sort((a, b) => b - a);
        const nm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        acc.top[k] += v[0] / nm;
        acc.ratio[k] += v[1] > 0 ? v[0] / v[1] : 1;
        if (v[0] / nm > 0.5) acc.over[k]++;
      });
      terms.forEach((t) => { occ++; if (tf[t] === 1) occ1++; else if (tf[t] < 5) occ24++; else occ5++; });
      maxTfSum += Math.max(...w.raw);
    });
    if (!n) { $("#wl-tf-stats").innerHTML = ""; return; }
    const row = (label, f) => `<tr><td>${label}</td>${K.map((k) => `<td class="num">${f(k)}</td>`).join("")}</tr>`;
    $("#wl-tf-stats").innerHTML = `
      <div class="table-scroll"><table class="lab-table compact">
        <thead><tr><th>${n.toLocaleString()} 篇文件平均</th><th class="num">Raw TF</th><th class="num">Log TF</th><th class="num">TF-IDF</th></tr></thead>
        <tbody>
          ${row("權重最高的詞，L2 正規化後的權重", (k) => f3(acc.top[k] / n))}
          ${row("權重第 1 名 ÷ 第 2 名", (k) => `${(acc.ratio[k] / n).toFixed(2)} 倍`)}
          ${row("最高權重 > 0.5 的文件數", (k) => acc.over[k].toLocaleString())}
        </tbody></table></div>
      <p class="lab-footnote">參考：每篇平均 ${(occ / n).toFixed(0)} 個不同詞幹；若每個詞權重都相同，L2 正規化後約為 ${f3(base / n)}。每篇最高 tf 平均 ${(maxTfSum / n).toFixed(1)}。</p>
      <div class="table-scroll"><table class="lab-table compact">
        <thead><tr><th>tf 分佈（所有「文件 × 詞」組合）</th><th class="num">tf = 1</th><th class="num">tf = 2–4</th><th class="num">tf ≥ 5</th></tr></thead>
        <tbody><tr><td>比例</td><td class="num">${(occ1 / occ * 100).toFixed(1)}%</td><td class="num">${(occ24 / occ * 100).toFixed(1)}%</td><td class="num">${(occ5 / occ * 100).toFixed(1)}%</td></tr></tbody>
      </table></div>`;
  }

  function renderIdfTable() {
    const st = IRApp.getStats(SCOPE);
    const N = st.N || 1;
    const terms = Object.keys(st.df);
    const common = terms.slice().sort((a, b) => st.df[b] - st.df[a]).slice(0, 10);
    const rare = terms.filter((t) => st.df[t] >= 3 && st.df[t] <= 15 && t.length > 3)
      .sort((a, b) => st.cf[b] - st.cf[a]).slice(0, 10);
    const row = (t) => {
      const ic = IRCore.idfWeight(N, st.df[t], "classic"), is = IRCore.idfWeight(N, st.df[t], "smooth");
      return `<tr><td><code>${esc(t)}</code></td><td class="num">${st.df[t]}</td><td class="num">${(st.df[t] / N * 100).toFixed(1)}%</td><td class="num">${st.cf[t]}</td><td class="num">${f3(ic)}</td><td class="num">${f3(is)}</td></tr>`;
    };
    $("#wl-idf-table").innerHTML = `
      <div class="table-scroll"><table class="lab-table compact">
        <thead><tr><th>詞幹</th><th class="num">df</th><th class="num">df / N</th><th class="num">cf</th><th class="num">ln(N/df)</th><th class="num">ln(N/df)+1</th></tr></thead>
        <tbody>
          <tr><td colspan="6" class="group-row">df 最高的 10 個詞</td></tr>${common.map(row).join("")}
          <tr><td colspan="6" class="group-row">df 介於 3–15 中 cf 最高的 10 個詞</td></tr>${rare.map(row).join("")}
        </tbody></table></div>
      <p class="lab-footnote">N = ${N.toLocaleString()}。df = 含有該詞的文件數；cf = 該詞在所有文件中出現的總次數。</p>`;
  }

  // ------------------------------------------------------------------
  // 權重計算：查詢向量
  // ------------------------------------------------------------------
  let QV_ROWS = [];
  function renderQueryVector(text) {
    const st = IRApp.getStats(SCOPE);
    const N = st.N || 1;
    const qtf = {};
    IRCore.queryTerms(text).forEach((t) => { qtf[t] = (qtf[t] || 0) + 1; });
    const uniq = Object.keys(qtf);
    const known = uniq.filter((t) => st.df[t]);
    const unknown = uniq.filter((t) => !st.df[t]);
    if (!known.length) {
      $("#wl-qv-table").innerHTML = `<p class="empty-state small">查詢詞都不在詞彙中。</p>`;
      $("#wl-qv-note").textContent = "";
      QV_ROWS = [];
      renderIdfChart();
      return;
    }
    // 查詢的 TF 部分使用 Log TF（1 + ln tf），與系統預設一致；tf = 1 時三種 TF 都等於 1
    const rows = known.map((t) => {
      const lt = IRCore.tfWeight(qtf[t], "log");
      const ic = IRCore.idfWeight(N, st.df[t], "classic"), is = IRCore.idfWeight(N, st.df[t], "smooth");
      return { t, tf: qtf[t], df: st.df[t], ic, is, w0: lt, w1: lt * ic, w2: lt * is };
    });
    const nm = (k) => Math.sqrt(rows.reduce((s, r) => s + r[k] * r[k], 0)) || 1;
    const n0 = nm("w0"), n1 = nm("w1"), n2 = nm("w2");
    rows.sort((a, b) => b.df - a.df);
    $("#wl-qv-table").innerHTML = `
      <div class="table-scroll"><table class="lab-table compact">
        <thead>
          <tr><th rowspan="2">查詢詞幹</th><th class="num" rowspan="2">tf</th><th class="num" rowspan="2">df</th><th class="num" rowspan="2">df / N</th><th class="num" rowspan="2">ln(N/df)</th><th class="num" rowspan="2">ln(N/df)+1</th>
            <th class="group-head" colspan="3">L2 正規化後的查詢權重（TF 為 Log TF）</th></tr>
          <tr><th class="num">不用 IDF</th><th class="num">IDF</th><th class="num">IDF+1</th></tr>
        </thead>
        <tbody>${rows.map((r) => `<tr><td><code>${esc(r.t)}</code></td><td class="num">${r.tf}</td><td class="num">${r.df}</td><td class="num">${(r.df / N * 100).toFixed(1)}%</td><td class="num">${f3(r.ic)}</td><td class="num">${f3(r.is)}</td>
          <td class="num">${f3(r.w0 / n0)}</td><td class="num">${f3(r.w1 / n1)}</td><td class="num">${f3(r.w2 / n2)}</td></tr>`).join("")}</tbody>
        <tfoot><tr class="wl-foot"><td colspan="6" title="正規化前的查詢權重（Log TF × IDF）平方加總再開根號；每個權重除以這個值，就得到上方的正規化後權重">L2 長度（正規化前，√ 權重平方和）</td>
          <td class="num">${f3(n0)}</td><td class="num">${f3(n1)}</td><td class="num">${f3(n2)}</td></tr></tfoot>
      </table></div>
      <p class="lab-footnote">正規化後權重 = （Log TF × IDF）÷ 該欄的 L2 長度。例如 IDF 欄：每個詞的 Log TF × ln(N/df) ÷ ${f3(n1)}；tf = 1 時 Log TF = 1，就是 ln(N/df) ÷ ${f3(n1)}。</p>`;
    const repeated = rows.filter((r) => r.tf > 1);
    const common = rows.filter((r) => r.df / N > 0.3);
    const share = (k) => common.reduce((s, r) => s + r[k], 0) / rows.reduce((s, r) => s + r[k], 0);
    $("#wl-qv-note").innerHTML = (repeated.length
      ? `${repeated.map((r) => `<code>${esc(r.t)}</code> 出現 ${r.tf} 次`).join("、")}，其餘詞 tf = 1；查詢權重以 Log TF × IDF 計算。`
      : `每個詞在查詢中都只出現一次（tf = 1），三種 TF 的值都是 1，查詢權重只差在 IDF。`)
      + (common.length ? ` df / N > 30% 的詞（${common.map((r) => `<code>${esc(r.t)}</code>`).join("、")}）佔權重總和：不用 IDF ${(share("w0") * 100).toFixed(0)}%、IDF ${(share("w1") * 100).toFixed(0)}%、IDF+1 ${(share("w2") * 100).toFixed(0)}%。` : "")
      + (unknown.length ? `（${unknown.map(esc).join("、")} 不在詞彙中，已忽略）` : "");
    QV_ROWS = rows;
    renderIdfChart();
  }

  // 標籤避讓：依序嘗試幾個位置，與已放置的標籤重疊就換位置；都放不下就省略（hover 仍可看到）
  function placeLabels(pts, xmin, xmax, obstacles) {
    const boxes = (obstacles || []).slice(), out = [];
    const cand = [[7, 4], [-7, 4], [7, -10], [-7, -10], [7, 18], [-7, 18], [7, -24], [-7, -24], [7, 32], [-7, 32], [7, -38], [-7, -38]];
    pts.slice().sort((a, b) => a.cx - b.cx).forEach((p) => {
      const w = p.t.length * 6.8 + 4, h = 13;
      for (const [dx, dy] of cand) {
        const x0 = dx > 0 ? p.cx + dx : p.cx + dx - w;
        const y0 = p.cy + dy - h + 3;
        if (x0 < xmin - 40 || x0 + w > xmax + 90) continue;
        const hit = boxes.some((b) => x0 < b.x + b.w && x0 + w > b.x && y0 < b.y + b.h && y0 + h > b.y);
        if (hit) continue;
        boxes.push({ x: x0, y: y0, w, h });
        out.push(`<text x="${x0 + 2}" y="${y0 + h - 3}" class="tick lbl">${esc(p.t)}</text>`);
        break;
      }
    });
    return out.join("");
  }

  // df → IDF 的兩條曲線（x 軸取對數），並標出目前查詢詞的位置
  function renderIdfChart() {
    const qrows = QV_ROWS;
    const st = IRApp.getStats(SCOPE);
    const N = st.N || 1;
    const W = 720, H = 280, m = { l: 48, r: 96, t: 14, b: 40 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const lx = (df) => Math.log10(df) / Math.log10(N);
    const x = (df) => m.l + lx(df) * iw;
    const yMax = Math.ceil(Math.log(N) + 1);
    const y = (v) => m.t + ih - (v / yMax) * ih;
    const curve = (sch) => {
      const pts = [];
      for (let i = 0; i <= 120; i++) { const df = Math.pow(N, i / 120); pts.push(`${x(df).toFixed(1)},${y(IRCore.idfWeight(N, df, sch)).toFixed(1)}`); }
      return pts.join(" ");
    };
    const xt = [1, 10, 100, 1000, 10000].filter((v) => v <= N);
    if (xt[xt.length - 1] !== N) xt.push(N);
    const yt = niceTicks(0, yMax, 5);
    const dots = (qrows || []).map((r) => `<circle cx="${x(r.df)}" cy="${y(r.ic)}" r="4.5" fill="${C_B}" stroke="var(--paper-raised)" stroke-width="2" data-tip="<strong>${esc(r.t)}</strong><br>df ${r.df}（${(r.df / N * 100).toFixed(1)}%）<br>ln(N/df) ${f3(r.ic)}<br>ln(N/df)+1 ${f3(r.is)}"/>
      <circle cx="${x(r.df)}" cy="${y(r.is)}" r="4.5" fill="${C_A}" stroke="var(--paper-raised)" stroke-width="2" data-tip="<strong>${esc(r.t)}</strong><br>df ${r.df}（${(r.df / N * 100).toFixed(1)}%）<br>ln(N/df) ${f3(r.ic)}<br>ln(N/df)+1 ${f3(r.is)}"/>
`).join("") + placeLabels((qrows || []).map((r) => ({ t: r.t, cx: x(r.df), cy: y(r.ic) })), m.l, m.l + iw,
      // 避開：所有圓點、x 軸刻度區、右側的系列名稱
      [].concat(...(qrows || []).map((r) => [{ x: x(r.df) - 6, y: y(r.ic) - 6, w: 12, h: 12 }, { x: x(r.df) - 6, y: y(r.is) - 6, w: 12, h: 12 }]),
        [{ x: 0, y: m.t + ih + 2, w: W, h: 40 }, { x: m.l + iw + 2, y: y(1) - 12, w: 90, h: 16 }, { x: m.l + iw + 2, y: y(0) - 12, w: 90, h: 16 }]));
    const el = $("#wl-idf-chart");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="wl-svg" role="img" aria-label="df 與 IDF 的關係">
      ${yt.map((v) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${m.l - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${v}</text>`).join("")}
      ${xt.map((v) => `<text x="${x(v)}" y="${m.t + ih + 16}" class="tick" text-anchor="middle">${v.toLocaleString()}</text>`).join("")}
      <line x1="${m.l}" x2="${m.l + iw}" y1="${y(0)}" y2="${y(0)}" class="axis"/>
      <text x="${m.l + iw / 2}" y="${H - 4}" class="axis-title" text-anchor="middle">df（含有該詞的文件數，對數刻度）</text>
      <text x="12" y="${m.t + ih / 2}" class="axis-title" text-anchor="middle" transform="rotate(-90 12 ${m.t + ih / 2})">IDF</text>
      <polyline points="${curve("classic")}" fill="none" stroke="${C_B}" stroke-width="2"/>
      <polyline points="${curve("smooth")}" fill="none" stroke="${C_A}" stroke-width="2"/>
      <text x="${m.l + iw + 6}" y="${y(0) + 4}" class="series-label">ln(N/df)</text>
      <text x="${m.l + iw + 6}" y="${y(1) + 4}" class="series-label">ln(N/df)+1</text>
      ${dots}
    </svg>
    <div class="chart-legend"><span><i style="background:${C_B}"></i>ln(N/df)</span><span><i style="background:${C_A}"></i>ln(N/df) + 1</span><span class="muted">圓點：上方「查詢向量」中的詞（標籤放不下時，滑鼠移到圓點上可查看）</span></div>`;
    bindBarTips(el);
    $("#wl-idf-tip").textContent = `N = ${N.toLocaleString()}。df = N 時，ln(N/df) = 0，ln(N/df)+1 = 1。`;
  }

  // ------------------------------------------------------------------
  // 排名比較
  // ------------------------------------------------------------------
  const CMP_PRESETS = [
    { label: "Raw TF vs Log TF", a: "rawtf|l2", b: "logtf|l2" },
    { label: "Log TF vs TF-IDF", a: "logtf|l2", b: "tfidf-log|l2" },
    { label: "IDF only vs TF-IDF", a: "idf|l2", b: "tfidf-log|l2" },
    { label: "Raw TF：L2 vs 不正規化", a: "rawtf|l2", b: "rawtf|none" },
    { label: "TF-IDF：L2 vs 不正規化", a: "tfidf-log|l2", b: "tfidf-log|none" },
    { label: "IDF vs IDF+1", a: "tfidf-log|l2", b: "tfidf-log-s|l2" },
  ];

  function renderCompare() {
    const text = $("#wl-cmp-q").value.trim();
    const out = $("#wl-cmp-out"), sum = $("#wl-cmp-summary");
    if (!text) { out.innerHTML = ""; sum.innerHTML = ""; return; }
    const A = cfgByKey($("#wl-cmp-a").value), B = cfgByKey($("#wl-cmp-b").value);
    const ra = rankFull(A, text), rb = rankFull(B, text);
    const ia = ra.map((r) => r.id), ib = rb.map((r) => r.id);
    const q = findQuery(text);
    const judg = q ? judgments(q.id) : null;
    const qr = q ? qrelsOf(q.id) : null;
    const st = IRApp.getStats(SCOPE);
    const terms = Array.from(new Set(IRCore.queryTerms(text)));
    const avg = avgDocLen();
    const meanLen = (ids) => { const v = ids.slice(0, 10).map((id) => st.docLen[id] || 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };

    const col = (cfg, list, other) => {
      const pos = new Map(other.slice(0, 10).map((id, i) => [id, i + 1]));
      const fullPos = new Map(other.map((id, i) => [id, i + 1]));
      const items = list.slice(0, 10).map((r, i) => {
        const p = pos.get(r.id);
        const fp = fullPos.get(r.id);
        let mv;
        if (p === undefined) mv = `<span class="mv new" title="另一欄的名次：${fp ? fp : "沒有出現"}">新${fp ? `（${fp}）` : ""}</span>`;
        else if (p === i + 1) mv = `<span class="mv same" title="另一欄也是第 ${i + 1} 名">＝</span>`;
        else mv = p > i + 1 ? `<span class="mv up" title="另一欄是第 ${p} 名">↑${p - i - 1}</span>` : `<span class="mv down" title="另一欄是第 ${p} 名">↓${i + 1 - p}</span>`;
        const g = judg ? judg[r.id] : undefined;
        const badge = g === undefined ? (judg ? `<span class="rel-badge na" title="未判讀">?</span>` : "") : `<span class="rel-badge g${g}">${g}</span>`;
        const len = st.docLen[r.id] || 0;
        return `<li><span class="cmp-rank">${i + 1}</span>${badge}
          <span class="cmp-main"><a href="#" class="cmp-title" data-open="${esc(r.id)}">${esc(docTitle(r.id))}</a>
          <span class="cmp-meta">${cfg.norm === "none" ? "內積" : "cosine"} ${f4(r.score)} · 長度 <span class="${len > avg * 1.3 ? "long" : ""}">${len}</span> · PMID ${esc(pmidOf(r.id))}</span></span>${mv}</li>`;
      }).join("");
      const m = qr ? EvalCore.evaluateRun(list.map((r) => r.id), qr) : null;
      return `<div class="cmp-col">
        <h4 class="cmp-head">${esc(cfg.label)}</h4>
        ${m ? `<p class="cmp-metrics">P@10 ${f3(m.p10)} · nDCG@10 ${f3(m.ndcg10)} · RR ${f3(m.rr)}</p>` : ""}
        <p class="cmp-metrics">前 10 名平均長度 ${meanLen(list.map((r) => r.id)).toFixed(0)}</p>
        <ol class="cmp-list">${items || `<li class="empty-state small">沒有結果</li>`}</ol></div>`;
    };
    out.innerHTML = col(A, ra, ib) + col(B, rb, ia);
    out.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); IRApp.openDoc(el.dataset.open, terms); }));
    const ov = EvalCore.overlapAt(ia, ib, 10);
    sum.innerHTML = `<p class="lab-result">兩欄前 10 名重疊 <strong>${ov}</strong> 篇 · 語料平均長度 ${avg.toFixed(0)} 個索引詞${q ? ` · 測試查詢 ${q.id}（${q.type === "short" ? "短" : "長"}查詢，相關文件 ${Object.keys(qr).length} 篇）` : " · 非測試查詢，沒有相關性標籤"}</p>`;
  }

  // ------------------------------------------------------------------
  // 評估
  // ------------------------------------------------------------------
  const METRIC_COLS = [
    { k: "p5", label: "P@5" }, { k: "p10", label: "P@10" }, { k: "r10", label: "R@10" }, { k: "r20", label: "R@20" },
    { k: "rr", label: "MRR" }, { k: "ap", label: "MAP" }, { k: "ndcg10", label: "nDCG@10" },
  ];

  function computeEval() {
    if (!SET) return null;
    const st = IRApp.getStats(SCOPE);
    const res = {};
    CONFIGS.forEach((cfg) => {
      const per = {}, lens = [];
      SET.queries.forEach((q) => {
        const ids = rankIds(cfg, q.text);
        per[q.id] = EvalCore.evaluateRun(ids, qrelsOf(q.id));
        ids.slice(0, 10).forEach((id) => lens.push(st.docLen[id] || 0));
      });
      const rows = Object.values(per);
      const mean = {};
      METRIC_COLS.forEach((c) => { mean[c.k] = EvalCore.mean(rows, c.k); });
      const by = (type) => SET.queries.filter((q) => q.type === type).map((q) => per[q.id]);
      mean.shortNdcg = EvalCore.mean(by("short"), "ndcg10");
      mean.longNdcg = EvalCore.mean(by("long"), "ndcg10");
      mean.len10 = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
      res[cfg.key] = { per, mean };
    });
    return res;
  }

  function renderEval() {
    if (!SET) return;
    LAST_EVAL = computeEval();
    const E = LAST_EVAL;
    const best = {};
    METRIC_COLS.forEach((c) => { best[c.k] = Math.max(...CONFIGS.map((cfg) => E[cfg.key].mean[c.k])); });
    const isBest = (k, v) => Math.abs(v - best[k]) < 1e-9;
    $("#wl-eval-table").innerHTML = `
      <div class="table-scroll"><table class="lab-table compact wl-eval-table">
        <thead><tr><th>權重方法</th><th>正規化</th>${METRIC_COLS.map((c) => `<th class="num">${c.label}</th>`).join("")}<th class="num" title="前 10 名文件的平均索引詞數">前 10 名<br>平均長度</th></tr></thead>
        <tbody>${PRESETS.map((p) => NORMS.map((n, ni) => {
          const m = E[`${p.id}|${n.id}`].mean;
          return `<tr class="${ni === 0 ? "grp-first" : ""}">${ni === 0 ? `<td rowspan="2">${esc(p.label)}</td>` : ""}<td>${n.id === "l2" ? "L2" : "無"}</td>
            ${METRIC_COLS.map((c) => `<td class="num">${isBest(c.k, m[c.k]) ? `<strong>${f3(m[c.k])}</strong>` : f3(m[c.k])}</td>`).join("")}
            <td class="num">${m.len10.toFixed(0)}</td></tr>`;
        }).join("")).join("")}</tbody>
      </table></div>
      <p class="lab-footnote">索引範圍：${SCOPE === "title" ? "標題＋摘要" : "只用摘要"}；語料平均長度 ${avgDocLen().toFixed(0)} 個索引詞。</p>`;
    renderEvalChart(E);
    renderGroupTable(E);
    renderPerQuery();
  }

  // 分組水平長條圖：每個權重方法一組，每組兩根（兩個系列）。refLine 可畫一條參考線（例如語料平均長度）
  function groupedBars(el, groups, series, opt) {
    const rowH = 30, barH = 11, gap = 2, W = opt.width || 500, m = { l: 196, r: 24, t: 8, b: 30 };
    const H = m.t + groups.length * rowH + m.b, iw = W - m.l - m.r;
    const max = opt.max;
    const x = (v) => m.l + (v / max) * iw;
    const bars = groups.map((label, i) => {
      const y0 = m.t + i * rowH + (rowH - series.length * barH - (series.length - 1) * gap) / 2;
      return series.map((sr, j) => {
        const v = sr.values[i];
        const y = y0 + j * (barH + gap);
        const w = Math.max(5, x(v) - m.l);
        return `<path d="M${m.l},${y} h${w - 4} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${sr.color}"/>
          <rect x="${m.l}" y="${y - 1}" width="${iw}" height="${barH + 2}" fill="transparent" data-tip="<strong>${esc(label)}</strong><br><i class='sw' style='background:${sr.color}'></i>${esc(sr.name)}：${opt.fmt(v)}"/>`;
      }).join("") + `<text x="${m.l - 8}" y="${y0 + barH + 4}" class="tick" text-anchor="end">${esc(label)}</text>`;
    }).join("");
    const ref = opt.refLine !== undefined
      ? `<line x1="${x(opt.refLine)}" x2="${x(opt.refLine)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>
         <text x="${x(opt.refLine) + 4}" y="${m.t + 9}" class="tick">${esc(opt.refLabel || "")}</text>` : "";
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="wl-svg" role="img" aria-label="${esc(opt.aria || "")}">
      ${opt.ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${H - m.b}" class="grid"/><text x="${x(t)}" y="${H - m.b + 16}" class="tick" text-anchor="middle">${t}</text>`).join("")}
      <line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" class="axis"/>
      ${bars}${ref}
    </svg>
    <div class="chart-legend">${series.map((sr) => `<span><i style="background:${sr.color}"></i>${esc(sr.name)}</span>`).join("")}${opt.refLine !== undefined ? `<span class="muted">虛線：${esc(opt.refLabel)}</span>` : ""}</div>`;
    bindBarTips(el);
  }

  function renderEvalChart(E) {
    const labels = PRESETS.map((p) => p.label);
    groupedBars($("#wl-eval-chart"), labels, [
      { name: "L2 正規化（cosine）", color: C_A, values: PRESETS.map((p) => E[`${p.id}|l2`].mean.ndcg10) },
      { name: "不正規化（內積）", color: C_B, values: PRESETS.map((p) => E[`${p.id}|none`].mean.ndcg10) },
    ], { max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], fmt: f3, aria: "各權重方法的 nDCG@10" });
    const bestCfg = CONFIGS.slice().sort((a, b) => E[b.key].mean.ndcg10 - E[a.key].mean.ndcg10)[0];
    $("#wl-eval-tip").textContent = `nDCG@10 最高：${bestCfg.label}（${f3(E[bestCfg.key].mean.ndcg10)}）。`;

    // 前 10 名平均文件長度
    const avg = avgDocLen();
    const lens = PRESETS.map((p) => [E[`${p.id}|l2`].mean.len10, E[`${p.id}|none`].mean.len10]);
    const mx = Math.max(avg, ...lens.flat());
    const step = mx > 200 ? 50 : 25;
    const top = Math.ceil(mx / step) * step;
    const ticks = []; for (let t = 0; t <= top; t += step) ticks.push(t);
    groupedBars($("#wl-eval-len-chart"), labels, [
      { name: "L2 正規化（cosine）", color: C_A, values: lens.map((v) => v[0]) },
      { name: "不正規化（內積）", color: C_B, values: lens.map((v) => v[1]) },
    ], { width: 720, max: top, ticks, fmt: (v) => `${v.toFixed(0)} 個索引詞`, refLine: avg, refLabel: `語料平均 ${avg.toFixed(0)}`, aria: "前 10 名平均文件長度" });
    $("#wl-eval-len-tip").textContent = `12 個查詢、每個查詢前 10 名文件的平均索引詞數（${SCOPE === "title" ? "標題＋摘要" : "摘要"}）。`;
  }

  function renderGroupTable(E) {
    groupedBars($("#wl-eval-group-chart"), PRESETS.map((p) => p.label), [
      { name: "短查詢（Q01–Q06）", color: C_A, values: PRESETS.map((p) => E[`${p.id}|l2`].mean.shortNdcg) },
      { name: "長查詢（Q07–Q12）", color: C_B, values: PRESETS.map((p) => E[`${p.id}|l2`].mean.longNdcg) },
    ], { max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], fmt: f3, aria: "短查詢與長查詢的 nDCG@10" });
    $("#wl-eval-group").innerHTML = `<div class="table-scroll"><table class="lab-table compact">
      <thead><tr><th>權重方法（L2）</th><th class="num">短查詢</th><th class="num">長查詢</th><th class="num">長 − 短</th></tr></thead>
      <tbody>${PRESETS.map((p) => {
        const m = E[`${p.id}|l2`].mean;
        return `<tr><td>${esc(p.label)}</td><td class="num">${f3(m.shortNdcg)}</td><td class="num">${f3(m.longNdcg)}</td><td class="num">${(m.longNdcg - m.shortNdcg >= 0 ? "+" : "") + f3(m.longNdcg - m.shortNdcg)}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function renderPerQuery() {
    if (!LAST_EVAL || !SET) return;
    const metric = $("#wl-pq-metric").value, norm = $("#wl-pq-norm").value;
    const E = LAST_EVAL;
    $("#wl-pq-table").innerHTML = `<div class="table-scroll"><table class="lab-table compact">
      <thead><tr><th>查詢</th><th>類型</th><th class="num">相關篇數</th>${PRESETS.map((p) => `<th class="num">${esc(p.label)}</th>`).join("")}</tr></thead>
      <tbody>${SET.queries.map((q) => {
        const vals = PRESETS.map((p) => E[`${p.id}|${norm}`].per[q.id][metric]);
        const mx = Math.max(...vals);
        return `<tr><td><button type="button" class="term-link" data-cmp="${esc(q.text)}" title="在排名比較中開啟">${esc(q.id)}</button> ${esc(q.text)}</td><td>${q.type === "short" ? "短" : "長"}</td><td class="num">${Object.keys(qrelsOf(q.id)).length}</td>
          ${vals.map((v) => `<td class="num">${Math.abs(v - mx) < 1e-9 && mx > 0 ? `<strong>${f3(v)}</strong>` : f3(v)}</td>`).join("")}</tr>`;
      }).join("")}</tbody></table></div>`;
    $("#wl-pq-table").querySelectorAll("[data-cmp]").forEach((b) => b.addEventListener("click", () => {
      $("#wl-cmp-q").value = b.dataset.cmp;
      renderCompare();
      $("#wl-compare").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function downloadCSV(name, rows) {
    const csv = "﻿" + rows.map((r) => r.map((c) => {
      const s = String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------
  // 測試查詢與相關性標註
  // ------------------------------------------------------------------
  function renderQueries() {
    if (!SET) return;
    $("#wl-judge-desc").textContent = SET.description || "";
    $("#wl-queries").innerHTML = `<div class="table-scroll"><table class="lab-table compact wl-q-table">
      <thead><tr><th>ID</th><th>查詢</th><th>類型</th><th>判斷標準</th><th class="num">已判讀</th><th class="num">相關（1／2）</th></tr></thead>
      <tbody>${SET.queries.map((q) => {
        const j = judgments(q.id);
        const v = Object.values(j);
        const mod = Object.keys(USER_QRELS[q.id] || {}).length;
        return `<tr><td>${esc(q.id)}</td><td><button type="button" class="term-link" data-cmp="${esc(q.text)}">${esc(q.text)}</button></td><td>${q.type === "short" ? "短" : "長"}</td>
          <td class="narr">${esc(q.narrative)}</td><td class="num">${v.length}${mod ? `<br><small class="muted">已修改 ${mod}</small>` : ""}</td>
          <td class="num">${v.filter((g) => g === 1).length}／${v.filter((g) => g === 2).length}</td></tr>`;
      }).join("")}</tbody></table></div>`;
    $("#wl-queries").querySelectorAll("[data-cmp]").forEach((b) => b.addEventListener("click", () => {
      $("#wl-cmp-q").value = b.dataset.cmp;
      renderCompare();
      $("#wl-compare").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function judgeCandidates(q) {
    const best = new Map(); // id -> 在 24 種設定中的最佳名次
    ["abstract", "title"].forEach((scope) => CONFIGS.forEach((cfg) => {
      rankIds(cfg, q.text, scope).slice(0, SET.pool_depth || 20).forEach((id, i) => {
        if (!best.has(id) || best.get(id) > i + 1) best.set(id, i + 1);
      });
    }));
    const j = judgments(q.id);
    Object.keys(j).forEach((id) => { if (!best.has(id)) best.set(id, Infinity); });
    return Array.from(best.entries()).filter(([id]) => IRApp.docById(id)).map(([id, r]) => ({ id, bestRank: r, g: j[id] }));
  }

  function renderJudge() {
    if (!SET) return;
    const q = SET.queries.find((x) => x.id === $("#wl-judge-q").value) || SET.queries[0];
    const filter = $("#wl-judge-filter").value;
    $("#wl-judge-narr").innerHTML = `<strong>${esc(q.id)}　${esc(q.text)}</strong><br>${esc(q.narrative)}`;
    let items = judgeCandidates(q);
    const total = items.length, unj = items.filter((x) => x.g === undefined).length;
    if (filter === "rel") items = items.filter((x) => x.g > 0);
    if (filter === "new") items = items.filter((x) => x.g === undefined);
    items.sort((a, b) => (b.g || 0) - (a.g || 0) || a.bestRank - b.bestRank);
    $("#wl-judge-count").textContent = `候選 ${total} 篇（尚未判讀 ${unj} 篇），顯示 ${items.length} 篇。`;
    const terms = Array.from(new Set(IRCore.queryTerms(q.text)));
    $("#wl-judge-list").innerHTML = items.map((x) => {
      const d = IRApp.docById(x.id);
      return `<li class="judge-item${x.g === undefined ? " unjudged" : ""}">
        <div class="judge-btns" role="group" aria-label="相關等級">${[0, 1, 2].map((g) => `<button type="button" class="judge-btn g${g}${x.g === g ? " on" : ""}" data-id="${esc(x.id)}" data-g="${g}" title="${["不相關", "部分相關", "高度相關"][g]}">${g}</button>`).join("")}</div>
        <div class="judge-main">
          <a href="#" class="cmp-title" data-open="${esc(x.id)}">${esc(d.title)}</a>
          <span class="cmp-meta">PMID ${esc(pmidOf(x.id))} · ${Number.isFinite(x.bestRank) ? `最佳名次 ${x.bestRank}` : "不在目前的前 20 名"}${x.g === undefined ? " · <strong>尚未判讀</strong>" : ""}</span>
          <details><summary>摘要</summary><p>${esc(d.abstract || "")}</p></details>
        </div></li>`;
    }).join("") || `<li class="empty-state small">沒有符合的文件。</li>`;
    $("#wl-judge-list").querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); IRApp.openDoc(el.dataset.open, terms); }));
  }

  let saveTimer = null;
  function setJudgment(qid, id, g) {
    USER_QRELS[qid] = USER_QRELS[qid] || {};
    const base = (SET.qrels[qid] || {})[id];
    const inPool = (SET.pools[qid] || []).includes(id);
    const builtIn = base !== undefined ? base : (inPool ? 0 : undefined);
    if (builtIn === g) delete USER_QRELS[qid][id]; else USER_QRELS[qid][id] = g;
    if (!Object.keys(USER_QRELS[qid]).length) delete USER_QRELS[qid];
    IRStorage.set("qrelsUser", USER_QRELS);
    renderJudge();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { renderQueries(); renderEval(); renderCompare(); }, 250);
  }

  function exportQrels() {
    const out = { exported_at: new Date().toISOString(), queries: SET.queries.map((q) => ({ id: q.id, type: q.type, text: q.text, narrative: q.narrative })), judgments: {} };
    SET.queries.forEach((q) => { out.judgments[q.id] = judgments(q.id); });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" }));
    a.download = "qrels.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importQrels(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { alert("無法解析 JSON：" + e.message); return; }
    const j = data.judgments || data.qrels || data;
    const user = {};
    let n = 0;
    SET.queries.forEach((q) => {
      if (!j[q.id]) return;
      const built = {};
      (SET.pools[q.id] || []).forEach((id) => { built[id] = 0; });
      Object.assign(built, SET.qrels[q.id] || {});
      for (const id in j[q.id]) {
        const g = Number(j[q.id][id]);
        if (![0, 1, 2].includes(g)) continue;
        if (built[id] !== g) { user[q.id] = user[q.id] || {}; user[q.id][id] = g; n++; }
      }
    });
    USER_QRELS = user;
    IRStorage.set("qrelsUser", USER_QRELS);
    refreshAll();
    alert(`已匯入，與內建標註不同的判斷共 ${n} 筆。`);
  }

  // ------------------------------------------------------------------
  // 初始化
  // ------------------------------------------------------------------
  function fillMethodSelects() {
    const opts = CONFIGS.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join("");
    $("#wl-cmp-a").innerHTML = opts;
    $("#wl-cmp-b").innerHTML = opts;
    $("#wl-cmp-a").value = "logtf|l2";
    $("#wl-cmp-b").value = "tfidf-log|l2";
    $("#wl-cmp-presets").innerHTML = CMP_PRESETS.map((p, i) => `<button type="button" class="chip-btn" data-i="${i}">${esc(p.label)}</button>`).join("");
    $("#wl-cmp-presets").querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => {
      const p = CMP_PRESETS[+b.dataset.i];
      $("#wl-cmp-a").value = p.a; $("#wl-cmp-b").value = p.b;
      renderCompare();
    }));
  }

  function refreshAll() {
    if (!READY || !IRApp.getDocs().length) return;
    renderDocVector(resolveDocInput($("#wl-doc-id").value));
    renderTfStats();
    renderIdfTable();
    renderQueryVector($("#wl-qv-q").value);
    renderCompare();
    if (SET) { renderQueries(); renderEval(); renderJudge(); }
  }

  async function init() {
    if (!$("#weight-section")) return;
    fillMethodSelects();
    try {
      const res = await fetch("data/eval-set.json");
      if (res.ok) SET = await res.json();
    } catch (e) { SET = null; }
    try { USER_QRELS = (await IRStorage.get("qrelsUser")) || {}; } catch (e) { USER_QRELS = {}; }

    if (SET) {
      $("#wl-cmp-chips").innerHTML = `<span class="example-label">測試查詢：</span>` + SET.queries.map((q) => `<button type="button" class="chip-btn" data-q="${esc(q.text)}" title="${esc(q.id)}（${q.type === "short" ? "短" : "長"}查詢）">${esc(q.id)}</button>`).join("");
      $("#wl-cmp-chips").querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => { $("#wl-cmp-q").value = b.dataset.q; renderCompare(); }));
      $("#wl-judge-q").innerHTML = SET.queries.map((q) => `<option value="${q.id}">${esc(q.id)}　${esc(q.text)}</option>`).join("");
      $("#wl-cmp-q").value = SET.queries.find((q) => q.id === "Q07") ? SET.queries.find((q) => q.id === "Q07").text : SET.queries[0].text;
      $("#wl-qv-q").value = $("#wl-cmp-q").value;
      $("#wl-qv-chips").innerHTML = `<span class="example-label">測試查詢：</span>` + SET.queries.map((q) => `<button type="button" class="chip-btn" data-q="${esc(q.text)}" title="${esc(q.text)}">${esc(q.id)}</button>`).join("");
      $("#wl-qv-chips").querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => { $("#wl-qv-q").value = b.dataset.q; renderQueryVector(b.dataset.q); }));
    } else {
      ["#wl-eval-table", "#wl-queries"].forEach((s) => { $(s).innerHTML = `<p class="empty-state small">無法載入 data/eval-set.json，評估功能無法使用。</p>`; });
    }

    $("#wl-scope").addEventListener("change", () => { SCOPE = $("#wl-scope").value; refreshAll(); });
    $("#wl-doc-apply").addEventListener("click", () => {
      const id = resolveDocInput($("#wl-doc-id").value);
      if (!id) { alert("找不到這個 PMID。"); return; }
      renderDocVector(id);
    });
    $("#wl-doc-id").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#wl-doc-apply").click(); });
    $("#wl-doc-auto").addEventListener("click", () => renderDocVector(pickHighTfDoc()));
    $("#wl-doc-sort").addEventListener("change", () => renderDocVector(resolveDocInput($("#wl-doc-id").value)));
    $("#wl-qv-apply").addEventListener("click", () => renderQueryVector($("#wl-qv-q").value));
    $("#wl-qv-q").addEventListener("keydown", (e) => { if (e.key === "Enter") renderQueryVector($("#wl-qv-q").value); });
    $("#wl-cmp-apply").addEventListener("click", renderCompare);
    $("#wl-cmp-q").addEventListener("keydown", (e) => { if (e.key === "Enter") renderCompare(); });
    $("#wl-cmp-a").addEventListener("change", renderCompare);
    $("#wl-cmp-b").addEventListener("change", renderCompare);
    $("#wl-pq-metric").addEventListener("change", renderPerQuery);
    $("#wl-pq-norm").addEventListener("change", renderPerQuery);
    $("#wl-eval-csv").addEventListener("click", () => {
      if (!LAST_EVAL) return;
      const head = ["method", "normalization"].concat(METRIC_COLS.map((c) => c.label), ["short_nDCG@10", "long_nDCG@10", "avg_len@10"]);
      downloadCSV(`weighting-eval-${SCOPE}.csv`, [head].concat(CONFIGS.map((c) => {
        const m = LAST_EVAL[c.key].mean;
        return [c.preset.label, c.norm].concat(METRIC_COLS.map((x) => m[x.k].toFixed(4)), [m.shortNdcg.toFixed(4), m.longNdcg.toFixed(4), m.len10.toFixed(1)]);
      })));
    });
    $("#wl-pq-csv").addEventListener("click", () => {
      if (!LAST_EVAL) return;
      const head = ["query_id", "type", "query", "method", "normalization"].concat(METRIC_COLS.map((c) => c.label.replace("MRR", "RR").replace("MAP", "AP")));
      const rows = [head];
      SET.queries.forEach((q) => CONFIGS.forEach((c) => {
        const m = LAST_EVAL[c.key].per[q.id];
        rows.push([q.id, q.type, q.text, c.preset.label, c.norm].concat(METRIC_COLS.map((x) => m[x.k].toFixed(4))));
      }));
      downloadCSV(`weighting-per-query-${SCOPE}.csv`, rows);
    });

    $("#wl-judge-q").addEventListener("change", renderJudge);
    $("#wl-judge-filter").addEventListener("change", renderJudge);
    $("#wl-judge-list").addEventListener("click", (e) => {
      const b = e.target.closest(".judge-btn[data-id]");
      if (b) setJudgment($("#wl-judge-q").value, b.dataset.id, +b.dataset.g);
    });
    $("#wl-judge-export").addEventListener("click", exportQrels);
    $("#wl-judge-import").addEventListener("click", () => $("#wl-judge-file").click());
    $("#wl-judge-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) file.text().then(importQrels);
      e.target.value = "";
    });
    $("#wl-judge-reset").addEventListener("click", () => {
      if (!Object.keys(USER_QRELS).length) return;
      if (!confirm("確定要捨棄這個瀏覽器中的標註修改，恢復網站內建的相關性標註嗎？")) return;
      USER_QRELS = {};
      IRStorage.set("qrelsUser", USER_QRELS);
      refreshAll();
    });

    READY = true;
    IRApp.onCorpusChange(() => refreshAll());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
