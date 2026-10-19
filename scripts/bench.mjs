#!/usr/bin/env node
// Rank models by response latency against the local OpenAI-compatible router.
// Reads the router baseURL + apiKey from the ZCode provider config; never prints the key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(SKILL_DIR, 'baseline.json');

const DEFAULT_PROMPT =
  'Write a TypeScript function `chunk<T>(items: T[], size: number): T[][]` that splits ' +
  'an array into chunks. Then explain its time complexity in two sentences.';

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const ARGS = {
  runs: Number(opt('--runs', 3)),
  maxTokens: Number(opt('--max-tokens', 256)),
  all: flag('--all'),
  json: flag('--json'),
  sweep: flag('--sweep'),
  noProbe: flag('--no-probe'),
  models: opt('--models'),
  prompt: opt('--prompt', DEFAULT_PROMPT),
  config: opt('--config'),
  effort: opt('--effort', undefined),
  thinking: opt('--thinking', undefined),
  tokens: Number(opt('--tokens', 200)),
  rankBy: opt('--rank-by', 'ttft'),
  baseline: flag('--baseline'),
  noBaseline: flag('--no-baseline'),
  baseUrl: opt('--base-url', undefined),
  apiKey: opt('--api-key', undefined),
};
if (!Number.isInteger(ARGS.runs) || ARGS.runs < 1) ARGS.runs = 3;
if (!Number.isInteger(ARGS.maxTokens) || ARGS.maxTokens < 1) ARGS.maxTokens = 256;
if (!Number.isInteger(ARGS.tokens) || ARGS.tokens < 1) ARGS.tokens = 200;
if (flag('--help') || flag('-h')) {
  console.log(`model-bench - rank LLM endpoints by response latency

Usage: node scripts/bench.mjs [options]

  --runs N          repetitions per model (default 3)
  --max-tokens N    response cap (default 256)
  --tokens N        target length for the t200 score (default 200)
  --rank-by X       rank by ttft or combined (default ttft)
  --no-baseline     suppress the baseline comparison
  --sweep           test every accepted reasoning level per model
  --effort LEVEL    force one level (low|medium|high|max|xhigh|none)
  --thinking on|off force the toggle for models without effort levels
  --all             benchmark every model the endpoint reports
  --models a,b,c    explicit model ids
  --prompt "..."    custom workload
  --base-url URL    endpoint to test
  --api-key KEY     bearer token
  --config PATH     alternate ZCode config file
  --json            raw per-run data plus probed capabilities
  -h, --help        this message

Endpoint resolution: --base-url/--api-key, then MODEL_BENCH_BASE_URL/MODEL_BENCH_API_KEY,
then ~/.zcode/v2/config.json.

t200 = TTFT + (N / tokens_per_second), the wall-clock ms to receive N tokens.`);
  process.exit(0);
}
if (!['ttft', 'combined'].includes(ARGS.rankBy)) fail('--rank-by must be ttft or combined');
if (ARGS.thinking && !['on', 'off'].includes(ARGS.thinking)) fail('--thinking must be on or off');

