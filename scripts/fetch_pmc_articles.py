"""
fetch_pmc_articles.py
----------------------
OPTIONAL helper to download real PubMed Central Open-Access full-text XML
articles and drop them into data/downloads/ (upload them with the web page's "上傳 XML 文件").

Run this on your own machine (it needs internet access, which this
Claude/sandbox environment does not have). Usage:

    pip install requests
    python3 scripts/fetch_pmc_articles.py PMC7096066 PMC8425720 PMC9767445

Where the arguments are PMC IDs (with or without the "PMC" prefix) of
articles that are part of the PMC Open Access Subset (i.e. free full text,
not just abstract). You can find OA article IDs by searching
https://pmc.ncbi.nlm.nih.gov/ and filtering for "Open access", or by
searching https://www.ncbi.nlm.nih.gov/pmc/?term=<your topic> and checking
each article's license.

This uses NCBI's E-utilities efetch endpoint. Please respect NCBI's rate
limits (max 3 requests/second without an API key) -- this script already
sleeps between requests.
"""

import sys
import time
import os

try:
    import requests
except ImportError:
    sys.exit("This script needs the 'requests' package: pip install requests")

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "downloads")
EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"


def fetch_one(pmcid: str):
    pmcid = pmcid.upper()
    if not pmcid.startswith("PMC"):
        pmcid = "PMC" + pmcid
    params = {"db": "pmc", "id": pmcid, "rettype": "full", "retmode": "xml"}
    resp = requests.get(EFETCH_URL, params=params, timeout=30)
    resp.raise_for_status()
    if b"<article" not in resp.content:
        print(f"  ! {pmcid}: no full-text <article> found in response "
              f"(article may not be in the Open Access Subset). Skipped.")
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f"{pmcid}.xml")
    with open(out_path, "wb") as f:
        f.write(resp.content)
    print(f"  ✓ saved {out_path}")


def main():
    ids = sys.argv[1:]
    if not ids:
        sys.exit(__doc__)
    for pmcid in ids:
        print(f"Fetching {pmcid} ...")
        try:
            fetch_one(pmcid)
        except requests.HTTPError as e:
            print(f"  ! HTTP error for {pmcid}: {e}")
        time.sleep(0.4)  # stay under NCBI's rate limit
    print("\nDone. Now upload the XML files in data/downloads/ with the web page's \"上傳 XML 文件\" panel.")


if __name__ == "__main__":
    main()
