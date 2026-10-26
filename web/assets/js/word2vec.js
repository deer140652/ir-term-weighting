/*
 * word2vec.js
 * -----------
 * 從零實作 Word2Vec（Mikolov et al., 2013），不使用任何機器學習套件。
 *
 *   ● Skip-gram（SG）：用「中心詞」預測視窗內的「周圍詞」
 *   ● CBOW          ：用視窗內「周圍詞向量的平均」預測「中心詞」
 *
 * 兩者都使用 Negative Sampling 取代完整 softmax：
 *   對每個（輸入 h, 目標詞 o）正樣本，另外從 unigram^0.75 分佈抽 k 個負樣本 n_i，
 *   最小化  L = −log σ(h·u_o) − Σ_i log σ(−h·u_{n_i})
 *   梯度：  g = (label − σ(h·u)) · lr
 *           u ← u + g·h          （輸出向量）
 *           h ← h + Σ g·u        （輸入向量，累加後一次更新）
 *
 * 其他訓練細節（同原始 C 版 word2vec）：
 *   - 高頻詞次抽樣（subsampling）：保留機率 (√(f/(t·N)) + 1) · (t·N)/f
 *   - 動態視窗：每個位置實際視窗大小在 1..window 間隨機
 *   - 學習率由 lr0 線性遞減至 lr0 × 1e-4
 *   - 視窗不跨越句子邊界（使用 ir-core.js 的規則式斷句器切句）
 *
 * 訓練完成後可查詢近鄰詞（mostSimilar）與兩詞的 cosine 相似度（similarity）；
 * PCA 與 t-SNE 降維在 w2v-ui.js。
 *
 * 訓練在 Web Worker（由 Blob 動態建立）中執行，不會卡住頁面；
 * 若瀏覽器不支援 Worker，會退回在主執行緒同步執行。
 *
 * 對外公開為 window.Word2Vec。
 */
