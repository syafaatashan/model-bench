---
name: model-bench
description: >-
  Rank LLM endpoints by response latency: time to first token, throughput, and a combined
  t200 score. Runs every model at its own built-in default so the numbers are comparable.
  Use when the user asks which model is fastest, which model to use for the fastest response,
  which model is best overall for speed, or wants a latency, TTFT, tokens per second, or
  benchmark comparison between models.
metadata:
  author: syafaatashan
  version: "2.0"
---

# model-bench

Rank models by response latency. Calls the configured OpenAI-compatible endpoint directly, so it
measures the model rather than agent startup overhead. No dependencies, no new keys, no config
changes.

## Default comparison: everything on default

The default run sends no reasoning parameter at all. Every model uses its own built-in default,
which is the only fair basis for comparing models whose controls differ. Forcing a level would
compare thinking budgets instead of models.

```bash
node "${ZCODE_SKILL_DIR}/scripts/bench.mjs"
```

Prints TTFT, tok/s, t200, and total, ranked by median TTFT. Use `--runs 5` when the top two are
close; pooled endpoints are noisy and single runs mislead.

## Workflow

1. **Smoke test.** Confirms every model answers and the stream parses.

   ```bash
   node "${ZCODE_SKILL_DIR}/scripts/bench.mjs" --runs 1 --max-tokens 64
   ```

   Exit 1 means no model produced a token. Verify the endpoint is reachable before anything else.

2. **Benchmark.** Three runs per model by default, median used for ranking.

3. **Report to the user in their language.** State the winner by the requested metric, the
   highest-throughput model separately when it differs, and any `Failed` entries with their
   errors. Mention the baseline comparison when ranks moved.

## The combined metric (t200)

```
t200 = TTFT + (200 / tokens_per_second)
```

Wall-clock milliseconds to receive 200 tokens. This is the answer to "which model is best for
speed" because it needs no arbitrary weighting: a model that starts fast but writes slowly and one
that starts slowly but writes fast are compared on the time the user actually waits.

Change the target with `--tokens N` and rank by it with `--rank-by combined`. Use plain TTFT when
the question is only "which one replies first".

`t200` is skipped for a buffered run, which has no measurable generation phase. The notes column
shows `n/m timed` when some runs could not contribute, so do not treat a model with fewer timed
runs as having the same evidence as one with all runs.

## Baseline

`baseline.json` next to this file holds a recorded reference run. Every default run prints a
`## vs baseline` table with rank movement and the `t200` delta per model, so the output answers
"did anything change" rather than only "what happened just now".

Live numbers are not reproducible. Pooled endpoints route each request to a possibly different
upstream, and observed swings reach tens of percent. Report the delta and whether it exceeds the
noise instead of treating a re-run as a regression. `--no-baseline` suppresses the comparison.

## Reading the output

| column | meaning |
|---|---|
| TTFT med | ms until the first token, reasoning or visible. |
| tok/s | generation speed after the first token. Blank for buffered answers. |
| t200 ms | combined score. Lower is better. |
| TTFT min-max | spread across runs; a wide range means an unstable upstream. |
| total med | ms until the response ended. |
| tokens | completion tokens; `*` in a sweep matrix means it hit the cap. |
| notes | `buffered`, `buffered?`, `reasoning`, `capped`, `LEVEL IGNORED`, `n/m timed`. |

Caveats to surface whenever they appear:

- **`buffered`**: the upstream sent the whole answer in one frame, so TTFT equals total and
  throughput is unmeasurable. That is the gateway, not the model. Compare `total med` instead.
- **`buffered?`**: only some runs buffered, so `t200` is a median over fewer samples.
- **`capped`**: every run stopped at `--max-tokens`, so token counts say nothing about effort.
- **pooled routing**: re-run with `--runs 5` when the top two are within a few hundred ms.

## Thought level (optional, off by default)

Only relevant when the user explicitly asks about thought level or reasoning effort. Probing costs
seven tiny requests per model, so it runs only when a level is requested.

```bash
node "${ZCODE_SKILL_DIR}/scripts/bench.mjs" --sweep --runs 2 --max-tokens 256
```

The script probes what each model actually accepts, because metadata cannot be trusted. Observed
during development: one model advertised no effort support while accepting `reasoning_effort`, and
another rejected the `thinking` field with `unknown field "thinking"` despite advertising reasoning
support.

A sweep ranks each level separately, never mixed, and prints the probed reasoning controls. Some
models have no level at all; say so instead of presenting a level comparison for them. Never
compare a model at `low` against another at `max` without labelling the level in every row.

## Options

```bash
--runs N          repetitions per model (default 3)
--max-tokens N    response cap (default 256)
--tokens N        target length for the t200 score (default 200)
--rank-by X       rank by ttft or combined (default ttft)
--no-baseline     suppress the baseline comparison
--sweep           test every accepted level per model; ranks per level, never mixed
--effort LEVEL    force one level (low|medium|high|max|xhigh|none)
--thinking on|off force the toggle for models without effort levels
--all             benchmark every model the endpoint reports
--models a,b,c    explicit model ids
--prompt "..."    custom workload; the same prompt is required for a fair comparison
--base-url URL    endpoint to test, overriding the ZCode provider config
--api-key KEY     bearer token, overriding the ZCode provider config
--json            raw per-run data plus probed capabilities
--config PATH     alternate ZCode config file
```

Runs are sequential on purpose. Parallel requests contend for the same endpoint and produce
latency figures that describe the queue rather than the model. Do not change `temperature` away
from 0; sampling noise would blur the timing difference.

## Commands worth running

```bash
# Which model should I use? Combined score, stable sample.
node "${ZCODE_SKILL_DIR}/scripts/bench.mjs" --runs 5 --rank-by combined

# Same, tuned for short answers.
node "${ZCODE_SKILL_DIR}/scripts/bench.mjs" --runs 5 --rank-by combined --tokens 50

# Every model the endpoint serves, not just the configured ones.
node "${ZCODE_SKILL_DIR}/scripts/bench.mjs" --all --runs 1 --max-tokens 64

# Does thinking off actually help?
node "${ZCODE_SKILL_DIR}/scripts/bench.mjs" --thinking off --runs 3
```
