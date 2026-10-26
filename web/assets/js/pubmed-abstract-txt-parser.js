/*
 * pubmed-abstract-txt-parser.js
 * ------------------------------
 * Parses the plain-text file PubMed itself produces when you select search
 * results and use "Save" → Format: Abstract (Text). That file already
 * contains the full citation (title, authors, journal, year) AND the
 * abstract text for every record — so unlike pmid-fetcher.js, this needs
 * ZERO network requests and is completely unaffected by CORS, since
 * nothing is fetched from anywhere; the data is already right there in
 * the file the person uploaded.
 *
 * Each record looks like:
 *   1. Journal Abbrev. 2021 Jan 15;172:112752. doi: 10.1016/j.xxx.
 *
 *   Article Title Here.
 *
 *   Author A(1), Author B(2), Author C(2).
 *
 *   Author information:
 *   (1)Some affiliation...
 *
 *   The abstract paragraph goes here, potentially spanning several
 *   wrapped lines...
 *
 *   Copyright line (optional)
 *
 *   DOI: 10.1016/j.xxx
 *   PMCID: PMC1234567 (optional — not every record has one)
 *   PMID: 12345678 [Indexed for MEDLINE]
 *
 *   Conflict of interest statement: ... (optional)
 *
 * Records are numbered sequentially (1., 2., 3., ...) — splitting is
 * anchored on that exact sequential numbering (not just "any line
 * starting with digits+period") so a stray number inside an abstract's
 * prose can never be mistaken for a new record boundary.
 */
