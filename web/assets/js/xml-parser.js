/*
 * xml-parser.js
 * -------------
 * Parses a PubMed Central (PMC) JATS-style XML document string in the
 * browser (using the native DOMParser — no library, no server round-trip)
 * into the same document shape as the pre-built corpus (web/data/corpus.json). This powers the "Upload your own XML" feature: a
 * file never leaves the browser, it's parsed and indexed entirely
 * client-side.
 */
(function (global) {
  "use strict";

  function textOf(el) {
    // Flatten all text content of an element, joining pieces from
    // different child nodes/tags with a space so text from adjacent tags
    // (e.g. a structured abstract's <title>Background</title><p>...</p>)
    // doesn't run together into one word.
    if (!el) return "";
    const parts = [];
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3) {          // TEXT_NODE
        parts.push(node.nodeValue);
      } else if (node.nodeType === 1) {   // ELEMENT_NODE
        parts.push(textOf(node));
      }
    });
    return parts.join(" ");
  }

  function collapseWs(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function directChildren(el, tagName) {
    if (!el) return [];
    return Array.from(el.children || []).filter((c) => c.tagName && c.tagName.toLowerCase() === tagName);
  }

  function extractOneAbstractSec(sec) {
    const titleEl = directChildren(sec, "title")[0];
    let paras = directChildren(sec, "p");
    if (!paras.length) paras = Array.from(sec.querySelectorAll("p"));
    const text = collapseWs(paras.map((p) => textOf(p)).join(" "));
    return { title: collapseWs(textOf(titleEl)), text };
  }

  // These abstract-type values are secondary/redundant blurbs, not the real
  // scholarly abstract — e.g. Wiley journals often ship an <abstract
  // abstract-type="toc"> containing a reworded, shortened restatement of the
  // main abstract, meant for a journal's table-of-contents listing, not for
  // the article itself. Skip these so they don't get shown as a duplicate
  // "second abstract". Types like "summary" (e.g. ASM's IMPORTANCE
  // statements) are genuinely distinct scholarly content and are kept.
  const SKIP_ABSTRACT_TYPES = new Set(["toc", "graphical", "teaser", "short", "web-summary", "highlights", "key points", "keypoints"]);

  function extractAllAbstracts(scopeEl) {
    // A single article can have MORE THAN ONE <abstract> element — e.g.
    // many journals ship a plain main <abstract> PLUS a separate
    // <abstract abstract-type="summary"><title>IMPORTANCE</title>...</abstract>
    // as a sibling, not nested inside the first one. querySelector() only
    // ever returns the FIRST match, which would silently drop the second
    // abstract entirely — so this walks ALL <abstract> elements within the
    // given scope (one article) instead.
    const allAbstractEls = Array.from(scopeEl.getElementsByTagName("abstract"));
    const filteredEls = allAbstractEls.filter((el) => !SKIP_ABSTRACT_TYPES.has((el.getAttribute("abstract-type") || "").toLowerCase()));
    // Only apply the skip-list if it still leaves at least one abstract —
    // if a document's ONLY <abstract> happens to carry one of these type
    // labels (some journals tag their real, sole abstract this way, not
    // just redundant secondary blurbs), filtering it out would leave
    // nothing and wrongly trigger the whole-document generic fallback.
    // Better to keep a possibly-redundant abstract than lose the real one.
    const abstractEls = filteredEls.length ? filteredEls : allAbstractEls;
    const sections = [];
    abstractEls.forEach((abstractEl) => {
      const ownTitleEl = directChildren(abstractEl, "title")[0];
      const ownParas = directChildren(abstractEl, "p");
      const secs = directChildren(abstractEl, "sec");

      // 1. Text sitting DIRECTLY under <abstract> (a <p>, possibly preceded
      //    by its own <title>) — this is the "ABSTRACT" part in documents
      //    that mix a plain lead paragraph with a separate <sec> for e.g.
      //    "IMPORTANCE", both inside the SAME <abstract> element.
      if (ownParas.length) {
        const text = collapseWs(ownParas.map((p) => textOf(p)).join(" "));
        if (text) sections.push({ title: collapseWs(textOf(ownTitleEl)), text });
      }

      // 2. Any <sec> children, each becomes its own labeled section.
      secs.forEach((sec) => {
        const s = extractOneAbstractSec(sec);
        if (s.text) sections.push(s);
      });

      // 3. Neither a direct <p> nor a <sec> was found under this <abstract>
      //    (e.g. text sits even deeper, or in some other wrapper) — fall
      //    back to that abstract's whole flattened text so nothing is lost.
      if (!ownParas.length && !secs.length) {
        const text = collapseWs(textOf(abstractEl));
        if (text) sections.push({ title: collapseWs(textOf(ownTitleEl)), text });
      }
    });
    return sections;
  }

  /**
   * Parses ONE <article> element (or an equivalent scope for a generic,
   * non-JATS XML file) into a document object.
   *
   * Two-tier strategy:
   *  1. If it looks like a JATS-style journal article (has
   *     <article-title>/<abstract>/<body><p>...), extract that structure
   *     for a nicer title/authors/abstract/paragraph breakdown.
   *  2. Otherwise, this is treated as a generic XML document: ALL of its
   *     text content is flattened and indexed as-is, so literally any
   *     well-formed XML file can be uploaded and searched — JATS just
   *     happens to render more richly (structured metadata) when present.
   *
   * @param {Element} scopeEl the <article> element (or document root) to extract from
   * @param {string} fallbackId id/title to use if none is found in the XML
   * @returns {{ok:true, doc:object}|{ok:false, error:string}}
   */
  function extractOneArticle(scopeEl, fallbackId) {
    const titleEl = scopeEl.querySelector("article-title") || scopeEl.querySelector("title");
    const pmcEl = scopeEl.querySelector('article-id[pub-id-type="pmcid"]') || scopeEl.querySelector('article-id[pub-id-type="pmc"]');
    const pmidEl = scopeEl.querySelector('article-id[pub-id-type="pmid"]');
    const journalEl = scopeEl.querySelector("journal-title");
    const yearEl = scopeEl.querySelector("pub-date year") || scopeEl.querySelector("year");

    const authors = Array.from(scopeEl.querySelectorAll('contrib[contrib-type="author"]')).map((c) => {
      const given = textOf(c.querySelector("given-names"));
      const surname = textOf(c.querySelector("surname"));
      return [given, surname].filter(Boolean).join(" ");
    }).filter(Boolean);

    const keywords = Array.from(scopeEl.querySelectorAll("kwd")).map((k) => collapseWs(textOf(k)));

    const abstractSections = extractAllAbstracts(scopeEl);
    const abstract = abstractSections.map((s) => s.text).join(" ");

    let abstractText, bodyParas;

    if (abstract) {
      // Has a real <abstract> — per the assignment, only the abstract is
      // indexed, displayed, and matched against. Full article body text is
      // intentionally NOT extracted or used, even if <body><p> exists.
      abstractText = abstract;
      bodyParas = [];
    } else {
      // No abstract at all (a generic, non-article XML file, or a JATS
      // article missing <abstract>) -> fall back to indexing the WHOLE
      // document's flattened text, since there's no abstract to isolate.
      const wholeText = collapseWs(textOf(scopeEl));
      if (!wholeText) {
        return { ok: false, error: "這個 XML 檔案裡沒有找到任何文字內容可以索引。" };
      }
      abstractText = "";
      bodyParas = [wholeText];
    }

    const title = collapseWs(textOf(titleEl)) || fallbackId || ("文件_" + Date.now());
    const pmid = collapseWs(textOf(pmidEl));
    const pmcid = collapseWs(textOf(pmcEl));
    const id = pmcid || (pmid ? "PMID" + pmid : "") || fallbackId || ("UPLOAD_" + Date.now());
    const fullText = IRCore.joinWithPeriod(title, `${abstractText} ${bodyParas.join(" ")}`.trim());
    const stats = IRCore.computeStats(fullText);

    const doc = {
      id,
      pmid,
      pmcid,
      title,
      journal: collapseWs(textOf(journalEl)),
      year: collapseWs(textOf(yearEl)),
      authors,
      keywords,
      abstract: abstractText || (bodyParas[0] || ""),
      abstract_sections: abstractSections,
      num_paragraphs: bodyParas.length,
      body_paragraphs: bodyParas,
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
      is_generic_xml: !abstract,
    };

    return { ok: true, doc };
  }

  /**
   * @param {string} xmlText raw XML file contents
   * @param {string} fallbackId id/title to use if the XML has no <article-id>/<article-title>
   * @returns {{ok:true, docs:object[]}|{ok:false, error:string}}
   *
   * A single uploaded file usually contains ONE article, but NCBI's efetch
   * endpoint wraps results in a <pmc-articleset> root — and if that request
   * covered MULTIPLE PMC IDs at once, one file can contain SEVERAL <article>
   * elements. This splits each one into its own separate document instead
   * of mixing their content together (which is what happens if you scope
   * queries to the whole file instead of to each individual <article>).
   */
  /**
   * Parses ONE <PubmedArticle> element — this is NCBI's PubMed/MEDLINE
   * citation schema (used when efetch'ing db=pubmed), completely different
   * tag names from JATS. This is what you get for a PMID that has NO full
   * text in PMC: title + structured abstract + authors + journal/year, but
   * NO body paragraphs (PubMed itself never carries full article text).
   * Returns the SAME doc shape as extractOneArticle() so the rest of the
   * app (rendering, indexing, search) doesn't need to know the difference.
   */
  function extractOnePubmedArticle(articleEl, fallbackId) {
    const titleEl = articleEl.querySelector("ArticleTitle");
    const pmidEl = articleEl.querySelector("PMID");
    const journalEl = articleEl.querySelector("Journal Title") || articleEl.querySelector("Journal ISOAbbreviation");
    const yearEl = articleEl.querySelector("JournalIssue PubDate Year") || articleEl.querySelector("PubDate Year");
    // Even a plain PubMed/MEDLINE citation (db=pubmed) often carries a PMC
    // cross-reference in <PubmedData><ArticleIdList><ArticleId IdType="pmc">
    // -- worth surfacing even though we didn't fetch the full text.
    const pmcidEl = articleEl.querySelector('PubmedData > ArticleIdList > ArticleId[IdType="pmc"]');
    //const pmcidEl = articleEl.querySelector('ArticleId[IdType="pmc"]');

    const authors = Array.from(articleEl.querySelectorAll("AuthorList > Author")).map((a) => {
      const given = textOf(a.querySelector("ForeName"));
      const surname = textOf(a.querySelector("LastName"));
      const collective = textOf(a.querySelector("CollectiveName"));
      return [given, surname].filter(Boolean).join(" ") || collective;
    }).filter(Boolean);

    const keywords = Array.from(articleEl.querySelectorAll("KeywordList Keyword")).map((k) => collapseWs(textOf(k)));

    // PubMed structured abstracts use multiple <AbstractText Label="...">
    // siblings instead of JATS's <sec><title>. Each becomes its own section,
    // exactly like the ABSTRACT/IMPORTANCE sections from JATS documents.
    const abstractTextEls = Array.from(articleEl.querySelectorAll("Abstract > AbstractText"));
    const abstractSections = abstractTextEls.map((el) => ({
      title: collapseWs(el.getAttribute("Label") || ""),
      text: collapseWs(textOf(el)),
    })).filter((s) => s.text);
    const abstract = abstractSections.map((s) => s.text).join(" ");

    const title = collapseWs(textOf(titleEl)) || fallbackId || ("文件_" + Date.now());
    if (!title && !abstract) {
      // Truly nothing to show at all (no title, no abstract) -- this is
      // the only case worth rejecting outright.
      return { ok: false, error: "這篇 PubMed 記錄沒有標題也沒有摘要，無法建立文件。" };
    }
    const pmid = collapseWs(textOf(pmidEl)) || fallbackId;
    const pmcid = collapseWs(textOf(pmcidEl));
    // Per the assignment's abstract-only matching scope, a record with NO
    // abstract (common for short editorials/correspondence) is still kept
    // -- just with an empty abstract, so it's visible by title and doesn't
    // silently vanish from the corpus. It simply won't be findable by any
    // keyword search (nothing to match against) and shows blank content.
    const fullText = abstract ? IRCore.joinWithPeriod(title, abstract) : title;
    const stats = IRCore.computeStats(fullText);

    const doc = {
      id: "PMID" + (pmid || fallbackId || Date.now()),
      pmid,
      pmcid,
      title,
      journal: collapseWs(textOf(journalEl)),
      year: collapseWs(textOf(yearEl)),
      authors,
      keywords,
      abstract,
      abstract_sections: abstractSections,
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
      is_pubmed_abstract_only: true, // no full text was available in PMC
    };

    return { ok: true, doc };
  }

  function parseArticleXML(xmlText, fallbackId) {
    let xdoc;
    try {
      const parser = new DOMParser();
      xdoc = parser.parseFromString(xmlText, "application/xml");
      const perr = xdoc.querySelector("parsererror");
      if (perr) return { ok: false, error: "這個檔案不是格式正確的 XML。" };
    } catch (e) {
      return { ok: false, error: "無法解析 XML：" + e.message };
    }

    const root = xdoc.documentElement;
    if (!root) return { ok: false, error: "找不到 XML 的根元素。" };

    // Detect which schema this file uses: JATS journal-article (<article>),
    // PubMed/MEDLINE citation (<PubmedArticle>), or neither (generic XML).
    let articleEls, extractFn;
    const jatsEls = (root.tagName && root.tagName.toLowerCase() === "article")
      ? [root] : Array.from(xdoc.getElementsByTagName("article"));
    const pubmedEls = Array.from(xdoc.getElementsByTagName("PubmedArticle"));

    if (jatsEls.length) {
      articleEls = jatsEls;
      extractFn = extractOneArticle;
    } else if (pubmedEls.length) {
      articleEls = pubmedEls;
      extractFn = extractOnePubmedArticle;
    } else {
      articleEls = [root]; // not a recognized schema -> generic single doc
      extractFn = extractOneArticle;
    }

    const multiple = articleEls.length > 1;
    const docs = [];
    const errors = [];
    articleEls.forEach((articleEl, i) => {
      const id = multiple ? `${fallbackId}_${i + 1}` : fallbackId;
      const result = extractFn(articleEl, id);
      if (result.ok) docs.push(result.doc);
      else errors.push(result.error);
    });

    if (!docs.length) {
      return { ok: false, error: errors[0] || "這個 XML 檔案裡沒有找到任何文字內容可以索引。" };
    }
    return { ok: true, docs };
  }

  global.PMCXmlParser = { parseArticleXML };
})(window);
