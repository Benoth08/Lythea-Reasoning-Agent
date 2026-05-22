# Lythéa v5.8.0 — Extended Python Sandbox

First public release of Lythéa. Earlier versions (V3.9 through V5.7.1)
existed as deployment snapshots on a personal RunPod instance — see the
[Project history](README.md#project-history) section in the README for
the full evolution.

This release introduces a substantially extended Python sandbox covering
four operational domains, with full observability through a dedicated
debug panel.

## ✨ What's new

### Extended Python sandbox — four operational domains

The agent now delegates the following operations to a sandboxed Python
subprocess rather than relying on the LLM's pattern matching:

- **Arithmetic validation** — exact date arithmetic (day counts, weekday
  lookups, time differences), primality testing, prime factorization,
  factorials, Fibonacci numbers, GCD/LCM, combinatorics. Uses `sympy`
  and `datetime` for exact computation.
- **Data analysis** — descriptive statistics on inline numeric lists
  (mean, median, std, quartiles, IQR), histograms, outlier detection,
  basic linear regression. Uses `numpy` and `statistics`.
- **Unit and format conversions** — temperature (°F/°C/K), mass
  (kg/lbs/oz), length (m/ft/in/mi/km), volume (L/gal), base encodings
  (base64, URL-encode, hex), numeric bases (binary, hexadecimal,
  decimal), JSON reformatting (pretty/compact), Unix timestamp ↔ ISO
  8601 date conversion.
- **Code execution** — runs and validates user-provided or LLM-generated
  Python snippets in isolation.

### Observable sandbox

When the 🔬 debug panel is active, every Python execution produces a
dedicated **🐍 Sandbox Python** panel showing:

- The generated code with syntax highlighting
- `stdout` capture
- Return value (if different from stdout)
- `stderr` and error trace (if execution failed)
- Inline matplotlib plots produced during execution (base64 PNG)
- Execution duration in milliseconds
- A "📋 Copy code" button to reuse the generated code elsewhere

Outside debug mode, only a minimal inline signal is shown:
`🐍 Calculation executed in sandbox ✅ (Xms)`.

### Tool router prototype extension

The `SemanticRouter` `python` route was extended from 33 to 68 prototype
examples covering the new domains, plus calibration of the routing
thresholds. Includes prototypes in French, English, Spanish, German,
Italian, and Portuguese.

### Endpoint exposure

New endpoint:
- `GET /api/cognition/python_last` — returns the last sandbox execution
  details (code, stdout, stderr, result, duration, plots) for use by
  the debug panel.

### Configuration

- Sandbox timeout extended from 5s to 10s to accommodate light data
  analysis on inline lists.
- Code generation prompt enriched with library hints (`sympy`,
  `datetime`, `base64`, `urllib.parse`, `json`) so the LLM picks the
  right tool for each domain.

## 🐛 Bug fixes (V5.7.x → V5.8.0)

The following fixes have been validated through this release. They were
introduced incrementally in V5.6.16, V5.7.0, and V5.7.1 — this is the
first public release that contains all of them:

**V5.6.16 (cognitive modules)**
- Chroma `'RustBindingsAPI' object has no attribute 'bindings'` after
  global memory wipe, now resolved via aggressive singleton reset
- French personal narrative no longer triggers false web searches
  (e.g., "hier j'ai vu mon médecin" no longer triggers Reverso queries)
- Five new N1 inhibition patterns in French (API key requests, system
  prompt reveals, instruction bypass, role-play jailbreaks)
- Expanded planning markers for real-life multi-step intents (moving,
  travel preparation, event organization)
- Step-completion markers (FR + EN) now recognize natural phrasings
- Affect arousal threshold lowered from 0.6 to 0.4 to better capture
  emotional salience in everyday conversation
- ~50 affective lexicon entries added in French and English

**V5.7.0 (Visual Working Memory)**
- New short-term image buffer with capacity 3, exponential decay
  (10-min half-life), and salience-based eviction
- Image references resolve across turns even if no image is uploaded
  in the current message
- Cognitive zoom triggers on natural references to image regions

**V5.7.1 (semantic vision detector)**
- Migration from regex to embeddings for multilingual coverage
- Contrastive prototypes (positive + negative) with calibrated 0.06
  margin reduce false positives to near zero
- Anti-hallucination guard injected when an image is referenced but
  no zoom is triggered — prevents the LLM from fabricating details
- Validated at 95.1% precision on a 41-case labeled test set in
  degraded mode (without embeddings); higher with embeddings loaded

## 📦 Installation

See [README.md](README.md#installation) for full instructions. Quick
start:

```bash
git clone <repo-url>
cd lythea
./launch.sh
```

Requires a GPU pod with ≥24GB VRAM. Tested on RunPod A40 (48GB).

## 🔭 What's next (V5.8.x and V6.0.0)

- **V5.8.1** — CSV/Excel file analysis (extending Python sandbox to
  uploaded tabular data)
- **V5.9.0** — Retry logic when generated code fails, proactive
  visualizations during explanations
- **V6.0.0** — Epistemic perceptual grounding (track which visual
  details come from real VLM observations vs. LLM hallucinations) and
  calculation self-verification (silent re-checking of numerical
  claims before emission)

## 📋 Known limitations

- Single-user assumption (no auth, no multi-tenancy)
- GPU required (won't run on CPU)
- Long sessions accumulate memory in Chroma/SDM — manual wipe needed
- Empirical thresholds calibrated for personal use patterns
- Subprocess sandbox is appropriate for personal use but not for
  serving untrusted users
- No formal benchmark evaluation — validation is by direct observation

## 💬 Feedback

This is exploratory research code, not a production framework. If you
find something interesting, broken, or worth discussing, feel free to
open an issue or reach out via the contact in the README.