// ---------- endpoint resolution ----------
// Priority: explicit flags, then env vars, then the ZCode provider config. The config path is
// ZCode-specific; the flags and env vars let this run against any OpenAI-compatible endpoint.
function resolveEndpoint() {
  const flagUrl = ARGS.baseUrl || process.env.MODEL_BENCH_BASE_URL;
  if (flagUrl) {
    return {
      base: flagUrl.replace(/\/+$/, ''),
      key: ARGS.apiKey || process.env.MODEL_BENCH_API_KEY || '',
      models: ARGS.models ? ARGS.models.split(',').map((s) => s.trim()).filter(Boolean) : [],
      name: 'custom',
    };
  }

  const configPath = ARGS.config || path.join(os.homedir(), '.zcode', 'v2', 'config.json');
  if (!fs.existsSync(configPath)) {
    fail(
      'no endpoint configured. Pass --base-url and --api-key, or set MODEL_BENCH_BASE_URL and ' +
      `MODEL_BENCH_API_KEY, or provide a ZCode config at ${configPath} via --config.`,
    );
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const providers = Object.entries(cfg.provider || {});
  const baseOf = (v) => v?.options?.baseURL || v?.baseURL || '';
  const picked = providers.find(
    ([, v]) => v && typeof v === 'object' && baseOf(v).includes('/v1') &&
      v.models && Object.keys(v.models).length > 0,
  );
  if (!picked) fail(`no provider with a /v1 baseURL and models in ${configPath}`);
  const [, provider] = picked;
  return {
    base: baseOf(provider).replace(/\/+$/, ''),
    key: provider.options?.apiKey || '',
    models: Object.keys(provider.models),
    name: provider.name || 'zcode',
  };
}

const ENDPOINT = resolveEndpoint();
const BASE = ENDPOINT.base;
const KEY = ENDPOINT.key;
const provider = { name: ENDPOINT.name };

function auth() {
  return KEY ? { Authorization: `Bearer ${KEY}` } : {};
}
function fail(msg) {
  console.error(`model-bench: ${msg}`);
  process.exit(1);
}

let models = ARGS.models
  ? ARGS.models.split(',').map((s) => s.trim()).filter(Boolean)
  : ENDPOINT.models;
if (ARGS.all) {
  const list = await fetch(`${BASE}/models`, { headers: auth() }).then((r) => r.json());
  const ids = (list?.data || []).map((m) => m.id).filter(Boolean);
  if (ids.length) models = ids;
}
if (!models.length) {
  fail('no models to test. Pass --models a,b,c or --all, or configure models in the ZCode config.');
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'max', 'xhigh'];
// Probing costs 7 tiny requests per model, so only do it when a level is actually requested.
const NEEDS_PROBE = ARGS.sweep || ARGS.effort !== undefined || ARGS.thinking !== undefined;

// ---------- capability probe ----------
// Neither the router's /v1/models metadata nor ZCode's id-matchers predict what a model
// actually accepts (observed: space-bunny advertises thinkingEffortSupported:false but
// accepts reasoning_effort; glm rejects the `thinking` field outright). So ask the endpoint.
// ponytail: one probe per process, no cache; add a cache file if this ever gets slow.
async function post(model, extra, maxTokens) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth() },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0,
      max_tokens: maxTokens,
      ...extra,
    }),
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text };
  return { ok: true, status: r.status, text };
}

async function probeCaps(model) {
  const caps = { thinking: false, thinkingDisable: false, effort: [], reasonByDefault: false };
  if (!NEEDS_PROBE) return caps;
  const [on, off, ...efforts] = await Promise.all([
    post(model, { thinking: { type: 'enabled' } }, 4),
    post(model, { thinking: { type: 'disabled' } }, 4),
    ...EFFORT_ORDER.map((l) => post(model, { reasoning_effort: l }, 4)),
  ]);
  caps.thinking = on.ok;
  caps.thinkingDisable = off.ok;
  caps.effort = EFFORT_ORDER.filter((_, i) => efforts[i].ok);
  const base = await post(model, {}, 4);
  caps.reasonByDefault = base.ok && /reasoning_content/.test(base.text);
  return caps;
}

// Build the reasoning part of the body from a *label* the model actually accepts.
function reasoningBody(caps, label) {
  if (label === undefined) return {};
  if (label === 'on') return caps.thinking ? { thinking: { type: 'enabled' } } : {};
  if (label === 'off') return caps.thinkingDisable ? { thinking: { type: 'disabled' } } : {};
  if (caps.effort.includes(label)) return { reasoning_effort: label };
  return {};
}

function variantsFor(model, caps) {
  const effort = ARGS.effort;
  if (effort !== undefined) {
    const label = effort === 'none' ? 'none' : effort;
    // Flag it rather than reporting a level the model silently discarded.
    const ignored = Object.keys(reasoningBody(caps, label)).length === 0;
    return [{ label, effort: label, ignored }];
  }
  if (ARGS.thinking !== undefined) {
    const ignored = Object.keys(reasoningBody(caps, ARGS.thinking)).length === 0;
    return [{ label: ARGS.thinking, effort: ARGS.thinking, ignored }];
  }
  if (ARGS.sweep) {
    if (caps.effort.length) return caps.effort.map((l) => ({ label: l, effort: l }));
    if (caps.thinking && caps.thinkingDisable) {
      return [{ label: 'on', effort: 'on' }, { label: 'off', effort: 'off' }];
    }
    return [{ label: 'default', effort: undefined }];
  }
  // Default comparison: send no reasoning parameter at all, so every model runs at its own
  // built-in default. That is the only apples-to-apples comparison across models whose
  // levels differ (glm has no switch, longcat/space-bunny have no matching levels).
  return [{ label: 'default', effort: undefined }];
}

