"""
fetch_by_pmid_list.py
----------------------
Reads a TXT file of PMIDs (one per line, per the course assignment format)
and downloads their PubMed/MEDLINE abstract records (title, structured
abstract, authors, journal, year -- no full article body, since PubMed
itself never carries that, and this assignment only needs the abstract
anyway), saving the result into data/downloads/ (upload them with the web page's "上傳 XML 文件").

This is the OFFLINE fallback for the browser's "用 PMID 清單抓取文獻" feature
in web/index.html -- same NCBI endpoint, same logic, but running from a
normal Python environment isn't subject to a browser's CORS restrictions,
so use this if the in-browser fetch fails on your network.

Usage:
    pip install requests
    python3 scripts/fetch_by_pmid_list.py pmids.txt

Then upload the downloaded XML files with the web page's "上傳 XML 文件" panel.
"""

import os
import sys

try:
    import requests
except ImportError:
    sys.exit("This script needs the 'requests' package: pip install requests")

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "downloads")
EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
TOOL_NAME = "xml-fulltext-search-classroom-tool"
CONTACT_EMAIL = "example@example.com"  # NCBI asks for a contact email; feel free to use your own
BATCH_SIZE = 150


def extract_pmids(text: str):
    tokens = [t.strip() for t in text.replace(",", " ").replace(";", " ").split()]
    seen = []
    for t in tokens:
        if t.isdigit() and 1 <= len(t) <= 9 and t not in seen:
            seen.append(t)
    return seen


def chunk(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def efetch_pubmed_abstracts(ids):
    if not ids:
        return None
    params = {
        "db": "pubmed",
        "id": ",".join(ids),
        "retmode": "xml",
        "tool": TOOL_NAME,
        "email": CONTACT_EMAIL,
    }
    resp = requests.get(EFETCH_URL, params=params, timeout=60)
    resp.raise_for_status()
    return resp.content


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    txt_path = sys.argv[1]
    if not os.path.isfile(txt_path):
        sys.exit(f"File not found: {txt_path}")

    with open(txt_path, "r", encoding="utf-8", errors="replace") as f:
        pmids = extract_pmids(f.read())

    if not pmids:
        sys.exit("No PMIDs found in that file (expected one number per line).")

    print(f"Found {len(pmids)} PMIDs. Fetching PubMed abstract records...")
    os.makedirs(OUT_DIR, exist_ok=True)

    saved = 0
    for i, group in enumerate(chunk(pmids, BATCH_SIZE)):
        content = efetch_pubmed_abstracts(group)
        if content:
            out_path = os.path.join(OUT_DIR, f"pmid_batch_{i + 1}.xml")
            with open(out_path, "wb") as f:
                f.write(content)
            print(f"  \u2713 saved {out_path} ({len(group)} PMIDs)")
            saved += len(group)

    print(f"\nDone: fetched abstract records for {saved} PMID(s).")
    print("Now upload the XML files in data/downloads/ with the web page's \"上傳 XML 文件\" panel.")


if __name__ == "__main__":
    main()
