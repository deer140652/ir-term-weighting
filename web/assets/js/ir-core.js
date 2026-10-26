/*
 * ir-core.js
 * ----------
 * 檢索系統的核心：斷句、斷詞、停用詞、Porter stemmer，以及 term weighting
 * （TF／IDF／正規化可自由組合）與向量空間模型的計分。
 * Provides: tokenize(), removeStopwords(), stem(), splitSentences(),
 * computeStats() — used both (a) to process a user's search query the same
 * way documents were indexed, and (b) to power the "try your own text"
 * live document-statistics analyzer in the UI.
 *
 * Pure vanilla JS, no dependencies. Exposed as window.IRCore.
 */
(function (global) {
  "use strict";

  // -------------------------------------------------------------------
  // Stopwords (127-word SMART/standard IR list)
  // -------------------------------------------------------------------
  const STOPWORDS = new Set(`
a about above after again against all am an and any are aren't as at be
because been before being below between both but by can't cannot could
couldn't did didn't do does doesn't doing don't down during each few for
from further had hadn't has hasn't have haven't having he he'd he'll he's
her here here's hers herself him himself his how how's i i'd i'll i'm i've
if in into is isn't it it's its itself let's me more most mustn't my myself
no nor not of off on once only or other ought our ours ourselves out over
own same shan't she she'd she'll she's should shouldn't so some such than
that that's the their theirs them themselves then there there's these they
they'd they'll they're they've this those through to too under until up
very was wasn't we we'd we'll we're we've were weren't what what's when
when's where where's which while who who's whom why why's with won't would
wouldn't you you'd you'll you're you've your yours yourself yourselves
`.split(/\s+/).filter(Boolean));

  // -------------------------------------------------------------------
  // Rule-based sentence (EOS) segmentation
  // -------------------------------------------------------------------
  const ABBR_LAST_WORDS = new Set([
    "e.g.", "i.e.", "al.", "etc.", "vs.", "fig.", "figs.", "no.", "nos.",
    "dr.", "mr.", "mrs.", "ms.", "prof.", "vol.", "pp.", "p.", "approx.",
    "ca.", "cf.", "ref.", "refs.", "eq.", "eqs.", "min.", "max.", "avg.",
    "mg.", "kg.", "ml.", "mmol.", "std.", "sd.", "st.", "jr.", "sr.",
  ].map((a) => a.replace(/\.$/, "")));

  function isAlnum(ch) {
    return /[A-Za-z0-9]/.test(ch);
  }

  function splitSentences(text) {
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return [];

    const sentences = [];
    let start = 0;
    const n = text.length;

    for (let i = 0; i < n; i++) {
      const ch = text[i];
      if (ch === "." || ch === "!" || ch === "?") {
        let isBoundary = true;

        if (ch === ".") {
          // decimal numbers, e.g. "8.1%"
          if (i > 0 && i < n - 1 && /[0-9]/.test(text[i - 1]) && /[0-9]/.test(text[i + 1])) {
            isBoundary = false;
          }
          // known abbreviation
          if (isBoundary) {
            let j = i - 1;
            while (j >= 0 && isAlnum(text[j])) j--;
            const word = text.slice(j + 1, i).toLowerCase();
            if (ABBR_LAST_WORDS.has(word)) isBoundary = false;
          }
          // single capital initial, e.g. "H. Chen"
          if (isBoundary && i - 1 >= 0 && /[A-Z]/.test(text[i - 1])) {
            if (i - 2 < 0 || text[i - 2] === " ") isBoundary = false;
          }
        }

        if (isBoundary) {
          let k = i + 1;
          while (k < n && text[k] === " ") k++;
          if (k < n) {
            const nxt = text[k];
            if (!(/[A-Z0-9]/.test(nxt) || '"\'"‘(['.includes(nxt))) {
              isBoundary = false;
            }
          }
        }

        if (isBoundary) {
          const sentence = text.slice(start, i + 1).trim();
          if (sentence) sentences.push(sentence);
          start = i + 1;
        }
      }
    }
    const tail = text.slice(start).trim();
    if (tail) sentences.push(tail);
    return sentences;
  }

  // -------------------------------------------------------------------
  // Tokenizer
  // -------------------------------------------------------------------
  function tokenize(text) {
    // Must START with a letter (so a bare number like "2020" or "139" is
    // still never captured as a term), but can now contain digits in the
    // middle/end — this lets alphanumeric compounds like "COVID-19" or
    // "SARS-CoV-2" survive tokenization as their OWN distinct term, instead
    // of silently losing the trailing "-19"/"-2" and collapsing into plain
    // "covid"/"sars-cov". A search for "COVID-19" can then match/highlight
    // only "COVID-19" occurrences, not every plain "COVID".
    const re = /[A-Za-z][A-Za-z0-9\-']*[A-Za-z0-9]|[A-Za-z]/g;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[0].toLowerCase());
    return out;
  }

  function removeStopwords(tokens) {
    return tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  }

  // -------------------------------------------------------------------
  // Porter Stemmer (classic algorithm)
  // -------------------------------------------------------------------
  function PorterStemmer() {
    let b = "", k = 0, j = 0;

    function cons(i) {
      const ch = b[i];
      if ("aeiou".includes(ch)) return false;
      if (ch === "y") return i === 0 ? true : !cons(i - 1);
      return true;
    }

    function m() {
      let n = 0, i = 0;
      while (true) {
        if (i > j) return n;
        if (!cons(i)) break;
        i++;
      }
      i++;
      while (true) {
        while (true) {
          if (i > j) return n;
          if (cons(i)) break;
          i++;
        }
        i++;
        n++;
        while (true) {
          if (i > j) return n;
          if (!cons(i)) break;
          i++;
        }
        i++;
      }
    }

    function vowelInStem() {
      for (let i = 0; i <= j; i++) if (!cons(i)) return true;
      return false;
    }

    function doubleCons(x) {
      return x >= 1 && b[x] === b[x - 1] && cons(x);
    }

    function cvc(i) {
      if (i < 2 || !cons(i) || cons(i - 1) || !cons(i - 2)) return false;
      return !"wxy".includes(b[i]);
    }

    function ends(s) {
      if (b.slice(k - s.length + 1, k + 1) === s) {
        j = k - s.length;
        return true;
      }
      return false;
    }

    function setto(s) {
      b = b.slice(0, j + 1) + s;
      k = j + s.length;
    }

    function r(s) {
      if (m() > 0) setto(s);
    }

    function step1ab() {
      if (b[k] === "s") {
        if (ends("sses")) k -= 2;
        else if (ends("ies")) setto("i");
        else if (b[k - 1] !== "s") k -= 1;
      }
      if (ends("eed")) {
        if (m() > 0) k -= 1;
      } else if ((ends("ed") || ends("ing")) && vowelInStem()) {
        k = j;
        if (ends("at")) setto("ate");
        else if (ends("bl")) setto("ble");
        else if (ends("iz")) setto("ize");
        else if (doubleCons(k)) {
          k -= 1;
          if ("lsz".includes(b[k])) k += 1;
        } else if (m() === 1 && cvc(k)) setto("e");
      }
    }

    function step1c() {
      if (ends("y") && vowelInStem()) b = b.slice(0, k) + "i";
    }

    const STEP2 = [
      ["ational", "ate"], ["tional", "tion"], ["enci", "ence"],
      ["anci", "ance"], ["izer", "ize"], ["bli", "ble"], ["alli", "al"],
      ["entli", "ent"], ["eli", "e"], ["ousli", "ous"], ["ization", "ize"],
      ["ation", "ate"], ["ator", "ate"], ["alism", "al"], ["iveness", "ive"],
      ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
      ["iviti", "ive"], ["biliti", "ble"], ["logi", "log"],
    ];
    function step2() {
      for (const [suf, rep] of STEP2) {
        if (ends(suf)) { r(rep); break; }
      }
    }

    const STEP3 = [
      ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
      ["ical", "ic"], ["ful", ""], ["ness", ""],
    ];
    function step3() {
      for (const [suf, rep] of STEP3) {
        if (ends(suf)) { r(rep); break; }
      }
    }

    const STEP4 = ["al", "ance", "ence", "er", "ic", "able", "ible", "ant",
      "ement", "ment", "ent", "ou", "ism", "ate", "iti", "ous", "ive", "ize"];
    function step4() {
      for (const suf of STEP4) {
        if (ends(suf)) {
          if (m() > 1) k = j;
          return;
        }
      }
      if (ends("ion")) {
        if (m() > 1 && j >= 0 && "st".includes(b[j])) k = j;
      }
    }

    function step5() {
      j = k;
      if (b[k] === "e") {
        const a = m();
        if (a > 1 || (a === 1 && !cvc(k - 1))) k -= 1;
      }
      if (b[k] === "l" && doubleCons(k) && m() > 1) k -= 1;
    }

    this.stem = function (word) {
      word = word.toLowerCase();
      if (word.length <= 2) return word;
      b = word; k = word.length - 1;
      step1ab();
      if (k >= 0) {
        step1c();
        step2();
        step3();
        step4();
        step5();
      }
      return b.slice(0, k + 1);
    };

    // 逐步追蹤版：回傳每一個 Porter 步驟之後的詞形，用於介面上展示演算法
    // 的實際運作過程（結果與 stem() 完全相同）。
    this.trace = function (word) {
      word = word.toLowerCase();
      const steps = [{ step: "輸入", result: word }];
      if (word.length <= 2) {
        steps.push({ step: "長度 ≤ 2，不處理", result: word });
        return steps;
      }
      b = word; k = word.length - 1;
      const snap = (name) => steps.push({ step: name, result: b.slice(0, k + 1) });
      step1ab(); snap("Step 1a/1b（複數、-ed、-ing）");
      if (k >= 0) {
        step1c(); snap("Step 1c（y → i）");
        step2(); snap("Step 2（雙重字尾，如 -ational）");
        step3(); snap("Step 3（-icate、-ful、-ness…）");
        step4(); snap("Step 4（移除 -al、-ance、-ment…）");
        step5(); snap("Step 5（移除 -e、-ll → -l）");
      }
      return steps;
    };
  }

  const stemmer = new PorterStemmer();
  // 詞幹快取：語料庫中同一個字會重複出現非常多次，快取後大型語料（例如數千篇
  // 摘要）重建索引、Zipf 統計、Word2Vec 前處理都能快上數倍。
  const STEM_CACHE = new Map();
  function stem(word) {
    const hit = STEM_CACHE.get(word);
    if (hit !== undefined) return hit;
    // Strip a trailing possessive apostrophe ("cancer's" -> "cancer",
    // "cancers'" -> "cancers") BEFORE running Porter stemming. Without
    // this, the algorithm's own "drop a trailing s" rule can leave the
    // apostrophe dangling (e.g. "cancer's" -> "cancer'"), producing a
    // stem that never matches the plain "cancer" a search would produce.
    const cleaned = word.replace(/'s$|'$/i, "");
    const out = stemmer.stem(cleaned || word);
    if (STEM_CACHE.size < 200000) STEM_CACHE.set(word, out);
    return out;
  }
  function stemTrace(word) {
    const cleaned = word.replace(/'s$|'$/i, "");
    return new PorterStemmer().trace(cleaned || word);
  }
  function stemAll(tokens) { return tokens.map(stem); }

  // -------------------------------------------------------------------
  // Document statistics
  // -------------------------------------------------------------------
  function expandHyphenatedTokens(tokens) {
    // For a hyphenated compound token like "pre-covid", ALSO index its
    // individual hyphen-split parts ("pre", "covid") as separate terms —
    // without this, "pre-COVID-19" tokenizes as ONE token "pre-covid" that
    // never matches a plain "covid" search, even though the word is right
    // there. Keeping the whole compound too (not replacing it) means
    // precise multi-word terms like "SARS-CoV-2" or "beta-cell" still work
    // as intended; this only ADDS extra recall on top.
    const expanded = [];
    tokens.forEach((t) => {
      expanded.push(t);
      if (t.includes("-")) {
        t.split("-").forEach((part) => {
          // skip purely-numeric fragments (e.g. the "19" in "covid-19") —
          // we still don't want bare numbers becoming their own index term
          if (part.length > 1 && !/^\d+$/.test(part)) expanded.push(part);
        });
      }
    });
    return expanded;
  }

  function joinWithPeriod(a, b) {
    // Joins two pieces of text (typically a title and a body) with ". "
    // between them, but WITHOUT adding a redundant period if `a` already
    // ends in sentence-ending punctuation — e.g. a title that already ends
    // in "." would otherwise become "title.. body", and the doubled
    // period confuses the sentence-boundary detector (neither period ends
    // up recognized as a real boundary, merging the title into the body's
    // first sentence).
    const aTrim = (a || "").trim();
    const bTrim = (b || "").trim();
    if (!aTrim) return bTrim;
    if (!bTrim) return aTrim;
    const sep = /[.!?]$/.test(aTrim) ? " " : ". ";
    return aTrim + sep + bTrim;
  }

  function computeStats(text) {
    const sentences = splitSentences(text);
    const rawTokens = tokenize(text);
    const expandedTokens = expandHyphenatedTokens(rawTokens);
    const noStop = removeStopwords(expandedTokens);
    const stems = stemAll(noStop);
    const words = (text.match(/\S+/g) || []);
    const numSentences = sentences.length;
    return {
      num_characters: text.length,
      num_characters_no_spaces: text.replace(/\s/g, "").length,
      num_words: words.length,
      num_sentences: numSentences,
      avg_words_per_sentence: numSentences ? Math.round((words.length / numSentences) * 100) / 100 : 0,
      num_index_terms: noStop.length,
      num_unique_stems: new Set(stems).size,
      sentences,
      tokens: noStop,
      stems,
    };
  }

  // -------------------------------------------------------------------
  // Term weighting（作業三）
  // 權重拆成三個彼此獨立的維度，可以自由組合：
  //   TF：raw = tf；log = 1 + ln(tf)（tf = 0 時為 0）；binary = 有出現就是 1
  //   IDF：none = 1；classic = ln(N / df)（課本公式）；smooth = ln(N / df) + 1
  //   正規化：l2 = 文件向量除以 L2 長度（即 cosine）；none = 直接用內積
  // 對數一律用自然對數。classic 與 smooth 只差一個常數 1，但這個 1 會讓
  // 「出現在所有文件中的詞」權重從 0 變成 1，常見詞被壓低的程度也跟著變小。
  // -------------------------------------------------------------------
  const TF_SCHEMES = {
    raw: { label: "Raw TF", formula: "tf", fn: (tf) => tf },
    log: { label: "Log TF", formula: "1 + ln(tf)", fn: (tf) => (tf > 0 ? 1 + Math.log(tf) : 0) },
    binary: { label: "Binary", formula: "1（有出現）", fn: (tf) => (tf > 0 ? 1 : 0) },
  };
  const IDF_SCHEMES = {
    none: { label: "不使用 IDF", formula: "1", fn: () => 1 },
    classic: { label: "IDF", formula: "ln(N / df)", fn: (N, df) => Math.log(N / df) },
    smooth: { label: "IDF + 1", formula: "ln(N / df) + 1", fn: (N, df) => Math.log(N / df) + 1 },
  };
  const NORM_SCHEMES = {
    l2: { label: "L2 正規化（cosine）", formula: "q·d / (|q| |d|)" },
    none: { label: "不正規化（內積）", formula: "q·d" },
  };

  // 實驗用的預設方法組合（排名比較、評估表都用這一組）
  const WEIGHT_PRESETS = [
    { id: "rawtf", label: "Raw TF", tf: "raw", idf: "none" },
    { id: "logtf", label: "Log TF", tf: "log", idf: "none" },
    { id: "idf", label: "IDF only", tf: "binary", idf: "classic" },
    { id: "tfidf-raw", label: "TF-IDF（raw TF）", tf: "raw", idf: "classic" },
    { id: "tfidf-log", label: "TF-IDF（log TF）", tf: "log", idf: "classic" },
    { id: "tfidf-log-s", label: "TF-IDF（log TF，IDF+1）", tf: "log", idf: "smooth" },
  ];

  function tfWeight(tf, scheme) { return (TF_SCHEMES[scheme] || TF_SCHEMES.log).fn(tf); }
  function idfWeight(N, df, scheme) { return df > 0 ? (IDF_SCHEMES[scheme] || IDF_SCHEMES.smooth).fn(N, df) : 0; }

  function schemeLabel(s) {
    const p = WEIGHT_PRESETS.find((x) => x.tf === s.tf && x.idf === s.idf);
    const base = p ? p.label : `${TF_SCHEMES[s.tf].label} × ${IDF_SCHEMES[s.idf].label}`;
    return s.norm ? `${base}｜${s.norm === "l2" ? "L2" : "無正規化"}` : base;
  }

  // 第一步：只做一次的詞項統計（tf、df、文件長度）。之後切換權重方法時，
  // 不需要重新斷詞、詞幹還原，只要用這份統計重新算權重即可。
  function buildTermStats(docs) {
    // docs: array of { id, full_text }
    const df = {};       // stem -> 出現在幾篇文件
    const cf = {};       // stem -> 在整個語料中出現幾次
    const docTF = {};    // doc id -> { stem: tf }
    const docLen = {};   // doc id -> 索引詞總數（過濾停用詞、詞幹還原後）
    docs.forEach((doc) => {
      const st = computeStats(doc.full_text || "");
      const counts = {};
      st.stems.forEach((s) => { counts[s] = (counts[s] || 0) + 1; });
      docTF[doc.id] = counts;
      docLen[doc.id] = st.stems.length;
      Object.keys(counts).forEach((term) => {
        df[term] = (df[term] || 0) + 1;
        cf[term] = (cf[term] || 0) + counts[term];
      });
    });
    return { N: docs.length, df, cf, docTF, docLen, ids: docs.map((d) => d.id) };
  }

  // 第二步：依權重方法建立反向索引。idf 表一律包含所有詞（不用 IDF 時值為 1），
  // 方便判斷查詢詞是否在詞彙中。
  function buildWeightedIndex(stats, scheme) {
    scheme = Object.assign({ tf: "log", idf: "smooth" }, scheme);
    const N = stats.N || 1;
    const idf = {};
    Object.keys(stats.df).forEach((term) => { idf[term] = idfWeight(N, stats.df[term], scheme.idf); });

    const postings = {};   // term -> { docId: weight }
    const docNorms = {};
    stats.ids.forEach((docId) => {
      const counts = stats.docTF[docId];
      let sumSq = 0;
      for (const term in counts) {
        const w = tfWeight(counts[term], scheme.tf) * idf[term];
        sumSq += w * w;
        if (!postings[term]) postings[term] = {};
        postings[term][docId] = w;
      }
      docNorms[docId] = Math.sqrt(sumSq) || 1;
    });
    return { scheme: { tf: scheme.tf, idf: scheme.idf }, N, df: stats.df, docLen: stats.docLen, idf, doc_norms: docNorms, postings };
  }

  // 相容舊介面：預設為 log TF × (IDF + 1)
  function buildIndex(docs) {
    return buildWeightedIndex(buildTermStats(docs), { tf: "log", idf: "smooth" });
  }

  // 查詢前處理：與文件相同的斷詞、停用詞、詞幹還原（查詢端不拆連字號）
  function queryTerms(text) {
    return stemAll(removeStopwords(tokenize(text || "")));
  }

  // 查詢向量：用與文件相同的 TF／IDF 方法；不在詞彙中的詞直接忽略
  function queryVector(terms, index) {
    const counts = {};
    terms.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    const vec = {};
    for (const t in counts) {
      if (index.idf[t] === undefined) continue;
      vec[t] = tfWeight(counts[t], index.scheme.tf) * index.idf[t];
    }
    return vec;
  }

  // 計分：l2 → cosine；none → 內積。分數相同時依文件 id 排序，確保結果可重現。
  function scoreVector(qWeights, index, norm) {
    const scores = {};
    for (const term in qWeights) {
      const postings = index.postings[term];
      const qw = qWeights[term];
      if (!postings || !qw) continue;
      for (const docId in postings) scores[docId] = (scores[docId] || 0) + postings[docId] * qw;
    }
    const qNorm = Math.sqrt(Object.values(qWeights).reduce((s, w) => s + w * w, 0)) || 1;
    const out = [];
    for (const docId in scores) {
      const dot = scores[docId];
      out.push({ id: docId, dot, score: norm === "none" ? dot : dot / (qNorm * (index.doc_norms[docId] || 1)) });
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  // 一次完成：查詢文字 → 排名（實驗與評估用，不含拼字校正、模糊比對）
  function rank(text, index, norm) {
    return scoreVector(queryVector(queryTerms(text), index), index, norm);
  }

  global.IRCore = {
    STOPWORDS,
    splitSentences,
    tokenize,
    removeStopwords,
    expandHyphenatedTokens,
    joinWithPeriod,
    stem,
    stemAll,
    stemTrace,
    computeStats,
    TF_SCHEMES,
    IDF_SCHEMES,
    NORM_SCHEMES,
    WEIGHT_PRESETS,
    tfWeight,
    idfWeight,
    schemeLabel,
    buildTermStats,
    buildWeightedIndex,
    buildIndex,
    queryTerms,
    queryVector,
    scoreVector,
    rank,
  };
})(typeof window !== "undefined" ? window : globalThis);