// ---------- one streaming request ----------
async function runOnce(model, caps, label) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth() },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: ARGS.prompt }],
        stream: true,
        temperature: 0,
        max_tokens: ARGS.maxTokens,
        ...reasoningBody(caps, label),
      }),
    });
  } catch (e) {
    throw new Error(`connect failed: ${e.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);

  let ttftEvent = null;
  let ttft = null;        // first token of any kind (content or reasoning)
  let ttftVisible = null; // first *visible* content token
  let contentChunks = 0;
  let reasoningChunks = 0;
  let usageTokens = null;
  let finish = null;
  let buf = '';
  let sse = true;

  const consume = (delta) => {
    if (!delta) return;
    const d = delta.content;
    const r = delta.reasoning_content;
    const now = performance.now() - t0;
    if (typeof r === 'string' && r !== '') {
      reasoningChunks++;
      if (ttft === null) ttft = now;
    }
    if (typeof d === 'string' && d !== '') {
      contentChunks++;
      if (ttft === null) ttft = now;
      if (ttftVisible === null) ttftVisible = now;
    }
  };

  // Handles SSE (`data: {...}` lines) and a single buffered JSON body alike.
  const decoder = new TextDecoder();
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) { if (line) sse = false; continue; }
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      if (ttftEvent === null) ttftEvent = performance.now() - t0;
      try {
        const j = JSON.parse(payload);
        const ch = j.choices?.[0];
        consume(ch?.delta);
        consume(ch?.message); // tolerate non-stream deltas
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (j.usage?.completion_tokens != null) usageTokens = j.usage.completion_tokens;
      } catch { /* partial frame, ignore */ }
    }
  }
  if (ttftEvent === null && !sse && buf.trim().startsWith('{')) {
    const j = JSON.parse(buf);
    const ch = j.choices?.[0];
    consume(ch?.message);
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (j.usage?.completion_tokens != null) usageTokens = j.usage.completion_tokens;
  }

  const total = performance.now() - t0;
  const tokens = usageTokens ?? contentChunks;
  const genMs = Math.max(total - (ttft ?? total), 0);
  const buffered = ttft !== null && ttft >= total * 0.9;
  const rate = buffered || genMs <= 0 ? null : tokens / (genMs / 1000);
  return {
    model, label,
    ttft_ms: ttft === null ? null : Math.round(ttft),
    ttft_visible_ms: ttftVisible === null ? null : Math.round(ttftVisible),
    ttft_event_ms: ttftEvent === null ? null : Math.round(ttftEvent),
    total_ms: Math.round(total), tokens, finish,
    reasoning: reasoningChunks > 0,
    // A buffered answer has no measurable generation phase, so tok/s would be fiction.
    tok_per_s: rate === null ? null : +rate.toFixed(1),
    // Wall-clock time to get N tokens out: wait for the first, then stream the rest.
    // This is the combined "fast to start AND fast to write" number.
    time_for_n: ttft === null || rate === null ? null : Math.round(ttft + (ARGS.tokens / rate) * 1000),
    streamed: ttftEvent !== null,
    buffered,
  };
}

const TRANSIENT = /HTTP (429|500|502|503|504)/;
// The router surfaces upstream flakiness as 429/5xx; retry with backoff before giving up.
async function attempt(model, caps, label) {
  let last;
  for (let k = 0; k < 3; k++) {
    try {
      return await runOnce(model, caps, label);
    } catch (e) {
      last = e.message;
      if (!TRANSIENT.test(last)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (k + 1)));
    }
  }
  throw new Error(last);
}

async function runVariant(model, caps, v) {
  const runs = [];
  let error = null;
  for (let i = 0; i < ARGS.runs; i++) {
    try {
      runs.push({ ...(await attempt(model, caps, v.effort)), ignored: !!v.ignored });
    } catch (e) {
      error = e.message;
      break;
    }
  }
  return { model, label: v.label, runs, error };
}

// ---------- stats ----------
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const stdev = (a) => {
  if (a.length < 2) return null;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const summarize = (res) => {
  const ok = res.runs.filter((r) => r.ttft_ms !== null);
  if (!ok.length) {
    return { model: res.model, label: res.label, ok: false,
      error: res.error || 'no token received (empty response)' };
  }
  const ttf = ok.map((r) => r.ttft_ms);
  const tps = ok.map((r) => r.tok_per_s).filter((v) => v != null);
  const vis = ok.map((r) => r.ttft_visible_ms).filter((v) => v != null);
  const tfn = ok.map((r) => r.time_for_n).filter((v) => v != null);
  return {
    model: res.model, label: res.label, ok: true, runs: ok.length,
    ttft_median: Math.round(median(ttf)), ttft_min: Math.min(...ttf),
    ttft_max: Math.max(...ttf), ttft_sd: stdev(ttf) === null ? null : Math.round(stdev(ttf)),
    ttft_visible_median: vis.length ? Math.round(median(vis)) : null,
    total_median: Math.round(median(ok.map((r) => r.total_ms))),
    tokens_median: Math.round(median(ok.map((r) => r.tokens))),
    tok_per_s: tps.length ? +median(tps).toFixed(1) : null,
    time_for_n_median: tfn.length ? Math.round(median(tfn)) : null,
    reasoning: ok.some((r) => r.reasoning),
    buffered: ok.every((r) => r.buffered),
    sometimesBuffered: ok.some((r) => r.buffered) && !ok.every((r) => r.buffered),
    // Runs whose generation phase was measurable, i.e. the ones time_for_n is based on.
    timedRuns: tfn.length,
    ignored: ok.some((r) => r.ignored),
    // Every run stopped on the token cap, so token counts say nothing about effort.
    capped: ok.every((r) => r.finish === 'length'),
  };
};

// A switch the router ignores shows up as an identical token budget across levels -
// but only when the answers were allowed to finish. A capped answer is evidence of nothing.
const inertModels = () => {
  const byModel = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  const inert = [];
  const inconclusive = [];
  for (const [model, rs] of byModel) {
    if (rs.length < 2) continue;
    if (rs.every((r) => r.capped)) { inconclusive.push(model); continue; }
    const t = rs.filter((r) => !r.capped).map((r) => r.tokens_median);
    if (t.length >= 2 && Math.max(...t) - Math.min(...t) <= 2) inert.push(model);
  }
  return { inert, inconclusive };
};

// ---------- run ----------
const capsByModel = new Map();
for (const m of models) capsByModel.set(m, await probeCaps(m));

const results = [];
for (const m of models) {
  const caps = capsByModel.get(m);
  for (const v of variantsFor(m, caps)) {
    process.stderr.write(`testing ${m} [${v.label}] ...\n`);
    results.push(summarize(await runVariant(m, caps, v)));
  }
}
const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const { inert, inconclusive } = inertModels();
const ORDER = [...EFFORT_ORDER, 'on', 'off', 'default', 'none'];
const lvlRank = (l) => (ORDER.includes(l) ? ORDER.indexOf(l) : 99);
const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v == null ? '-' : v);
const notesOf = (r) => [r.buffered && 'buffered', r.sometimesBuffered && 'buffered?', r.reasoning && 'reasoning',
  r.capped && 'capped', r.ignored && 'LEVEL IGNORED',
  r.timedRuns < r.runs && `${r.timedRuns}/${r.runs} timed`].filter(Boolean).join(', ') || '-';
const COMBINED_HDR = `t${ARGS.tokens}`;
const row = (r, i, withEffort) =>
  `| ${i + 1} | ${pad(r.model, 30)} | ${withEffort ? `${pad(r.label, 8)} | ` : ''}` +
  `${pad(num(r.ttft_median), 7)} | ${pad(num(r.tok_per_s), 5)} | ${pad(num(r.time_for_n_median), 8)} | ` +
  `${pad(`${r.ttft_min}-${r.ttft_max}`, 11)} | ${pad(num(r.ttft_sd), 4)} | ` +
  `${pad(num(r.total_median), 8)} | ${pad(num(r.tokens_median), 6)} | ${notesOf(r)} |`;
const header = (withEffort) => (withEffort ? [
  `| # | model | effort | TTFT med | tok/s | ${COMBINED_HDR} ms | TTFT min-max | ±sd | total med | tokens | notes |`,
  '|---|-------|--------|---------:|------:|----------:|-------------:|----:|----------:|-------:|-------|',
] : [
  `| # | model | TTFT med | tok/s | ${COMBINED_HDR} ms | TTFT min-max | ±sd | total med | tokens | notes |`,
  '|---|-------|---------:|------:|----------:|-------------:|----:|----------:|-------:|-------|',
]);

