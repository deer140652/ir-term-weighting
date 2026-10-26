/*
 * app.js
 * ------
 * 載入預先建好的範例語料庫（web/data/corpus.json），並讓使用者直接在瀏覽器
 * 上傳 PubMed/PMC XML 檔案（由 xml-parser.js 在前端解析——檔案不會離開瀏覽器，
 * 也沒有伺服器可以接收它），每次文件集合改變時都用 ir-core.js 即時重新建立
 * TF-IDF 反向索引。搜尋時以餘弦相似度為每篇文獻評分，並渲染排序、標示關鍵字
 * 的結果、語料庫統計儀表板，以及即時的句子偵測小工具。
 */
(function () {
  "use strict";


  let BASE_DOCS = [];      // 來自 web/data/corpus.json（隨網站一起發布的範例語料）
  let UPLOADED_DOCS = [];  // 使用者匯入、在瀏覽器端解析出來的文獻，存在 IndexedDB
  let ALL_DOCS = [];
  let DOC_BY_ID = {};
  // 詞項統計（tf、df、文件長度）：摘要、標題＋摘要各一份，只在文件集合改變時重算
  let STATS_ABSTRACT = IRCore.buildTermStats([]);
  let STATS_WITH_TITLE = IRCore.buildTermStats([]);
  // 依「範圍 × TF × IDF」快取的加權索引（切換權重方法時不必重新斷詞）
  let INDEX_CACHE = new Map();
  // 目前搜尋使用的權重方法：預設為 log TF × (IDF+1)、L2 正規化（原本系統的設定）
  let WEIGHTING = { tf: "log", idf: "smooth", norm: "l2" };
  let INCLUDE_TITLE = false; // 搜尋框旁邊「包含標題」勾選框的狀態
  let CORPUS_STATS = { num_documents: 0, total_words: 0, total_sentences: 0, total_characters: 0, vocabulary_size: 0 };
  let LAST_MATCHED_TERMS = []; // stems from the most recent search, used to highlight the full-text modal

  // ---- 新增：拼字校正 / 模糊比對 / 分析模組共用狀態 ----
  let SPELL_ABSTRACT = new EditDistance.SpellCorrector();   // 字典：摘要中出現過的字
  let SPELL_WITH_TITLE = new EditDistance.SpellCorrector(); // 字典：標題＋摘要中出現過的字
  let REMOVED_BASE = new Set(); // 被刪除的基礎語料文獻 id（存在 IndexedDB）
  let BASE_SIGNATURE = null;    // corpus.json 的簽章，用來確認預設模型是否對應這份語料
  let FUZZY_INFO = new Map();   // 最近一次搜尋中「部分比對」命中的詞幹 -> { queryWord, queryStem, distance }
  let FUZZY = false;          // 「模糊比對」勾選框
  let SPELL_CHECK = true;     // 「拼字校正」勾選框
  let CORPUS_READY = false;
  const CORPUS_LISTENERS = [];
  const STATS_CACHE = new WeakMap(); // doc 物件 -> 摘要統計（避免大型語料重複計算）

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 目前生效的索引：依「包含標題」勾選狀態，在兩套預先建好的索引間切換
  function getStats(scope) {
    return scope === "title" ? STATS_WITH_TITLE : STATS_ABSTRACT;
  }
  function getIndex(scope, scheme) {
    const key = `${scope}|${scheme.tf}|${scheme.idf}`;
    let ix = INDEX_CACHE.get(key);
    if (!ix) {
      ix = IRCore.buildWeightedIndex(getStats(scope), scheme);
      INDEX_CACHE.set(key, ix);
    }
    return ix;
  }
  function activeScope() { return INCLUDE_TITLE ? "title" : "abstract"; }
  function activeIndex() {
    return getIndex(activeScope(), WEIGHTING);
  }
  function activeSpeller() {
    return INCLUDE_TITLE ? SPELL_WITH_TITLE : SPELL_ABSTRACT;
  }
  // 搜尋範圍內的文字（與索引、命中位置、文章視窗的句子編號一致）
  function searchScopeText(doc) {
    return INCLUDE_TITLE ? IRCore.joinWithPeriod(doc.title, doc.abstract || "") : (doc.abstract || "");
  }

  // 基礎語料庫（web/data/corpus.json）：為了縮小檔案，只存必要欄位，
  // 其餘欄位（full_text、abstract_sections…）在這裡補回。
  async function loadBaseCorpus() {
    const res = await fetch("data/corpus.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    BASE_SIGNATURE = data.signature || null;
    BASE_DOCS = (data.documents || []).map((d) => Object.assign({
      pmcid: "", journal: "", year: "", authors: [], keywords: [], body_paragraphs: [],
    }, d, {
      full_text: d.full_text || IRCore.joinWithPeriod(d.title || "", d.abstract || ""),
      abstract_sections: d.abstract_sections || (d.abstract ? [{ title: "", text: d.abstract }] : []),
      is_base: true,
    }));
  }

  // 使用者匯入的文獻與刪除紀錄存在 IndexedDB（見 storage.js）
  async function loadFromStorage() {
    await IRStorage.migrateLegacy();
    const [uploads, removed] = await Promise.all([IRStorage.get("uploads"), IRStorage.get("removedBase")]);
    UPLOADED_DOCS = Array.isArray(uploads) ? uploads : [];
    REMOVED_BASE = new Set(Array.isArray(removed) ? removed : []);
  }

  function persistUploads() {
    IRStorage.set("uploads", UPLOADED_DOCS);
  }
  function persistRemovedBase() {
    IRStorage.set("removedBase", Array.from(REMOVED_BASE));
  }
  function activeBaseDocs() {
    return BASE_DOCS.filter((d) => !REMOVED_BASE.has(d.id));
  }
  function isBaseIntact() {
    return BASE_DOCS.length > 0 && activeBaseDocs().length === BASE_DOCS.length;
  }

  // ----------------------------------------------------------------
  // 每當文件集合改變時（上傳／移除），重建整個記憶體中的索引
  // ----------------------------------------------------------------
  // 語料庫總覽只算摘要（不含標題），符合作業「只需要比對摘要」的範圍——
  // 跟搜尋時「包含標題」那個開關是分開的兩件事，這裡固定不算標題。
  function abstractStats(doc) {
    let st = STATS_CACHE.get(doc);
    if (!st) {
      st = IRCore.computeStats(doc.abstract || "");
      STATS_CACHE.set(doc, st);
    }
    return st;
  }

  // 建立拼字校正字典：語料中所有（非停用詞）字的出現次數
  function buildSpellDict(texts) {
    const freq = new Map();
    texts.forEach((t) => {
      IRCore.removeStopwords(IRCore.expandHyphenatedTokens(IRCore.tokenize(t || ""))).forEach((w) => {
        freq.set(w, (freq.get(w) || 0) + 1);
      });
    });
    const sc = new EditDistance.SpellCorrector();
    sc.build(freq);
    return sc;
  }

  function rebuildAll() {
    ALL_DOCS = activeBaseDocs().concat(UPLOADED_DOCS);
    DOC_BY_ID = {};
    ALL_DOCS.forEach((d) => { DOC_BY_ID[d.id] = d; });

    // 建兩套獨立的索引：TF-IDF 的 idf 值取決於「整個語料庫」的範圍，所以
    // 不能只建一套索引、搜尋時再挑要不要看標題——那樣 idf 會算錯。摘要版跟
    // 標題+摘要版分開各自建一次，搜尋時依照「包含標題」的勾選狀態去選用
    // 對應的那一套（見 activeIndex()）。
    STATS_ABSTRACT = IRCore.buildTermStats(ALL_DOCS.map((d) => ({ id: d.id, full_text: d.abstract || "" })));
    STATS_WITH_TITLE = IRCore.buildTermStats(ALL_DOCS.map((d) => ({ id: d.id, full_text: d.full_text })));
    INDEX_CACHE = new Map();

    CORPUS_STATS = {
      num_documents: ALL_DOCS.length,
      total_words: ALL_DOCS.reduce((s, d) => s + abstractStats(d).num_words, 0),
      total_sentences: ALL_DOCS.reduce((s, d) => s + abstractStats(d).num_sentences, 0),
      total_characters: ALL_DOCS.reduce((s, d) => s + abstractStats(d).num_characters, 0),
      vocabulary_size: Object.keys(getStats(activeScope()).df).length,
    };

    SPELL_ABSTRACT = buildSpellDict(ALL_DOCS.map((d) => d.abstract || ""));
    SPELL_WITH_TITLE = buildSpellDict(ALL_DOCS.map((d) => d.full_text || ""));

    const hintEl = $("#example-chips-wrap");
    if (hintEl) hintEl.hidden = ALL_DOCS.length > 0;

    CORPUS_READY = true;
    CORPUS_LISTENERS.forEach((fn) => { try { fn(ALL_DOCS); } catch (e) { console.error(e); } });
  }

  // ----------------------------------------------------------------
  // 拼字校正：查詢詞的詞幹不在索引中 → 以編輯距離找語料中最接近的字
  // ----------------------------------------------------------------
  function correctQuery(queryText) {
    const words = queryText.trim().split(/\s+/).filter(Boolean);
    const changes = [];
    const unknown = [];
    const speller = activeSpeller();
    const out = words.map((w) => {
      if (w.length > 1 && w.endsWith("*")) return w;
      const toks = IRCore.tokenize(w);
      if (toks.length !== 1) return w;
      const t = toks[0];
      if (IRCore.STOPWORDS.has(t) || t.length < 3) return w;
      if (activeIndex().idf[IRCore.stem(t)] !== undefined) return w;
      const cand = speller.correct(t);
      if (cand) {
        changes.push({ from: t, to: cand.word, distance: cand.distance, freq: cand.freq });
        return cand.word;
      }
      unknown.push(t);
      return w;
    });
    return { text: out.join(" "), changes, unknown };
  }

  // 依長度分桶的索引詞表（模糊比對用），快取在索引物件上
  function indexTermsByLength(index) {
    if (!index._byLen) {
      index._byLen = new Map();
      Object.keys(index.idf).forEach((t) => {
        if (!index._byLen.has(t.length)) index._byLen.set(t.length, []);
        index._byLen.get(t.length).push(t);
      });
    }
    return index._byLen;
  }

  // ----------------------------------------------------------------
  // 搜尋：TF-IDF 向量空間模型 + 餘弦相似度
  // ----------------------------------------------------------------
  function scoreQuery(queryText) {
    // PubMed-style wildcard/truncation search: a word ending in "*" expands
    // to every indexed stem that STARTS WITH the text before the "*" (e.g.
    // "confirm*" matches confirm/confirmed/confirms/confirming), instead of
    // requiring an exact stem match. Words without "*" go through the normal
    // tokenize -> stopword-removal -> stem pipeline as before.
    const rawWords = queryText.trim().split(/\s+/).filter(Boolean);
    const wildcardWords = rawWords.filter((w) => w.length > 1 && w.endsWith("*"));
    const normalWordsText = rawWords.filter((w) => !(w.length > 1 && w.endsWith("*"))).join(" ");

    const rawTokens = IRCore.tokenize(normalWordsText);
    // NOTE: deliberately NOT expanding hyphenated query terms here (unlike
    // the document side in ir-core.js's computeStats) — a search for
    // "pre-covid" should stay specific to that compound, not silently
    // broaden into also matching every standalone "covid". Expansion only
    // happens when INDEXING documents, so a plain "covid" search can still
    // find "pre-COVID-19" inside a document, without the reverse happening.
    const qTerms = IRCore.stemAll(IRCore.removeStopwords(rawTokens));
    const stopwordsFound = rawTokens.filter((t) => IRCore.STOPWORDS.has(t));

    const qCounts = {};
    qTerms.forEach((t) => { qCounts[t] = (qCounts[t] || 0) + 1; });

    const qWeights = {};
    const matchedTerms = new Set();
    for (const term in qCounts) {
      const idf = activeIndex().idf[term];
      if (idf === undefined) continue;
      matchedTerms.add(term);
      // 查詢向量與文件使用同一套 TF／IDF 方法
      qWeights[term] = IRCore.tfWeight(qCounts[term], WEIGHTING.tf) * idf;
    }

    // 模糊比對（partial matching）：以 DP 編輯距離把每個查詢詞幹擴展到
    // 索引中「距離 ≤ k」的詞幹，權重乘上 1/(1+距離)，距離越遠權重越低。
    const fuzzyExpansions = [];
    // 查詢詞幹 -> 使用者輸入的原始字（顯示「部分比對」時用）
    const surfaceOf = {};
    IRCore.removeStopwords(rawTokens).forEach((w) => { surfaceOf[IRCore.stem(w)] = w; });
    if (FUZZY) {
      const byLen = indexTermsByLength(activeIndex());
      Array.from(new Set(qTerms)).forEach((q) => {
        const k = EditDistance.defaultMaxDist(q.length);
        if (k === 0) return;
        const cands = [];
        for (let L = q.length - k; L <= q.length + k; L++) {
          (byLen.get(L) || []).forEach((t) => {
            if (t === q) return;
            const d = EditDistance.distance(q, t, k, true); // 含相鄰交換
            if (d <= k) cands.push({ query: q, term: t, distance: d });
          });
        }
        cands.sort((a, b) => a.distance - b.distance || activeIndex().idf[a.term] - activeIndex().idf[b.term]);
        cands.slice(0, 10).forEach((c) => {
          const w = activeIndex().idf[c.term] / (1 + c.distance);
          qWeights[c.term] = Math.max(qWeights[c.term] || 0, w);
          matchedTerms.add(c.term);
          fuzzyExpansions.push(Object.assign(c, { queryWord: surfaceOf[c.query] || c.query }));
        });
      });
    }

    // Expand each "prefix*" word into every matching indexed stem.
    const expandedWildcardTerms = [];
    wildcardWords.forEach((w) => {
      const prefixTokens = IRCore.tokenize(w.slice(0, -1)); // strip trailing "*"
      const prefix = prefixTokens.join("");
      if (!prefix) return;
      Object.keys(activeIndex().idf)
        .filter((term) => term.startsWith(prefix))
        .forEach((term) => {
          matchedTerms.add(term);
          expandedWildcardTerms.push(term);
          // treat as if the user typed this exact matching word once
          const w2 = activeIndex().idf[term]; // log(1) tf-weight = 1 * idf
          qWeights[term] = Math.max(qWeights[term] || 0, w2);
        });
    });

    if ((qTerms.length === 0 || Object.keys(qWeights).length === 0) && expandedWildcardTerms.length === 0) {
      return {
        results: [], matchedTerms: [],
        rawTokenCount: rawTokens.length,
        allStopwords: wildcardWords.length === 0 && rawTokens.length > 0 && stopwordsFound.length === rawTokens.length,
        stopwordsFound: Array.from(new Set(stopwordsFound)),
        hadWildcard: wildcardWords.length > 0,
        fuzzyExpansions,
      };
    }

    // 計分：L2 正規化 → cosine similarity；不正規化 → 內積（dot product）
    const results = IRCore.scoreVector(qWeights, activeIndex(), WEIGHTING.norm)
      .map((r) => ({ doc: DOC_BY_ID[r.id], score: r.score }))
      .filter((r) => r.doc);
    return { results, matchedTerms: Array.from(matchedTerms), fuzzyExpansions };
  }

  // ----------------------------------------------------------------
  // 渲染輔助函式
  // ----------------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function isHighlightMatch(word, matchedStems) {
    // Used only to decide WHETHER a token has any match at all (e.g. for
    // picking where to center a snippet) — see renderToken() below for the
    // actual character-level rendering, which only marks the specific
    // matching segment(s) of a hyphenated compound, not the whole thing.
    const w = word.toLowerCase();
    if (matchedStems.includes(IRCore.stem(w))) return true;
    if (w.includes("-")) {
      return w.split("-").some((part) => part.length > 1 && matchedStems.includes(IRCore.stem(part)));
    }
    return false;
  }

  function countMatches(text, matchedStems) {
    if (!text || !matchedStems || matchedStems.length === 0) return 0;
    const re = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let count = 0, mm;
    while ((mm = re.exec(text)) !== null) {
      if (isHighlightMatch(mm[0], matchedStems)) count++;
    }
    return count;
  }

  function renderToken(word, matchedStems) {
    // If the WHOLE token's own stem matches (covers plain words, and a
    // hyphenated query like "pre-covid" matching that exact compound),
    // mark the whole token. Otherwise, for a hyphenated word, check each
    // "-"-separated segment independently and mark ONLY the segment(s)
    // that match — e.g. searching "covid" highlights just "COVID" inside
    // "pre-COVID-19", leaving "pre" as plain text.
    const wLower = word.toLowerCase();
    const whole = IRCore.stem(wLower);
    if (matchedStems.includes(whole)) {
      return `<mark${markClass(whole)}>${escapeHtml(word)}</mark>`;
    }
    if (word.includes("-")) {
      const parts = word.split("-");
      let anyMatch = false;
      const rendered = parts.map((part) => {
        const ps = IRCore.stem(part.toLowerCase());
        const isMatch = part.length > 1 && matchedStems.includes(ps);
        if (isMatch) anyMatch = true;
        return isMatch ? `<mark${markClass(ps)}>${escapeHtml(part)}</mark>` : escapeHtml(part);
      });
      if (anyMatch) return rendered.join("-");
    }
    return escapeHtml(word);
  }

  // 完全比對用一般反白；部分比對（模糊比對擴展出來的詞）用另一種樣式
  function markClass(stem) {
    const f = FUZZY_INFO.get(stem);
    return f ? ` class="fz" title="部分比對：${escapeHtml(f.queryWord)} ≈ 此字（詞幹 ${escapeHtml(f.queryStem)} ↔ ${escapeHtml(stem)}，編輯距離 ${f.distance}）"` : "";
  }

  function highlightSnippet(text, matchedStems, maxLen) {
    maxLen = maxLen || 320;
    const tokenRe = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let m, hitIndex = -1;
    while ((m = tokenRe.exec(text)) !== null) {
      if (isHighlightMatch(m[0], matchedStems)) {
        hitIndex = m.index;
        break;
      }
    }
    let start = 0;
    if (hitIndex > maxLen / 2) start = hitIndex - Math.floor(maxLen / 2);
    let snippet = text.slice(start, start + maxLen);
    if (start > 0) snippet = "…" + snippet;
    if (start + maxLen < text.length) snippet = snippet + "…";

    let html = "";
    let last = 0;
    const re2 = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let mm;
    while ((mm = re2.exec(snippet)) !== null) {
      const word = mm[0];
      html += escapeHtml(snippet.slice(last, mm.index));
      html += renderToken(word, matchedStems);
      last = mm.index + word.length;
    }
    html += escapeHtml(snippet.slice(last));
    return html;
  }

  function highlightFullText(text, matchedStems) {
    // Like highlightSnippet, but marks every match across the WHOLE text
    // with no cropping — used in the full-article modal.
    if (!text) return "";
    if (!matchedStems || matchedStems.length === 0) return escapeHtml(text);
    let html = "";
    let last = 0;
    const re = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const word = mm[0];
      html += escapeHtml(text.slice(last, mm.index));
      html += renderToken(word, matchedStems);
      last = mm.index + word.length;
    }
    html += escapeHtml(text.slice(last));
    return html;
  }

  // 回傳某個字（可能是連字號複合詞）命中了哪些查詢詞幹
  function hitStemsOf(word, stemSet) {
    const w = word.toLowerCase();
    const whole = IRCore.stem(w);
    if (stemSet.has(whole)) return [whole];
    if (w.includes("-")) {
      return w.split("-").filter((p) => p.length > 1).map((p) => IRCore.stem(p)).filter((st) => stemSet.has(st));
    }
    return [];
  }

  // 找出每個命中詞幹在文件中的位置：S = 第幾句（與文章視窗「句子切分結果」
  // 的編號一致），W = 該句中第幾個字（以空白分隔計算）。
  function locateHits(text, matchedStems) {
    const stemSet = new Set(matchedStems);
    const byStem = new Map();
    const tokRe = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    IRCore.splitSentences(text || "").forEach((sent, si) => {
      const chunks = sent.match(/\S+/g) || [];
      chunks.forEach((chunk, wi) => {
        let m;
        tokRe.lastIndex = 0;
        while ((m = tokRe.exec(chunk)) !== null) {
          hitStemsOf(m[0], stemSet).forEach((st) => {
            if (!byStem.has(st)) byStem.set(st, { stem: st, forms: new Map(), positions: [] });
            const e = byStem.get(st);
            const surface = m[0].toLowerCase();
            e.forms.set(surface, (e.forms.get(surface) || 0) + 1);
            e.positions.push({ s: si + 1, w: wi + 1 });
          });
        }
      });
    });
    return Array.from(byStem.values());
  }

  // 每篇結果的命中位置，分成「完全比對」與「部分比對」兩行
  function renderHitLocations(doc, matchedTerms) {
    const hits = locateHits(searchScopeText(doc), matchedTerms);
    if (!hits.length) return "";
    const MAX = 6;
    const posText = (h) => {
      const pos = h.positions.slice(0, MAX).map((p) => `S${p.s}·W${p.w}`).join(", ");
      return pos + (h.positions.length > MAX ? ` …+${h.positions.length - MAX}` : "");
    };
    const exact = [], partial = [];
    hits.forEach((h) => {
      const form = Array.from(h.forms.entries()).sort((a, b) => b[1] - a[1])[0][0];
      const f = FUZZY_INFO.get(h.stem);
      if (f) {
        // 顯示的距離為「使用者輸入的字」與「文件中實際的字」之間的編輯距離
        const d = EditDistance.distance(f.queryWord.toLowerCase(), form, null, true);
        partial.push(`<span class="hl-term"><mark class="fz">${escapeHtml(form)}</mark> ≈ ${escapeHtml(f.queryWord)}<span class="ed-badge">編輯距離 ${d}</span> ×${h.positions.length}：<span class="hl-pos">${posText(h)}</span></span>`);
      } else {
        exact.push(`<span class="hl-term"><mark>${escapeHtml(form)}</mark> ×${h.positions.length}：<span class="hl-pos">${posText(h)}</span></span>`);
      }
    });
    return `<div class="hit-locations" title="S = 第幾句（對應文章視窗中的句子編號），W = 句中第幾個字">
      ${exact.length ? `<div class="hl-row"><span class="hl-label">完全比對</span>${exact.join("")}</div>` : ""}
      ${partial.length ? `<div class="hl-row"><span class="hl-label fz-label">部分比對</span>${partial.join("")}</div>` : ""}
    </div>`;
  }

  // 搜尋結果上方的提示：拼字校正、模糊比對擴展、Word2Vec 語意相近詞
  function renderSearchNotes(originalQuery, correction, fuzzyExpansions, noCorrect) {
    const el = $("#search-notes");
    if (!el) return;
    let html = "";
    if (correction && correction.changes.length && !noCorrect) {
      const parts = correction.changes.map((c) =>
        `<del>${escapeHtml(c.from)}</del> → <strong>${escapeHtml(c.to)}</strong><span class="ed-badge">編輯距離 ${c.distance}</span>`).join("　");
      html += `<p class="spell-banner">拼字校正：${parts}　已改用校正後的查詢顯示結果。
        <button type="button" class="link-btn inline" id="search-original">仍要搜尋原始輸入「${escapeHtml(originalQuery)}」</button></p>`;
    } else if (noCorrect) {
      const sugg = correctQuery(originalQuery);
      if (sugg.changes.length) {
        html += `<p class="spell-banner">您是不是要找：<button type="button" class="link-btn inline" id="search-suggest">${escapeHtml(sugg.text)}</button>？</p>`;
      }
    }
    if (correction && correction.unknown.length && !noCorrect) {
      html += `<p class="spell-banner muted">「${correction.unknown.map(escapeHtml).join("、")}」不在語料庫詞彙中，且找不到編輯距離夠近的字可校正。</p>`;
    }
    if (fuzzyExpansions && fuzzyExpansions.length) {
      const chips = fuzzyExpansions.map((f) =>
        `<span class="fuzzy-chip">${escapeHtml(f.query)} ≈ ${escapeHtml(f.term)}<small>d=${f.distance}</small></span>`).join("");
      html += `<div class="fuzzy-line"><span class="notes-label">模糊比對擴展（詞幹）</span>${chips}<span class="notes-label">— 部分比對的字以 <mark class="fz">虛線框</mark> 標示</span></div>`;
    }
    el.innerHTML = html;
    el.hidden = !html;
    const orig = $("#search-original");
    if (orig) orig.addEventListener("click", () => renderResults(originalQuery, { noCorrect: true }));
    const sug = $("#search-suggest");
    if (sug) sug.addEventListener("click", () => { $("#search-input").value = sug.textContent; renderResults(sug.textContent); });
  }

  function renderResults(queryText, opts) {
    opts = opts || {};
    const resultsEl = $("#results");
    const countEl = $("#result-count");

    if (!queryText.trim()) {
      resultsEl.innerHTML = "";
      countEl.textContent = "";
      LAST_MATCHED_TERMS = [];
      FUZZY_INFO = new Map();
      renderSearchNotes("", null, null, false);
      renderCorpusOverview();
      return;
    }

    const originalQuery = queryText;
    let correction = null;
    if (SPELL_CHECK && !opts.noCorrect) {
      correction = correctQuery(queryText);
      if (correction.changes.length) queryText = correction.text;
    }

    const { results, matchedTerms, allStopwords, stopwordsFound, rawTokenCount, hadWildcard, fuzzyExpansions } = scoreQuery(queryText);
    // 只有「不是查詢詞本身」的擴展詞才算部分比對
    const exactStems = new Set(IRCore.stemAll(IRCore.removeStopwords(IRCore.tokenize(queryText))));
    FUZZY_INFO = new Map();
    (fuzzyExpansions || []).forEach((f) => {
      if (!exactStems.has(f.term) && !FUZZY_INFO.has(f.term)) {
        FUZZY_INFO.set(f.term, { queryWord: f.queryWord, queryStem: f.query, distance: f.distance });
      }
    });
    renderSearchNotes(originalQuery, correction, fuzzyExpansions, !!opts.noCorrect);

    countEl.textContent = results.length
      ? `符合「${queryText}」的文獻：${results.length} / ${ALL_DOCS.length} 篇｜權重：${IRCore.schemeLabel(WEIGHTING)}`
      : `沒有符合「${queryText}」的文獻`;

    if (results.length === 0) {
      if (allStopwords) {
        resultsEl.innerHTML = `<p class="empty-state">「${stopwordsFound.map((w) => `<code>${escapeHtml(w)}</code>`).join("、")}」是<strong>停用詞（stopword）</strong>——像 and、is、the、of 這類字幾乎每篇文獻都會出現，對檢索沒有鑑別度，系統會依照標準 IR 前處理流程自動忽略，不納入比對。請改搜尋有實際意義的關鍵字，例如疾病、藥物、症狀、方法等名詞。</p>`;
      } else if (hadWildcard) {
        resultsEl.innerHTML = `<p class="empty-state">沒有任何索引詞是以這個字首開頭的。萬用字元 <code>*</code> 是比對「已建索引的詞幹」，試試更短的字首，或先確認語料庫裡有沒有相關字詞。</p>`;
      } else if (rawTokenCount === 0) {
        resultsEl.innerHTML = `<p class="empty-state">請輸入至少一個英文字母組成的關鍵字。</p>`;
      } else {
        resultsEl.innerHTML = `<p class="empty-state">沒有符合的文獻。請嘗試更廣泛的關鍵字；系統支援詞幹比對，也可在字尾加 <code>*</code> 進行前綴搜尋，例如 <code>con*</code>。</p>`;
      }
      LAST_MATCHED_TERMS = matchedTerms;
      return;
    }
    LAST_MATCHED_TERMS = matchedTerms;
    LAST_RESULTS = { results, matchedTerms, maxScore: results[0].score || 1, norm: WEIGHTING.norm };
    CURRENT_PAGE = 1;
    renderResultPage(false);
  }

  // 搜尋結果分頁：每頁 PAGE_SIZE 筆，頁面高度固定，不會因為結果多而越拉越長
  let PAGE_SIZE = 10;
  let CURRENT_PAGE = 1;
  let LAST_RESULTS = { results: [], matchedTerms: [], maxScore: 1, norm: "l2" };

  function renderResultCard({ doc, score }, i, matchedTerms) {
      const snippet = highlightSnippet(doc.abstract, matchedTerms);
      // cosine 介於 0–1，直接當比例；內積沒有上限，改以第一名為 100%
      const isCos = LAST_RESULTS.norm !== "none";
      const pct = Math.max(0, Math.min(100, Math.round((isCos ? score : score / (LAST_RESULTS.maxScore || 1)) * 100)));
      const titleHtml = INCLUDE_TITLE ? highlightFullText(doc.title, matchedTerms) : escapeHtml(doc.title);
      const hitText = INCLUDE_TITLE ? `${doc.title} ${doc.abstract || ""}` : (doc.abstract || "");
      const hitCount = countMatches(hitText, matchedTerms);
      const authors = doc.authors || [];
      const authorDisplay = authors.length > 3
        ? `${authors.slice(0, 3).join(", ")} et al.`
        : (authors.join(", ") || "—");
        
      return `
        <article class="result-card" style="--rank-delay:${(i % PAGE_SIZE) * 40}ms">
          <div class="result-rank">#${i + 1}</div>
          <div class="result-body">
            <h3>${titleHtml}${/* doc.uploaded ? ' <span class="uploaded-tag">已上傳</span>' : "" */ ""}${doc.is_generic_xml ? ' <span class="generic-tag">一般 XML（非期刊格式）</span>' : ""}</h3>
            <p class="result-meta">${escapeHtml(doc.journal || "—")} · ${escapeHtml(doc.year || "—")} · ${escapeHtml(authorDisplay)}</p>
            <p class="result-ids"><span class="pmid">PMID: ${escapeHtml(doc.pmid || "—")}</span>${doc.pmcid ? `<span class="pmid">PMCID: ${escapeHtml(doc.pmcid)}</span>` : ""}</p>
            <p class="result-snippet">${snippet}</p>
            ${renderHitLocations(doc, matchedTerms)}
            <div class="result-footer">
              <span class="score-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
              <span class="score-label"><strong class="score-num">${isCos ? "cosine" : "內積"} ${score.toFixed(4)}</strong> · 命中 ${hitCount} 個關鍵字</span>
              <button class="link-btn" data-doc="${doc.id}">查看完整文章（標示命中關鍵字）→</button>
            </div>
          </div>
        </article>`;
  }

  // 頁碼列：第一頁、最後一頁、目前頁前後各 2 頁，其餘以 … 表示
  function pageNumbers(total, cur) {
    const set = new Set([1, total, cur - 2, cur - 1, cur, cur + 1, cur + 2]);
    const pages = Array.from(set).filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const out = [];
    pages.forEach((p, i) => {
      if (i && p - pages[i - 1] > 1) out.push("…");
      out.push(p);
    });
    return out;
  }

  function renderPager(total, totalPages) {
    const from = (CURRENT_PAGE - 1) * PAGE_SIZE + 1;
    const to = Math.min(total, CURRENT_PAGE * PAGE_SIZE);
    const btn = (p, label, disabled, current) =>
      `<button type="button" class="page-btn${current ? " current" : ""}" data-page="${p}" ${disabled ? "disabled" : ""} ${current ? 'aria-current="page"' : ""}>${label}</button>`;
    return `
      <nav class="pager" aria-label="搜尋結果分頁">
        <span class="pager-info">第 ${from.toLocaleString()}–${to.toLocaleString()} 筆，共 ${total.toLocaleString()} 筆</span>
        <span class="pager-pages">
          ${btn(CURRENT_PAGE - 1, "‹ 上一頁", CURRENT_PAGE === 1)}
          ${pageNumbers(totalPages, CURRENT_PAGE).map((p) => (p === "…" ? `<span class="page-gap">…</span>` : btn(p, p, false, p === CURRENT_PAGE))).join("")}
          ${btn(CURRENT_PAGE + 1, "下一頁 ›", CURRENT_PAGE === totalPages)}
        </span>
        <label class="pager-size">每頁
          <select class="page-size">${[10, 20, 50].map((n) => `<option value="${n}" ${n === PAGE_SIZE ? "selected" : ""}>${n}</option>`).join("")}</select> 筆</label>
      </nav>`;
  }

  function renderResultPage(scroll) {
    const resultsEl = $("#results");
    const { results, matchedTerms } = LAST_RESULTS;
    const total = results.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    CURRENT_PAGE = Math.min(Math.max(1, CURRENT_PAGE), totalPages);
    const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
    const cards = results.slice(start, start + PAGE_SIZE).map((r, k) => renderResultCard(r, start + k, matchedTerms)).join("");
    resultsEl.innerHTML = cards + (totalPages > 1 || total > 10 ? renderPager(total, totalPages) : "");
    if (scroll) {
      const anchor = $("#result-count");
      const top = anchor.getBoundingClientRect().top + window.scrollY - 60;
      window.scrollTo({ top, behavior: "smooth" });
    }
  }

  function rerenderCurrent() {
    renderResults($("#search-input").value);
  }

  // ----------------------------------------------------------------
  // 語料庫總覽儀表板
  // ----------------------------------------------------------------
  function renderCorpusOverview() {
    const cs = CORPUS_STATS;
    $("#stat-docs").textContent = cs.num_documents;
    $("#stat-words").textContent = cs.total_words.toLocaleString();
    $("#stat-sentences").textContent = cs.total_sentences.toLocaleString();
    $("#stat-vocab").textContent = cs.vocabulary_size.toLocaleString();

    const btn = $("#doc-stats-open");
    if (btn) {
      btn.textContent = `查看各文獻字數與句數（共 ${ALL_DOCS.length.toLocaleString()} 篇）→`;
      btn.disabled = ALL_DOCS.length === 0;
    }
    if ($("#doc-stats-modal").open) renderDocStatsList();

    $("#results").innerHTML = "";
    $("#result-count").textContent = "";
  }

  // ----------------------------------------------------------------
  // 文獻詳細視窗（完整統計 + 句子切分結果）
  // ----------------------------------------------------------------
  function openDocModal(docId) {
    const doc = DOC_BY_ID[docId];
    if (!doc) return;
    const modal = $("#doc-modal");
    const terms = LAST_MATCHED_TERMS;

    // Stats & sentence breakdown are computed fresh here (not from the
    // precomputed doc.stats/doc.sentences, which always include the
    // title) so they correctly follow the "搜尋時包含標題" toggle: with it
    // off, only the abstract is counted/listed; with it on, the title is
    // included in both the numbers and the sentence list.
    const statsSourceText = INCLUDE_TITLE ? IRCore.joinWithPeriod(doc.title, doc.abstract || "") : (doc.abstract || "");
    const s = IRCore.computeStats(statsSourceText);

    $("#doc-modal-title").innerHTML = INCLUDE_TITLE ? highlightFullText(doc.title, terms) : escapeHtml(doc.title);
    $("#doc-modal-meta").innerHTML = `${escapeHtml(doc.journal || "—")} · ${escapeHtml(doc.year || "—")} · ${escapeHtml((doc.authors || []).join(", ") || "—")}<br><span class="pmid">PMID: ${escapeHtml(doc.pmid || "—")}</span>${doc.pmcid ? `<span class="pmid">PMCID: ${escapeHtml(doc.pmcid)}</span>` : ""}`;
    $("#doc-modal-stats").innerHTML = [
      ["字元數", s.num_characters.toLocaleString()],
      ["字元數（不含空白）", s.num_characters_no_spaces.toLocaleString()],
      ["字數", s.num_words.toLocaleString()],
      ["句數", s.num_sentences.toLocaleString()],
      //["平均每句字數", s.avg_words_per_sentence],
      ["索引詞數（過濾停用詞後）", s.num_index_terms.toLocaleString()],
      ["唯一詞幹數", s.num_unique_stems.toLocaleString()],
    ].map(([label, val]) => `<div class="stat-chip"><span>${label}</span><strong>${val}</strong></div>`).join("");

    // full-text panel: abstract + every body paragraph, with the current
    // search's matched terms highlighted throughout (not just a snippet)
    const paras = (doc.body_paragraphs && doc.body_paragraphs.length) ? doc.body_paragraphs : [];
    const displayedText = (INCLUDE_TITLE ? [doc.title] : []).concat([doc.abstract]).concat(paras).join(" ");
    const hitCount = countMatches(displayedText, terms);

    $("#doc-modal-match-banner").innerHTML = terms.length
      ? `<span class="match-banner-count">${hitCount}</span> 個關鍵字命中處已標示：<mark>完全比對</mark>${FUZZY_INFO.size ? `、<mark class="fz">部分比對</mark>` : ""}${INCLUDE_TITLE ? "（含標題）" : ""}`
      : "";
    $("#doc-modal-match-banner").hidden = terms.length === 0;

    let fulltextHtml = "";
    if (doc.abstract_sections && doc.abstract_sections.length) {
      doc.abstract_sections.forEach((sec) => {
        if (sec.title) {
          fulltextHtml += `<p class="doc-fulltext-abstract-label">${escapeHtml(sec.title)}</p>`;
        }
        fulltextHtml += `<p>${highlightFullText(sec.text, terms)}</p>`;
      });
    } else if (doc.abstract) {
      fulltextHtml += `<p>${highlightFullText(doc.abstract, terms)}</p>`;
    }
    if (paras.length) {
      fulltextHtml += `<p class="doc-fulltext-abstract-label">Content</p>`;
      fulltextHtml += paras.map((p) => `<p>${highlightFullText(p, terms)}</p>`).join("");
    }
    if (!fulltextHtml) {
      fulltextHtml = `<p class="empty-state small">這份文件沒有可顯示的內文。</p>`;
    }
    $("#doc-modal-fulltext").innerHTML = fulltextHtml;

    renderDocWeights(doc);

    $("#doc-modal-sentences").innerHTML = s.sentences
      .map((sent, i) => {
        const hit = terms.length && countMatches(sent, terms) > 0;
        return `<li${hit ? ' class="sent-hit"' : ""}><span class="sent-idx">S${i + 1}</span><span>${terms.length ? highlightFullText(sent, terms) : escapeHtml(sent)}</span></li>`;
      })
      .join("");
    modal.showModal();
  }

  // 文獻視窗中的「詞項權重向量」：列出這篇文件在目前權重方法下的向量，
  // 並並列 Raw TF、Log TF、IDF、IDF+1，方便對照
  function renderDocWeights(doc) {
    const el = $("#doc-modal-weights");
    if (!el) return;
    const scope = activeScope();
    const st = getStats(scope);
    const tf = st.docTF[doc.id];
    if (!tf) { el.innerHTML = ""; return; }
    const ix = activeIndex();
    const norm = ix.doc_norms[doc.id] || 1;
    const qset = new Set(LAST_MATCHED_TERMS);
    const N = st.N;
    const rows = Object.keys(tf).map((t) => ({
      t, tf: tf[t], df: st.df[t],
      logtf: IRCore.tfWeight(tf[t], "log"),
      idf: IRCore.idfWeight(N, st.df[t], "classic"),
      idfs: IRCore.idfWeight(N, st.df[t], "smooth"),
      w: ix.postings[t][doc.id],
    }));
    rows.sort((a, b) => b.w - a.w || b.tf - a.tf);
    const top = rows.slice(0, 15);
    const hits = rows.filter((r) => qset.has(r.t) && !top.includes(r));
    const f = (x, d) => x.toFixed(d === undefined ? 3 : d);
    const tr = (r) => `<tr${qset.has(r.t) ? ' class="changed"' : ""}><td><code>${escapeHtml(r.t)}</code></td>
      <td class="num">${r.tf}</td><td class="num">${f(r.logtf)}</td><td class="num">${r.df}</td>
      <td class="num">${f(r.idf)}</td><td class="num">${f(r.idfs)}</td>
      <td class="num"><strong>${f(r.w)}</strong></td><td class="num">${f(r.w / norm)}</td></tr>`;
    el.innerHTML = `
      <p class="lab-footnote">目前權重：<strong>${escapeHtml(IRCore.schemeLabel(WEIGHTING))}</strong>（${INCLUDE_TITLE ? "標題＋摘要" : "摘要"}）。
      共 ${rows.length} 個不同詞幹、${st.docLen[doc.id]} 個索引詞；向量 L2 長度 = ${f(norm)}。依目前權重由高到低列出前 15 個${hits.length ? "，以及本次查詢命中的詞" : ""}（查詢詞以底色標示）。</p>
      <div class="table-scroll"><table class="lab-table compact">
        <thead><tr><th>詞幹</th><th class="num">tf<br><small>Raw TF</small></th><th class="num">1+ln(tf)<br><small>Log TF</small></th><th class="num">df</th>
        <th class="num">ln(N/df)<br><small>IDF</small></th><th class="num">ln(N/df)+1<br><small>IDF+1</small></th><th class="num">目前權重</th><th class="num" title="= 目前權重 ÷ 向量 L2 長度（√ 這篇所有詞權重的平方和）">L2 正規化後權重</th></tr></thead>
        <tbody>${top.map(tr).join("")}${hits.length ? `<tr><td colspan="8" class="muted-num">⋯ 查詢命中的詞</td></tr>${hits.map(tr).join("")}` : ""}</tbody>
      </table></div>`;
  }

  // ----------------------------------------------------------------
  // 上傳面板：在瀏覽器端解析 PMC/JATS XML
  // ----------------------------------------------------------------
  // 右側「目前語料」摘要
  function renderUploadPanel() {
    const base = activeBaseDocs().length;
    const up = UPLOADED_DOCS.length;
    $("#corpus-summary").innerHTML = `目前共 <strong>${(base + up).toLocaleString()}</strong> 篇：預設語料 ${base.toLocaleString()}${BASE_DOCS.length ? ` / ${BASE_DOCS.length.toLocaleString()}` : ""} 篇、匯入 ${up.toLocaleString()} 篇`;
    if ($("#manage-modal").open) renderManageList();
  }

  // 文獻有變動時的共同後續處理
  function afterCorpusChange() {
    rebuildAll();
    renderUploadPanel();
    renderCorpusOverview();
    rerenderCurrent();
  }

  // ----------------------------------------------------------------
  // 彈出視窗：各文獻字數與句數
  // ----------------------------------------------------------------
  function docLabel(d) {
    const idParts = [];
    if (d.pmid) idParts.push("PMID " + d.pmid);
    if (d.pmcid) idParts.push(d.pmcid);
    return idParts.length ? idParts.join(" · ") : d.id;
  }

  function matchesFilter(d, q) {
    if (!q) return true;
    return (d.title || "").toLowerCase().includes(q) || (d.pmid || "").includes(q) ||
      (d.pmcid || "").toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
  }

  function renderDocStatsList() {
    const q = $("#doc-stats-search").value.trim().toLowerCase();
    const sort = $("#doc-stats-sort").value;
    let rows = ALL_DOCS.map((d, i) => ({ d, i, st: abstractStats(d) })).filter((r) => matchesFilter(r.d, q));
    const by = {
      "words-desc": (a, b) => b.st.num_words - a.st.num_words,
      "words-asc": (a, b) => a.st.num_words - b.st.num_words,
      "sent-desc": (a, b) => b.st.num_sentences - a.st.num_sentences,
      "sent-asc": (a, b) => a.st.num_sentences - b.st.num_sentences,
    }[sort];
    if (by) rows.sort(by);
    const max = Math.max(1, ...ALL_DOCS.map((d) => abstractStats(d).num_words));
    $("#doc-stats-count").textContent = `顯示 ${rows.length.toLocaleString()} / ${ALL_DOCS.length.toLocaleString()} 篇（字數、句數只計算摘要）`;
    $("#doc-stats-list").innerHTML = rows.length ? rows.map(({ d, st }) => `
      <button type="button" class="stats-row" data-doc="${escapeHtml(d.id)}">
        <span class="stats-row-head">
          <span class="stats-row-id">${escapeHtml(docLabel(d))}</span>
          <span class="stats-row-val">${st.num_words} 字 / ${st.num_sentences} 句</span>
        </span>
        <span class="stats-row-title">${escapeHtml(d.title || "")}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.round((st.num_words / max) * 100)}%"></span></span>
      </button>`).join("") : `<p class="empty-state small">沒有符合的文獻。</p>`;
  }

  function initDocStatsModal() {
    const modal = $("#doc-stats-modal");
    $("#doc-stats-open").addEventListener("click", () => {
      renderDocStatsList();
      modal.showModal();
    });
    $("#doc-stats-close").addEventListener("click", () => modal.close());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
    $("#doc-stats-search").addEventListener("input", renderDocStatsList);
    $("#doc-stats-sort").addEventListener("change", renderDocStatsList);
    $("#doc-stats-list").addEventListener("click", (e) => {
      const row = e.target.closest(".stats-row[data-doc]");
      if (row) openDocModal(row.dataset.doc);
    });
  }

  // ----------------------------------------------------------------
  // 彈出視窗：管理文獻（預設語料＋匯入文獻）
  // ----------------------------------------------------------------
  function manageRows() {
    const q = $("#manage-search").value.trim().toLowerCase();
    const src = $("#manage-source").value;
    const rows = [];
    if (src !== "upload") activeBaseDocs().forEach((d) => rows.push({ d, base: true }));
    if (src !== "base") UPLOADED_DOCS.forEach((d) => rows.push({ d, base: false }));
    return rows.filter((r) => matchesFilter(r.d, q));
  }

  const MANAGE_SELECTED = new Set();

  function renderManageList() {
    const rows = manageRows();
    // 已經不存在的勾選項目移除
    const alive = new Set(ALL_DOCS.map((d) => d.id));
    Array.from(MANAGE_SELECTED).forEach((id) => { if (!alive.has(id)) MANAGE_SELECTED.delete(id); });

    $("#manage-count").textContent = `顯示 ${rows.length.toLocaleString()} 篇｜目前語料共 ${ALL_DOCS.length.toLocaleString()} 篇（預設 ${activeBaseDocs().length.toLocaleString()}、匯入 ${UPLOADED_DOCS.length.toLocaleString()}）${REMOVED_BASE.size ? `｜已刪除預設語料 ${REMOVED_BASE.size.toLocaleString()} 篇` : ""}`;
    $("#manage-list").innerHTML = rows.length ? rows.map(({ d, base }) => `
      <li>
        <label class="manage-check"><input type="checkbox" data-id="${escapeHtml(d.id)}" ${MANAGE_SELECTED.has(d.id) ? "checked" : ""}></label>
        <span class="manage-main">
          <span class="manage-title">${escapeHtml(d.title || d.id)}</span>
          <span class="manage-meta"><span class="src-badge ${base ? "base" : "upload"}">${base ? "預設" : "匯入"}</span>${escapeHtml(docLabel(d))}</span>
        </span>
        <button type="button" class="remove-upload" data-id="${escapeHtml(d.id)}" aria-label="刪除" title="刪除這篇">×</button>
      </li>`).join("") : `<li class="empty-state small">沒有符合的文獻。</li>`;
    const visibleIds = rows.map((r) => r.d.id);
    const allChecked = visibleIds.length > 0 && visibleIds.every((id) => MANAGE_SELECTED.has(id));
    $("#manage-select-all").checked = allChecked;
    $("#manage-delete-selected").disabled = MANAGE_SELECTED.size === 0;
    $("#manage-delete-selected").textContent = `刪除勾選（${MANAGE_SELECTED.size.toLocaleString()}）`;
    $("#manage-restore").disabled = REMOVED_BASE.size === 0 && UPLOADED_DOCS.length === 0;
  }

  function removeDocs(ids) {
    const set = new Set(ids);
    let baseChanged = false, upChanged = false;
    BASE_DOCS.forEach((d) => { if (set.has(d.id) && !REMOVED_BASE.has(d.id)) { REMOVED_BASE.add(d.id); baseChanged = true; } });
    const before = UPLOADED_DOCS.length;
    UPLOADED_DOCS = UPLOADED_DOCS.filter((d) => !set.has(d.id));
    upChanged = UPLOADED_DOCS.length !== before;
    ids.forEach((id) => MANAGE_SELECTED.delete(id));
    if (baseChanged) persistRemovedBase();
    if (upChanged) persistUploads();
    if (baseChanged || upChanged) afterCorpusChange();
  }

  function clearAllDocs() {
    if (!ALL_DOCS.length) return;
    if (!confirm(`確定要刪除目前全部 ${ALL_DOCS.length.toLocaleString()} 篇文獻嗎？\n（之後可以用「恢復預設語料」還原 GLP-1 預設文獻）`)) return;
    BASE_DOCS.forEach((d) => REMOVED_BASE.add(d.id));
    UPLOADED_DOCS = [];
    MANAGE_SELECTED.clear();
    persistRemovedBase();
    persistUploads();
    afterCorpusChange();
  }

  function restoreDefaults() {
    if (!confirm("確定要恢復預設語料嗎？\n所有匯入的文獻都會被移除，Word2Vec 也會換回預設模型。")) return;
    REMOVED_BASE = new Set();
    UPLOADED_DOCS = [];
    MANAGE_SELECTED.clear();
    persistRemovedBase();
    persistUploads();
    afterCorpusChange();
    window.dispatchEvent(new CustomEvent("ir:restore-defaults"));
  }

  function initManageModal() {
    const modal = $("#manage-modal");
    $("#manage-open").addEventListener("click", () => {
      renderManageList();
      modal.showModal();
    });
    $("#manage-close").addEventListener("click", () => modal.close());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
    $("#manage-search").addEventListener("input", renderManageList);
    $("#manage-source").addEventListener("change", renderManageList);
    $("#manage-list").addEventListener("click", (e) => {
      const del = e.target.closest(".remove-upload[data-id]");
      if (del) { removeDocs([del.dataset.id]); return; }
    });
    $("#manage-list").addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox][data-id]");
      if (!cb) return;
      if (cb.checked) MANAGE_SELECTED.add(cb.dataset.id); else MANAGE_SELECTED.delete(cb.dataset.id);
      renderManageList();
    });
    $("#manage-select-all").addEventListener("change", (e) => {
      const ids = manageRows().map((r) => r.d.id);
      ids.forEach((id) => (e.target.checked ? MANAGE_SELECTED.add(id) : MANAGE_SELECTED.delete(id)));
      renderManageList();
    });
    $("#manage-delete-selected").addEventListener("click", () => {
      const n = MANAGE_SELECTED.size;
      if (n && confirm(`確定要刪除勾選的 ${n.toLocaleString()} 篇文獻嗎？`)) removeDocs(Array.from(MANAGE_SELECTED));
    });
    $("#manage-clear-all").addEventListener("click", clearAllDocs);
    $("#manage-restore").addEventListener("click", restoreDefaults);
  }

  function setUploadStatus(msg, isError) {
    const el = $("#upload-status");
    el.textContent = msg;
    el.classList.toggle("upload-status-error", !!isError);
  }

  function uniqueId(baseId) {
    if (!DOC_BY_ID[baseId] && !UPLOADED_DOCS.some((d) => d.id === baseId)) return baseId;
    let n = 2;
    while (DOC_BY_ID[`${baseId}_${n}`] || UPLOADED_DOCS.some((d) => d.id === `${baseId}_${n}`)) n++;
    return `${baseId}_${n}`;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /\.(xml|nxml)$/i.test(f.name));
    if (files.length === 0) {
      setUploadStatus("請選擇 .xml 或 .nxml 檔案。", true);
      return;
    }
    let added = 0, failed = [];
    for (const file of files) {
      let text;
      try {
        text = await file.text();
      } catch (e) {
        failed.push(`${file.name}：無法讀取檔案`);
        continue;
      }
      const fallbackId = file.name.replace(/\.(xml|nxml)$/i, "");
      const result = PMCXmlParser.parseArticleXML(text, fallbackId);
      if (!result.ok) {
        failed.push(`${file.name}：${result.error}`);
        continue;
      }
      result.docs.forEach((doc) => {
        doc.id = uniqueId(doc.id);
        UPLOADED_DOCS.push(doc);
        added++;
      });
    }

    if (added > 0) {
      persistUploads();
      rebuildAll();
      renderUploadPanel();
      renderCorpusOverview();
      rerenderCurrent();
    }

    if (added && !failed.length) {
      setUploadStatus(`已新增 ${added} 篇文獻，已完成索引，現在就能搜尋。`, false);
    } else if (added && failed.length) {
      setUploadStatus(`已新增 ${added} 篇，但有 ${failed.length} 篇失敗：${failed.join("；")}`, true);
    } else {
      setUploadStatus(`無法新增任何檔案：${failed.join("；")}`, true);
    }
  }

  function initUploadPanel() {
    const input = $("#xml-upload-input");
    const dropzone = $("#upload-dropzone");

    input.addEventListener("change", () => {
      if (input.files.length) handleFiles(input.files);
      input.value = ""; // 讓同名檔案也能再次上傳
    });

    ["dragenter", "dragover"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dropzone-active");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dropzone-active");
      });
    });
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
    dropzone.addEventListener("click", () => input.click());

    renderUploadPanel();
  }

  // ----------------------------------------------------------------
  // PMID 清單面板：讀取 .txt、抓 NCBI 全文/摘要，加入語料庫
  // ----------------------------------------------------------------
  function setPmidStatus(msg, isError) {
    const el = $("#pmid-status");
    el.textContent = msg;
    el.classList.toggle("upload-status-error", !!isError);
  }

  function initPmidPanel() {
    const input = $("#pmid-upload-input");
    const dropzone = $("#pmid-dropzone");
    const preview = $("#pmid-preview");
    const previewCount = $("#pmid-preview-count");
    const startBtn = $("#pmid-fetch-start");
    let pendingIds = { pmids: [], pmcIds: [] };

    function loadTxt(file) {
      if (!/\.txt$/i.test(file.name)) {
        setPmidStatus("請選擇 .txt 檔案。", true);
        return;
      }
      file.text().then((text) => {
        // Format 1: PubMed's own "Save → Format: Abstract" export — the
        // abstract text is already in the file, so this parses INSTANTLY
        // with zero network requests (no CORS risk at all).
        if (PubmedAbstractTxtParser.looksLikePubmedAbstractTxt(text)) {
          const result = PubmedAbstractTxtParser.parsePubmedAbstractTxt(text, "pubmed_txt");
          if (result.ok && result.docs.length) {
            let added = 0, noAbstract = 0;
            result.docs.forEach((doc) => {
              // 作業要求每篇至少包含摘要：略過沒有摘要的紀錄（評論、勘誤、只有作者名單的紀錄等）
              if (!doc.abstract || doc.abstract.split(/\s+/).filter(Boolean).length < 20) { noAbstract++; return; }
              doc.id = uniqueId(doc.id);
              UPLOADED_DOCS.push(doc);
              added++;
            });
            persistUploads();
            rebuildAll();
            renderUploadPanel();
            renderCorpusOverview();
            rerenderCurrent();
            preview.hidden = true;
            pendingIds = { pmids: [], pmcIds: [] };
            setPmidStatus(`偵測到 PubMed 摘要匯出格式，已直接解析並新增 ${added} 篇文獻${noAbstract ? `，略過沒有摘要的 ${noAbstract} 篇` : ""}。`, false);
            return;
          }
        }

        // Format 2/3: a list of bare PMIDs and/or "PMC..." accession
        // numbers (freely mixed) -> this DOES need a live fetch to NCBI,
        // so show a preview + explicit confirm step first.
        pendingIds = PmidFetcher.extractIds(text);
        const total = pendingIds.pmids.length + pendingIds.pmcIds.length;
        if (!total) {
          preview.hidden = true;
          setPmidStatus("這個檔案看起來不是 PubMed 摘要匯出格式，也沒有找到看起來像 PMID 或 PMC 編號的內容。", true);
          return;
        }
        const parts = [];
        if (pendingIds.pmids.length) parts.push(`${pendingIds.pmids.length} 個 PMID`);
        if (pendingIds.pmcIds.length) parts.push(`${pendingIds.pmcIds.length} 個 PMC 編號`);
        previewCount.textContent = `找到 ${parts.join("、")}，準備好就按下方按鈕開始。`;
        preview.hidden = false;
        setPmidStatus("", false);
      }).catch((e) => setPmidStatus("無法讀取檔案：" + e.message, true));
    }

    input.addEventListener("change", () => {
      if (input.files.length) loadTxt(input.files[0]);
      input.value = "";
    });

    ["dragenter", "dragover"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dropzone-active");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dropzone-active");
      });
    });
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) loadTxt(e.dataTransfer.files[0]);
    });
    dropzone.addEventListener("click", () => input.click());

    startBtn.addEventListener("click", async () => {
      if (!pendingIds.pmids.length && !pendingIds.pmcIds.length) return;
      startBtn.disabled = true;
      try {
        const { docs, errors } = await PmidFetcher.fetchArticlesForIds(
          pendingIds,
          (msg) => setPmidStatus(msg, false)
        );

        let added = 0;
        docs.forEach((doc) => {
          doc.id = uniqueId(doc.id);
          UPLOADED_DOCS.push(doc);
          added++;
        });

        if (added > 0) {
          persistUploads();
          rebuildAll();
          renderUploadPanel();
          renderCorpusOverview();
          rerenderCurrent();
        }

        const parts = [];
        if (added) parts.push(`成功新增 ${added} 篇文獻`);
        if (errors.length) parts.push(`${errors.length} 個問題：${errors.join("；")}`);
        setPmidStatus(parts.join("。") || "沒有新增任何文獻。", errors.length > 0 && added === 0);
        setUploadStatus("", false); // 順便清掉「上傳 XML 文件」那邊可能殘留的舊狀態文字

        if (added > 0) {
          preview.hidden = true;
          pendingIds = { pmids: [], pmcIds: [] };
        }
      } catch (e) {
        setPmidStatus(e.message, true);
      } finally {
        startBtn.disabled = false;
      }
    });
  }

  // ----------------------------------------------------------------
  // 即時分析器：貼上任意文字，立即看到規則式統計結果
  // ----------------------------------------------------------------
  function initAnalyzer() {
    const input = $("#analyzer-input");
    const out = $("#analyzer-output");
    const sentList = $("#analyzer-sentences");

    function run() {
      const text = input.value;
      if (!text.trim()) {
        out.innerHTML = "";
        sentList.innerHTML = "";
        return;
      }
      const s = IRCore.computeStats(text);
      out.innerHTML = [
        ["字元數", s.num_characters],
        ["字數", s.num_words],
        ["句數", s.num_sentences],
        ["平均每句字數", s.avg_words_per_sentence],
        ["唯一詞幹數", s.num_unique_stems],
      ].map(([label, val]) => `<div class="stat-chip small"><span>${label}</span><strong>${val}</strong></div>`).join("");
      sentList.innerHTML = s.sentences.map((sent, i) =>
        `<li><span class="sent-idx">${i + 1}</span>${escapeHtml(sent)}</li>`).join("");
    }

    input.addEventListener("input", run);
    $("#analyzer-sample").addEventListener("click", () => {
      input.value = "Dr. Silva et al. reported a 9.7 mmHg reduction in systolic blood pressure (p < 0.001). This exceeded the 5.0 mmHg threshold set a priori. Is a low-sodium diet, e.g. <100 mmol/day, feasible long-term? Further trials, incl. larger cohorts, are planned for 2025.";
      run();
    });
  }

  // ----------------------------------------------------------------
  // 啟動
  // ----------------------------------------------------------------
  async function init() {
    const searchInput = $("#search-input");
    const form = $("#search-form");
    const modal = $("#doc-modal");

    // Wire up the upload panel and modal FIRST, independent of whether the
    // base corpus loads successfully — so "upload" still works even if
    // corpus.json failed to fetch (e.g. opened via file:// instead of a
    // server, or pushed without the data/ folder).
    initDocStatsModal();
    initManageModal();
    initUploadPanel();
    initPmidPanel();
    $("#results").addEventListener("click", (e) => {
      const btn = e.target.closest(".link-btn[data-doc]");
      if (btn) { openDocModal(btn.dataset.doc); return; }
      const pageBtn = e.target.closest(".page-btn[data-page]");
      if (pageBtn && !pageBtn.disabled) {
        CURRENT_PAGE = parseInt(pageBtn.dataset.page, 10);
        renderResultPage(true);
      }
    });
    $("#results").addEventListener("change", (e) => {
      const sel = e.target.closest(".page-size");
      if (!sel) return;
      // 換每頁筆數時，盡量讓目前看到的第一筆仍在畫面上
      const firstIndex = (CURRENT_PAGE - 1) * PAGE_SIZE;
      PAGE_SIZE = parseInt(sel.value, 10);
      CURRENT_PAGE = Math.floor(firstIndex / PAGE_SIZE) + 1;
      renderResultPage(true);
    });
    $("#doc-modal-close").addEventListener("click", () => modal.close());
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.close();
    });
    initAnalyzer();

    $("#corpus-summary").textContent = "載入語料中…";
    const storageReady = loadFromStorage().catch(() => {});
    try {
      await loadBaseCorpus();
      await storageReady;
    } catch (err) {
      await storageReady;
      BASE_DOCS = [];
      $("#results").innerHTML = `<p class="empty-state">無法載入內建語料庫（${escapeHtml(String(err))}）。這通常是因為直接用瀏覽器打開檔案（file://）而不是透過伺服器。請改用 <code>python3 -m http.server</code> 開一個本機伺服器，或部署到 GitHub Pages 後再開啟。上傳功能不受影響，仍可使用。</p>`;
    }

    rebuildAll();
    renderUploadPanel();
    renderCorpusOverview();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      renderResults(searchInput.value);
    });
    //searchInput.addEventListener("input", () => renderResults(searchInput.value));

    const fuzzyToggle = $("#fuzzy-toggle");
    if (fuzzyToggle) {
      fuzzyToggle.addEventListener("change", () => {
        FUZZY = fuzzyToggle.checked;
        renderResults(searchInput.value);
      });
    }
    const spellToggle = $("#spell-toggle");
    if (spellToggle) {
      SPELL_CHECK = spellToggle.checked;
      spellToggle.addEventListener("change", () => {
        SPELL_CHECK = spellToggle.checked;
        renderResults(searchInput.value);
      });
    }

    initWeightingControls();

    const includeTitleToggle = $("#include-title-toggle");
    if (includeTitleToggle) {
      includeTitleToggle.addEventListener("change", () => {
        INCLUDE_TITLE = includeTitleToggle.checked;
        renderResults(searchInput.value);
      });
    }

    $$(".example-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        searchInput.value = chip.textContent;
        renderResults(searchInput.value);
        searchInput.focus();
      });
    });
  }

  // ----------------------------------------------------------------
  // 權重方法選單（搜尋框下方）
  // ----------------------------------------------------------------
  function initWeightingControls() {
    const preset = $("#w-preset"), tfSel = $("#w-tf"), idfSel = $("#w-idf"), normSel = $("#w-norm");
    if (!preset) return;
    preset.innerHTML = IRCore.WEIGHT_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("") +
      `<option value="custom">自訂組合</option>`;
    const sync = () => {
      tfSel.value = WEIGHTING.tf; idfSel.value = WEIGHTING.idf; normSel.value = WEIGHTING.norm;
      const p = IRCore.WEIGHT_PRESETS.find((x) => x.tf === WEIGHTING.tf && x.idf === WEIGHTING.idf);
      preset.value = p ? p.id : "custom";
      const fx = $("#w-formula");
      if (fx) {
        const t = IRCore.TF_SCHEMES[WEIGHTING.tf].formula, i = IRCore.IDF_SCHEMES[WEIGHTING.idf].formula;
        fx.innerHTML = `w = <code>${t}</code> × <code>${i}</code>　·　score = <code>${IRCore.NORM_SCHEMES[WEIGHTING.norm].formula}</code>`;
      }
    };
    const apply = () => { sync(); renderResults($("#search-input").value); window.dispatchEvent(new CustomEvent("ir:weighting", { detail: WEIGHTING })); };
    preset.addEventListener("change", () => {
      const p = IRCore.WEIGHT_PRESETS.find((x) => x.id === preset.value);
      if (p) { WEIGHTING = Object.assign({}, WEIGHTING, { tf: p.tf, idf: p.idf }); }
      apply();
    });
    [tfSel, idfSel, normSel].forEach((sel) => sel.addEventListener("change", () => {
      WEIGHTING = { tf: tfSel.value, idf: idfSel.value, norm: normSel.value };
      apply();
    }));
    const reset = $("#w-reset");
    if (reset) reset.addEventListener("click", () => { WEIGHTING = { tf: "log", idf: "smooth", norm: "l2" }; apply(); });
    sync();
  }

  // ----------------------------------------------------------------
  // 給 lab-ui.js（Zipf / Word2Vec / 編輯距離分析區塊）使用的介面
  // ----------------------------------------------------------------
  window.IRApp = {
    getDocs: () => ALL_DOCS,
    // 分析用文字：標題＋摘要（與「標題＋摘要」索引相同的範圍）
    analysisText: (d) => IRCore.joinWithPeriod(d.title || "", d.abstract || ""),
    getSpeller: () => SPELL_WITH_TITLE,
    isBaseIntact: () => isBaseIntact(),
    baseSignature: () => BASE_SIGNATURE,
    baseCount: () => BASE_DOCS.length,
    onCorpusChange: (fn) => {
      CORPUS_LISTENERS.push(fn);
      if (CORPUS_READY) fn(ALL_DOCS);
    },
    search: (q) => {
      $("#search-input").value = q;
      renderResults(q);
      $("#search-input").scrollIntoView({ behavior: "smooth", block: "center" });
    },
    rerender: () => rerenderCurrent(),
    // 權重實驗區塊（weighting-lab.js）使用
    getStats: (scope) => getStats(scope),
    getIndex: (scope, scheme) => getIndex(scope, scheme),
    docById: (id) => DOC_BY_ID[id],
    // terms：要在文章視窗中標示的詞幹（實驗區塊的查詢）；不影響搜尋區的狀態
    openDoc: (id, terms) => {
      if (!terms) { openDocModal(id); return; }
      const keepTerms = LAST_MATCHED_TERMS, keepFuzzy = FUZZY_INFO;
      LAST_MATCHED_TERMS = terms; FUZZY_INFO = new Map();
      try { openDocModal(id); } finally { LAST_MATCHED_TERMS = keepTerms; FUZZY_INFO = keepFuzzy; }
    },
    getWeighting: () => Object.assign({}, WEIGHTING),
  };

  document.addEventListener("DOMContentLoaded", init);
})();