(function (global) {
  "use strict";

  function splitRecords(text) {
    const lines = text.split(/\r?\n/);
    const starts = [];
    let expected = 1;
    lines.forEach((line, i) => {
      const m = line.match(/^(\d+)\.\s/);
      if (m && parseInt(m[1], 10) === expected) {
        starts.push(i);
        expected++;
      }
    });
    const records = [];
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1] : lines.length;
      records.push(lines.slice(s, e).join("\n").trim());
    }
    return records;
  }

  // 作者名單的後備判斷（用在沒有「Author information:」區塊的紀錄）。
  // 名單由逗號或分號分隔，每個名字可能帶有多個單位編號，例如
  // "Sawamura T(1)(2)"、"Braga CBA(#)(2)"、"Holliday MW Jr(3)(4)"、
  // "de la Serna JB(5)"、"El Eid L(1)"，也可能夾著團體名稱
  // （"CranioGLP1_FORCE Group"）。
  const AFFIL_MARKS = /(?:\s*\([\d#*†‡§,\s]+\))+$/u;
  // allowGroupOnly：允許整個名單都是團體名稱（例如「XX Professional Committee, YY Association.」）
  function isAuthorListBlock(b, allowGroupOnly) {
    const oneLine = b.replace(/\s+/g, " ").trim();
    if (/^Author information:/i.test(oneLine)) return false;
    if (!/\.$/.test(oneLine)) return false;
    const parts = oneLine.replace(/\.$/, "").split(/\s*[,;]\s*/).filter(Boolean);
    if (!parts.length) return false;
    let personLike = 0, groupLike = 0;
    const ok = parts.every((part) => {
      const name = part.replace(AFFIL_MARKS, "").trim();
      if (!name || name.length > 100) return false;
      if (/\b(Group|Groups|Consortium|Collaborative|Collaborators|Investigators|Participants|Committee|Networks?|Study|Society|Association|Federation|Panel|Council|Programm?e?|Initiative|Team|Taskforce|Task Force)\b/i.test(name)) { groupLike++; return true; }
      // 姓氏（可含小寫的前置詞與連字號）＋ 1–5 個大寫縮寫，選擇性加上 Jr/Sr/II/III
      const m = name.match(/^[\p{L}'’.\- ]+?\s\p{Lu}{1,5}(?:\s(?:Jr|Sr|2nd|3rd|II|III|IV))?$/u);
      if (m) { personLike++; return true; }
      return /^[\p{Lu}][\p{L}'’\-]+(?:-[\p{L}]+)?$/u.test(name); // 只有單一名稱（例如 "Yi-Cai"）
    });
    return ok && (personLike > 0 || (allowGroupOnly && groupLike === parts.length));
  }

  function extractAuthorNames(block) {
    const oneLine = block.replace(/\s+/g, " ").trim().replace(/\.$/, "");
    return oneLine.replace(/^In:\s*/i, "").split(/\s*[,;]\s*/)
      .map((s) => s.replace(AFFIL_MARKS, "").trim())
      .filter(Boolean);
  }

  // 摘要段落結尾常夾帶的版權聲明（沒有用空行與摘要分開時）
  function stripTrailingNotices(text) {
    return text
      .replace(/\s+(?:Copyright\s*)?(?:©|\(c\)|Copyright)\s*(?:\d{4}|the author|the american|american|elsevier|springer|wiley|published)[^]{0,400}$/i, "")
      .replace(/\s+This (?:journal|article) is ©[^]{0,200}$/i, "")
      .replace(/\s+DOI:\s*10\.\S+\s*$/i, "")
      .trim();
  }

  const FOOTER_RE = /^(DOI:|PMCID:|PMID:|©|Copyright|Conflict of interest|Comment in|Comment on|Update of|Update in|Erratum|Retraction|Expression of concern|Publisher:)/i;
  // 作者名單之後、摘要之前的資訊區塊（直接移除，不是頁尾）
  const META_BLOCK_RE = /^(Author information:|Collaborators:|Investigators:)/i;

  function parseOneRecord(recordText, fallbackId) {
    const blocks = recordText.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length < 2) return { ok: false, error: "格式不完整，略過。" };

    const citationLine = blocks[0] || "";
    const pmidM = recordText.match(/PMID:\s*(\d+)/);
    const pmcidM = recordText.match(/PMCID:\s*(PMC\d+)/);
    const yearM = citationLine.match(/\b(19|20)\d{2}\b/);
    const journalM = citationLine.replace(/^\d+\.\s*/, "").match(/^(.+?)\.\s+(?:19|20)\d{2}/);

    let footerStart = blocks.findIndex((b, i) => i > 0 && FOOTER_RE.test(b));
    if (footerStart === -1) footerStart = blocks.length;

    // 線上書籍（例如 StatPearls）：第一行是「編號. 標題.」，第二個區塊是作者，
    // 接著是「In: 書名 [Internet]...」的出處區塊
    const isBook = isAuthorListBlock(blocks[1] || "") && blocks.slice(2, 5).some((b) => /^In:\s/.test(b));
    const title = isBook
      ? citationLine.replace(/^\d+\.\s*/, "").replace(/\s+/g, " ").trim()
      : (blocks[1] || "").replace(/\s+/g, " ").trim();

    let authors = isBook ? extractAuthorNames(blocks[1]) : [];
    // 先移除語言標註等中括號區塊（例如「[Article in English]」）與書籍出處區塊
    let bodyBlocks = blocks.slice(2, footerStart)
      .filter((b) => !/^\[.*\]$/.test(b.replace(/\s+/g, " ")))
      .filter((b) => !(isBook && /^In:\s/.test(b)));
    // 1) 依 PubMed 格式的結構判斷：作者名單一定緊接在「Collaborators:」或
    //    「Author information:」區塊之前
    const infoIdx = bodyBlocks.findIndex((b) => META_BLOCK_RE.test(b));
    if (infoIdx > 0) {
      authors = extractAuthorNames(bodyBlocks[infoIdx - 1]);
      bodyBlocks.splice(infoIdx - 1, 1);
    }
    bodyBlocks = bodyBlocks.filter((b) => !META_BLOCK_RE.test(b));
    // 2) 沒有 Author information 時，用名字格式判斷（只看摘要前的第一個區塊）
    //    （若整筆紀錄只有作者名單、沒有摘要，摘要就會是空的，之後會被略過）
    if (!authors.length && bodyBlocks.length >= 1 && isAuthorListBlock(bodyBlocks[0], bodyBlocks.length > 1)) {
      authors = extractAuthorNames(bodyBlocks[0]);
      bodyBlocks.shift();
    }
    bodyBlocks = bodyBlocks.filter((b) => !/^Author information:/i.test(b));
    bodyBlocks = bodyBlocks.filter((b) => !/^Comment in/i.test(b));
    bodyBlocks = bodyBlocks.filter((b) => !/^\[.*\]$/.test(b.replace(/\s+/g, " ")));

    const abstract = stripTrailingNotices(bodyBlocks.join(" ").replace(/\s+/g, " ").trim());

    if (!title) return { ok: false, error: "找不到標題，略過。" };

    const pmid = pmidM ? pmidM[1] : "";
    const pmcid = pmcidM ? pmcidM[1] : "";
    const fullText = IRCore.joinWithPeriod(title, abstract);
    const stats = IRCore.computeStats(fullText);

    const doc = {
      id: pmcid || (pmid ? "PMID" + pmid : fallbackId),
      pmid,
      pmcid,
      title,
      journal: journalM ? journalM[1].trim() : "",
      year: yearM ? yearM[0] : "",
      authors,
      keywords: [],
      abstract,
      abstract_sections: abstract ? [{ title: "", text: abstract }] : [],
      num_paragraphs: 0,
      body_paragraphs: [],
      full_text: fullText,
      stats: {
        num_characters: stats.num_characters,
        num_characters_no_spaces: stats.num_characters_no_spaces,
        num_words: stats.num_words,
        num_sentences: stats.num_sentences,
        avg_words_per_sentence: stats.avg_words_per_sentence,
        num_index_terms: stats.num_index_terms,
        num_unique_stems: stats.num_unique_stems,
      },
      sentences: stats.sentences,
      uploaded: true,
      is_generic_xml: false,
      is_pubmed_abstract_only: true,
    };
    return { ok: true, doc };
  }

  /**
   * @param {string} text raw contents of the .txt file
   * @param {string} fallbackId prefix used if a record has no PMID/PMCID
   * @returns {{ok:true, docs:object[]}|{ok:false, error:string}}
   */
  function parsePubmedAbstractTxt(text, fallbackId) {
    const records = splitRecords(text);
    if (!records.length) return { ok: false, error: "not_this_format" };

    const docs = [];
    records.forEach((r, i) => {
      const result = parseOneRecord(r, `${fallbackId}_${i + 1}`);
      if (result.ok) docs.push(result.doc);
    });

    if (!docs.length) return { ok: false, error: "not_this_format" };
    return { ok: true, docs };
  }

  /** Quick check used to auto-detect this format vs. a bare PMID list. */
  function looksLikePubmedAbstractTxt(text) {
    return /^\d+\.\s/m.test(text) && /PMID:\s*\d+/.test(text);
  }

  global.PubmedAbstractTxtParser = { parsePubmedAbstractTxt, looksLikePubmedAbstractTxt };
})(window);
