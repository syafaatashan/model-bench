# model-bench

Rank LLM endpoints by response latency: time to first token, throughput, and a combined score
that reflects how long a request actually takes to produce a useful answer.

Built for OpenAI-compatible endpoints. Runs with zero dependencies on Node 18 or newer.

```
$ node scripts/bench.mjs --runs 5 --rank-by combined

** Best by combined: oc/deepseek-v4.1-flash-free - 3042 ms for 200 tokens (TTFT 2045 ms + 185.8 tok/s)

| # | model | TTFT med | tok/s | t200 ms | TTFT min-max | sd | total med | tokens | notes |
|---|-------|---------:|------:|--------:|-------------:|---:|----------:|-------:|-------|
| 1 | oc/deepseek-v4.1-flash-free | 2045 | 185.8 | 3042 | 1376-2831 | 728 | 2987 | 189 | reasoning |
| 2 | oc/space-bunny-free        | 1987 |  87.7 | 4098 |  995-5054 | 2116 | 4689 | 256 | reasoning |
| 3 | oc/longcat-2.5-preview-free | 2288 | 42.2 | 7264 | 2260-3259 | 569 | 5622 | 118 | reasoning |
```

## Why this exists

Most benchmark tools measure one number. In practice you wait for two things: the first token,
and then everything after it. A model that replies in 900 ms but generates slowly can finish
after a model that replies in 1.5 s but streams quickly. Ranking on either metric alone hides
that.

`t200` resolves it without inventing weights:

```
t200 = TTFT + (200 / tokens_per_second)
```

It is the wall-clock time to receive 200 tokens. Change the target with `--tokens N` to match
your workload. Short answers favor low TTFT, long answers favor high throughput, and `t200`
reflects whichever effect dominates at the length you actually care about.

## Install

Requires Node 18 or newer. There is nothing to install.

```bash
git clone https://github.com/syafaatashan/model-bench.git
cd model-bench
node scripts/bench.mjs --help
```

### As a ZCode skill

Copy the directory into your skills folder:

```bash
cp -r model-bench ~/.zcode/skills/
```

ZCode then loads it automatically and matches requests such as "which model is fastest" or
"benchmark these models".

## Endpoint configuration

The script resolves its target in this order:

1. `--base-url` and `--api-key` flags
2. `MODEL_BENCH_BASE_URL` and `MODEL_BENCH_API_KEY` environment variables
3. The provider config at `~/.zcode/v2/config.json` (ZCode users, no setup required)

Any OpenAI-compatible endpoint works. It needs `/chat/completions` with streaming, and ideally
`/models`.

```bash
# Explicit endpoint
node scripts/bench.mjs \
  --base-url https://api.openai.com/v1 \
  --api-key "$OPENAI_API_KEY" \
  --models gpt-4o-mini,gpt-4o --all

# Or via environment
export MODEL_BENCH_BASE_URL=https://api.openai.com/v1
export MODEL_BENCH_API_KEY=$OPENAI_API_KEY
node scripts/bench.mjs --all --runs 3
```

The API key is read at runtime and is never printed, logged, or written to disk.

## Usage

```bash
node scripts/bench.mjs [options]
```

| Option | Default | Purpose |
|---|---|---|
| `--runs N` | `3` | Repetitions per model. Median is used, so one slow run cannot move the ranking. |
| `--max-tokens N` | `256` | Response cap. |
| `--tokens N` | `200` | Target length for the `t200` score. |
| `--rank-by ttft\|combined` | `ttft` | Primary ranking key. |
| `--models a,b,c` | configured models | Explicit model ids. |
| `--all` | off | Test every model the endpoint reports on `/models`. |
| `--prompt "..."` | coding task | Workload. The same prompt is used for every model. |
| `--sweep` | off | Test every reasoning level each model accepts. |
| `--effort LEVEL` | off | Force one level: `low`, `medium`, `high`, `max`, `xhigh`, `none`. |
| `--thinking on\|off` | off | Force the toggle for models without effort levels. |
| `--base-url URL` | ZCode config | Endpoint to test. |
| `--api-key KEY` | ZCode config | Bearer token. |
| `--json` | off | Raw per-run data and probed capabilities. |
| `--no-baseline` | off | Skip the recorded-baseline comparison. |
| `--config PATH` | `~/.zcode/v2/config.json` | Alternate provider config. |

## How the measurements are taken

Each run is a single streaming request. Timing starts immediately before `fetch` and records:

- **TTFT**: the first token of any kind, whether reasoning or visible text. A model that spends
  two seconds thinking before writing anything has a two-second TTFT, because that is what the
  user waits through.
- **tok/s**: completion tokens divided by the generation window, which starts at the first token
  and ends when the stream closes.
- **t200**: computed from the two values above.
- **total**: first byte to stream close.

Runs are sequential by design. Parallel requests contend for the same endpoint and produce
latency figures that describe your queue rather than the model.

`temperature` is pinned to 0 so sampling variance does not blur the timing difference.

## Reasoning controls are probed, not assumed

Model metadata lies. On a provider tested during development, one model advertised
`thinkingEffortSupported: false` while accepting `reasoning_effort` without error, and another
rejected the `thinking` field outright with `unknown field "thinking"` despite advertising
reasoning support.

The default run therefore sends no reasoning parameter at all. Every model uses its own built-in
default, which is the only fair basis for comparing models whose controls differ. When you ask
for a specific level, the script first probes what the endpoint accepts with four-token requests,
then sends only what worked.

`sweep` ranks each level separately. Comparing one model at `low` against another at `max` would
measure thinking budgets, not models.

## Reading the output

| Note | Meaning |
|---|---|
| `buffered` | The upstream sent the whole answer in one frame. TTFT equals total, so `tok/s` and `t200` are unmeasurable. This describes the gateway, not the model. |
| `buffered?` | Only some runs buffered. `t200` is a median over the remaining samples. |
| `reasoning` | Reasoning tokens arrived before visible text. |
| `capped` | Every run hit `--max-tokens`, so token counts cannot be compared across levels. |
| `n/m timed` | Only `n` of `m` runs produced a measurable generation phase. |
| `LEVEL IGNORED` | The requested level is not accepted by that model, so nothing was sent. |

## Baselines

`baseline.json` holds a recorded reference run. Default runs print a comparison showing rank
movement and the `t200` delta per model, so the output answers "did anything change" rather than
only "what happened just now".

Live numbers are not reproducible. Free-tier and pooled endpoints route each request to a
possibly different upstream, and observed swings reach tens of percent. Report the delta and
whether it exceeds the noise rather than treating a re-run as a regression.

To record a new baseline, run the benchmark under your intended conditions and rewrite
`baseline.json` with the resulting medians.

## Limitations

- Measures speed only. It does not measure answer quality, correctness, or cost. The fastest
  model is not automatically the best one for your task.
- Single endpoint per run. Cross-provider comparison needs one run per provider.
- Streaming is required for meaningful results. Buffered upstreams are detected and excluded from
  the combined score rather than reported with fabricated throughput.
- Token counts come from the endpoint's `usage` field when present, otherwise from counting
  content deltas. Providers that report no usage will show approximate throughput.

## License

MIT. See [LICENSE](LICENSE).
