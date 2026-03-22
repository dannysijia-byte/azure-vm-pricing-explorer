/**
 * Local backend proxy for Azure VM SKU Explorer.
 * Handles Azure auth + API calls server-side to avoid browser CORS restrictions.
 * Uses Server-Sent Events (SSE) to stream live progress back to the browser.
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

// ── Azure helpers ─────────────────────────────────────────────────────────────

function httpsPost(hostname, pathStr, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req  = https.request(
      { hostname, path: pathStr, method: 'POST',
        headers: { 'Content-Length': data.length, ...headers } },
      res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(reqUrl, headers) {
  return new Promise((resolve, reject) => {
    // Pass URL as string directly — avoids url.URL re-decoding %20 to spaces
    const req = https.get(reqUrl, { headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
  });
}

async function getToken(tenantId, clientId, clientSecret) {
  const body = new url.URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://management.azure.com/.default',
  }).toString();

  const r = await httpsPost(
    'login.microsoftonline.com',
    `/${tenantId}/oauth2/v2.0/token`,
    body,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );

  const parsed = JSON.parse(r.body);
  if (r.status !== 200) throw new Error(parsed.error_description || JSON.stringify(parsed));
  return parsed.access_token;
}

// Fetch all SKU pages, calling onPage(skus, pageNum, total) after each page
async function fetchSkusStreaming(subscriptionId, token, onPage) {
  const allSkus = [];
  let nextUrl = `https://management.azure.com/subscriptions/${subscriptionId}`
    + `/providers/Microsoft.Compute/skus?api-version=2021-07-01`
    + `&$filter=resourceType%20eq%20'virtualMachines'`;
  let page = 0;

  while (nextUrl) {
    const r = await httpsGet(nextUrl, { Authorization: `Bearer ${token}` });
    if (r.status !== 200) throw new Error(`Azure API ${r.status}: ${r.body}`);
    const data = JSON.parse(r.body);
    const batch = data.value || [];
    allSkus.push(...batch);
    page++;
    nextUrl = data.nextLink || null;
    await onPage(allSkus.length, page, !!nextUrl);
  }
  return allSkus;
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Request handler ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  // Proxy for Azure Retail Prices API (avoids CORS)
  if (req.method === 'GET' && req.url.startsWith('/api/prices')) {
    const parsed = new url.URL(req.url, 'http://localhost');
    // If nextUrl param is provided, use it directly (for pagination)
    const nextUrlParam = parsed.searchParams.get('nextUrl');
    let azureUrl;
    if (nextUrlParam) {
      azureUrl = nextUrlParam;
    } else {
      // Forward original query string to Azure
      const qs = req.url.replace('/api/prices', '');
      azureUrl = `https://prices.azure.com/api/retail/prices${qs}`;
    }
    console.log(`[${new Date().toISOString()}] Proxying pricing: ${azureUrl.substring(0, 140)}...`);
    try {
      const r = await httpsGet(azureUrl, {});
      if (r.status !== 200) {
        res.writeHead(r.status, { 'Content-Type': 'application/json', ...corsHeaders });
        return res.end(r.body);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(r.body);
    } catch (e) {
      console.error('Pricing proxy error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // SSE streaming endpoint — POST body contains credentials
  if (req.method === 'POST' && req.url === '/api/skus') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      // Start SSE stream immediately
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        ...corsHeaders,
      });

      try {
        const { subscriptionId, tenantId, clientId, clientSecret } = JSON.parse(body);
        if (!subscriptionId || !tenantId || !clientId || !clientSecret) {
          sseWrite(res, 'error', { message: 'All fields are required.' });
          return res.end();
        }

        sseWrite(res, 'progress', { stage: 'auth', message: 'Authenticating with Azure...' });
        console.log(`[${new Date().toISOString()}] Auth for subscription ${subscriptionId}`);

        const token = await getToken(tenantId, clientId, clientSecret);
        sseWrite(res, 'progress', { stage: 'fetch', message: 'Fetching SKUs...', count: 0, page: 0 });

        const skus = await fetchSkusStreaming(subscriptionId, token, (count, page, hasMore) => {
          sseWrite(res, 'progress', {
            stage: 'fetch',
            message: `Fetched ${count.toLocaleString()} SKUs (page ${page})${hasMore ? '…' : ''}`,
            count,
            page,
          });
        });

        console.log(`  -> Done: ${skus.length} SKUs`);
        sseWrite(res, 'done', { skus });
        res.end();
      } catch (e) {
        console.error('Error:', e.message);
        sseWrite(res, 'error', { message: e.message });
        res.end();
      }
    });
    return;
  }

  // SSO endpoint — receives a delegated access token from MSAL, proxies to Azure
  if (req.method === 'POST' && req.url === '/api/skus-sso') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        ...corsHeaders,
      });

      try {
        const { subscriptionId, token } = JSON.parse(body);
        if (!subscriptionId || !token) {
          sseWrite(res, 'error', { message: 'subscriptionId and token are required.' });
          return res.end();
        }

        sseWrite(res, 'progress', { stage: 'fetch', message: 'Fetching SKUs via SSO token...', count: 0, page: 0 });
        console.log(`[${new Date().toISOString()}] SSO fetch for subscription ${subscriptionId}`);

        const skus = await fetchSkusStreaming(subscriptionId, token, (count, page, hasMore) => {
          sseWrite(res, 'progress', {
            stage: 'fetch',
            message: `Fetched ${count.toLocaleString()} SKUs (page ${page})${hasMore ? '…' : ''}`,
            count,
            page,
          });
        });

        console.log(`  -> SSO done: ${skus.length} SKUs`);
        sseWrite(res, 'done', { skus });
        res.end();
      } catch (e) {
        console.error('SSO Error:', e.message);
        sseWrite(res, 'error', { message: e.message });
        res.end();
      }
    });
    return;
  }

  // Static file server
  let reqPath = req.url === '/' ? 'index.html' : req.url.split('?')[0];
  // Serve MSAL.js from node_modules
  if (reqPath === '/msal-browser.min.js') {
    reqPath = 'node_modules/@azure/msal-browser/lib/msal-browser.min.js';
  }
  const filePath = path.join(__dirname, reqPath);
  const ext      = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Azure VM SKU Explorer running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.\n');
});
