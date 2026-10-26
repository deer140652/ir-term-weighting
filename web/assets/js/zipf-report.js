/*
 * zipf-report.js
 * --------------
 * 詞頻分析區塊的呈現（計算由 zipf.js 完成），依「分析的是哪一份數據」分成四組：
 *   1. 前處理與詞彙統計：A–D 四種前處理條件的綜合比較表、log–log 疊圖、詞頻譜、詞幹合併實例
 *   2. 詞彙頻率表：每個詞的 CF、DF、CF/DF、IDF（可排序、搜尋、自選詞）＋ CF–DF 散佈圖
 *   3. 詞頻分佈與 Zipf 迴歸：線性／完整分佈／log–log 三種刻度、可並排比較兩種條件、
 *      可顯示區段界線；迴歸結果，以及高／中／低頻區段（DF 比例與 CF 門檻）的分段擬合與殘差
 * 所有表格可下載 CSV（UTF-8 含 BOM，Excel 可直接開啟中文）。
 * 對外公開為 window.ZipfReport。
 */
(function (global) {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "—");
  const d3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");
  const d4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : "—");
  const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "—");

  const COND_KEYS = ["A", "B", "C", "D"];
  const COND_COLORS = { A: "#8C6D1F", B: "#6B5B95", C: "#B5651D", D: "#2F6F73" };
  const GROUP_COLORS = ["#2F6F73", "#8C6D1F", "#B5651D", "#6B5B95", "#3E7C3A", "#A23B5B", "#2E5E9E", "#7A4A2A"];
  const DEFAULT_TERMS = "glp-1, receptor, patients, weight, diabetes, obesity, risk, treatment, results, methods, semaglutide, tirzepatide, orforglipron, osa, pcos, asthma, hfpef, kidney, cancer, nausea";

  let R = null;
  const S = {
    cond: "D",
    preTab: "loglog",
    scale: "linear",
    linN: 200,
    pair: false,
    pairL: "C",
    pairR: "D",
    showBounds: false,
    dfPct: 30,   // 高頻：DF 比例超過此值（%）
    cfMax: 2,    // 低頻：CF 不超過此值
  };

  const C = (k) => R.conditions[k];
  const condLabel = (k) => Zipf.CONDITIONS.find((c) => c.key === k).label;
  const condShort = (k) => Zipf.CONDITIONS.find((c) => c.key === k).short;
  const dot = (k) => `<span class="cond-dot" style="background:${COND_COLORS[k]}"></span>`;

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
  // 通用 SVG 圖
  // -------------------------------------------------------------------
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }

  function makeAxis(scale, min, max) {
    if (scale === "log") {
      const lo = Math.floor(Math.log10(Math.max(min, 1e-9)));
      const hi = Math.max(lo + 1, Math.ceil(Math.log10(max)));
      const ticks = [];
      for (let e = lo; e <= hi; e++) ticks.push({ v: Math.pow(10, e), label: `10<tspan dy="-6" font-size="9">${e}</tspan>` });
      return { t: (v) => (Math.log10(Math.max(v, 1e-9)) - lo) / (hi - lo), inv: (u) => Math.pow(10, lo + u * (hi - lo)), ticks };
    }
    const step = niceStep((max - min) / 5);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push({ v, label: fmt(Math.round(v * 1000) / 1000) });
    return { t: (v) => (v - lo) / (hi - lo || 1), inv: (u) => lo + u * (hi - lo), ticks };
  }

  let CLIP_SEQ = 0;
  /**
   * opts: xScale, yScale, xMin, xMax, yMin, yMax, xLabel, yLabel,
   *       series: [{ kind: "line"|"dots"|"squares", color, colors?, points: [[x,y]], label, opacities? }],
   *       fits: [{ color, slope, intercept, label }],
   *       shades: [{ from, to, color, label, opacity }],
   *       vlines: [{ x, label }], notes: [string], zeroLine
   */
  function chartSVG(opts) {
    const W = 720, H = 400, ml = 64, mr = 18, mt = 18, mb = 46;
    const pw = W - ml - mr, ph = H - mt - mb;
    const xa = makeAxis(opts.xScale, opts.xMin, opts.xMax);
    const ya = makeAxis(opts.yScale, opts.yMin, opts.yMax);
    const X = (v) => ml + xa.t(v) * pw;
    const Y = (v) => mt + ph - ya.t(v) * ph;
    const clip = `zclip-${++CLIP_SEQ}`;
    let g = `<defs><clipPath id="${clip}"><rect x="${ml}" y="${mt}" width="${pw}" height="${ph}"/></clipPath></defs>`;
    xa.ticks.forEach((tk) => {
      const x = X(tk.v);
      g += `<line x1="${x}" y1="${mt}" x2="${x}" y2="${mt + ph}" class="zg"/><text x="${x}" y="${mt + ph + 16}" class="zt" text-anchor="middle">${tk.label}</text>`;
    });
    ya.ticks.forEach((tk) => {
      const y = Y(tk.v);
      g += `<line x1="${ml}" y1="${y}" x2="${ml + pw}" y2="${y}" class="zg"/><text x="${ml - 8}" y="${y + 4}" class="zt" text-anchor="end">${tk.label}</text>`;
    });
    g += `<g clip-path="url(#${clip})">`;
    (opts.shades || []).forEach((s) => {
      const x1 = X(Math.max(s.from, opts.xMin)), x2 = X(Math.min(s.to, opts.xMax));
      if (x2 <= x1) return;
      g += `<rect x="${x1}" y="${mt}" width="${x2 - x1}" height="${ph}" fill="${s.color}" opacity="${s.opacity || 0.14}"/>`;
      if (s.label) g += `<text x="${(x1 + x2) / 2}" y="${mt + 14}" class="zt" text-anchor="middle">${esc(s.label)}</text>`;
    });
    if (opts.zeroLine) g += `<line x1="${ml}" y1="${Y(0)}" x2="${ml + pw}" y2="${Y(0)}" stroke="var(--ink)" stroke-width="1"/>`;
    (opts.fits || []).forEach((f) => {
      const y1 = Math.pow(10, f.intercept + f.slope * Math.log10(opts.xMin));
      const y2 = Math.pow(10, f.intercept + f.slope * Math.log10(opts.xMax));
      g += `<line x1="${X(opts.xMin)}" y1="${Y(y1)}" x2="${X(opts.xMax)}" y2="${Y(Math.max(y2, 1e-9))}" stroke="${f.color}" stroke-width="1.6" stroke-dasharray="7 4"/>`;
    });
    (opts.series || []).forEach((s) => {
      const kept = [];
      let lastX = -1;
      const gap = s.kind === "line" ? 0.7 : s.kind === "dots" ? 1.4 : 0;
      s.points.forEach((p, i) => {
        const x = X(p[0]);
        if (gap === 0 || x - lastX >= gap || i === s.points.length - 1) { kept.push({ x, y: Y(p[1]), i }); lastX = x; }
      });
      if (s.kind === "line") {
        g += `<polyline points="${kept.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round"/>`;
      } else if (s.kind === "squares") {
        const size = kept.length <= 250 ? 5 : kept.length <= 800 ? 3 : 2;
        g += kept.map((p) => `<rect x="${(p.x - size / 2).toFixed(1)}" y="${(p.y - size / 2).toFixed(1)}" width="${size}" height="${size}" fill="${s.colors ? s.colors[p.i] : s.color}" opacity="${s.opacities ? s.opacities[p.i] : 1}"/>`).join("");
      } else {
        g += kept.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.8" fill="${s.color}" opacity="${s.opacities ? s.opacities[p.i] : 0.75}"/>`).join("");
      }
    });
    (opts.vlines || []).forEach((v) => {
      if (v.x < opts.xMin || v.x > opts.xMax) return;
      const x = X(v.x);
      g += `<line x1="${x}" y1="${mt}" x2="${x}" y2="${mt + ph}" class="zcut"/><text x="${x + 5}" y="${mt + 28}" class="zcut-label">${esc(v.label)}</text>`;
    });
    g += `</g>`;
    (opts.notes || []).forEach((n, i) => { g += `<text x="${ml + pw - 6}" y="${mt + ph - 10 - i * 14}" class="zt chart-note" text-anchor="end">${esc(n)}</text>`; });
    g += `<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" class="zframe"/>`;
    g += `<text x="${ml + pw / 2}" y="${H - 6}" class="zl" text-anchor="middle">${esc(opts.xLabel)}</text>`;
    g += `<text transform="translate(14 ${mt + ph / 2}) rotate(-90)" class="zl" text-anchor="middle">${esc(opts.yLabel)}</text>`;
    const legend = (opts.series || []).filter((s) => s.label).map((s) => ({ label: s.label, color: s.color }))
      .concat((opts.fits || []).filter((f) => f.label).map((f) => ({ label: f.label, color: f.color, dashed: true })));
    if (legend.length) {
      const lw = 250, lh = 8 + legend.length * 17;
      g += `<g transform="translate(${ml + pw - lw - 8} ${mt + 8})"><rect width="${lw}" height="${lh}" class="zlegend"/>`;
      legend.forEach((l, i) => {
        const y = 14 + i * 17;
        g += `<line x1="8" y1="${y - 4}" x2="30" y2="${y - 4}" stroke="${l.color}" stroke-width="2.5" ${l.dashed ? 'stroke-dasharray="6 4"' : ""}/><text x="36" y="${y}" class="zt">${esc(l.label)}</text>`;
      });
      g += `</g>`;
    }
    g += `<line class="zcursor" x1="0" y1="${mt}" x2="0" y2="${mt + ph}" visibility="hidden"/>`;
    return {
      svg: `<svg viewBox="0 0 ${W} ${H}" class="zipf-svg" role="img">${g}</svg>`,
      X, Y, invX: (px) => xa.inv((px - ml) / pw), invY: (py) => ya.inv((mt + ph - py) / ph),
      plotLeft: ml, plotRight: ml + pw, plotTop: mt, plotBottom: mt + ph, width: W, height: H,
    };
  }

  function svgPoint(svg, chart, e) {
    const rect = svg.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * chart.width, y: ((e.clientY - rect.top) / rect.height) * chart.height };
  }

  // 依 x（排名）顯示提示
  function attachRankTip(container, chart, tipEl, describe) {
    const svg = container.querySelector("svg");
    const cursor = svg.querySelector(".zcursor");
    svg.addEventListener("mousemove", (e) => {
      const p = svgPoint(svg, chart, e);
      if (p.x < chart.plotLeft || p.x > chart.plotRight) { cursor.setAttribute("visibility", "hidden"); return; }
      const rank = Math.max(1, Math.round(chart.invX(p.x)));
      const html = describe(rank);
      if (!html) return;
      cursor.setAttribute("x1", chart.X(rank)); cursor.setAttribute("x2", chart.X(rank));
      cursor.setAttribute("visibility", "visible");
      tipEl.innerHTML = html;
    });
    svg.addEventListener("mouseleave", () => cursor.setAttribute("visibility", "hidden"));
  }

  // -------------------------------------------------------------------
  // 統一格式的詞彙表元件：Rank｜Term｜CF｜DF｜CF/DF｜IDF
  // -------------------------------------------------------------------
  const TERM_COLS = [
    { key: "rank", label: "Rank", num: true, title: "依 CF 由高到低的排名", cell: (r) => fmt(r.rank) },
    { key: "term", label: "Term", num: false, cell: (r) => `<button class="term-link" data-q="${esc(r.term)}">${esc(r.term)}</button>${r.input && r.input.toLowerCase() !== r.term ? `<small class="muted">（輸入：${esc(r.input)}）</small>` : ""}` },
    { key: "freq", label: "CF", num: true, title: "Collection Frequency：在整個語料中出現的總次數", cell: (r) => fmt(r.freq) },
    { key: "df", label: "DF", num: true, title: "Document Frequency：包含這個詞的文獻數", cell: (r) => fmt(r.df) },
    { key: "ratio", label: "CF/DF", num: true, title: "平均每篇（有出現的文獻）出現幾次；越大代表越集中在少數文獻", cell: (r) => d3(r.ratio) },
    { key: "idf", label: "IDF", num: true, title: "IDF = log10(N / DF)", cell: (r) => d3(r.idf) },
  ];

  function makeTermTable(cfg) {
    const st = { sort: cfg.defaultSort || { key: "rank", dir: 1 }, page: 1 };
    const cols = TERM_COLS;
    const PAGE = cfg.pageSize || 50;

    function sorted() {
      const rows = cfg.getRows().slice();
      const { key, dir } = st.sort;
      rows.sort((a, b) => {
        if (a.missing || b.missing) return (a.missing ? 1 : 0) - (b.missing ? 1 : 0);
        const x = a[key], y = b[key];
        if (key === "term") return dir * String(x).localeCompare(String(y));
        return dir * ((x === undefined ? -Infinity : x) - (y === undefined ? -Infinity : y)) || a.rank - b.rank;
      });
      return rows;
    }

    function render() {
      const el = $(cfg.container);
      const rows = sorted();
      const pages = Math.max(1, Math.ceil(rows.length / PAGE));
      st.page = Math.min(Math.max(1, st.page), pages);
      const view = rows.slice((st.page - 1) * PAGE, st.page * PAGE);
      const arrow = (k) => (st.sort.key === k ? (st.sort.dir > 0 ? " ▲" : " ▼") : "");
      el.innerHTML = `
        <div class="table-scroll tall">
          <table class="lab-table term-table">
            <colgroup>${cols.map((c) => `<col class="col-${c.key}">`).join("")}</colgroup>
            <thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""} sortable" data-sort="${c.key}" title="${esc(c.title || "點擊排序")}">${c.label}${arrow(c.key)}</th>`).join("")}</tr></thead>
            <tbody>${view.length ? view.map((r) => r.missing
              ? `<tr class="missing-row"><td class="num">—</td><td>${esc(r.input)}${r.term ? ` <small class="muted">→ ${esc(r.term)}</small>` : ""}</td><td colspan="${cols.length - 2}" class="muted">${esc(r.note)}</td></tr>`
              : `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.cell(r)}</td>`).join("")}</tr>`).join("")
              : `<tr><td colspan="${cols.length}" class="muted">沒有符合的詞。</td></tr>`}</tbody>
          </table>
        </div>
        <div class="table-foot">
          <span class="muted">共 ${fmt(rows.length)} 個詞${pages > 1 ? `，第 ${st.page} / ${pages} 頁` : ""}</span>
          ${pages > 1 ? `<span class="mini-pager">
            <button type="button" class="page-btn" data-tpage="${st.page - 1}" ${st.page === 1 ? "disabled" : ""}>‹</button>
            <button type="button" class="page-btn" data-tpage="${st.page + 1}" ${st.page === pages ? "disabled" : ""}>›</button></span>` : ""}
        </div>`;
      el.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
        const k = th.dataset.sort;
        st.sort = st.sort.key === k ? { key: k, dir: -st.sort.dir } : { key: k, dir: k === "rank" || k === "term" ? 1 : -1 };
        st.page = 1;
        render();
        if (cfg.onChange) cfg.onChange();
      }));
      el.querySelectorAll("[data-tpage]").forEach((b) => b.addEventListener("click", () => {
        st.page = parseInt(b.dataset.tpage, 10);
        render();
        if (cfg.onChange) cfg.onChange();
      }));
      el.querySelectorAll(".term-link[data-q]").forEach((b) => b.addEventListener("click", () => IRApp.search(b.dataset.q)));
      return view;
    }

    function csv(filename) {
      const rows = sorted();
      downloadCSV(filename, cols.map((c) => c.label), rows.map((r) => r.missing
        ? cols.map((c, i) => (i === 1 ? r.input : i === cols.length - 1 ? r.note : ""))
        : cols.map((c) => {
          const v = r[c.key];
          if (c.key === "ratio" || c.key === "idf") return Number.isFinite(v) ? v.toFixed(3) : "";
          return v;
        })));
    }

    return {
      render, csv,
      resetPage: () => { st.page = 1; },
      resetSort: () => { st.sort = cfg.defaultSort || { key: "rank", dir: 1 }; st.page = 1; },
      currentView: () => { const rows = sorted(); return rows.slice((st.page - 1) * PAGE, st.page * PAGE); },
    };
  }

  // -------------------------------------------------------------------
  // 1. 前處理與詞彙統計（A–D）
  // -------------------------------------------------------------------
  function compareMetrics() {
    return [
      ["文獻數（Documents）", (c) => fmt(c.numDocs), (c) => c.numDocs],
      ["總 token 數（Total tokens）", (c) => fmt(c.tokens), (c) => c.tokens],
      ["詞彙量（Unique terms）", (c) => fmt(c.vocab), (c) => c.vocab],
      ["平均每篇 token 數", (c) => c.avgTokens.toFixed(1), (c) => c.avgTokens.toFixed(1)],
      ["只出現 1 次的詞比例", (c) => pct(c.hapaxRatio), (c) => pct(c.hapaxRatio)],
      ["前 10 名佔總 token 比例", (c) => pct(c.top10Share), (c) => pct(c.top10Share)],
      ["前 10 名詞彙", (c) => `<span class="terms-cell">${c.ranked.slice(0, 10).map((e) => esc(e.term)).join(" ")}</span>`, (c) => c.ranked.slice(0, 10).map((e) => e.term).join(" ")],
      ["Slope", (c) => d4(c.fitAll.slope), (c) => d4(c.fitAll.slope)],
      ["Intercept", (c) => d4(c.fitAll.intercept), (c) => d4(c.fitAll.intercept)],
      ["Zipf exponent k", (c) => d4(c.fitAll.k), (c) => d4(c.fitAll.k)],
      ["R²", (c) => d4(c.fitAll.r2), (c) => d4(c.fitAll.r2)],
      ["RMSE", (c) => d4(c.fitAll.rmse), (c) => d4(c.fitAll.rmse)],
      ["曲線前段（前 10 名）局部 k", (c) => d4(c.headK), (c) => d4(c.headK)],
    ];
  }

  function renderPre() {
    const m = compareMetrics();
    $("#z-cmp-table").innerHTML = `
      <div class="table-scroll"><table class="lab-table metrics-table">
        <colgroup><col class="col-metric">${COND_KEYS.map(() => `<col class="col-cond">`).join("")}</colgroup>
        <thead><tr><th>指標</th>${COND_KEYS.map((k) => `<th class="num">${dot(k)}${esc(condShort(k))}</th>`).join("")}</tr></thead>
        <tbody>${m.map(([name, f]) => `<tr><td>${name}</td>${COND_KEYS.map((k) => `<td class="num">${f(C(k))}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <p class="lab-footnote">迴歸式 log<sub>10</sub>(CF) = a − k · log<sub>10</sub>(rank)，以最小平方法、使用全部詞彙。「曲線前段局部 k」只用前 10 名的詞迴歸，越小代表曲線前段越平坦。</p>`;
    renderPreChart();
  }

  // 詞幹還原合併實例（彈出視窗）
  function renderMerges() {
    const q = $("#merge-search").value.trim().toLowerCase();
    const list = q ? R.merges.filter((m) => m.stem.includes(q) || m.forms.some(([w]) => w.includes(q))) : R.merges;
    const shown = list.slice(0, 200);
    $("#merge-count").textContent = `Porter 共將 ${fmt(R.mergedStemCount)} 組不同詞形合併為同一詞幹（C → D）。${q ? `符合「${q}」的有 ${fmt(list.length)} 組。` : ""}${list.length > shown.length ? `依合併詞形數排序，顯示前 ${shown.length} 組。` : ""}`;
    $("#merge-list").innerHTML = shown.length ? shown.map((mg) => `
      <div class="merge-card">
        <div class="merge-head"><code>${esc(mg.stem)}</code><span>${mg.forms.length} 種詞形 · CF ${fmt(mg.freq)}</span></div>
        <div class="merge-forms">${mg.forms.map(([w, f]) => `<span>${esc(w)}<small>${fmt(f)}</small></span>`).join("")}</div>
      </div>`).join("") : `<p class="empty-state small">沒有符合的詞幹。</p>`;
  }

  function renderPreChart() {
    $$("#z-pre .chart-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === S.preTab));
    const wrap = $("#z-pre-chart");
    const tip = $("#z-pre-tip");
    if (S.preTab === "loglog") {
      const maxV = Math.max(...COND_KEYS.map((k) => C(k).vocab));
      const maxF = Math.max(...COND_KEYS.map((k) => C(k).ranked[0].freq));
      const chart = chartSVG({ xScale: "log", yScale: "log", xMin: 1, xMax: maxV, yMin: 1, yMax: maxF, xLabel: "Rank（log）", yLabel: "CF（log）",
        series: COND_KEYS.map((k) => ({ kind: "line", color: COND_COLORS[k], points: C(k).ranked.map((e) => [e.rank, e.freq]), label: `${condShort(k)}（k = ${C(k).fitAll.k.toFixed(3)}）` })) });
      wrap.innerHTML = `<div class="chart-wrap">${chart.svg}</div>`;
      tip.textContent = "滑鼠移到圖上，比較同一排名下四種條件的詞與 CF。";
      attachRankTip(wrap, chart, tip, (rank) => COND_KEYS.map((k) => {
        const e = C(k).ranked[rank - 1];
        return `<span style="color:${COND_COLORS[k]}">${k}：${e ? `${esc(e.term)}（${fmt(e.freq)}）` : "—"}</span>`;
      }).join("　") + `　｜ rank ${fmt(rank)}`);
      return;
    }
    // 詞頻譜 V(m)：出現恰好 m 次的詞有幾個
    const buckets = [];
    for (let m = 1; m <= 10; m++) buckets.push({ label: String(m), test: (f) => f === m });
    buckets.push({ label: ">10", test: (f) => f > 10 });
    const counts = COND_KEYS.map((k) => buckets.map((b) => { let n = 0; C(k).spectrum.forEach((v, f) => { if (b.test(f)) n += v; }); return n; }));
    const W = 720, H = 360, ml = 64, mr = 18, mt = 18, mb = 46, pw = W - ml - mr, ph = H - mt - mb;
    const maxV = Math.max(1, ...counts.flat());
    const step = niceStep(maxV / 5), top = Math.ceil(maxV / step) * step;
    const Y = (v) => mt + ph - (v / top) * ph;
    const bw = pw / buckets.length, barW = (bw * 0.8) / 4;
    let g = "";
    for (let v = 0; v <= top + 1e-9; v += step) g += `<line x1="${ml}" y1="${Y(v)}" x2="${ml + pw}" y2="${Y(v)}" class="zg"/><text x="${ml - 8}" y="${Y(v) + 4}" class="zt" text-anchor="end">${fmt(v)}</text>`;
    buckets.forEach((b, i) => {
      COND_KEYS.forEach((k, j) => {
        const v = counts[j][i], x = ml + i * bw + bw * 0.1 + j * barW;
        g += `<rect x="${x}" y="${Y(v)}" width="${barW - 1}" height="${mt + ph - Y(v)}" fill="${COND_COLORS[k]}"><title>${condShort(k)}：出現 ${b.label} 次的詞有 ${fmt(v)} 個</title></rect>`;
      });
      g += `<text x="${ml + i * bw + bw / 2}" y="${mt + ph + 16}" class="zt" text-anchor="middle">${b.label}</text>`;
    });
    g += `<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" class="zframe"/>`;
    g += `<text x="${ml + pw / 2}" y="${H - 6}" class="zl" text-anchor="middle">出現次數 m</text><text transform="translate(14 ${mt + ph / 2}) rotate(-90)" class="zl" text-anchor="middle">詞數 V(m)</text>`;
    g += `<g transform="translate(${ml + pw - 160} ${mt + 8})"><rect width="152" height="${8 + 4 * 17}" class="zlegend"/>${COND_KEYS.map((k, i) => `<rect x="8" y="${8 + i * 17}" width="14" height="10" fill="${COND_COLORS[k]}"/><text x="28" y="${17 + i * 17}" class="zt">${esc(condShort(k))}</text>`).join("")}</g>`;
    wrap.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="zipf-svg">${g}</svg></div>`;
    tip.textContent = "滑鼠移到長條上可看數值。去除標點與詞幹還原會讓只出現 1、2 次的詞明顯變少。";
  }

  // -------------------------------------------------------------------
  // 2. 詞彙頻率表 ＋ CF–DF 散佈圖
  // -------------------------------------------------------------------
  let termTable = null;
  let termMode = "top50";

  function termRows() {
    const c = C(S.cond);
    if (termMode === "custom") {
      const index = new Map(c.ranked.map((e) => [e.term, e]));
      const seen = new Set();
      return $("#z-terms-input").value.split(/[,，\n]+/).map((w) => w.trim()).filter(Boolean)
        .filter((w) => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .map((w) => {
          const t = Zipf.normalizeTerm(w, S.cond);
          const e = t ? index.get(t) : null;
          if (e) return Object.assign({ input: w }, e);
          return { missing: true, input: w, term: t, note: !t ? "停用詞（此條件已移除）" : "語料中沒有這個詞", rank: Infinity };
        });
    }
    const q = $("#z-terms-search").value.trim().toLowerCase();
    const minCF = Math.max(1, parseInt($("#z-terms-mincf").value, 10) || 1);
    let rows = termMode === "top50" ? c.ranked.slice(0, 50) : c.ranked;
    if (q) rows = rows.filter((e) => e.term.includes(q));
    if (minCF > 1) rows = rows.filter((e) => e.freq >= minCF);
    return rows;
  }

  function renderTerms() {
    $$("#z-terms .mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === termMode));
    $("#z-terms-custom").hidden = termMode !== "custom";
    $("#z-terms-filters").hidden = termMode === "custom";
    termTable.render();
    renderScatter();
  }

  function renderScatter() {
    const c = C(S.cond);
    const pts = c.ranked;
    const hi = new Set(termTable.currentView().filter((r) => !r.missing).map((r) => r.term));
    const maxDF = Math.max(...pts.map((e) => e.df)), maxCF = pts[0].freq;
    const W = 520, H = 440, ml = 60, mr = 16, mt = 16, mb = 46, pw = W - ml - mr, ph = H - mt - mb;
    const xa = makeAxis("log", 1, Math.max(10, maxDF)), ya = makeAxis("log", 1, Math.max(10, maxCF));
    const X = (v) => ml + xa.t(v) * pw, Y = (v) => mt + ph - ya.t(v) * ph;
    let g = "";
    xa.ticks.forEach((t) => { g += `<line x1="${X(t.v)}" y1="${mt}" x2="${X(t.v)}" y2="${mt + ph}" class="zg"/><text x="${X(t.v)}" y="${mt + ph + 16}" class="zt" text-anchor="middle">${t.label}</text>`; });
    ya.ticks.forEach((t) => { g += `<line x1="${ml}" y1="${Y(t.v)}" x2="${ml + pw}" y2="${Y(t.v)}" class="zg"/><text x="${ml - 8}" y="${Y(t.v) + 4}" class="zt" text-anchor="end">${t.label}</text>`; });
    const lim = Math.max(maxDF, maxCF);
    g += `<line x1="${X(1)}" y1="${Y(1)}" x2="${X(lim)}" y2="${Y(lim)}" stroke="var(--ink-soft)" stroke-dasharray="5 4"/>`;
    g += `<text x="${X(Math.min(maxDF, 300))}" y="${Y(Math.min(maxDF, 300)) + 16}" class="zt">CF = DF</text>`;
    // 同一個像素位置只畫一個點（大量低頻詞重疊）
    const seen = new Set();
    let dots = "", hiDots = "";
    pts.forEach((e) => {
      const x = X(e.df), y = Y(e.freq);
      if (hi.has(e.term)) {
        hiDots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.6" fill="var(--rust)"/>`;
        if (hi.size <= 25) hiDots += `<text x="${(x + 5).toFixed(1)}" y="${(y - 4).toFixed(1)}" class="scatter-label">${esc(e.term)}</text>`;
        return;
      }
      const key = `${Math.round(x)}|${Math.round(y)}`;
      if (seen.has(key)) return;
      seen.add(key);
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="${COND_COLORS[S.cond]}" opacity="0.45"/>`;
    });
    g += dots + hiDots;
    g += `<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" class="zframe"/>`;
    g += `<text x="${ml + pw / 2}" y="${H - 6}" class="zl" text-anchor="middle">DF（log）</text><text transform="translate(14 ${mt + ph / 2}) rotate(-90)" class="zl" text-anchor="middle">CF（log）</text>`;
    $("#z-scatter").innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="zipf-svg">${g}</svg></div>`;
    const svg = $("#z-scatter svg");
    const tip = $("#z-scatter-tip");
    svg.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W, py = ((ev.clientY - rect.top) / rect.height) * H;
      let best = null, bd = 64;
      for (const e of pts) {
        const dx = X(e.df) - px, dy = Y(e.freq) - py, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = e; }
      }
      if (best) tip.innerHTML = `<strong>${esc(best.term)}</strong>　CF = ${fmt(best.freq)}　DF = ${fmt(best.df)}　CF/DF = ${d3(best.ratio)}　IDF = ${d3(best.idf)}　（rank ${fmt(best.rank)}）`;
    });
  }

  // -------------------------------------------------------------------
  // 3. 詞頻分佈與 Zipf 迴歸
  // -------------------------------------------------------------------
  function distConds() {
    return S.pair ? [S.pairL, S.pairR] : [S.cond];
  }

  // 區段界線（高頻／中頻／低頻），依目前的 DF 比例與 CF 門檻
  function boundsOf(k) {
    return Zipf.zoneBounds(C(k).ranked, R.numDocs, S.dfPct / 100, S.cfMax);
  }

  function zoneOf(k, rank) {
    const b = boundsOf(k);
    return rank <= b.highEnd ? "高頻（太常見）" : rank >= b.lowStart ? "低頻（太罕見）" : "中頻（顯著詞）";
  }

  function distChart(k, shared) {
    const c = C(k);
    const bd = boundsOf(k);
    const opts = { xLabel: "", yLabel: "", series: [], fits: [], shades: [], vlines: [], notes: [] };
    if (S.scale === "linear") {
      const n = shared.linN;
      let gi = -1, last = null;
      const shown = c.ranked.slice(0, n);
      const colors = shown.map((e) => { if (e.freq !== last) { gi++; last = e.freq; } return GROUP_COLORS[gi % GROUP_COLORS.length]; });
      const opac = shown.map((e) => (S.showBounds && (e.rank <= bd.highEnd || e.rank >= bd.lowStart) ? 0.4 : 1));
      Object.assign(opts, { xScale: "linear", yScale: "linear", xMin: 0, xMax: n, yMin: 0, yMax: shared.yMax, xLabel: "Rank", yLabel: "CF" });
      opts.series.push({ kind: "squares", points: shown.map((e) => [e.rank, e.freq]), colors, opacities: opac });
    } else if (S.scale === "semilog") {
      Object.assign(opts, { xScale: "linear", yScale: "log", xMin: 0, xMax: shared.xMax, yMin: 1, yMax: shared.yMax, xLabel: "Rank（全部詞彙）", yLabel: "CF（log）" });
      opts.series.push({ kind: "line", color: COND_COLORS[k], points: c.ranked.map((e) => [e.rank, e.freq]) });
    } else {
      Object.assign(opts, { xScale: "log", yScale: "log", xMin: 1, xMax: shared.xMax, yMin: 1, yMax: shared.yMax, xLabel: "Rank（log）", yLabel: "CF（log）" });
      opts.series.push({ kind: "dots", color: COND_COLORS[k], points: c.ranked.map((e) => [e.rank, e.freq]), label: "觀察值" });
      opts.fits.push({ color: "#222", slope: c.fitAll.slope, intercept: c.fitAll.intercept, label: `迴歸線 k = ${c.fitAll.k.toFixed(3)}` });
    }
    if (S.showBounds) {
      const xMax = opts.xMax;
      const upperX = bd.highEnd + 0.5, lowerX = bd.lowStart - 0.5;
      opts.shades.push({ from: Math.max(opts.xMin, upperX), to: lowerX, color: "#E3B23C", opacity: 0.2 });
      if (bd.highEnd > 0) opts.vlines.push({ x: upperX, label: "Upper cut-off" });
      opts.vlines.push({ x: lowerX, label: "Lower cut-off" });
      if (lowerX > xMax) opts.notes.push(`Lower cut-off 在 rank ${fmt(bd.lowStart - 1)} 之後（超出顯示範圍）`);
    }
    return chartSVG(opts);
  }

  function describeRank(k) {
    const c = C(k);
    return (rank) => {
      const e = c.ranked[rank - 1];
      if (!e) return "";
      let s = `${dot(k)}<strong>${esc(condShort(k))}</strong>　rank <strong>${fmt(rank)}</strong>　<strong>${esc(e.term)}</strong>　CF = ${fmt(e.freq)}　DF = ${fmt(e.df)}`;
      if (S.scale === "loglog") {
        const pred = Math.pow(10, c.fitAll.intercept + c.fitAll.slope * Math.log10(rank));
        s += `　預測 CF = ${pred.toFixed(1)}　殘差 = ${(Math.log10(e.freq) - Math.log10(pred)).toFixed(3)}`;
      }
      s += `　DF 比例 = ${pct(e.dfRatio)}`;
      if (S.showBounds) s += `　→ ${zoneOf(k, rank)}`;
      return s;
    };
  }

  function renderDist() {
    $$("#z-dist .scale-tab").forEach((b) => b.classList.toggle("active", b.dataset.scale === S.scale));
    $("#z-linN-wrap").hidden = S.scale !== "linear";
    $("#z-pair-selects").hidden = !S.pair;
    const ks = distConds();
    const shared = {
      linN: Math.min(S.linN, Math.max(...ks.map((k) => C(k).vocab))),
      xMax: Math.max(...ks.map((k) => C(k).vocab)),
      yMax: Math.max(...ks.map((k) => C(k).ranked[0].freq)),
    };
    const charts = {};
    $("#z-dist-charts").className = ks.length > 1 ? "zipf-pair" : "chart-col";
    $("#z-dist-charts").innerHTML = ks.map((k) => {
      charts[k] = distChart(k, shared);
      return `<div class="zipf-pane" data-cond="${k}">
        <h4 class="zipf-pane-title"><span class="pane-name">${dot(k)}${esc(condLabel(k))}</span><span class="pane-meta">詞彙量 ${fmt(C(k).vocab)}　k = ${C(k).fitAll.k.toFixed(3)}</span></h4>
        <div class="chart-wrap">${charts[k].svg}</div></div>`;
    }).join("");
    $$("#z-dist-charts .zipf-pane").forEach((pane) => attachRankTip(pane, charts[pane.dataset.cond], $("#z-dist-tip"), describeRank(pane.dataset.cond)));
    const notes = {
      linear: "線性座標（同課堂範例圖）：每個排名一個方塊，同一 CF 同一顏色。",
      semilog: "X 軸涵蓋全部詞彙、Y 軸取對數：整個分佈都能看清楚，最右邊的水平段是只出現 1 次的詞。",
      loglog: "log–log 座標：若符合 Zipf's Law，點會接近一條直線；虛線為最小平方法迴歸線。",
    };
    $("#z-dist-note").textContent = notes[S.scale] + (S.showBounds ? ` 兩條界線依下方「區段分析」的門檻（DF 比例 > ${S.dfPct}%、CF ≤ ${S.cfMax}），淡黃底為中頻（顯著詞）區段。` : "") + (ks.length > 1 ? " 兩張圖使用相同的座標範圍。" : "");
    renderRegression();
    renderResiduals();
  }

  function renderRegression() {
    const ks = distConds();
    const rows = [
      ["迴歸使用的詞數", (f) => fmt(f.points)],
      ["Slope", (f) => d4(f.slope)],
      ["Intercept（a）", (f) => d4(f.intercept)],
      ["Zipf exponent k", (f) => `<strong>${d4(f.k)}</strong>`],
      ["R²", (f) => d4(f.r2)],
      ["RMSE（log₁₀）", (f) => d4(f.rmse)],
      ["平均誤差倍數 10^RMSE", (f) => `${Math.pow(10, f.rmse).toFixed(2)} 倍`],
    ];
    $("#z-reg-table").innerHTML = `
      <div class="table-scroll"><table class="lab-table metrics-table">
        <colgroup><col class="col-metric">${ks.map(() => `<col class="col-cond"><col class="col-cond">`).join("")}</colgroup>
        <thead>
          <tr><th rowspan="2">指標</th>${ks.map((k) => `<th colspan="2" class="num group-head">${dot(k)}${esc(condShort(k))}</th>`).join("")}</tr>
          <tr>${ks.map(() => `<th class="num">全部詞彙</th><th class="num" title="排除只出現 1 次的詞（hapax）">排除 hapax</th>`).join("")}</tr>
        </thead>
        <tbody>${rows.map(([name, f]) => `<tr><td>${name}</td>${ks.map((k) => `<td class="num">${f(C(k).fitAll)}</td><td class="num muted-num">${f(C(k).fitNoHapax)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <p class="lab-footnote">迴歸式 log<sub>10</sub>(CF) = a − k · log<sub>10</sub>(rank)。只出現 1 次的詞在圖上形成一段水平平台，「排除 hapax」一欄顯示去掉這段平台後的擬合結果；其他表格與圖一律使用「全部詞彙」。</p>`;
  }

  function renderResiduals() {
    const ks = distConds();
    const shade = ["#B5651D", "#2F6F73", "#6B5B95"];
    const charts = {};
    // 並排時兩張殘差圖共用相同的 X、Y 範圍
    const resid = {};
    ks.forEach((k) => {
      const f = C(k).fitAll;
      resid[k] = C(k).ranked.map((e) => [e.rank, Math.log10(e.freq) - (f.intercept + f.slope * Math.log10(e.rank))]);
    });
    const lim = Math.max(0.5, Math.ceil(Math.max(...ks.flatMap((k) => resid[k].map((p) => Math.abs(p[1])))) * 4) / 4);
    const xMaxRes = Math.max(...ks.map((k) => C(k).vocab));
    $("#z-res-charts").className = ks.length > 1 ? "zipf-pair" : "chart-col";
    $("#z-res-charts").innerHTML = ks.map((k) => {
      const c = C(k), f = c.fitAll;
      const seg = Zipf.segmentAnalysis(c.ranked, f, boundsOf(k));
      const pts = resid[k];
      charts[k] = { chart: chartSVG({ xScale: "log", yScale: "linear", xMin: 1, xMax: xMaxRes, yMin: -lim, yMax: lim, zeroLine: true,
        xLabel: "Rank（log）", yLabel: "殘差 log₁₀(CF) − 預測",
        shades: seg.segments.map((s, i) => (s.n > 0 ? { from: Math.max(1, s.from - 0.5), to: s.to + 0.5, color: shade[i], label: s.name.replace(/（.*）/, "") } : null)).filter(Boolean),
        series: [{ kind: "dots", color: COND_COLORS[k], points: pts }] }), pts };
      return `<div class="zipf-pane" data-cond="${k}">
        <h4 class="zipf-pane-title"><span class="pane-name">${dot(k)}${esc(condLabel(k))}</span><span class="pane-meta">殘差圖</span></h4>
        <div class="chart-wrap">${charts[k].chart.svg}</div></div>`;
    }).join("");
    $$("#z-res-charts .zipf-pane").forEach((pane) => {
      const k = pane.dataset.cond;
      attachRankTip(pane, charts[k].chart, $("#z-res-tip"), (rank) => {
        const e = C(k).ranked[rank - 1];
        return e ? `${dot(k)}<strong>${esc(condShort(k))}</strong>　rank <strong>${fmt(rank)}</strong>　<strong>${esc(e.term)}</strong>　CF = ${fmt(e.freq)}　殘差 = ${charts[k].pts[rank - 1][1].toFixed(3)}` : "";
      });
    });
    const segRows = (withDecades) => ks.flatMap((k) => {
      const seg = Zipf.segmentAnalysis(C(k).ranked, C(k).fitAll, boundsOf(k));
      const list = withDecades ? seg.decades : seg.segments;
      const best = seg.segments.filter((x) => x.n > 0).sort((a, b) => a.resid.rmse - b.resid.rmse)[0];
      return list.map((x) => ({ k, s: x, share: x.tokens / C(k).tokens, best: !withDecades && x === best }));
    });
    const table = (rows, first) => `
      <div class="table-scroll"><table class="lab-table seg-table">
        <colgroup><col class="col-cond-short"><col class="col-seg"><col class="col-range"><col class="col-n"><col class="col-n"><col class="col-n"><col class="col-n"><col class="col-n"><col class="col-n"></colgroup>
        <thead><tr><th>條件</th><th>${first}</th><th>排名範圍</th><th class="num">詞數</th><th class="num">佔總 token</th>
          <th class="num" title="只用該段的點另外迴歸得到的斜率">局部 k</th><th class="num">局部 R²</th>
          <th class="num" title="該段的點相對於整體迴歸線的誤差；越小越貼近 Zipf 直線">殘差 RMSE</th>
          <th class="num" title="正值：觀察值高於迴歸線；負值：低於迴歸線">平均殘差</th></tr></thead>
        <tbody>${rows.map(({ k, s, share, best }) => `<tr${best ? ' class="best"' : ""}><td>${dot(k)}${k}</td><td>${esc(s.name)}</td><td class="muted">${s.n ? `${fmt(s.from)}–${fmt(s.to)}` : "—"}</td><td class="num">${fmt(s.n)}</td><td class="num">${pct(share)}</td>
          <td class="num">${s.local ? d4(s.local.k) : "—"}</td><td class="num">${s.local ? d4(s.local.r2) : "—"}</td>
          <td class="num">${d4(s.resid.rmse)}</td><td class="num">${Number.isFinite(s.resid.bias) ? (s.resid.bias >= 0 ? "+" : "") + s.resid.bias.toFixed(4) : "—"}</td></tr>`).join("")}</tbody>
      </table></div>`;
    $("#z-seg-table").innerHTML = table(segRows(false), "區段") +
      `<p class="lab-footnote">區段定義：高頻（太常見）= 排名在最後一個 DF 比例 > ${S.dfPct}% 的詞之前（含）；低頻（太罕見）= CF ≤ ${S.cfMax} 的詞；中頻（顯著詞）= 其餘。底色標示各條件中殘差 RMSE 最小、最貼近整體 Zipf 直線的區段。</p>
       <details class="seg-details"><summary>以 10 倍排名細分</summary>${table(segRows(true), "排名區間")}</details>`;
    S._segRows = segRows;
  }

  // -------------------------------------------------------------------
  function renderAll() {
    if (!R) return;
    renderPre();
    termTable.resetPage();
    renderTerms();
    renderDist();
  }

  function render(result) {
    R = result;
    renderAll();
  }

  function init() {
    $("#z-terms-input").value = DEFAULT_TERMS;
    termTable = makeTermTable({ container: "#z-terms-table", getRows: termRows, onChange: renderScatter });

    $("#z-cond").addEventListener("change", () => { S.cond = $("#z-cond").value; if (!R) return; termTable.resetPage(); renderTerms(); renderDist(); });
    $$("#z-pre .chart-tab").forEach((b) => b.addEventListener("click", () => { S.preTab = b.dataset.tab; if (R) renderPreChart(); }));

    $$("#z-terms .mode-tab").forEach((b) => b.addEventListener("click", () => { termMode = b.dataset.mode; if (!R) return; termTable.resetSort(); renderTerms(); }));
    ["#z-terms-search", "#z-terms-mincf"].forEach((s) => $(s).addEventListener("input", () => { if (!R) return; termTable.resetPage(); renderTerms(); }));
    $("#z-terms-apply").addEventListener("click", () => { if (R) { termTable.resetPage(); renderTerms(); } });
    $("#z-terms-reset").addEventListener("click", () => { $("#z-terms-input").value = DEFAULT_TERMS; if (R) { termTable.resetPage(); renderTerms(); } });
    $("#z-csv-terms").addEventListener("click", () => R && termTable.csv(`terms_${termMode}_${S.cond}.csv`));
    $("#z-csv-cmp").addEventListener("click", () => R && downloadCSV("preprocessing_A-D.csv", ["指標"].concat(COND_KEYS.map((k) => condLabel(k))),
      compareMetrics().map(([name, , raw]) => [name.replace(/<[^>]+>/g, "")].concat(COND_KEYS.map((k) => raw(C(k)))))));

    $$("#z-dist .scale-tab").forEach((b) => b.addEventListener("click", () => { S.scale = b.dataset.scale; if (R) renderDist(); }));
    $("#z-linN").addEventListener("change", () => { S.linN = parseInt($("#z-linN").value, 10); if (R) renderDist(); });
    $("#z-pair").addEventListener("change", () => { S.pair = $("#z-pair").checked; if (R) renderDist(); else $("#z-pair-selects").hidden = !S.pair; });
    $("#z-pairL").addEventListener("change", () => { S.pairL = $("#z-pairL").value; if (R) renderDist(); });
    $("#z-pairR").addEventListener("change", () => { S.pairR = $("#z-pairR").value; if (R) renderDist(); });
    $("#z-showbounds").addEventListener("change", () => { S.showBounds = $("#z-showbounds").checked; if (R) renderDist(); });
    $("#z-csv-reg").addEventListener("click", () => {
      if (!R) return;
      const rows = [];
      distConds().forEach((k) => [["全部詞彙", C(k).fitAll], ["排除 hapax", C(k).fitNoHapax]].forEach(([name, f]) =>
        rows.push([condLabel(k), name, f.points, f.slope.toFixed(4), f.intercept.toFixed(4), f.k.toFixed(4), f.r2.toFixed(4), f.rmse.toFixed(4)])));
      downloadCSV("zipf_regression.csv", ["條件", "迴歸範圍", "詞數", "Slope", "Intercept", "Zipf exponent k", "R2", "RMSE"], rows);
    });
    $("#z-csv-seg").addEventListener("click", () => {
      if (!R || !S._segRows) return;
      const rows = S._segRows(false).concat(S._segRows(true)).map(({ k, s, share }) => [k, s.name, s.n ? `${s.from}-${s.to}` : "", s.n, pct(share),
        s.local ? s.local.k.toFixed(4) : "", s.local ? s.local.r2.toFixed(4) : "", d4(s.resid.rmse), d4(s.resid.bias)]);
      downloadCSV(`zipf_segments_df${S.dfPct}_cf${S.cfMax}.csv`, ["條件", "區段", "排名範圍", "詞數", "佔總 token", "局部 k", "局部 R2", "殘差 RMSE", "平均殘差"], rows);
    });

    // 區段門檻
    const onThreshold = () => {
      let p = parseFloat($("#z-dfpct").value), m = parseInt($("#z-cfmax").value, 10);
      if (!Number.isFinite(p)) p = 30;
      if (!Number.isFinite(m)) m = 2;
      S.dfPct = Math.min(100, Math.max(0, p));
      S.cfMax = Math.max(0, m);
      $("#z-dfpct").value = S.dfPct;
      $("#z-cfmax").value = S.cfMax;
      if (R) renderDist();
    };
    $("#z-dfpct").addEventListener("change", onThreshold);
    $("#z-cfmax").addEventListener("change", onThreshold);
    $("#z-threshold-reset").addEventListener("click", () => { $("#z-dfpct").value = 30; $("#z-cfmax").value = 2; onThreshold(); });

    // 詞幹還原合併實例
    const mm = $("#merge-modal");
    $("#z-merge-open").addEventListener("click", () => { if (!R) return; $("#merge-search").value = ""; renderMerges(); mm.showModal(); });
    $("#merge-close").addEventListener("click", () => mm.close());
    mm.addEventListener("click", (e) => { if (e.target === mm) mm.close(); });
    $("#merge-search").addEventListener("input", () => { if (R) renderMerges(); });
  }

  document.addEventListener("DOMContentLoaded", init);
  global.ZipfReport = { render };
})(window);
