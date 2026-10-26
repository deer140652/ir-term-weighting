#!/usr/bin/env node
/*
 * sample_pmids.js
 * ---------------
 * 從 PubMed「Save → Format: Abstract」匯出的 .txt 中，以固定種子隨機抽出 N 篇
 * 「有摘要」的文獻（摘要至少 20 個字），輸出 PMID 清單（一行一個，依數字排序）。
 * 使用與網頁相同的解析器（web/assets/js/pubmed-abstract-txt-parser.js）。
 *
 * 用法：
 *   node scripts/sample_pmids.js <PubMed 摘要.txt> --n 1000 --seed 20261001 --out data/pmids_1000.txt
 *   node scripts/sample_pmids.js <PubMed 摘要.txt> --keep data/pmids_1000.txt --n 1000 --seed 20261001 --out data/pmids_1000.txt
 *
 *   --keep：保留既有清單中仍然有效的 PMID，只從其餘的有效文獻中隨機遞補不足的篇數
 */
"use strict";

const fs = require("fs");
const path = require("path");

global.window = global;
const JS = path.join(__dirname, "..", "web", "assets", "js");
require(path.join(JS, "ir-core.js"));
require(path.join(JS, "pubmed-abstract-txt-parser.js"));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// xorshift32 + Fisher–Yates：固定種子，結果可重現
function shuffled(items, seed) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function main() {
  const input = process.argv[2];
  const n = parseInt(arg("--n", "1000"), 10);
  const seed = parseInt(arg("--seed", "20261001"), 10);
  const out = arg("--out", null);
  const keepFile = arg("--keep", null);
  if (!input || input.startsWith("--")) {
    console.error("用法：node scripts/sample_pmids.js <PubMed 摘要.txt> [--n 1000] [--seed 20261001] [--keep 既有清單.txt] [--out 輸出.txt]");
    process.exit(1);
  }

  const text = fs.readFileSync(input, "utf8").replace(/\r\n?/g, "\n");
  const docs = PubmedAbstractTxtParser.parsePubmedAbstractTxt(text, "doc").docs;
  const words = (s) => (s || "").split(/\s+/).filter(Boolean).length;
  const valid = new Set(docs.filter((d) => d.pmid && words(d.abstract) >= 20).map((d) => d.pmid));
  console.log(`解析 ${docs.length} 筆，有摘要（≥ 20 字）的 ${valid.size} 筆`);

  let kept = [];
  if (keepFile) {
    const old = fs.readFileSync(keepFile, "utf8").split(/\s+/).filter(Boolean);
    kept = old.filter((p) => valid.has(p));
    const dropped = old.filter((p) => !valid.has(p));
    console.log(`既有清單 ${old.length} 篇：保留 ${kept.length} 篇，移除沒有摘要的 ${dropped.length} 篇${dropped.length ? `（${dropped.join(", ")}）` : ""}`);
  }
  const keptSet = new Set(kept);
  const pool = Array.from(valid).filter((p) => !keptSet.has(p)).sort((a, b) => Number(a) - Number(b));
  const need = Math.max(0, n - kept.length);
  const added = shuffled(pool, seed).slice(0, need);
  if (keepFile) console.log(`以 seed ${seed} 遞補 ${added.length} 篇${added.length ? `（${added.join(", ")}）` : ""}`);

  const result = kept.concat(added).sort((a, b) => Number(a) - Number(b));
  const textOut = result.join("\n") + "\n";
  if (out) {
    fs.writeFileSync(out, textOut);
    console.log(`→ ${out}（${result.length} 篇）`);
  } else {
    process.stdout.write(textOut);
  }
}

main();