// Primary ranking key. `combined` = wall-clock ms to produce ARGS.tokens, which is
// TTFT + N/rate - the only way to mix "starts fast" and "writes fast" without inventing weights.
const rankKey = (r) => (ARGS.rankBy === 'combined'
  ? (r.time_for_n_median ?? Infinity)
  : r.ttft_median);
const byRank = (a, b) => rankKey(a) - rankKey(b);

// ---------- baseline ----------
// A recorded reference run. Live numbers cannot be reproduced (routed pool), so the value
// here is the delta and the rank order, not an identical table.
function loadBaseline() {
  if (ARGS.noBaseline || !fs.existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}
const baseline = loadBaseline();
const baselineCompatible = (b) =>
  !!b && b.conditions?.tokens === ARGS.tokens && b.conditions?.rank_by === ARGS.rankBy &&
  !NEEDS_PROBE;
const fmtDelta = (now, was) => {
  if (now == null || was == null) return '-';
  const d = now - was;
  return `${d > 0 ? '+' : ''}${d}`;
};
const pctDelta = (now, was) => {
  if (now == null || was == null || was === 0) return '-';
  return `${Math.round(((now - was) / was) * 100)}%`;
};

const capsLine = (m) => {
  const c = capsByModel.get(m);
  const bits = [];
  bits.push(c.effort.length ? `effort=${c.effort.join('/')}` : 'effort=none');
  bits.push(c.thinking ? (c.thinkingDisable ? 'thinking=on/off' : 'thinking=on') : 'thinking=unsupported');
  if (c.reasonByDefault) bits.push('reasons by default');
  return `${pad(m, 30)} ${bits.join('  ')}`;
};

if (ARGS.json) {
  console.log(JSON.stringify({
    provider: provider.name, baseURL: BASE, prompt: ARGS.prompt, sweep: ARGS.sweep,
    rankBy: ARGS.rankBy, tokens: ARGS.tokens,
    capabilities: Object.fromEntries(capsByModel),
    ranked: [...ok].sort(byRank),
    failed, inert, inconclusive,
  }, null, 2));
} else {
  console.log(`# Model latency - provider ${provider.name} @ ${BASE}`);
  console.log(`prompt: ${ARGS.prompt.slice(0, 80)}${ARGS.prompt.length > 80 ? '…' : ''} | runs: ${ARGS.runs} | max_tokens: ${ARGS.maxTokens}${ARGS.sweep ? ' | sweep' : ''} | ranking by ${ARGS.rankBy}\n`);

  if (NEEDS_PROBE) {
    console.log('## Reasoning controls (probed, not assumed)\n');
    for (const m of models) console.log(`- ${capsLine(m)}`);
    console.log('');
  } else {
    console.log('Mode: every model at its own built-in default - no reasoning parameter sent.\n');
  }

  if (ARGS.sweep) {
    const labels = [...new Set(ok.map((r) => r.label))].sort((a, b) => lvlRank(a) - lvlRank(b));
    const cell = new Map(ok.map((r) => [`${r.model}\u0000${r.label}`, r]));
    console.log('## TTFT ms / completion tokens (median)\n');
    console.log(`| model | ${labels.join(' | ')} |`);
    console.log(`|-------|${labels.map(() => '---:').join('|')}|`);
    for (const m of models) {
      const cells = labels.map((l) => {
        const r = cell.get(`${m}\u0000${l}`);
        return r ? `${r.ttft_median}/${r.tokens_median}${r.capped ? '*' : ''}` : '-';
      });
      console.log(`| ${pad(m, 30)} | ${cells.join(' | ')} |`);
    }
    if (ok.some((r) => r.capped)) console.log('\n`*` = hit the token cap, so its token count is not comparable.');
    console.log('');
    for (const l of labels) {
      const group = ok.filter((r) => r.label === l).sort(byRank);
      if (!group.length) continue;
      const lead = ARGS.rankBy === 'combined'
        ? `${group[0].model} (${group[0].time_for_n_median} ms for ${ARGS.tokens} tokens)`
        : `${group[0].model} (${group[0].ttft_median} ms)`;
      console.log(`## effort=${l} - best: ${lead}\n`);
      console.log(header(true).join('\n'));
      group.forEach((r, i) => console.log(row(r, i, true)));
      console.log('');
    }
  } else {
    const ranked = [...ok].sort(byRank);
    if (ranked.length) {
      const lead = ARGS.rankBy === 'combined'
        ? `${ranked[0].model} - ${ranked[0].time_for_n_median} ms for ${ARGS.tokens} tokens (TTFT ${ranked[0].ttft_median} ms + ${ranked[0].tok_per_s} tok/s)`
        : `${ranked[0].model} - ${ranked[0].ttft_median} ms (median of ${ranked[0].runs})`;
      console.log(`** Best by ${ARGS.rankBy}: ${lead}\n`);
    }
    console.log(header(false).join('\n'));
    ranked.forEach((r, i) => console.log(row(r, i, false)));
    const fastestTps = ranked.filter((r) => r.tok_per_s != null).sort((a, b) => b.tok_per_s - a.tok_per_s)[0];
    const fastestTtft = ranked.reduce((a, b) => (a.ttft_median <= b.ttft_median ? a : b));
    const extras = [];
    if (fastestTtft !== ranked[0]) extras.push(`fastest first token: ${fastestTtft.model} (${fastestTtft.ttft_median} ms)`);
    if (fastestTps && fastestTps !== ranked[0]) extras.push(`highest throughput: ${fastestTps.model} (${fastestTps.tok_per_s} tok/s)`);
    if (extras.length) console.log(`\n${extras.join('\n')}`);

    if (baselineCompatible(baseline)) {
      const was = new Map(baseline.results.map((b) => [b.model, b]));
      const moved = [];
      console.log(`\n## vs baseline (${baseline.recorded}, ${baseline.conditions.runs} runs, t${baseline.conditions.tokens})\n`);
      console.log(`| model | rank now | rank baseline | t${ARGS.tokens} now | t${ARGS.tokens} baseline | Δ | Δ% |`);
      console.log(`|-------|----------:|--------------:|------------------:|-------------------------:|---:|---:|`);
      for (const r of ranked) {
        const b = was.get(r.model);
        if (!b) { console.log(`| ${pad(r.model, 30)} | new | - | ${num(r.time_for_n_median)} | - | - | - |`); continue; }
        const nowRank = ranked.indexOf(r) + 1;
        if (b.rank !== nowRank) moved.push(`${r.model}: ${b.rank}→${nowRank}`);
        console.log(`| ${pad(r.model, 30)} | ${nowRank} | ${b.rank} | ${num(r.time_for_n_median)} | ${num(b.t200_ms)} | ${fmtDelta(r.time_for_n_median, b.t200_ms)} | ${pctDelta(r.time_for_n_median, b.t200_ms)} |`);
      }
      if (moved.length) console.log(`\nRank changes: ${moved.join(', ')}`);
      else console.log(`\nRank order unchanged from baseline.`);
      console.log(`\nBaseline: ${baseline.note}`);
    } else if (baseline && !ARGS.noBaseline && !NEEDS_PROBE) {
      console.log(`\nBaseline not compared: recorded with t${baseline.conditions.tokens} / rank-by ${baseline.conditions.rank_by}. Use --no-baseline to silence.`);
    }
  }

  if (inert.length) {
    console.log(`\n**INERT**: token counts were identical across levels for ${inert.join(', ')} -`);
    console.log(`the router ignores that switch, so the level is a UI label rather than a real control.`);
  }
  if (inconclusive.length) {
    console.log(`\nInconclusive: ${inconclusive.join(', ')} hit the token cap on every level.`);
    console.log(`Raise --max-tokens to compare token counts across levels.`);
  }
  if (failed.length) console.log(`\nFailed:\n${failed.map((f) => `- ${f.model} [${f.label}]: ${f.error}`).join('\n')}`);
  if (ok.some((r) => r.buffered || r.sometimesBuffered)) {
    console.log(`\nNote: "buffered" = the upstream sent the whole answer in one frame (TTFT ≈ total), so its tok/s is`);
    console.log(`unmeasurable and t${ARGS.tokens} is skipped for that run. "buffered?" = only some runs did.`);
  }
  if (ok.some((r) => r.reasoning)) {
    console.log(`Note: "reasoning" = reasoning tokens arrive before visible text; TTFT counts the first token of either kind (JSON carries ttft_visible_median).`);
  }
  console.log(`Note: free-tier models come from a routed pool, so per-run numbers vary. Use --runs 5 when the ranking is close.`);
}
process.exit(ok.length ? 0 : 1);