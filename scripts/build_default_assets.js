#!/usr/bin/env node
/*
 * build_default_assets.js
 * -----------------------
 * 用 PubMed「Save → Format: Abstract」匯出的 .txt，產生網站開啟時自動載入的：
 *   1. web/data/corpus.json      —— 基礎語料庫
 *   2. web/data/w2v-default-sg.json / .bin   —— 預設 Skip-Gram 模型（詞彙表與參數 / Float32 向量）
 *   3. web/data/w2v-default-cbow.json / .bin —— 預設 CBOW 模型（參數與 Skip-Gram 相同，便於比較）
 *
 * 直接載入網頁端的 ir-core.js、pubmed-abstract-txt-parser.js、word2vec.js，
 * 所以解析結果、前處理與訓練演算法都跟瀏覽器中完全相同。
 *
 * 用法（在專案根目錄執行，需要 Node.js 16 以上）：
 *   node scripts/build_default_assets.js <PubMed 摘要.txt> [--pmids 清單.txt] [--epochs 5] [--skip-model]
 *
 *   --pmids：只保留清單中的 PMID（一行一個），例如 data/pmids_1000.txt
 *
 * 換了語料之後一定要重新產生模型：網頁會比對語料的「簽章」，
 * 不一致時不會載入預設模型（避免模型與文獻對不上）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const JS = path.join(ROOT, "web", "assets", "js");
const OUT = path.join(ROOT, "web", "data");

// ---- 讓瀏覽器端的程式可以在 Node 中執行 ----
global.window = global;
require(path.join(JS, "ir-core.js"));
require(path.join(JS, "pubmed-abstract-txt-parser.js"));
require(path.join(JS, "word2vec.js"));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// 語料簽章：文獻數 + 依 id 排序後的 FNV-1a 雜湊（網頁端 app.js 用同一個算法）
function corpusSignature(ids) {
  let h = 0x811c9dc5;
  ids.slice().sort().forEach((id) => {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x7c; h = Math.imul(h, 0x01000193) >>> 0;
  });
  return `${ids.length}-${h.toString(16)}`;
}

function main() {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("用法：node scripts/build_default_assets.js <PubMed 摘要.txt> [--pmids 清單.txt] [--epochs 5] [--skip-model]");
    process.exit(1);
  }
  const text = fs.readFileSync(input, "utf8").replace(/\r\n?/g, "\n");
  const parsed = PubmedAbstractTxtParser.parsePubmedAbstractTxt(text, "doc");
  if (!parsed.ok) throw new Error("無法解析檔案：" + parsed.error);

  // 依 PMID 清單篩選（選用）
  const pmidFile = arg("--pmids", null);
  const allow = pmidFile
    ? new Set(fs.readFileSync(pmidFile, "utf8").split(/\s+/).map((x) => x.trim()).filter(Boolean))
    : null;

  // 去除重複、略過沒有摘要的紀錄（評論、勘誤等）
  const seen = new Set();
  let noAbstract = 0, dup = 0;
  const docs = [];
  parsed.docs.forEach((d) => {
    if (allow && !allow.has(d.pmid)) return;
    if (!d.abstract || d.abstract.split(/\s+/).length < 20) { noAbstract++; return; }
    if (seen.has(d.id)) { dup++; return; }
    seen.add(d.id);
    // 只保留網頁需要的欄位；full_text / abstract_sections 等在網頁載入時再補回
    docs.push({
      id: d.id, pmid: d.pmid, pmcid: d.pmcid, title: d.title,
      journal: d.journal, year: d.year, authors: d.authors, abstract: d.abstract,
    });
  });

  const signature = corpusSignature(docs.map((d) => d.id));
  fs.mkdirSync(OUT, { recursive: true });
  const corpus = {
    source: path.basename(input),
    built_at: new Date().toISOString(),
    signature,
    corpus_stats: { num_documents: docs.length },
    documents: docs,
  };
  fs.writeFileSync(path.join(OUT, "corpus.json"), JSON.stringify(corpus));
  console.log(`語料：解析 ${parsed.docs.length} 筆${allow ? `，依 PMID 清單（${allow.size} 筆）篩選` : ""}，略過無摘要 ${noAbstract} 筆、重複 ${dup} 筆，保留 ${docs.length} 篇`);
  if (allow && docs.length !== allow.size) console.warn(`  注意：清單中有 ${allow.size - docs.length} 個 PMID 沒有對應到可用的文獻`);
  console.log(`  → web/data/corpus.json（${(fs.statSync(path.join(OUT, "corpus.json")).size / 1e6).toFixed(1)} MB），簽章 ${signature}`);

  if (process.argv.includes("--skip-model")) return;

  // ---- 訓練預設 Word2Vec 模型：Skip-Gram 與 CBOW 各一個（參數相同，便於比較）----
  const texts = docs.map((d) => IRCore.joinWithPeriod(d.title || "", d.abstract || ""));
  const corpusW2V = Word2Vec.buildCorpus(texts, { removeStopwords: true, useStem: false, minCount: 5 });
  console.log(`Word2Vec 前處理：${corpusW2V.stats.numSentences} 句、訓練詞元 ${corpusW2V.ids.length}、詞彙 ${corpusW2V.vocab.length}`);
  const epochs = parseInt(arg("--epochs", "5"), 10);

  ["w2v-default.json", "w2v-default.bin"].forEach((f) => {
    const old = path.join(OUT, f);
    if (fs.existsSync(old)) fs.unlinkSync(old);   // 舊版的單一預設模型檔
  });

  ["sg", "cbow"].forEach((model) => {
    const params = {
      model, dim: 100, window: 5, negative: 5, epochs,
      lr: model === "sg" ? 0.025 : 0.05,
      sample: 0.001, seed: 20260927,
    };
    let vectors = null, lossHistory = [], elapsed = 0, examples = 0;
    Word2Vec.trainCore(Object.assign({ ids: corpusW2V.ids, sentStarts: corpusW2V.sentStarts, freq: corpusW2V.freq }, params), (msg) => {
      if (msg.type === "epoch") console.log(`  [${model}] epoch ${msg.epoch} 平均 loss ${msg.loss.toFixed(4)}`);
      else if (msg.type === "done") { vectors = msg.vectors; lossHistory = msg.lossHistory; elapsed = msg.elapsed; examples = msg.examples; }
    });
    const m = new Word2Vec.Model(corpusW2V, vectors, params, { lossHistory, elapsed, examples });
    m.source = "default";
    m.signature = signature;
    m.trainedAt = new Date().toISOString();
    m.label = m.describe();
    const stored = m.toStorable();
    fs.writeFileSync(path.join(OUT, `w2v-default-${model}.json`), JSON.stringify(stored.meta));
    const buf = Buffer.from(stored.vectors.buffer, stored.vectors.byteOffset, stored.vectors.byteLength);
    fs.writeFileSync(path.join(OUT, `w2v-default-${model}.bin`), buf);
    console.log(`  [${model}] 完成：${(elapsed / 1000).toFixed(1)} 秒、訓練樣本 ${examples}，→ w2v-default-${model}.json + .bin（${(buf.length / 1e6).toFixed(1)} MB）`);
    ["semaglutide", "nausea"].forEach((w) => {
      const r = m.mostSimilar(w, 5);
      if (r) console.log(`    ${w} → ${r.map((x) => x.word).join(", ")}`);
    });
  });
}

main();
