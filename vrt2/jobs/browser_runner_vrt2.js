#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// jobs/browser_runner_vrt2.js · CLAW VRT2 · v3.3 Browser Harness
//
// Long-running daemon. Launches a persistent Chromium profile via Playwright,
// polls the browser_tasks queue from the local server, executes each task,
// posts results back. Same architectural pattern as the Reddit project's
// reddit_agent.py, translated to Node.
//
// Persistent profile lives at: ~/CLAW/VRT2/.browser_profile/
// First-time setup requires manually navigating to claude.ai and logging in
// inside that profile so the session cookie is stored.
//
// Usage:
//   node jobs/browser_runner_vrt2.js              # daemon mode, headless
//   node jobs/browser_runner_vrt2.js --headed     # visible browser (debug)
//   node jobs/browser_runner_vrt2.js --once       # single iteration then exit
//   node jobs/browser_runner_vrt2.js --login      # interactive login mode
//
// Requires:
//   npm install playwright
//   npx playwright install chromium
// ════════════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { getETDateString } = require('../lib/dates');
const { PORT } = require('../lib/config');

// Load .env from project root
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  console.error('FATAL: playwright not installed');
  console.error('  cd ~/CLAW/VRT2 && npm install playwright');
  console.error('  npx playwright install chromium');
  process.exit(1);
}

// ── CONSTANTS ───────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, '.browser_profile');
const FINDINGS_DIR = path.join(ROOT, 'findings');
const LOG_DIR = path.join(ROOT, 'logs');
const SERVER_BASE = 'http://127.0.0.1:' + PORT;

const POLL_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const TASK_TIMEOUT_MS = 5 * 60 * 1000;
const VIEWPORT = { width: 1280, height: 800 };

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/147.0.0.0 Safari/537.36';

// Selectors for claude.ai semantic review tasks. These are likely to need
// updates when Anthropic ships UI changes — they live here as constants
// so the fix is a one-line edit.
const CLAUDE_AI = {
  NEW_CHAT_URL: 'https://claude.ai/new',
  // Selector candidates in order of preference. The runner tries each.
  INPUT_SELECTORS: [
    '[data-testid="chat-input"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ],
  SEND_BUTTON_SELECTORS: [
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[type="submit"]'
  ],
  RESPONSE_CONTAINER_SELECTORS: [
    'div.font-claude-response',
    '[class*="font-claude-response"]',
    '[data-message-author="assistant"]',
    'div[class*="font-claude"]'
  ],
  STREAMING_INDICATOR_SELECTORS: [
    'button[aria-label="Stop response"]',
    'button[aria-label*="Stop"]',
    '[data-streaming="true"]'
  ],
  LOGIN_INDICATOR_SELECTORS: [
    'input[name="email"]',
    'button:has-text("Sign in")',
    'a[href*="/login"]'
  ]
};

// ── ARG PARSING ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const HEADLESS = !args.includes('--headed');
const ONCE = args.includes('--once');
const LOGIN_MODE = args.includes('--login');

// ── LOGGING ─────────────────────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = '[' + ts + '] [' + level + '] ' + msg;
  console.log(line);
  const day = ts.slice(0, 10);
  const file = path.join(LOG_DIR, 'browser_runner-' + day + '.log');
  try { fs.appendFileSync(file, line + '\n'); } catch (e) {}
}

