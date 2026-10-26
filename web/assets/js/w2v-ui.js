/*
 * w2v-ui.js
 * ---------
 * Word2Vec 區塊的介面：
 *   - 模型清單：同時保留多個模型（預設的 Skip-Gram、CBOW，以及自行訓練的模型），
 *     任選兩個作為「模型 A／模型 B」比較
 *   - 比較表：參數、詞彙量、訓練樣本數、訓練時間、各 epoch 的 loss
 *   - 詞彙表統計：文件數、總詞數、詞彙數、高頻詞
 *   - 近鄰詞比較：多個查詢詞 × 兩個模型的前 5 名近鄰
 *   - 詞對相似度：多組詞對 × 兩個模型的 cosine 相似度
 *   - 視覺化：PCA 與 t-SNE 降到二維的散佈圖（t-SNE 為自行實作）
 * 訓練由 word2vec.js 在 Web Worker 中執行；自行訓練的模型存在 IndexedDB。
 * 對外公開為 window.W2VUI。
 */
(function (global) {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n).toLocaleString();

  const DEFAULT_NB_WORDS = "semaglutide, tirzepatide, liraglutide, insulin, obesity, diabetes, nausea, cancer, kidney, liver, cardiovascular, pancreatitis, orforglipron, retatrutide";
  const DEFAULT_PAIRS = [
    "nausea - vomiting", "semaglutide - tirzepatide", "kidney - renal", "liver - hepatic",
    "cancer - tumor", "cancer - diagnosis", "cancer - treatment", "obesity - weight", "diabetes - insulin",
    "nausea - kidney  # 對照組", "insulin - vomiting  # 對照組",
  ].join("\n");
  const DEFAULT_VIZ_WORDS = "semaglutide, nausea, liver, kidney, cancer, insulin";
  const GROUP_COLORS = ["#2F6F73", "#B5651D", "#6B5B95", "#3E7C3A", "#A23B5B", "#2E5E9E", "#8C6D1F", "#7A4A2A"];
  const MAX_TRAINED = 6;

  let SLOTS = [];        // { id, model, source: "default" | "trained" }
  let A_ID = null, B_ID = null;
  let TRAINING = false;
  let INITIALIZED = false;
  const DEFAULT_CACHE = {};

  const slotById = (id) => SLOTS.find((s) => s.id === id);
  const modelA = () => (slotById(A_ID) || {}).model;
  const modelB = () => (slotById(B_ID) || {}).model;
  const archName = (m) => (m.params.model === "sg" ? "Skip-Gram" : "CBOW");

  // -------------------------------------------------------------------
  // CSV
  // -------------------------------------------------------------------
  function downloadCSV(filename, header, rows) {
    const cell = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = "\uFEFF" + [header].concat(rows).map((r) => r.map(cell).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // -------------------------------------------------------------------
  // 訓練參數與狀態
  // -------------------------------------------------------------------
  function readParams() {
    const model = $("input[name=w2v-model]:checked").value;
    const lrInput = parseFloat($("#w2v-lr").value);
    return {
      model,
      dim: parseInt($("#w2v-dim").value, 10),
      window: Math.max(1, Math.min(20, parseInt($("#w2v-window").value, 10) || 5)),
      negative: Math.max(1, Math.min(20, parseInt($("#w2v-neg").value, 10) || 5)),
      epochs: Math.max(1, Math.min(50, parseInt($("#w2v-epochs").value, 10) || 5)),
      lr: lrInput > 0 ? lrInput : (model === "sg" ? 0.025 : 0.05),
      sample: parseFloat($("#w2v-sample").value),
      seed: 20260927,
    };
  }

  function setStatus(msg, isError) {
    const el = $("#w2v-status");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  // 單一或多條 loss 曲線（各 epoch 的平均 loss）
  function lossSVG(series, W, H) {
    W = W || 300; H = H || 100;
    const all = series.flatMap((s) => s.values);
    if (!all.length) return "";
    const m = 10, mb = 16;
    const max = Math.max(...all), min = Math.min(...all), span = max - min || 1;
    const n = Math.max(2, ...series.map((s) => s.values.length));
    const X = (i) => m + (i / (n - 1)) * (W - 2 * m);
    const Y = (v) => m + (1 - (v - min) / span) * (H - m - mb);
    let g = "";
    series.forEach((s) => {
      g += `<polyline points="${s.values.map((v, i) => `${X(i)},${Y(v)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
      g += s.values.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="3" fill="${s.color}"><title>${esc(s.name)} epoch ${i + 1}: ${v.toFixed(4)}</title></circle>`).join("");
    });
    g += `<text x="${m}" y="${H - 3}" class="zt">epoch 1</text><text x="${W - m}" y="${H - 3}" class="zt" text-anchor="end">epoch ${n}</text>`;
    g += `<text x="${W - m}" y="${m + 2}" class="zt" text-anchor="end">loss ${max.toFixed(2)}</text><text x="${W - m}" y="${H - mb - 2}" class="zt" text-anchor="end">${min.toFixed(2)}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="loss-svg">${g}</svg>`;
  }

  // -------------------------------------------------------------------
  // 模型清單
  // -------------------------------------------------------------------
  async function persistTrained() {
    const trained = SLOTS.filter((s) => s.source === "trained").map((s) => s.model.toStorable());
    await IRStorage.set("w2vSlots", trained);
  }

  function addSlot(model, source, id) {
    model.label = model.label || model.describe();
    if (source === "trained") {
      // 相同設定的自行訓練模型只保留最新的一個
      SLOTS = SLOTS.filter((s) => !(s.source === "trained" && s.model.label === model.label));
      const trained = SLOTS.filter((s) => s.source === "trained");
      if (trained.length >= MAX_TRAINED) SLOTS = SLOTS.filter((s) => s !== trained[0]);
    }
    const slot = { id: id || `t-${Date.now()}`, model, source };
    SLOTS.push(slot);
    return slot.id;
  }

  function ensureSelection() {
    if (!slotById(A_ID)) A_ID = (SLOTS.find((s) => s.id === "default-sg") || SLOTS[0] || {}).id || null;
    if (!slotById(B_ID) || B_ID === A_ID) {
      const other = SLOTS.find((s) => s.id === "default-cbow" && s.id !== A_ID) || SLOTS.find((s) => s.id !== A_ID);
      B_ID = other ? other.id : null;
    }
    global.Word2Vec.current = modelA() || null;
  }

  function renderSlots() {
    const el = $("#w2v-slots");
    if (!SLOTS.length) { el.innerHTML = `<p class="empty-state small">目前沒有模型。</p>`; return; }
    el.innerHTML = `
      <div class="table-scroll"><table class="lab-table slot-table">
        <thead><tr><th>模型</th><th>來源</th><th class="num">詞彙量</th><th class="center">A</th><th class="center">B</th><th></th></tr></thead>
        <tbody>${SLOTS.map((s) => `<tr>
          <td>${esc(s.model.label)}</td>
          <td><span class="src-badge ${s.source === "default" ? "base" : "upload"}">${s.source === "default" ? "預設" : "自行訓練"}</span></td>
          <td class="num">${fmt(s.model.vocab.length)}</td>
          <td class="center"><input type="radio" name="w2v-slot-a" value="${s.id}" ${s.id === A_ID ? "checked" : ""} aria-label="設為模型 A"></td>
          <td class="center"><input type="radio" name="w2v-slot-b" value="${s.id}" ${s.id === B_ID ? "checked" : ""} aria-label="設為模型 B"></td>
          <td>${s.source === "trained" ? `<button class="remove-upload" data-del="${s.id}" title="刪除這個模型">×</button>` : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
    $$("input[name=w2v-slot-a]").forEach((r) => r.addEventListener("change", () => { A_ID = r.value; if (A_ID === B_ID) B_ID = null; ensureSelection(); renderAll(); }));
    $$("input[name=w2v-slot-b]").forEach((r) => r.addEventListener("change", () => { B_ID = r.value; if (A_ID === B_ID) A_ID = null; ensureSelection(); renderAll(); }));
    $$("#w2v-slots [data-del]").forEach((b) => b.addEventListener("click", async () => {
      SLOTS = SLOTS.filter((s) => s.id !== b.dataset.del);
      await persistTrained();
      ensureSelection();
      renderAll();
    }));
  }

  // -------------------------------------------------------------------
  // 比較表
  // -------------------------------------------------------------------
  function compareRows() {
    const per = (m) => (m.examples ? Math.round(m.examples / m.params.epochs) : NaN);
    return [
      ["架構", (m) => archName(m)],
      ["預測方式", (m) => (m.params.model === "sg" ? "中心詞 → 上下文詞" : "上下文詞 → 中心詞")],
      ["向量維度", (m) => m.params.dim],
      ["視窗大小", (m) => m.params.window],
      ["負樣本數", (m) => m.params.negative],
      ["Epochs", (m) => m.params.epochs],
      ["最小詞頻", (m) => m.options.minCount],
      ["次抽樣門檻", (m) => (m.params.sample ? m.params.sample : "不使用")],
      ["初始學習率", (m) => m.params.lr],
      ["前處理", (m) => `${m.options.removeStopwords ? "移除停用詞" : "保留停用詞"}${m.options.useStem ? "、Porter" : ""}`],
      ["詞彙量", (m) => fmt(m.vocab.length)],
      ["訓練詞元", (m) => fmt(m.stats.trainTokens)],
      ["每個 epoch 的訓練樣本數", (m) => (Number.isFinite(per(m)) ? fmt(per(m)) : "—")],
      ["訓練時間（秒）", (m) => (m.elapsed / 1000).toFixed(1)],
      ["各 epoch 平均 loss", (m) => m.lossHistory.map((v) => v.toFixed(3)).join(" → ")],
      ["最終 loss", (m) => (m.lossHistory.length ? m.lossHistory[m.lossHistory.length - 1].toFixed(4) : "—")],
    ];
  }

  function renderCompare() {
    const a = modelA(), b = modelB();
    const el = $("#w2v-compare");
    if (!a) { el.innerHTML = ""; $("#w2v-loss-compare").innerHTML = ""; return; }
    const cols = [["A", a], ["B", b]].filter(([, m]) => m);
    el.innerHTML = `
      <div class="table-scroll"><table class="lab-table metrics-table compare-table">
        <colgroup><col class="col-metric">${cols.map(() => `<col class="col-cond">`).join("")}</colgroup>
        <thead><tr><th>項目</th>${cols.map(([k, m]) => `<th>模型 ${k}<br><small class="muted">${esc(m.label)}</small></th>`).join("")}</tr></thead>
        <tbody>${compareRows().map(([name, f]) => `<tr><td>${name}</td>${cols.map(([, m]) => `<td>${esc(f(m))}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <p class="lab-footnote">訓練樣本數：Skip-Gram 每個（中心詞, 上下文詞）配對算一個樣本，CBOW 每個被預測的中心詞算一個樣本。兩種架構預測的目標不同，loss 數值不宜直接比較高低，應觀察各自是否隨 epoch 下降並趨於平穩。</p>`;
    $("#w2v-loss-compare").innerHTML = `<h4 class="lab-h4">訓練 loss</h4>` + lossSVG(cols.map(([k, m]) => ({ name: `模型 ${k}`, values: m.lossHistory, color: k === "A" ? "#2F6F73" : "#B5651D" })), 520, 140) +
      `<p class="viz-legend-inline"><span style="color:#2F6F73">● 模型 A</span>　<span style="color:#B5651D">● 模型 B</span></p>`;
  }

  // -------------------------------------------------------------------
  // 詞彙表統計
  // -------------------------------------------------------------------
  function renderVocab() {
    const a = modelA(), b = modelB();
    const el = $("#w2v-vocab");
    if (!a) { el.innerHTML = ""; return; }
    const sameCorpus = b && JSON.stringify(a.options) === JSON.stringify(b.options) && a.stats.trainTokens === b.stats.trainTokens;
    const cols = sameCorpus || !b ? [["模型 A、B（相同前處理）", a]] : [["模型 A", a], ["模型 B", b]];
    const top = (m) => m.vocab.slice(0, 20).map((w, i) => `${esc(w)} <small class="muted">${fmt(m.freq[i])}</small>`).join("、");
    const rows = [
      ["文件數", (m) => fmt(m.stats.numDocs)],
      ["總詞數（前處理後）", (m) => fmt(m.stats.rawTokens)],
      ["詞彙數（未過濾）", (m) => fmt(m.stats.rawVocab)],
      ["詞彙數（最小詞頻過濾後）", (m) => `${fmt(m.vocab.length)}（最小詞頻 ${m.options.minCount}）`],
      ["訓練詞元", (m) => fmt(m.stats.trainTokens)],
      ["句數", (m) => fmt(m.stats.numSentences)],
    ];
    el.innerHTML = `
      <div class="table-scroll"><table class="lab-table metrics-table">
        <colgroup><col class="col-metric">${cols.map(() => `<col class="col-cond">`).join("")}</colgroup>
        <thead><tr><th>項目</th>${cols.map(([n]) => `<th class="num">${n}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(([name, f]) => `<tr><td>${name}</td>${cols.map(([, m]) => `<td class="num">${f(m)}</td>`).join("")}</tr>`).join("")}
          <tr><td>高頻詞前 20 名</td>${cols.map(([, m]) => `<td class="terms-cell-wide">${top(m)}</td>`).join("")}</tr></tbody>
      </table></div>
      <p class="lab-footnote">詞彙表的前處理：斷詞、轉小寫、去除標點${a.options.removeStopwords ? "、移除停用詞" : ""}，並移除出現次數低於最小詞頻的詞。</p>`;
  }

  // -------------------------------------------------------------------
  // 近鄰詞比較
  // -------------------------------------------------------------------
  const splitWords = (text) => {
    const seen = new Set();
    return text.split(/[,，\n]+/).map((w) => w.trim()).filter(Boolean).filter((w) => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  function nbData() {
    const a = modelA(), b = modelB();
    return splitWords($("#w2v-nb-input").value).map((w) => {
      const idA = a ? a.lookup(w) : undefined;
      return {
        word: w,
        freq: idA !== undefined ? a.freq[idA] : (b && b.lookup(w) !== undefined ? b.freq[b.lookup(w)] : null),
        A: a ? a.mostSimilar(w, 5) : null,
        B: b ? b.mostSimilar(w, 5) : null,
      };
    });
  }

  function nbCell(list) {
    if (!list) return `<span class="muted">不在詞彙中</span>`;
    return `<ol class="nb-inline">${list.map((r) => `<li><button class="term-link" data-q="${esc(r.word)}">${esc(r.word)}</button> <small class="muted">${r.score.toFixed(2)}</small></li>`).join("")}</ol>`;
  }

  function renderNeighbors() {
    const el = $("#w2v-nb-table");
    const a = modelA(), b = modelB();
    if (!a) { el.innerHTML = ""; return; }
    const rows = nbData();
    el.innerHTML = rows.length ? `
      <div class="table-scroll"><table class="lab-table nb-table">
        <colgroup><col class="col-word"><col class="col-n"><col class="col-nb">${b ? `<col class="col-nb">` : ""}</colgroup>
        <thead><tr><th>查詢詞</th><th class="num">詞頻</th><th>模型 A：${esc(a.label)}</th>${b ? `<th>模型 B：${esc(b.label)}</th>` : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td><strong>${esc(r.word)}</strong></td><td class="num">${r.freq === null ? "—" : fmt(r.freq)}</td><td>${nbCell(r.A)}</td>${b ? `<td>${nbCell(r.B)}</td>` : ""}</tr>`).join("")}</tbody>
      </table></div>
      <p class="lab-footnote">數字為 cosine 相似度。詞頻較低的詞（例如出現少於 50 次），近鄰通常較不穩定，相似度數值也容易偏高。</p>`
      : `<p class="empty-state small">請輸入要查詢的詞。</p>`;
    $$("#w2v-nb-table .term-link[data-q]").forEach((x) => x.addEventListener("click", () => IRApp.search(x.dataset.q)));
  }

  // -------------------------------------------------------------------
  // 詞對相似度
  // -------------------------------------------------------------------
  function pairData() {
    const a = modelA(), b = modelB();
    return $("#w2v-pair-input").value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [main, note] = line.split("#");
      // 以「前後有空白的 -」或逗號分隔，避免拆開 glp-1 這類本身帶連字號的詞
      const parts = main.split(/\s+[-–]\s+|\s*[,，]\s*/).map((x) => x.trim()).filter(Boolean);
      if (parts.length < 2) return null;
      const [x, y] = parts;
      return { x, y, note: (note || "").trim(), A: a ? a.similarity(x, y) : null, B: b ? b.similarity(x, y) : null };
    }).filter(Boolean);
  }

  function renderPairs() {
    const el = $("#w2v-pair-table");
    const a = modelA(), b = modelB();
    if (!a) { el.innerHTML = ""; return; }
    const rows = pairData();
    const cell = (v) => (v === null ? `<span class="muted">不在詞彙中</span>` : `<span class="sim-bar"><span style="width:${Math.max(0, v) * 100}%"></span></span><span class="sim-val">${v.toFixed(3)}</span>`);
    el.innerHTML = rows.length ? `
      <div class="table-scroll"><table class="lab-table pair-table">
        <colgroup><col class="col-pair"><col class="col-sim">${b ? `<col class="col-sim">` : ""}<col class="col-note"></colgroup>
        <thead><tr><th>詞對</th><th>模型 A：${esc(a.label)}</th>${b ? `<th>模型 B：${esc(b.label)}</th>` : ""}<th>備註</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.note ? "control-row" : ""}"><td><strong>${esc(r.x)}</strong> – <strong>${esc(r.y)}</strong></td><td>${cell(r.A)}</td>${b ? `<td>${cell(r.B)}</td>` : ""}<td class="muted">${esc(r.note)}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="lab-footnote">cosine 相似度介於 −1 與 1，越接近 1 代表兩個詞的向量方向越一致。在小型語料中，不相關的詞也可能有不低的相似度，因此應與對照組比較，而不是只看絕對數值。</p>`
      : `<p class="empty-state small">請輸入詞對，例如 nausea - vomiting。</p>`;
  }

  // -------------------------------------------------------------------
  // 視覺化：PCA 與 t-SNE
  // -------------------------------------------------------------------
  function seededRandom(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // 以 power iteration 求前兩個主成分
  function pca2D(X) {
    const n = X.length, D = X[0].length;
    const mean = new Float64Array(D);
    X.forEach((r) => { for (let d = 0; d < D; d++) mean[d] += r[d] / n; });
    const C = X.map((r) => { const c = new Float64Array(D); for (let d = 0; d < D; d++) c[d] = r[d] - mean[d]; return c; });
    let total = 0;
    C.forEach((r) => { for (let d = 0; d < D; d++) total += r[d] * r[d]; });
    function component(orth) {
      let v = new Float64Array(D);
      for (let d = 0; d < D; d++) v[d] = Math.sin(d * 12.9898 + 1);
      let lambda = 0;
      for (let it = 0; it < 200; it++) {
        const proj = C.map((r) => { let s = 0; for (let d = 0; d < D; d++) s += r[d] * v[d]; return s; });
        const nv = new Float64Array(D);
        C.forEach((r, i) => { for (let d = 0; d < D; d++) nv[d] += r[d] * proj[i]; });
        if (orth) { let p = 0; for (let d = 0; d < D; d++) p += nv[d] * orth[d]; for (let d = 0; d < D; d++) nv[d] -= p * orth[d]; }
        let norm = 0; for (let d = 0; d < D; d++) norm += nv[d] * nv[d];
        norm = Math.sqrt(norm) || 1;
        lambda = norm;
        for (let d = 0; d < D; d++) nv[d] /= norm;
        v = nv;
      }
      return { v, lambda };
    }
    const c1 = component(null), c2 = component(c1.v);
    const pts = C.map((r) => {
      let x = 0, y = 0;
      for (let d = 0; d < D; d++) { x += r[d] * c1.v[d]; y += r[d] * c2.v[d]; }
      return [x, y];
    });
    return { pts, explained: total ? [c1.lambda / total, c2.lambda / total] : [0, 0] };
  }

  // 精確版 t-SNE（點數少，O(n²) 即可）：高斯核依 perplexity 二分搜尋 σ，低維用 Student-t 分佈
  function tsne2D(X, perplexity, seed) {
    const n = X.length;
    const perp = Math.max(2, Math.min(perplexity, (n - 1) / 3));
    const D2 = [];
    for (let i = 0; i < n; i++) {
      D2.push(new Float64Array(n));
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        let s = 0;
        for (let d = 0; d < X[i].length; d++) { const t = X[i][d] - X[j][d]; s += t * t; }
        D2[i][j] = s;
      }
    }
    const P = [];
    const logU = Math.log(perp);
    for (let i = 0; i < n; i++) {
      let beta = 1, lo = -Infinity, hi = Infinity;
      const row = new Float64Array(n);
      for (let it = 0; it < 60; it++) {
        let sum = 0;
        for (let j = 0; j < n; j++) { row[j] = i === j ? 0 : Math.exp(-D2[i][j] * beta); sum += row[j]; }
        sum = sum || 1e-12;
        let H = 0;
        for (let j = 0; j < n; j++) { row[j] /= sum; if (row[j] > 1e-12) H -= row[j] * Math.log(row[j]); }
        if (Math.abs(H - logU) < 1e-5) break;
        if (H > logU) { lo = beta; beta = hi === Infinity ? beta * 2 : (beta + hi) / 2; }
        else { hi = beta; beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2; }
      }
      P.push(row);
    }
    const Ps = [];
    for (let i = 0; i < n; i++) {
      Ps.push(new Float64Array(n));
      for (let j = 0; j < n; j++) Ps[i][j] = Math.max((P[i][j] + P[j][i]) / (2 * n), 1e-12);
    }
    const rnd = seededRandom(seed || 20261006);
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const Y = [], gains = [], upd = [];
    for (let i = 0; i < n; i++) { Y.push([gauss() * 1e-4, gauss() * 1e-4]); gains.push([1, 1]); upd.push([0, 0]); }
    const ITERS = 1000, lr = Math.max(n / 12, 50);
    const num = [];
    for (let i = 0; i < n; i++) num.push(new Float64Array(n));
    for (let it = 0; it < ITERS; it++) {
      const exag = it < 250 ? 12 : 1;
      const mom = it < 250 ? 0.5 : 0.8;
      let Z = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i === j) { num[i][j] = 0; continue; }
        const dx = Y[i][0] - Y[j][0], dy = Y[i][1] - Y[j][1];
        num[i][j] = 1 / (1 + dx * dx + dy * dy);
        Z += num[i][j];
      }
      // 先用同一組位置算完所有點的梯度，再一起更新（若邊算邊更新，誤差會一路放大而發散）
      const grad = [];
      for (let i = 0; i < n; i++) {
        let gx = 0, gy = 0;
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const q = Math.max(num[i][j] / Z, 1e-12);
          const m = (exag * Ps[i][j] - q) * num[i][j];
          gx += 4 * m * (Y[i][0] - Y[j][0]);
          gy += 4 * m * (Y[i][1] - Y[j][1]);
        }
        grad.push([gx, gy]);
      }
      for (let i = 0; i < n; i++) {
        for (let d = 0; d < 2; d++) {
          const g = grad[i][d];
          gains[i][d] = Math.sign(g) !== Math.sign(upd[i][d]) ? gains[i][d] + 0.2 : Math.max(gains[i][d] * 0.8, 0.01);
          upd[i][d] = mom * upd[i][d] - lr * gains[i][d] * g;
          Y[i][d] += upd[i][d];
        }
      }
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) { mx += Y[i][0] / n; my += Y[i][1] / n; }
      for (let i = 0; i < n; i++) { Y[i][0] -= mx; Y[i][1] -= my; }
    }
    return Y;
  }

  // 散佈圖：點依群組著色，所有點都標示詞名（盡量避開重疊）
  function scatterSVG(points, items) {
    const W = 560, H = 440, ml = 20, mr = 100, mt = 20, mb = 20;
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const X = (x) => ml + ((x - x0) / (x1 - x0 || 1)) * (W - ml - mr);
    const Y = (y) => H - mb - ((y - y0) / (y1 - y0 || 1)) * (H - mt - mb);
    const placed = [];
    const overlaps = (b) => placed.some((q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y);
    const OFFSETS = [0];
    for (let o = 12; o <= 72; o += 12) OFFSETS.push(o, -o);
    const order = items.map((it, i) => i).sort((a, b) => (items[b].isQuery ? 1 : 0) - (items[a].isQuery ? 1 : 0));
    const labelDy = new Array(items.length).fill(0);
    order.forEach((i) => {
      const it = items[i], fs = it.isQuery ? 12 : 10;
      const w = it.word.length * fs * 0.62 + 2;
      const box = (dy) => ({ x: X(points[i][0]) + 5, y: Y(points[i][1]) + dy - fs * 0.85, w, h: fs + 2 });
      const dy = OFFSETS.find((o) => { const b = box(o); return b.y > 2 && b.y + b.h < H - 2 && !overlaps(b); });
      labelDy[i] = dy === undefined ? 0 : dy;
      placed.push(box(labelDy[i]));
    });
    let g = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" class="zframe"/>`;
    items.forEach((it, i) => {
      const cx = X(points[i][0]), cy = Y(points[i][1]), col = GROUP_COLORS[it.group % GROUP_COLORS.length];
      if (labelDy[i]) g += `<line x1="${cx}" y1="${cy}" x2="${cx + 5}" y2="${cy + labelDy[i]}" class="pca-leader"/>`;
      g += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${it.isQuery ? 5 : 3.2}" fill="${col}"><title>${esc(it.word)}</title></circle>`;
      g += `<text x="${(cx + 6).toFixed(1)}" y="${(cy + labelDy[i] + 3).toFixed(1)}" fill="${col}" class="viz-label${it.isQuery ? " query" : ""}">${esc(it.word)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="zipf-svg viz-svg" role="img">${g}</svg>`;
  }

  function vizItems(model) {
    const k = parseInt($("#w2v-viz-k").value, 10) || 5;
    const items = [], seen = new Map(), missing = [];
    splitWords($("#w2v-viz-input").value).forEach((w, gi) => {
      const id = model.lookup(w);
      if (id === undefined) { missing.push(w); return; }
      const group = items.filter((x) => x.isQuery).length;
      if (!seen.has(id)) { seen.set(id, true); items.push({ id, word: model.vocab[id], group, isQuery: true }); }
      (model.mostSimilar(w, k) || []).forEach((r) => {
        if (seen.has(r.id)) return;
        seen.set(r.id, true);
        items.push({ id: r.id, word: r.word, group, isQuery: false });
      });
    });
    return { items, missing };
  }

  function renderViz() {
    const which = $("#w2v-viz-model").value;
    const model = which === "B" ? modelB() : modelA();
    const pcaEl = $("#w2v-pca"), tsneEl = $("#w2v-tsne");
    if (!model) { pcaEl.innerHTML = tsneEl.innerHTML = ""; $("#w2v-viz-legend").innerHTML = ""; return; }
    const { items, missing } = vizItems(model);
    if (items.length < 4) {
      pcaEl.innerHTML = tsneEl.innerHTML = `<p class="empty-state small">至少需要 4 個詞才能繪圖。</p>`;
      $("#w2v-viz-legend").innerHTML = missing.length ? `<span class="muted">不在詞彙中：${missing.map(esc).join("、")}</span>` : "";
      return;
    }
    const X = items.map((it) => Array.from(model.vectorOf(it.id)));
    const pca = pca2D(X);
    pcaEl.innerHTML = scatterSVG(pca.pts, items);
    $("#w2v-pca-meta").textContent = `前兩個主成分解釋 ${((pca.explained[0] + pca.explained[1]) * 100).toFixed(1)}% 的變異`;
    const perp = parseInt($("#w2v-viz-perp").value, 10) || 10;
    const ts = tsne2D(X, perp, 20261006);
    tsneEl.innerHTML = scatterSVG(ts, items);
    $("#w2v-tsne-meta").textContent = `perplexity ${Math.max(2, Math.min(perp, (items.length - 1) / 3)).toFixed(0)}、${items.length} 個詞、固定隨機種子`;
    const groups = items.filter((x) => x.isQuery);
    $("#w2v-viz-legend").innerHTML = `<span class="muted">${esc(model.label)}｜</span>` +
      groups.map((g) => `<span style="color:${GROUP_COLORS[g.group % GROUP_COLORS.length]}">● ${esc(g.word)} 與其近鄰</span>`).join("　") +
      (missing.length ? `　<span class="muted">不在詞彙中：${missing.map(esc).join("、")}</span>` : "");
  }

  // -------------------------------------------------------------------
  function renderAll() {
    ensureSelection();
    $("#w2v-explore").classList.toggle("disabled", !modelA());
    renderSlots();
    renderCompare();
    renderVocab();
    renderNeighbors();
    renderPairs();
    renderViz();
  }

  // -------------------------------------------------------------------
  // 載入預設模型與保存的模型
  // -------------------------------------------------------------------
  async function fetchDefault(kind) {
    if (DEFAULT_CACHE[kind]) return DEFAULT_CACHE[kind];
    const [metaRes, binRes] = await Promise.all([fetch(`data/w2v-default-${kind}.json`), fetch(`data/w2v-default-${kind}.bin`)]);
    if (!metaRes.ok || !binRes.ok) throw new Error("找不到預設模型檔案");
    DEFAULT_CACHE[kind] = { meta: await metaRes.json(), vectors: new Float32Array(await binRes.arrayBuffer()) };
    return DEFAULT_CACHE[kind];
  }

  // 預設模型只在「預設語料完整存在、且模型是用這份語料訓練的」時候使用
  async function loadDefaults() {
    SLOTS = SLOTS.filter((s) => s.source !== "default");
    if (!IRApp.isBaseIntact()) return false;
    const defaults = [];
    for (const kind of ["sg", "cbow"]) {
      try {
        const d = await fetchDefault(kind);
        if (d.meta.signature && d.meta.signature !== IRApp.baseSignature()) continue;
        defaults.push({ id: `default-${kind}`, model: Word2Vec.fromStored(d.meta, d.vectors), source: "default" });
      } catch (e) { console.warn(e); }
    }
    SLOTS = defaults.concat(SLOTS);   // 預設模型（Skip-Gram、CBOW）排在最前面
    return defaults.length > 0;
  }

  async function loadStored() {
    let stored = [];
    try { stored = (await IRStorage.get("w2vSlots")) || []; } catch (e) { stored = []; }
    // 舊版只保存一個模型（w2vModel），搬移到新的清單
    try {
      const legacy = await IRStorage.get("w2vModel");
      if (legacy && legacy.meta && legacy.vectors) { stored.push(legacy); await IRStorage.del("w2vModel"); }
    } catch (e) { /* 略過 */ }
    stored.forEach((s, i) => {
      try {
        const m = Word2Vec.fromStored(s.meta, s.vectors);
        SLOTS.push({ id: `t-${i}-${Date.parse(m.trainedAt || "") || i}`, model: m, source: "trained" });
      } catch (e) { console.warn("保存的模型無法載入：", e); }
    });
    if (stored.length) await persistTrained();
  }

  async function initModels() {
    await loadStored();
    const hasDefault = await loadDefaults();
    ensureSelection();
    if (!SLOTS.length) {
      setStatus(IRApp.getDocs().length ? "預設語料已有文獻被刪除，預設模型不適用。請按「開始訓練」，以目前的文獻訓練模型。" : "語料庫是空的，請先加入文獻再訓練。");
    } else {
      setStatus(hasDefault ? "已載入預設的 Skip-Gram 與 CBOW 模型，可直接分析；也可以調整參數後按「開始訓練」加入新的模型。" : "已載入先前訓練並保存的模型。");
    }
    renderAll();
  }

  async function onCorpusChange(docs) {
    if (!INITIALIZED) { INITIALIZED = true; await initModels(); return; }
    const hadDefault = SLOTS.some((s) => s.source === "default");
    if (hadDefault && !IRApp.isBaseIntact()) {
      SLOTS = SLOTS.filter((s) => s.source !== "default");
      setStatus("預設語料已有文獻被刪除，預設模型不再適用。請按「開始訓練」，以目前的文獻訓練新模型。");
    } else if (SLOTS.some((s) => s.source === "trained")) {
      setStatus(`語料庫已變動（目前 ${fmt(docs.length)} 篇）；自行訓練的模型是以先前的語料訓練的，可以重新訓練。`);
    }
    renderAll();
  }

  async function onRestoreDefaults() {
    if (TRAINING) Word2Vec.cancel();
    SLOTS = [];
    await IRStorage.del("w2vSlots");
    await loadDefaults();
    A_ID = B_ID = null;
    ensureSelection();
    setStatus(SLOTS.length ? "已換回預設的 Skip-Gram 與 CBOW 模型。" : "找不到預設模型，請按「開始訓練」。");
    renderAll();
  }

  // -------------------------------------------------------------------
  // 訓練
  // -------------------------------------------------------------------
  async function train() {
    if (TRAINING) return;
    const texts = IRApp.getDocs().map(IRApp.analysisText);
    if (!texts.length) { setStatus("語料庫是空的，請先加入文獻。", true); return; }
    const corpus = Word2Vec.buildCorpus(texts, {
      removeStopwords: $("#w2v-stop").checked,
      useStem: $("#w2v-stem").checked,
      minCount: Math.max(1, parseInt($("#w2v-mincount").value, 10) || 5),
    });
    if (corpus.vocab.length < 10 || corpus.ids.length < 50) {
      setStatus(`語料太小（詞彙 ${corpus.vocab.length}、訓練詞元 ${corpus.ids.length}），請加入更多文獻或調低最小詞頻。`, true);
      return;
    }
    const params = readParams();
    TRAINING = true;
    $("#w2v-train").disabled = true;
    $("#w2v-cancel").hidden = false;
    $("#w2v-progress").hidden = false;
    $("#w2v-progress-bar").style.width = "0%";
    const losses = [];
    $("#w2v-loss").innerHTML = "";
    setStatus(`前處理完成：${fmt(corpus.stats.numSentences)} 句、${fmt(corpus.ids.length)} 個訓練詞元、詞彙 ${fmt(corpus.vocab.length)}。開始訓練 ${params.model === "sg" ? "Skip-Gram" : "CBOW"}…`);
    try {
      const model = await Word2Vec.train(corpus, params, (msg) => {
        if (msg.type === "progress") {
          $("#w2v-progress-bar").style.width = (msg.progress * 100).toFixed(1) + "%";
          setStatus(`訓練中：epoch ${msg.epoch}/${msg.epochs} · ${(msg.progress * 100).toFixed(1)}% · loss ${msg.loss.toFixed(4)} · ${(msg.elapsed / 1000).toFixed(1)} s`);
        } else if (msg.type === "epoch") {
          losses.push(msg.loss);
          $("#w2v-loss").innerHTML = lossSVG([{ name: "loss", values: losses, color: "var(--rust)" }]);
        }
      });
      model.source = "trained";
      model.trainedAt = new Date().toISOString();
      model.label = model.describe();
      const id = addSlot(model, "trained");
      B_ID = id;
      if (A_ID === B_ID) A_ID = null;
      ensureSelection();
      await persistTrained();
      $("#w2v-progress-bar").style.width = "100%";
      setStatus(`訓練完成（${(model.elapsed / 1000).toFixed(1)} 秒）：「${model.label}」已加入模型清單並設為模型 B，已保存在此瀏覽器。`);
      renderAll();
    } catch (e) {
      if (!String(e.message).includes("cancel")) setStatus("訓練失敗：" + e.message, true);
    } finally {
      TRAINING = false;
      $("#w2v-train").disabled = false;
      $("#w2v-cancel").hidden = true;
    }
  }

  // -------------------------------------------------------------------
  function init() {
    $("#w2v-nb-input").value = DEFAULT_NB_WORDS;
    $("#w2v-pair-input").value = DEFAULT_PAIRS;
    $("#w2v-viz-input").value = DEFAULT_VIZ_WORDS;

    $("#w2v-train").addEventListener("click", train);
    $("#w2v-cancel").addEventListener("click", () => {
      if (Word2Vec.cancel()) {
        TRAINING = false;
        $("#w2v-train").disabled = false;
        $("#w2v-cancel").hidden = true;
        $("#w2v-progress").hidden = true;
        setStatus("已取消訓練。", true);
      }
    });
    $$("input[name=w2v-model]").forEach((r) => r.addEventListener("change", () => {
      $("#w2v-lr").placeholder = r.value === "sg" ? "預設 0.025" : "預設 0.05";
    }));

    $("#w2v-nb-apply").addEventListener("click", renderNeighbors);
    $("#w2v-nb-reset").addEventListener("click", () => { $("#w2v-nb-input").value = DEFAULT_NB_WORDS; renderNeighbors(); });
    $("#w2v-pair-apply").addEventListener("click", renderPairs);
    $("#w2v-pair-reset").addEventListener("click", () => { $("#w2v-pair-input").value = DEFAULT_PAIRS; renderPairs(); });
    $("#w2v-viz-apply").addEventListener("click", renderViz);
    $("#w2v-viz-reset").addEventListener("click", () => { $("#w2v-viz-input").value = DEFAULT_VIZ_WORDS; renderViz(); });
    ["#w2v-viz-model", "#w2v-viz-k", "#w2v-viz-perp"].forEach((s) => $(s).addEventListener("change", renderViz));

    $("#w2v-csv-compare").addEventListener("click", () => {
      const a = modelA(), b = modelB();
      if (!a) return;
      const cols = [a, b].filter(Boolean);
      downloadCSV("w2v_model_comparison.csv", ["項目"].concat(cols.map((m, i) => `模型 ${i ? "B" : "A"}（${m.label}）`)),
        compareRows().map(([name, f]) => [name].concat(cols.map((m) => f(m)))));
    });
    $("#w2v-csv-nb").addEventListener("click", () => {
      const a = modelA(), b = modelB();
      if (!a) return;
      const rows = [];
      nbData().forEach((r) => {
        for (let i = 0; i < 5; i++) {
          rows.push([r.word, r.freq === null ? "" : r.freq, i + 1,
            r.A && r.A[i] ? r.A[i].word : "", r.A && r.A[i] ? r.A[i].score.toFixed(4) : "",
            b && r.B && r.B[i] ? r.B[i].word : "", b && r.B && r.B[i] ? r.B[i].score.toFixed(4) : ""]);
        }
      });
      downloadCSV("w2v_neighbors.csv", ["查詢詞", "詞頻", "名次", `模型 A 近鄰（${a.label}）`, "A 相似度", b ? `模型 B 近鄰（${b.label}）` : "模型 B 近鄰", "B 相似度"], rows);
    });
    $("#w2v-csv-pair").addEventListener("click", () => {
      const a = modelA(), b = modelB();
      if (!a) return;
      downloadCSV("w2v_pair_similarity.csv", ["詞 1", "詞 2", `模型 A（${a.label}）`, b ? `模型 B（${b.label}）` : "模型 B", "備註"],
        pairData().map((r) => [r.x, r.y, r.A === null ? "" : r.A.toFixed(4), r.B === null ? "" : r.B.toFixed(4), r.note]));
    });
    window.addEventListener("ir:restore-defaults", onRestoreDefaults);
  }

  document.addEventListener("DOMContentLoaded", init);
  global.W2VUI = { onCorpusChange };
})(window);
