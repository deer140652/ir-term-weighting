/*
 * lab-ui.js
 * ---------
 * 頁面下方三個分析區塊的介面控制：
 *   詞頻分析   觸發計算（zipf.js），呈現交給 zipf-report.js
 *   詞嵌入     由 w2v-ui.js 負責（模型清單、比較、近鄰、相似度、PCA／t-SNE）
 *   字串比對   編輯距離 DP 表格與拼字校正示範（edit-distance.js）
 * 語料來源一律透過 app.js 公開的 window.IRApp 取得，與檢索系統使用同一批文獻。
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n).toLocaleString();
  const pct = (x, d) => (x * 100).toFixed(d === undefined ? 1 : d) + "%";

  function docsTexts() {
    return IRApp.getDocs().map(IRApp.analysisText);
  }

  // =================================================================
  // 詞頻分析（呈現由 zipf-report.js 負責）
  // =================================================================
  let ZIPF_RESULT = null;

  function runZipf() {
    const texts = docsTexts();
    if (!texts.length) {
      $("#zipf-status").textContent = "語料庫是空的，請先加入文獻。";
      $("#zipf-output").hidden = true;
      return;
    }
    const t0 = performance.now();
    ZIPF_RESULT = Zipf.analyze(texts);
    $("#zipf-status").textContent = `已分析 ${fmt(texts.length)} 篇文獻（標題＋摘要）、4 種前處理條件，耗時 ${Math.round(performance.now() - t0)} ms`;
    $("#zipf-output").hidden = false;
    ZipfReport.render(ZIPF_RESULT);
  }

  function initZipf() {
    $("#zipf-run").addEventListener("click", runZipf);
  }

  // =================================================================
  // 字串比對：編輯距離與拼字校正
  // =================================================================
  function renderEditDistance() {
    const a = $("#ed-a").value.trim().toLowerCase().slice(0, 24);
    const b = $("#ed-b").value.trim().toLowerCase().slice(0, 24);
    const res = EditDistance.matrix(a, b, $("#ed-transpose").checked);
    const onPath = new Set(res.path.map(([i, j]) => i + "," + j));

    let html = `<table class="dp-table"><thead><tr><th></th><th>ε</th>${Array.from(b).map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>`;
    for (let i = 0; i <= a.length; i++) {
      html += `<tr><th>${i === 0 ? "ε" : esc(a[i - 1])}</th>`;
      for (let j = 0; j <= b.length; j++) {
        const cls = onPath.has(i + "," + j) ? "on-path" : "";
        const last = i === a.length && j === b.length ? " final" : "";
        html += `<td class="${cls}${last}">${res.table[i][j]}</td>`;
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    $("#ed-table").innerHTML = html;

    const labels = { match: "相同", sub: "替換", ins: "插入", del: "刪除", swap: "交換" };
    $("#ed-ops").innerHTML = `
      <div class="align-row">${res.ops.map((o) => `<span class="al ${o.op}">${esc(o.from || "–")}</span>`).join("")}</div>
      <div class="align-row">${res.ops.map((o) => `<span class="al ${o.op}">${esc(o.to || "–")}</span>`).join("")}</div>
      <div class="align-row small">${res.ops.map((o) => `<span class="al-label ${o.op}">${labels[o.op]}</span>`).join("")}</div>`;
    $("#ed-result").innerHTML = `編輯距離 = <strong>${res.distance}</strong>
      （${["sub", "ins", "del", "swap"].map((k) => `${labels[k]} ${res.ops.filter((o) => o.op === k).length}`).join("、")}）`;
  }

  function renderSpellDemo() {
    const w = $("#spell-input").value.trim().toLowerCase();
    const out = $("#spell-out");
    const speller = IRApp.getSpeller();
    if (!w) { out.innerHTML = ""; return; }
    if (!IRApp.getDocs().length) { out.innerHTML = `<p class="empty-state small">語料庫是空的，請先加入文獻。</p>`; return; }
    const t0 = performance.now();
    const known = speller.has(w);
    const cands = speller.candidates(w, 2, 10);
    const ms = (performance.now() - t0).toFixed(1);
    out.innerHTML = `
      <p class="lab-footnote">${known ? `「${esc(w)}」出現在語料中（${fmt(speller.freq.get(w))} 次），不需校正。以下為相近字：` : `「${esc(w)}」不在語料詞彙中。`}
        字典大小 ${fmt(speller.freq.size)} 個字，比對耗時 ${ms} ms。</p>
      ${cands.length ? `<table class="lab-table compact"><thead><tr><th>候選字</th><th class="num">編輯距離</th><th class="num">詞頻</th><th></th></tr></thead><tbody>
        ${cands.map((c, i) => `<tr class="${i === 0 && !known ? "best" : ""}"><td class="mono">${esc(c.word)}</td><td class="num">${c.distance}</td><td class="num">${fmt(c.freq)}</td>
          <td><button class="term-link" data-q="${esc(c.word)}">用這個字搜尋 →</button></td></tr>`).join("")}</tbody></table>`
      : `<p class="empty-state small">編輯距離 ≤ 2 內沒有候選字。</p>`}`;
    $$("#spell-out .term-link").forEach((b) => b.addEventListener("click", () => IRApp.search(b.dataset.q)));
  }

  function initEditDistance() {
    ["#ed-a", "#ed-b"].forEach((s) => $(s).addEventListener("input", renderEditDistance));
    $("#ed-transpose").addEventListener("change", renderEditDistance);
    $$(".ed-example").forEach((btn) => btn.addEventListener("click", () => {
      const [x, y] = btn.dataset.pair.split("|");
      $("#ed-a").value = x; $("#ed-b").value = y;
      renderEditDistance();
    }));
    $("#spell-input").addEventListener("input", renderSpellDemo);
    renderEditDistance();
  }

  // =================================================================
  function init() {
    initZipf();
    initEditDistance();
    IRApp.onCorpusChange((docs) => {
      $$(".lab-corpus-count").forEach((el) => { el.textContent = fmt(docs.length); });
      if (ZIPF_RESULT) runZipf();     // 已經算過一次就自動跟著語料更新
      renderSpellDemo();
      W2VUI.onCorpusChange(docs);  // Word2Vec 區塊（w2v-ui.js）
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
