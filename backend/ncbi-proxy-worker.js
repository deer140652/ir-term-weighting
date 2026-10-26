/*
 * ncbi-proxy-worker.js
 * ---------------------
 * A minimal backend, meant to run on Cloudflare Workers (free tier).
 *
 * WHY THIS EXISTS: NCBI's E-utilities / ID Converter APIs are designed to
 * be called from server-side scripts (their own docs only show Perl/
 * command-line examples), not directly from browser JavaScript — so a
 * browser calling them directly may get blocked by CORS. A backend calling
 * another backend is NEVER subject to CORS (that's a browser-only rule),
 * so this tiny proxy sits in between: the frontend calls THIS worker
 * (which does send proper CORS headers, since we control it), and this
 * worker calls NCBI on the frontend's behalf, then hands the response back.
 *
 * WHAT IT DOES: forwards a request to any URL under ncbi.nlm.nih.gov, and
 * nothing else — it's intentionally a narrow, single-purpose proxy, not an
 * open relay, so it only ever forwards to NCBI's own domains and refuses
 * everything else.
 *
 * === DEPLOYMENT (one-time setup, ~5 minutes) ===
 *   1. Go to https://dash.cloudflare.com/sign-up and create a free account.
 *   2. In the left sidebar, click "Workers & Pages".
 *   3. Click "Create" → "Create Worker". Give it any name (e.g. "ncbi-proxy").
 *   4. Click "Deploy" (this deploys Cloudflare's default template first).
 *   5. Click "Edit code" to open the online editor.
 *   6. Select all the default code and delete it, then paste in this
 *      ENTIRE file.
 *   7. Click "Save and Deploy".
 *   8. Copy the worker's URL shown at the top of the page — it looks like
 *      https://ncbi-proxy.<your-subdomain>.workers.dev
 *   9. Paste that URL into web/assets/js/pmid-fetcher.js, into the
 *      OWN_BACKEND_PROXY constant near the top of the file.
 *  10. Commit + push web/assets/js/pmid-fetcher.js so your deployed site
 *      picks up the change.
 *
 * That's it — no server to maintain, no credit card required for the free
 * tier, and it keeps running with no further action from you.
 */

const ALLOWED_HOSTS = new Set([
  "eutils.ncbi.nlm.nih.gov",
  "www.ncbi.nlm.nih.gov",
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return new Response("Missing ?url= parameter.", { status: 400, headers: corsHeaders() });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return new Response("That's not a valid URL.", { status: 400, headers: corsHeaders() });
  }

  if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
    return new Response(
      "This proxy only forwards requests to NCBI (eutils.ncbi.nlm.nih.gov / www.ncbi.nlm.nih.gov).",
      { status: 403, headers: corsHeaders() }
    );
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: { "User-Agent": "xml-fulltext-search-classroom-tool (Cloudflare Worker proxy)" },
    });
  } catch (e) {
    return new Response("Could not reach NCBI: " + e.message, { status: 502, headers: corsHeaders() });
  }

  const body = await upstream.arrayBuffer();
  const headers = corsHeaders();
  headers["Content-Type"] = upstream.headers.get("Content-Type") || "text/plain; charset=utf-8";

  return new Response(body, { status: upstream.status, headers });
}

export default {
  async fetch(request) {
    return handleRequest(request);
  },
};