// ── HTTP HELPERS ────────────────────────────────────────────────────────
// HTTP helper with explicit 10s timeout. Previous version had no timeout,
// which meant a hung server would leave the promise unresolved forever.
function httpRequest(method, urlPath, body, timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  return new Promise(function(resolve, reject) {
    const url = new URL(SERVER_BASE + urlPath);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, function(res) {
      let chunks = '';
      res.on('data', function(c) { chunks += c; });
      res.on('end', function() {
        try {
          const parsed = chunks ? JSON.parse(chunks) : null;
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    // Request-level timeout — destroys the socket if the full exchange
    // doesn't complete within timeoutMs. This prevents hung promises.
    req.setTimeout(timeoutMs, function() {
      req.destroy(new Error('HTTP request timeout after ' + timeoutMs + 'ms: ' + method + ' ' + urlPath));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchNextTask() {
  const r = await httpRequest('GET', '/browser/queue');
  return r.body;
}

async function postResult(taskId, result) {
  const body = JSON.stringify({ task_id: taskId, ...result });
  return httpRequest('POST', '/browser/results', body);
}

async function postHeartbeat(state) {
  const body = JSON.stringify({
    daemon_name: 'browser_runner_vrt2',
    status: state.status || 'HEALTHY',
    current_task_id: state.current_task_id || null,
    tasks_completed_today: state.tasks_completed_today || 0,
    tasks_failed_today: state.tasks_failed_today || 0,
    notes: state.notes || null
  });
  try { await httpRequest('POST', '/browser/heartbeat', body); } catch (e) {}
}

// ── FINDINGS WRITER ─────────────────────────────────────────────────────
function findingsPathFor(task) {
  // v3.1.1 fix #A5: use ET date, not UTC. Findings written after ~8pm ET
  // would land in tomorrow's UTC date folder and get reviewed a day late.
  const date = getETDateString();
  const dir = path.join(FINDINGS_DIR, date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const hyp = task.hypothesis_id || 'misc';
  const filename = hyp + '_' + task.task_type + '_' + task.task_id + '.md';
  return path.join(dir, filename);
}

function writeFindings(task, content) {
  const filepath = findingsPathFor(task);
  const header = '# CLAW VRT2 Finding\n\n' +
    '- **Task ID:** ' + task.task_id + '\n' +
    '- **Type:** ' + task.task_type + '\n' +
    '- **Hypothesis:** ' + (task.hypothesis_id || 'n/a') + '\n' +
    '- **Captured:** ' + new Date().toISOString() + '\n\n---\n\n';
  fs.writeFileSync(filepath, header + content);
  return filepath;
}

// ── BROWSER STATE ───────────────────────────────────────────────────────
let browser = null;
let context = null;
let page = null;

async function ensureBrowser() {
  if (context && page) return;
  log('INFO', 'Launching persistent Chromium at ' + PROFILE_DIR);
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--exclude-switches=enable-automation',
      '--disable-automation'
    ]
  });

  // Reuse first page if exists, else create
  const pages = context.pages();
  page = pages.length > 0 ? pages[0] : await context.newPage();
  await page.addInitScript(function() {
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });
  });
  page.setDefaultTimeout(30000);
  log('INFO', 'Browser ready');
}

async function closeBrowser() {
  try { if (context) await context.close(); } catch (e) {}
  context = null;
  page = null;
}

// ── TASK HANDLERS ───────────────────────────────────────────────────────

// Promise.race-based timeout helper. AbortController cannot cross postMessage
// in sandboxed iframes, so we use Promise.race instead.
function withTimeout(promise, ms, label) {
  let timeoutHandle;
  const timeout = new Promise(function(_, reject) {
    timeoutHandle = setTimeout(function() {
      reject(new Error('Timeout after ' + ms + 'ms: ' + label));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(function() {
    clearTimeout(timeoutHandle);
  });
}

// Try multiple selectors in order, return the first one that exists
async function findFirstSelector(p, selectors, timeout) {
  timeout = timeout || 10000;
  for (const sel of selectors) {
    try {
      const el = await p.waitForSelector(sel, { timeout: timeout / selectors.length, state: 'visible' });
      if (el) return { selector: sel, element: el };
    } catch (e) {}
  }
  return null;
}

// ── HANDLER: scan_search ───────────────────────────────────────────────
async function handleScanSearch(task) {
  const payload = task.payload;
  const queries = payload.queries || [payload.query];
  const trigger_keywords = (payload.trigger_keywords || []).map(function(k) { return k.toLowerCase(); });
  const trigger_threshold = payload.trigger_threshold || 1;

  const allResults = [];
  for (const query of queries) {
    const url = (payload.url_template || 'https://html.duckduckgo.com/html/?q={query}')
      .replace('{query}', encodeURIComponent(query));
    log('INFO', '  search: ' + query);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);

      const results = await page.evaluate(function(payload) {
        const containerSel = (payload.extraction && payload.extraction.container_selector) || '.result__body';
        const titleSel = (payload.extraction && payload.extraction.title_selector) || '.result__title';
        const snippetSel = (payload.extraction && payload.extraction.snippet_selector) || '.result__snippet';
        const max = (payload.extraction && payload.extraction.max_results_per_query) || 10;
        const containers = document.querySelectorAll(containerSel);
        const out = [];
        for (let i = 0; i < containers.length && i < max; i++) {
          const c = containers[i];
          const titleEl = c.querySelector(titleSel);
          const snippetEl = c.querySelector(snippetSel);
          const linkEl = c.querySelector('a');
          out.push({
            title: titleEl ? titleEl.innerText.trim() : '',
            snippet: snippetEl ? snippetEl.innerText.trim() : '',
            url: linkEl ? linkEl.href : ''
          });
        }
        return out;
      }, payload);

      allResults.push({ query: query, results: results });
    } catch (e) {
      log('WARN', '  query failed: ' + query + ' — ' + e.message);
      allResults.push({ query: query, results: [], error: e.message });
    }
  }

  // Count keyword hits across all results
  let keywordHits = 0;
  const matchedSnippets = [];
  for (const r of allResults) {
    for (const item of r.results) {
      const text = (item.title + ' ' + item.snippet).toLowerCase();
      for (const kw of trigger_keywords) {
        if (text.includes(kw)) {
          keywordHits++;
          matchedSnippets.push({ kw: kw, title: item.title, snippet: item.snippet, url: item.url });
          break;
        }
      }
    }
  }

  const triggered = keywordHits >= trigger_threshold;

  // Write findings markdown
  let md = '## Search results for ' + (task.hypothesis_id || 'task ' + task.task_id) + '\n\n';
  md += '**Triggered:** ' + triggered + ' (hits: ' + keywordHits + ', threshold: ' + trigger_threshold + ')\n\n';
  for (const r of allResults) {
    md += '### Query: `' + r.query + '`\n\n';
    if (r.error) md += '> Error: ' + r.error + '\n\n';
    for (const item of r.results) {
      md += '- **' + item.title + '**  \n  ' + item.snippet + '  \n  ' + item.url + '\n\n';
    }
  }
  if (matchedSnippets.length > 0) {
    md += '## Trigger keyword matches\n\n';
    for (const m of matchedSnippets) {
      md += '- `' + m.kw + '` — ' + m.title + ' — ' + m.url + '\n';
    }
  }
  const findingsPath = writeFindings(task, md);

  return {
    status: 'SUCCESS',
    task_type: task.task_type,
    hypothesis_id: task.hypothesis_id,
    parsed_json: {
      triggered: triggered,
      keyword_hits: keywordHits,
      query_count: queries.length,
      total_results: allResults.reduce(function(s, r) { return s + r.results.length; }, 0),
      matched_snippets: matchedSnippets
    },
    findings_md_path: findingsPath
  };
}

// ── HANDLER: fetch_page ────────────────────────────────────────────────
async function handleFetchPage(task) {
  const payload = task.payload;
  log('INFO', '  fetch_page: ' + payload.url);
  await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const items = await page.evaluate(function(payload) {
    const containerSel = (payload.extraction && payload.extraction.container_selector) || 'article';
    const titleSel = (payload.extraction && payload.extraction.title_selector);
    const dateSel = (payload.extraction && payload.extraction.date_selector);
    const summarySel = (payload.extraction && payload.extraction.summary_selector);
    const max = (payload.extraction && payload.extraction.max_items) || 20;
    const containers = document.querySelectorAll(containerSel);
    const out = [];
    for (let i = 0; i < containers.length && i < max; i++) {
      const c = containers[i];
      out.push({
        title: titleSel ? (c.querySelector(titleSel) || {}).innerText || '' : (c.innerText || '').slice(0, 200),
        date: dateSel ? (c.querySelector(dateSel) || {}).innerText || '' : '',
        summary: summarySel ? (c.querySelector(summarySel) || {}).innerText || '' : '',
        href: (c.querySelector('a') || {}).href || ''
      });
    }
    return out;
  }, payload);

  // Hash content for diffing
  const hashInput = JSON.stringify(items.map(function(i) { return i.title + i.href; }));
  const contentHash = crypto.createHash('sha256').update(hashInput).digest('hex');

  let md = '## Page fetch: ' + payload.url + '\n\n';
  md += '**Items extracted:** ' + items.length + '  \n';
  md += '**Content hash:** `' + contentHash.slice(0, 16) + '`\n\n';
  for (const item of items) {
    md += '- **' + (item.title || '(no title)').trim() + '**';
    if (item.date) md += ' — ' + item.date.trim();
    md += '  \n';
    if (item.summary) md += '  ' + item.summary.trim() + '  \n';
    if (item.href) md += '  ' + item.href + '\n';
    md += '\n';
  }
  const findingsPath = writeFindings(task, md);

  return {
    status: 'SUCCESS',
    task_type: task.task_type,
    hypothesis_id: task.hypothesis_id,
    parsed_json: {
      url: payload.url,
      item_count: items.length,
      content_hash: contentHash,
      items: items.slice(0, 10)
    },
    findings_md_path: findingsPath
  };
}

// ── HANDLER: fetch_filing ──────────────────────────────────────────────
async function handleFetchFiling(task) {
  const payload = task.payload;
  const phrases = payload.search_phrases || [];
  const ctxChars = payload.context_chars || 500;

  log('INFO', '  fetch_filing: ' + payload.url);
  await page.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  const fullText = await page.evaluate(function() {
    return document.body ? document.body.innerText : '';
  });

  // Find each phrase and capture context window
  const matches = [];
  for (const phrase of phrases) {
    const lc = fullText.toLowerCase();
    const lcPhrase = phrase.toLowerCase();
    let pos = 0;
    let count = 0;
    while ((pos = lc.indexOf(lcPhrase, pos)) !== -1 && count < 3) {
      const start = Math.max(0, pos - Math.floor(ctxChars / 2));
      const end = Math.min(fullText.length, pos + lcPhrase.length + Math.floor(ctxChars / 2));
      matches.push({
        phrase: phrase,
        position: pos,
        context: fullText.substring(start, end).replace(/\s+/g, ' ').trim()
      });
      pos += lcPhrase.length;
      count++;
    }
  }

  let md = '## Filing fetch: ' + payload.url + '\n\n';
  md += '**Filing type:** ' + (payload.filing_type || 'unknown') + '  \n';
  md += '**Total page text length:** ' + fullText.length + '  \n';
  md += '**Phrase matches:** ' + matches.length + '\n\n';
  for (const m of matches) {
    md += '### `' + m.phrase + '` (pos ' + m.position + ')\n\n';
    md += '> ' + m.context + '\n\n';
  }
  const findingsPath = writeFindings(task, md);

  return {
    status: 'SUCCESS',
    task_type: task.task_type,
    hypothesis_id: task.hypothesis_id,
    parsed_json: {
      url: payload.url,
      total_text_length: fullText.length,
      match_count: matches.length,
      matches: matches
    },
    findings_md_path: findingsPath
  };
}

// ── HANDLER: semantic_review (uses claude.ai inside persistent profile) ─
// ── ANTHROPIC API CALL (replaces browser harness for semantic review) ───
function callAnthropicAPI(prompt, useWebSearch) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

  const https = require('https');
  const requestBody = {
    model: useWebSearch ? 'claude-sonnet-4-6' : 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  };
  if (useWebSearch) {
    requestBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const body = JSON.stringify(requestBody);

  return new Promise(function(resolve, reject) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    };
    if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: headers
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const textBlocks = (parsed.content || []).filter(function(b) { return b.type === 'text'; });
          const text = textBlocks.map(function(b) { return b.text; }).join('\n');
          if (!text) return reject(new Error('No text in API response: ' + data.slice(0, 200)));
          resolve(text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handleSemanticReview(task) {
  const payload = task.payload;
  log('INFO', '  semantic_review via API: ' + (task.hypothesis_id || 'task ' + task.task_id));

  // Load source findings
  let findingsContent = '';
  if (payload.source_findings_paths && payload.source_findings_paths.length > 0) {
    for (const fp of payload.source_findings_paths) {
      const fullPath = path.isAbsolute(fp) ? fp : path.join(ROOT, fp);
      try {
        findingsContent += '\n---\n# Source: ' + fp + '\n\n' + fs.readFileSync(fullPath, 'utf8');
      } catch (e) {
        log('WARN', '  could not read findings file: ' + fp);
      }
    }
  }

  // Build review prompt
  const promptTemplate = payload.review_prompt_template || payload.review_template || 'generic_review';
  const prompt = buildReviewPrompt(promptTemplate, payload, findingsContent);

  // Call Anthropic API directly — no browser needed
  // Peer context reviews need web search to look up news on specific dates
  // Templates that need live web search to look up current analyst data or news
  // Sonnet for: daily_brief, web-search templates
  // Haiku for: all other cheap semantic reviews
  const webSearchTemplates = ['review_h_ar_revisions', 'review_h_aws', 'review_etn_reaction'];
  const useWebSearch = webSearchTemplates.indexOf(promptTemplate) >= 0;
  const useSonnet = useWebSearch || promptTemplate === 'daily_brief';
  log('INFO', '  calling Anthropic API (' + (useSonnet ? (useWebSearch ? 'sonnet+search' : 'sonnet') : 'haiku') + ')');
  let responseText;
  try {
    responseText = await callAnthropicAPI(prompt, useSonnet);
  } catch (e) {
    log('ERROR', '  API call failed: ' + e.message);
    return {
      status: 'FAILED',
      task_type: task.task_type,
      hypothesis_id: task.hypothesis_id,
      error_message: 'API call failed: ' + e.message
    };
  }

  log('INFO', '  API response received (' + responseText.length + ' chars)');

  // Extract JSON from response
  const expectsMarkdown = (promptTemplate === 'daily_brief');

  let parsedJson = null;
  if (!expectsMarkdown) {
    const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenceMatch ? fenceMatch[1] : responseText;
    try {
      parsedJson = JSON.parse(candidate.trim());
    } catch (e) {
      const braceMatch = candidate.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try { parsedJson = JSON.parse(braceMatch[0]); } catch (e2) {}
      }
    }

    if (!parsedJson) {
      return {
        status: 'PARSE_FAIL',
        task_type: task.task_type,
        hypothesis_id: task.hypothesis_id,
        raw_output: responseText.slice(0, 5000),
        error_message: 'Could not parse JSON from API response'
      };
    }
  }

  // For daily_synthesis tasks, save the full markdown to daily_briefs/
  if (task.task_type === 'daily_synthesis') {
    const briefDate = (payload.date) || getETDateString();
    const briefDir = path.join(ROOT, 'daily_briefs');
    if (!fs.existsSync(briefDir)) fs.mkdirSync(briefDir, { recursive: true });
    const briefPath = path.join(briefDir, briefDate + '.md');
    const briefMd = (parsedJson && parsedJson.brief_md) || responseText || '(empty brief)';
    try {
      fs.writeFileSync(briefPath, briefMd);
      log('INFO', '  daily brief saved to ' + briefPath + ' (' + briefMd.length + ' chars)');
    } catch (e) {
      log('ERROR', '  failed to write daily brief file: ' + e.message);
    }
  }

  return {
    status: 'SUCCESS',
    task_type: task.task_type,
    hypothesis_id: task.hypothesis_id,
    raw_output: (task.task_type === 'daily_synthesis')
      ? responseText
      : responseText.slice(0, 10000),
    parsed_json: parsedJson,
    brief_md: expectsMarkdown ? responseText : null
  };
}

// ── HANDLER: daily_synthesis (delegated to semantic_review with brief template) ─
async function handleDailySynthesis(task) {
  // Load all findings files for the target date.
  // v3.1.1 fix #A5: ET date, not UTC. The fallback only triggers when the
  // producer didn't supply payload.date, which shouldn't normally happen
  // but is a safety net.
  const date = task.payload.date || getETDateString();
  const findingsDir = path.join(FINDINGS_DIR, date);
  let allFindings = '';
  if (fs.existsSync(findingsDir)) {
    const files = fs.readdirSync(findingsDir).filter(function(f) { return f.endsWith('.md'); }).sort();
    for (const f of files) {
      try {
        allFindings += '\n\n=== ' + f + ' ===\n\n' + fs.readFileSync(path.join(findingsDir, f), 'utf8');
      } catch (e) {}
    }
  }
  if (!allFindings) {
    allFindings = '(no findings files found for ' + date + ')';
  }
  // Inject combined findings into payload then run as semantic review
  task.payload.source_findings_paths = []; // clear, we use combined content directly
  task.payload._combined_findings = allFindings;
  task.payload.review_prompt_template = 'daily_brief';
  return handleSemanticReview(task);
}

// ── HANDLER: heartbeat (no-op, daemon writes its own heartbeats) ──────
async function handleHeartbeat(task) {
  return { status: 'SUCCESS', task_type: 'heartbeat' };
}

// ── PROMPT BUILDER ─────────────────────────────────────────────────────
function buildReviewPrompt(templateName, payload, findingsContent) {
  const combined = payload._combined_findings || findingsContent || '(no findings provided)';

  const TEMPLATES = {
    review_vrt_financials:
      'You are reviewing a Vertiv Holdings (VRT) SEC 10-Q filing for financial metrics.\n\n' +
      'Extract InventoryNet and Revenue figures for H-INV (inventory build signal).\n\n' +
      'Return ONLY a JSON object inside a ```json``` code fence:\n\n' +
      '```json\n' +
      '{\n' +
      '  "period_end": "YYYY-MM-DD",\n' +
      '  "inventory_net": 208000000,\n' +
      '  "revenue": 4100000000,\n' +
      '  "inventory_qoq_pct": 39.0,\n' +
      '  "h_inv_triggered": true,\n' +
      '  "raw_quote": "verbatim inventory text",\n' +
      '  "confidence": "high|med|low"\n' +
      '}\n' +
      '```\n\n' +
      'If you cannot find inventory data, return {"period_end": null, "inventory_net": null, "confidence": "none"}.\n\n' +
      '=== FINDINGS ===\n' + combined,

    review_h1_capex:
      'You are reviewing hyperscaler earnings transcripts for AI infrastructure capex guidance.\n\n' +
      'Extract quarterly capex figures (MSFT + META + AMZN + GOOGL combined) and count ' +
      'mentions of connectivity-related keywords (AECs, active electrical cables, Vertiv, ' +
      'power infrastructure, liquid cooling, data center infrastructure).\n\n' +
      'Return ONLY JSON in a code fence:\n\n' +
      '```json\n' +
      '{"company": "", "quarter": "", "capex_billions": 0, "yoy_growth_pct": 0, ' +
      '"connectivity_mentions": 0, "bullish_mentions": 0, "bearish_mentions": 0, ' +
      '"h1_triggered": false, "h14_triggered": false, ' +
      '"key_quotes": [{"text": "", "sentiment": "bull|bear|neutral"}]}\n' +
      '```\n\n' +
      '=== FINDINGS ===\n' + combined,

    review_h_ar_revisions:
      'You are reviewing analyst price target changes and rating upgrades/downgrades for ' +
      'Vertiv Holdings (VRT).\n\n' +
      'Count upward revisions (PT raises, upgrades to Buy/Strong Buy) and downward revisions ' +
      '(PT cuts, downgrades) in the last 7 days. H-AR fires at 3+ upward revisions.\n\n' +
      'Return ONLY JSON:\n\n' +
      '```json\n' +
      '{"upward_revisions": 0, "downward_revisions": 0, ' +
      '"h_ar_triggered": false, "h_ar_bear_triggered": false, ' +
      '"revisions": [{"firm": "", "analyst": "", "action": "upgrade|downgrade|pt_raise|pt_cut", ' +
      '"prior": 0, "new": 0, "date": "YYYY-MM-DD"}]}\n' +
      '```\n\n' +
      '=== FINDINGS ===\n' + combined,

    review_h_aws:
      'You are reviewing Amazon AWS news for events relevant to Vertiv Holdings (VRT).\n\n' +
      'AMZN is a top-3 VRT customer. Classify each AWS event:\n' +
      '- AWS Trainium/in-house silicon → BEAR (vertical integration risk)\n' +
      '- AWS region expansion, new DC → BULL (more infrastructure = more VRT orders)\n' +
      '- AWS + VRT partnership → STRONG BULL\n' +
      '- re:Invent connectivity/power/cooling keynote → BULL\n' +
      '- Generic AWS news → NEUTRAL\n\n' +
      'Return ONLY JSON:\n\n' +
      '```json\n' +
      '{"triggered": false, "events": [{"title": "", "url": "", ' +
      '"classification": "BEAR|BULL|STRONG_BULL|NEUTRAL", "summary": "1 sentence"}], ' +
      '"composite_direction": "BULL|BEAR|NEUTRAL"}\n' +
      '```\n\n' +
      '=== FINDINGS ===\n' + combined,

    review_etn_reaction:
      'You are reviewing ETN (Eaton Corp) earnings results for a VRT read-through.\n\n' +
      'ETN and VRT share the same hyperscaler customers (power/thermal infrastructure).\n' +
      'ETN reporting 3-4 weeks before VRT is a leading indicator for VRT earnings.\n\n' +
      'Classify the ETN earnings reaction:\n' +
      '- ETN beat + stock up >5% → BULL for VRT\n' +
      '- ETN beat + stock down >3% → BEAR for VRT (hidden negative guidance)\n' +
      '- ETN miss → STRONG BEAR for VRT\n' +
      '- ETN inline → NEUTRAL\n\n' +
      'Return ONLY JSON:\n\n' +
      '```json\n' +
      '{"etn_beat": true, "etn_stock_reaction_pct": 0, ' +
      '"vrt_direction": "BULL|BEAR|STRONG_BEAR|NEUTRAL", "confidence": "high|med|low", ' +
      '"dc_segment_growth_pct": 0, "key_evidence": "1-2 sentences"}\n' +
      '```\n\n' +
      '=== FINDINGS ===\n' + combined,

    daily_brief:
      'You are generating the morning intelligence brief for CLAW VRT2, a stock intelligence ' +
      'system tracking Vertiv Holdings (VRT), NYSE power/thermal infrastructure leader.\n\n' +
      'You are given all of yesterday\'s findings files (raw browser scan output for each ' +
      'hypothesis). Generate a markdown brief in this exact structure:\n\n' +
      '# CLAW VRT2 Daily Brief — ' + (payload.date || getETDateString()) + '\n\n' +
      '## Composite Direction\n[Current score, direction, regime, position sizing recommendation]\n\n' +
      '## Active Signals\n[List each firing hypothesis with brief explanation and confidence tier]\n\n' +
      '## Today\'s Findings Summary\n' +
      '**Bullish (N):** [bulleted list]\n' +
      '**Bearish (N):** [bulleted list]\n' +
      '**Neutral / Watch (N):** [bulleted list]\n\n' +
      '## Patterns I\'m Noticing\n[1-2 paragraphs of analysis. Most important section.]\n\n' +
      '## H-INV Status\n[VRT inventory build signal — is it firing into earnings?]\n\n' +
      '## Hypotheses That Did Not Fire\n[Brief list and why]\n\n' +
      '## Watchdog Status\n[Browser daemon health, data quality rating]\n\n' +
      'Keep total length under 900 words. Be specific. Avoid filler.\n\n' +
      'Return the markdown directly (no JSON wrapper).\n\n' +
      '=== YESTERDAY\'S FINDINGS ===\n' + combined,

    generic_review:
      'Review the following findings and return a JSON object with keys: ' +
      '"triggered" (bool), "summary" (string), "direction" (BULL|BEAR|NEUTRAL), ' +
      '"confidence" (high|med|low). Wrap the JSON in a ```json``` fence.\n\n' +
      '=== FINDINGS ===\n' + combined
  };

  return TEMPLATES[templateName] || TEMPLATES.generic_review;
}

// ── TASK ROUTER ────────────────────────────────────────────────────────
const HANDLERS = {
  'scan_search': handleScanSearch,
  'fetch_page': handleFetchPage,
  'fetch_filing': handleFetchFiling,
  'fetch_transcript': handleFetchPage, // transcripts use same pattern as fetch_page
  'semantic_review': handleSemanticReview,
  'daily_synthesis': handleDailySynthesis,
  'heartbeat': handleHeartbeat
};

async function processTask(task) {
  const start = Date.now();
  log('INFO', 'Processing task ' + task.task_id + ' (' + task.task_type + ', ' + (task.hypothesis_id || 'no-hyp') + ')');

  const handler = HANDLERS[task.task_type];
  if (!handler) {
    log('ERROR', '  unknown task_type: ' + task.task_type);
    return { status: 'FAILED', error_message: 'unknown task_type: ' + task.task_type };
  }

  try {
    await ensureBrowser();
    const result = await withTimeout(handler(task), TASK_TIMEOUT_MS, 'task ' + task.task_id);
    result.duration_ms = Date.now() - start;
    await closeBrowser();
    return result;
  } catch (e) {
    log('ERROR', '  task ' + task.task_id + ' failed: ' + e.message);
    await closeBrowser();
    return {
      status: 'FAILED',
      task_type: task.task_type,
      hypothesis_id: task.hypothesis_id,
      error_message: e.message,
      duration_ms: Date.now() - start
    };
  }
}

// ── MAIN LOOP ──────────────────────────────────────────────────────────
let running = true;
let stats = { tasks_completed_today: 0, tasks_failed_today: 0 };
// v3.1.1 fix #A5: use ET date so the daily counter resets at ET midnight,
// not UTC midnight. Operationally relevant for the dashboard's "today" count.
let lastDayReset = getETDateString();
let heartbeatTimer = null;  // tracked so shutdown can clear it

// Recursive-setTimeout heartbeat ticker. Unlike setInterval, this guarantees
// the previous heartbeat finishes (including any server wait) before the next
// is scheduled. This prevents backlog buildup when the server is slow or
// temporarily unreachable.
async function scheduleHeartbeat() {
  if (!running) return;
  try {
    const today = getETDateString();
    if (today !== lastDayReset) {
      stats.tasks_completed_today = 0;
      stats.tasks_failed_today = 0;
      lastDayReset = today;
    }
    await postHeartbeat({
      status: 'HEALTHY',
      tasks_completed_today: stats.tasks_completed_today,
      tasks_failed_today: stats.tasks_failed_today
    });
  } catch (e) {
    // postHeartbeat already swallows errors, but catch just in case
    log('WARN', 'heartbeat tick failed: ' + e.message);
  }
  if (running) {
    heartbeatTimer = setTimeout(scheduleHeartbeat, HEARTBEAT_INTERVAL_MS);
  }
}

async function mainLoop() {
  log('INFO', 'CLAW VRT2 browser_runner starting');
  log('INFO', 'Mode: ' + (HEADLESS ? 'headless' : 'headed') + (ONCE ? ' (single iteration)' : ' (daemon)'));
  log('INFO', 'Profile: ' + PROFILE_DIR);

  if (LOGIN_MODE) {
    log('INFO', 'Login mode — opening claude.ai for manual login. Close browser when done.');
    await ensureBrowser();
    await page.goto('https://claude.ai/login', { waitUntil: 'domcontentloaded' });
    log('INFO', 'Browser open. Sign in to claude.ai. Profile will persist the session.');
    log('INFO', 'When done, press Ctrl+C in this terminal to close.');
    return; // hold the process open
  }

  // Initial heartbeat (synchronous, before loop starts)
  await postHeartbeat({ status: 'HEALTHY', notes: 'daemon startup' });

  // Start the recursive heartbeat timer
  heartbeatTimer = setTimeout(scheduleHeartbeat, HEARTBEAT_INTERVAL_MS);

  while (running) {
    let task = null;
    try {
      task = await fetchNextTask();
    } catch (e) {
      log('WARN', 'fetchNextTask error: ' + e.message);
    }

    if (!task) {
      if (ONCE) break;
      // Poll sleep — interruptible so shutdown isn't delayed 30s
      for (let i = 0; i < POLL_INTERVAL_MS / 1000 && running; i++) {
        await new Promise(function(r) { setTimeout(r, 1000); });
      }
      continue;
    }

    await postHeartbeat({ status: 'HEALTHY', current_task_id: task.task_id });
    const result = await processTask(task);

    if (result.status === 'SUCCESS') stats.tasks_completed_today++;
    else stats.tasks_failed_today++;

    try {
      await postResult(task.task_id, result);
    } catch (e) {
      log('ERROR', 'postResult failed: ' + e.message);
    }

    if (ONCE) break;
  }

  log('INFO', 'Main loop exited, cleaning up');
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  await postHeartbeat({ status: 'DEGRADED', notes: 'daemon shutting down' });
  await closeBrowser();
  log('INFO', 'Shutdown complete');
}

process.on('SIGTERM', function() {
  log('INFO', 'SIGTERM received, shutting down');
  running = false;
});
process.on('SIGINT', function() {
  log('INFO', 'SIGINT received, shutting down');
  running = false;
});

mainLoop().catch(function(e) {
  log('ERROR', 'FATAL: ' + e.message);
  log('ERROR', e.stack);
  process.exit(1);
});