(function (global) {
  "use strict";

  // -------------------------------------------------------------------
  // 前處理：文件 → 句子 → 詞 → 詞彙表 id 序列
  // -------------------------------------------------------------------
  function buildCorpus(texts, opts) {
    opts = opts || {};
    const removeStop = opts.removeStopwords !== false;
    const useStem = !!opts.useStem;
    const minCount = opts.minCount || 3;

    const sentences = [];
    const counts = new Map();
    let rawTokens = 0;

    texts.forEach((text) => {
      IRCore.splitSentences(text || "").forEach((sent) => {
        let toks = IRCore.tokenize(sent);
        toks = removeStop ? IRCore.removeStopwords(toks) : toks.filter((t) => t.length > 1);
        if (useStem) toks = toks.map(IRCore.stem);
        if (!toks.length) return;
        rawTokens += toks.length;
        toks.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
        sentences.push(toks);
      });
    });

    const vocabEntries = Array.from(counts.entries())
      .filter(([, c]) => c >= minCount)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const vocab = vocabEntries.map((e) => e[0]);
    const freq = vocabEntries.map((e) => e[1]);
    const index = new Map(vocab.map((w, i) => [w, i]));

    const idList = [];
    const starts = [0];
    sentences.forEach((toks) => {
      let n = 0;
      toks.forEach((t) => {
        const id = index.get(t);
        if (id !== undefined) { idList.push(id); n++; }
      });
      if (n >= 2) starts.push(idList.length);
      else idList.length -= n; // 句子太短（< 2 詞）沒有上下文可學，丟掉
    });

    return {
      vocab, freq,
      ids: Int32Array.from(idList),
      sentStarts: Int32Array.from(starts),
      stats: {
        numDocs: texts.length,
        numSentences: starts.length - 1,
        rawTokens,
        trainTokens: idList.length,
        rawVocab: counts.size,
        vocab: vocab.length,
      },
      options: { removeStopwords: removeStop, useStem, minCount },
    };
  }

  // -------------------------------------------------------------------
  // 訓練核心（必須完全自給自足：會被 toString() 後塞進 Worker 執行）
  // -------------------------------------------------------------------
  function trainCore(data, post) {
    const ids = data.ids, starts = data.sentStarts, counts = data.freq;
    const V = counts.length, dim = data.dim, win = data.window;
    const negative = data.negative, epochs = data.epochs, lr0 = data.lr;
    const sample = data.sample, isSG = data.model === "sg";

    // xorshift32 亂數，固定種子讓結果可重現
    let seed = (data.seed >>> 0) || 20260927;
    function rnd() {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    }

    const Win = new Float32Array(V * dim);   // 輸入（詞）向量 —— 最後輸出的詞向量
    const Wout = new Float32Array(V * dim);  // 輸出（上下文）向量
    for (let i = 0; i < Win.length; i++) Win[i] = (rnd() - 0.5) / dim;

    // 負採樣用 unigram^0.75 查表
    const TABLE_SIZE = 1000000;
    const table = new Int32Array(TABLE_SIZE);
    let powSum = 0;
    for (let i = 0; i < V; i++) powSum += Math.pow(counts[i], 0.75);
    let wi = 0, acc = Math.pow(counts[0], 0.75) / powSum;
    for (let a = 0; a < TABLE_SIZE; a++) {
      table[a] = wi;
      if (a / TABLE_SIZE > acc && wi < V - 1) {
        wi++;
        acc += Math.pow(counts[wi], 0.75) / powSum;
      }
    }

    // 高頻詞次抽樣的保留機率
    let total = 0;
    for (let i = 0; i < V; i++) total += counts[i];
    const keep = new Float32Array(V);
    for (let i = 0; i < V; i++) {
      if (sample > 0) {
        const t = sample * total;
        keep[i] = Math.min(1, (Math.sqrt(counts[i] / t) + 1) * (t / counts[i]));
      } else keep[i] = 1;
    }

    const numSent = starts.length - 1;
    let maxLen = 0;
    for (let s = 0; s < numSent; s++) maxLen = Math.max(maxLen, starts[s + 1] - starts[s]);
    const sent = new Int32Array(maxLen);
    const neu1 = new Float32Array(dim);
    const neu1e = new Float32Array(dim);

    const totalWork = epochs * ids.length + 1;
    let processed = 0;
    let lr = lr0;
    const lossHistory = [];
    let examples = 0;          // 訓練樣本數：Skip-Gram 為（中心詞, 上下文詞）配對數；CBOW 為預測的中心詞數
    const t0 = Date.now();

    // 對一個（輸入向量 h, 目標 target）做一次 negative sampling 更新；
    // h 存在 H 陣列從 hOff 開始的位置；梯度累加到 neu1e。回傳 loss。
    function sgnsUpdate(H, hOff, target) {
      let loss = 0;
      for (let d = 0; d <= negative; d++) {
        let tgt, label;
        if (d === 0) { tgt = target; label = 1; }
        else {
          tgt = table[(rnd() * TABLE_SIZE) | 0];
          if (tgt === target) continue;
          label = 0;
        }
        const l2 = tgt * dim;
        let f = 0;
        for (let k = 0; k < dim; k++) f += H[hOff + k] * Wout[l2 + k];
        if (f > 15) f = 15; else if (f < -15) f = -15;
        const sig = 1 / (1 + Math.exp(-f));
        loss += label ? -Math.log(sig + 1e-10) : -Math.log(1 - sig + 1e-10);
        const g = (label - sig) * lr;
        for (let k = 0; k < dim; k++) {
          neu1e[k] += g * Wout[l2 + k];
          Wout[l2 + k] += g * H[hOff + k];
        }
      }
      return loss;
    }

    for (let ep = 0; ep < epochs; ep++) {
      let lossSum = 0, lossN = 0;
      for (let s = 0; s < numSent; s++) {
        // 次抽樣後的句子
        let len = 0;
        for (let p = starts[s]; p < starts[s + 1]; p++) {
          const w = ids[p];
          if (keep[w] >= 1 || rnd() < keep[w]) sent[len++] = w;
        }
        processed += starts[s + 1] - starts[s];
        lr = lr0 * Math.max(1e-4, 1 - processed / totalWork);

        for (let pos = 0; pos < len; pos++) {
          const center = sent[pos];
          const b = 1 + ((rnd() * win) | 0);          // 動態視窗 1..win
          const lo = Math.max(0, pos - b), hi = Math.min(len - 1, pos + b);

          if (isSG) {
            // Skip-gram：中心詞向量 → 預測每一個周圍詞
            const l1 = center * dim;
            for (let c = lo; c <= hi; c++) {
              if (c === pos) continue;
              neu1e.fill(0);
              lossSum += sgnsUpdate(Win, l1, sent[c]);
              lossN++;
              examples++;
              for (let k = 0; k < dim; k++) Win[l1 + k] += neu1e[k];
            }
          } else {
            // CBOW：周圍詞向量平均 → 預測中心詞
            neu1.fill(0);
            let cw = 0;
            for (let c = lo; c <= hi; c++) {
              if (c === pos) continue;
              const l = sent[c] * dim;
              for (let k = 0; k < dim; k++) neu1[k] += Win[l + k];
              cw++;
            }
            if (!cw) continue;
            for (let k = 0; k < dim; k++) neu1[k] /= cw;
            neu1e.fill(0);
            lossSum += sgnsUpdate(neu1, 0, center);
            lossN++;
            examples++;
            for (let c = lo; c <= hi; c++) {
              if (c === pos) continue;
              const l = sent[c] * dim;
              for (let k = 0; k < dim; k++) Win[l + k] += neu1e[k];
            }
          }
        }

        if (s % 250 === 0) {
          post({ type: "progress", epoch: ep + 1, epochs, progress: processed / totalWork,
                 loss: lossN ? lossSum / lossN : 0, lr, elapsed: Date.now() - t0 });
        }
      }
      lossHistory.push(lossN ? lossSum / lossN : 0);
      post({ type: "epoch", epoch: ep + 1, epochs, loss: lossHistory[ep], elapsed: Date.now() - t0 });
    }
    post({ type: "done", vectors: Win, lossHistory, examples, elapsed: Date.now() - t0 }, [Win.buffer]);
  }

  // -------------------------------------------------------------------
  // 啟動訓練（Worker 優先）
  // -------------------------------------------------------------------
  let currentWorker = null;

  function train(corpus, params, onMessage) {
    const payload = Object.assign({
      ids: corpus.ids, sentStarts: corpus.sentStarts, freq: corpus.freq,
    }, params);

    return new Promise((resolve, reject) => {
      function handle(msg) {
        if (msg.type === "done") {
          currentWorker = null;
          resolve(new Model(corpus, msg.vectors, params, msg));
        } else if (onMessage) onMessage(msg);
      }

      let worker = null;
      try {
        const src = `"use strict";\nconst trainCore = ${trainCore.toString()};\n` +
          `self.onmessage = (e) => { try { trainCore(e.data, (m, t) => self.postMessage(m, t)); }` +
          ` catch (err) { self.postMessage({ type: "error", message: String(err && err.message || err) }); } };`;
        const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        worker = new Worker(url);
        URL.revokeObjectURL(url);
      } catch (e) {
        worker = null;
      }

      if (worker) {
        currentWorker = worker;
        worker.onmessage = (e) => {
          if (e.data.type === "error") { currentWorker = null; worker.terminate(); reject(new Error(e.data.message)); }
          else handle(e.data);
        };
        worker.onerror = (e) => { currentWorker = null; reject(new Error(e.message || "Worker error")); };
        worker.postMessage(payload);
      } else {
        // 後備方案：主執行緒同步訓練（頁面會暫時停止回應）
        setTimeout(() => {
          try { trainCore(payload, handle); } catch (err) { reject(err); }
        }, 30);
      }
    });
  }

  function cancel() {
    if (currentWorker) {
      currentWorker.terminate();
      currentWorker = null;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // 訓練完成的模型：查詢相似詞、類比、PCA 投影、匯出
  // -------------------------------------------------------------------
  function Model(corpus, rawVectors, params, info) {
    this.vocab = corpus.vocab;
    this.freq = corpus.freq;
    this.options = corpus.options;
    this.stats = corpus.stats;
    this.params = params;
    this.dim = params.dim;
    this.lossHistory = info.lossHistory || [];
    this.elapsed = info.elapsed || 0;
    this.examples = info.examples || 0;
    this.raw = rawVectors;
    this.index = new Map(this.vocab.map((w, i) => [w, i]));

    // 預先 L2 正規化，之後 cosine 相似度 = 內積
    const V = this.vocab.length, D = this.dim;
    this.vecs = new Float32Array(V * D);
    for (let i = 0; i < V; i++) {
      let n = 0;
      for (let k = 0; k < D; k++) n += rawVectors[i * D + k] ** 2;
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < D; k++) this.vecs[i * D + k] = rawVectors[i * D + k] / n;
    }
  }

  Model.prototype.lookup = function (word) {
    if (!word) return undefined;
    let w = String(word).toLowerCase().trim();
    let id = this.index.get(w);
    if (id === undefined && this.options.useStem) id = this.index.get(IRCore.stem(w));
    if (id === undefined && !this.options.useStem) {
      // 模型用原始詞形訓練時，也試試看常見的複數/單數變化
      id = this.index.get(w.replace(/s$/, "")) ?? this.index.get(w + "s");
    }
    return id;
  };

  Model.prototype.vectorOf = function (id) {
    return this.vecs.subarray(id * this.dim, (id + 1) * this.dim);
  };

  Model.prototype.nearestToVector = function (vec, k, exclude) {
    const V = this.vocab.length, D = this.dim;
    let norm = 0;
    for (let d = 0; d < D; d++) norm += vec[d] * vec[d];
    norm = Math.sqrt(norm) || 1;
    const best = [];
    for (let i = 0; i < V; i++) {
      if (exclude && exclude.has(i)) continue;
      let s = 0;
      const off = i * D;
      for (let d = 0; d < D; d++) s += this.vecs[off + d] * vec[d];
      s /= norm;
      if (best.length < k || s > best[best.length - 1].score) {
        best.push({ word: this.vocab[i], id: i, score: s, freq: this.freq[i] });
        best.sort((x, y) => y.score - x.score);
        if (best.length > k) best.pop();
      }
    }
    return best;
  };

  // 兩個詞的 cosine 相似度（向量已正規化，故為內積）
  Model.prototype.similarity = function (a, b) {
    const ia = this.lookup(a), ib = this.lookup(b);
    if (ia === undefined || ib === undefined) return null;
    const va = this.vectorOf(ia), vb = this.vectorOf(ib);
    let s = 0;
    for (let k = 0; k < this.dim; k++) s += va[k] * vb[k];
    return s;
  };

  // 模型的簡短名稱，例如「Skip-Gram · d100 · w5」
  Model.prototype.describe = function () {
    const p = this.params, o = this.options;
    let s = `${p.model === "sg" ? "Skip-Gram" : "CBOW"} · d${p.dim} · w${p.window}`;
    if (o.minCount !== 5) s += ` · min${o.minCount}`;
    if (p.epochs !== 5) s += ` · ep${p.epochs}`;
    if (p.negative !== 5) s += ` · neg${p.negative}`;
    if (!o.removeStopwords) s += " · 含停用詞";
    if (o.useStem) s += " · Porter";
    return s;
  };

  Model.prototype.mostSimilar = function (word, k) {
    const id = this.lookup(word);
    if (id === undefined) return null;
    return this.nearestToVector(this.vectorOf(id), k || 10, new Set([id]));
  };

  // -------------------------------------------------------------------
  // 模型的存檔與載入：metadata（JSON）+ 原始向量（Float32Array）分開存放。
  // 用於：① 專案內建的預設模型（web/data/w2v-default.json + .bin）
  //       ② 重新訓練後存進 IndexedDB 的模型
  // -------------------------------------------------------------------
  Model.prototype.toStorable = function () {
    return {
      meta: {
        version: 1,
        vocab: this.vocab,
        freq: this.freq,
        options: this.options,
        stats: this.stats,
        params: this.params,
        lossHistory: this.lossHistory,
        elapsed: this.elapsed,
        examples: this.examples,
        label: this.label || null,
        topWords: this.vocab.slice(0, 20).map((w, i) => [w, this.freq[i]]),
        trainedAt: this.trainedAt || new Date().toISOString(),
        source: this.source || "trained",
        signature: this.signature || null,
      },
      vectors: this.raw,
    };
  };

  function fromStored(meta, vectors) {
    const corpusLike = { vocab: meta.vocab, freq: meta.freq, options: meta.options, stats: meta.stats };
    const vec = vectors instanceof Float32Array ? vectors : new Float32Array(vectors);
    if (vec.length !== meta.vocab.length * meta.params.dim) throw new Error("向量大小與詞彙表不符");
    const m = new Model(corpusLike, vec, meta.params, { lossHistory: meta.lossHistory, elapsed: meta.elapsed, examples: meta.examples });
    m.label = meta.label || null;
    m.trainedAt = meta.trainedAt;
    m.source = meta.source;
    m.signature = meta.signature;
    return m;
  }

  global.Word2Vec = {
    buildCorpus,
    train,
    trainCore, // 給離線腳本（scripts/build_default_assets.js）直接呼叫
    cancel,
    Model,
    fromStored,
    current: null, // 目前使用中的模型
  };
})(window);
