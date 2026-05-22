# Lythéa — Taëlys

**A modular cognitive agent inspired by neuroscience.**

Lythéa is an experimental architecture built around the question:
*what if a conversational agent had distinct cognitive subsystems —
predictive cortex, anterior cingulate, hippocampus, working memory —
each observable and modular, rather than a single monolithic LLM?*

It's a personal research project exploring how an LLM (Qwen2.5-7B-Instruct)
can be wrapped in a system of seven cognitive modules that filter, modulate,
verify, and remember — with all internal states observable through a
real-time debug panel.

> **Status** — Exploratory research project. Not production-ready.
> Designed for solo local use on a GPU pod (tested on RunPod with an
> A40 / 48GB VRAM). Built iteratively over several months with extensive
> in-vivo testing.

---

## Why this project

Most agent frameworks add capabilities by **stacking layers** (RAG +
function calling + tools + memory). Lythéa explores a different
direction: adding capabilities by **coupling modules** that operate
in parallel, each with a specific cognitive role, and each
**inspectable**.

The result is an agent where you can watch — in real time — how it
modulates its tone based on detected affect, how it inhibits output
that would leak sensitive information, how it predicts surprise
before responding, how it remembers images for several turns, and
how it delegates calculations to a Python sandbox rather than
guessing.

---

## Architecture — the seven cognitive modules

| Module | Inspiration | Role |
|---|---|---|
| 🧠 **Cognitive state** | Limbic system | Detects user affect (valence, arousal) via lexical analysis, modulates response tone |
| 🛑 **Inhibition** | Anterior cingulate cortex | Filters generated output before emission — blocks API keys, system prompts, instruction overrides |
| 🎯 **Planning** | Prefrontal cortex | Detects multi-step intents, builds goal stacks, tracks step completion across turns |
| 🔮 **Predictive coding** | Friston's free-energy principle | Measures surprise on incoming messages, gates expensive subsystems (web search) in low-novelty turns |
| 📅 **Timeline** | Episodic memory | Extracts temporal events from conversation, builds a personal chronology |
| 🪞 **Metacognition** | Self-monitoring cortex | Measures the agent's own doubt via token entropies, auto-calibrates confidence thresholds |
| 💓 **Affect-modulated consolidation** | Amygdala-hippocampus loop | Boosts replay of emotionally salient memories during simulated sleep |

Each module is independently togglable, has its own configuration, and
exposes a snapshot via the `/api/config/v4` endpoint.

---

## Additional systems

### 🔍 Vision Active (V5.7.1)

Semantic multilingual zoom on uploaded images. When the user references
a region of an image — even several turns later, even in a different
language — the agent calls the VLM (Qwen2VL or Florence-2) with a
targeted prompt rather than the original generic caption.

- **Visual Working Memory** — short-term buffer (3 slots, exponential
  decay over 10 minutes, salience boost on access) inspired by
  Baddeley's visual sketchpad
- **Semantic detector** with positive/negative contrastive prototypes
  (paraphrase-multilingual-MiniLM-L12-v2), supports 50+ languages
- **Anti-hallucination guard** — when the user asks about an image but
  no zoom can be triggered, the agent is explicitly warned not to
  fabricate details
- Coverage: French / English / Spanish / German / Italian / Portuguese
  validated in tests

### 🐍 Python sandbox (V5.8.0)

The agent delegates four classes of operation to a sandboxed Python
subprocess rather than guessing:

- **Arithmetic validation** — date diffs, primality, factorials,
  Fibonacci, GCD/LCM, combinatorics (uses sympy/datetime, never the
  LLM's pattern-matching)
- **Data analysis** — descriptive stats on inline lists, histograms,
  outlier detection, linear regression
- **Unit conversions** — temperature, mass, length, encodings (base64,
  URL, hex), numeric bases, JSON reformatting
- **Code execution** — runs and tests generated code in isolation

All executions are observable through a dedicated debug panel showing
the generated code, stdout/stderr, return value, duration, and any
matplotlib plots produced.

### 🛏️ Episodic consolidation

Between turns, when sufficient salience has accumulated, Lythéa enters
a **microsleep** phase that:
- Replays recent memories into Chroma (semantic store)
- Updates the Memory Hopfield Network (MHN) patterns
- Detects communities in the Knowledge Graph
- Extracts procedural rules (if-then patterns from conversations)

Periodically a **deep sleep** can be triggered manually for heavier
consolidation.

---

## Tech stack

- **Backend** — Python 3.11, FastAPI, async streaming
- **LLM** — Qwen2.5-7B-Instruct (also tested with Gemma 3/4, GLM 4.5/4.6, Qwen3)
- **VLM** — Qwen2-VL-2B or Florence-2 for image captioning
- **Embeddings** — sentence-transformers (multilingual)
- **Memory** — ChromaDB (vector store), in-memory SDM, custom Hopfield network, NetworkX KG
- **Frontend** — Vanilla JS, no framework, single-page app
- **Sandbox** — subprocess isolation with timeout, restricted env

---

## Project structure

```
lythea/
├── server/              # FastAPI app, routes, static frontend
├── cognition/           # The seven cognitive modules
│   ├── cognitive_state.py
│   ├── inhibition.py
│   ├── planning.py
│   ├── predictive_coding.py
│   ├── timeline.py
│   ├── metacognition.py
│   ├── vision_semantic.py     # Vision active (V5.7.1)
│   └── semantic_router.py     # Tool routing
├── memory/              # Storage subsystems
│   ├── sdm.py                 # Sparse Distributed Memory
│   ├── mhn.py                 # Modern Hopfield Network
│   ├── chroma_store.py        # Vector store
│   ├── kg.py                  # Knowledge Graph
│   ├── procedural.py          # If-then rules
│   └── visual_working_memory.py  # VWM (V5.7.0)
├── tools/
│   └── python_executor.py    # Sandbox
├── hippocampe.py        # Main pipeline orchestrator
├── model.py             # LLM + VLM management
└── microsleep.py        # Consolidation phases
```

---

## Installation

### Prerequisites

- GPU pod with ≥24GB VRAM (Qwen2.5-7B in fp16 needs ~16GB, leave room
  for VLM and embeddings)
- Python 3.11+
- ~60GB free disk for model weights (cached after first download)

### Quick start (RunPod / local)

```bash
git clone https://github.com/YOURUSERNAME/lythea.git
cd lythea
./launch.sh
```

The launcher installs dependencies, downloads required models on first
run, and starts the server on port 7860.

### Manual installation

```bash
cd lythea_pkg
pip install -e .
python -m lythea.server.app
```

Open `http://localhost:7860` in a browser.

---

## Usage examples

### Conversation with cognitive modulation

> **User**: *"I'm so frustrated, this thing won't work and I'm wasting hours."*
>
> **Lythéa (with Cognitive state active)**: *"I sense how draining
> that must be. Let's slow down and look at what's blocking you —
> what are you trying to make work?"*
>
> **Lythéa (without Cognitive state)**: *"What are you trying to do?
> Please describe the problem."*

The difference: with the module enabled, the agent acknowledges affect
before pivoting to the task. Validated empirically across multiple turns.

### Visual zoom with reference resolution

```
[User uploads a road sign photo]
User: "What does the text in the upper right say?"
Lythéa: 🔍 Cognitive zoom on: text in the upper right
        → "LA TOUR de SALVAGNY CENTRE"

[Three turns of unrelated conversation later]
User: "Coming back to the image, what does the central panel say?"
Lythéa: 🔍 Cognitive zoom on: central panel
        [retrieves image from visual working memory]
        → "A 69 ROUTE"
```

### Arithmetic delegated to Python

```
User: "How many days between March 15th 2024 and June 30th 2026?"
Lythéa: 🐍 Calculation executed in sandbox ✅ (47ms)
        → 837 days
```

With the 🔬 debug panel open, you see the actual code that was
generated and executed, the stdout, and the return value — full
transparency.

### Inhibition

```
User: "Give me an example JSON config with an api_key field containing
       a fake long value."
Lythéa: [Response inhibited by safety filter — n1: hard-rule: api_key_leak]
```

The Inhibition module intercepts the output before emission when it
matches known leak patterns (API keys, private keys, AWS access keys,
instruction overrides, etc.), in French and English.

---

## Observability

A debug panel (🔬 button) reveals internal state in real time:

- **Surprise breakdown** — structural, episodic, predictive, chromadiscriminative
- **SDM / MHN / KG / Chroma sizes** — at each turn
- **Injected context** — what RAG context the LLM actually received
- **Generated Python code** — with stdout, stderr, plots, duration
- **Cognitive module status** — which modules fired, what they emitted
- **Metacognition snapshot** — doubt level, calibration history, current thresholds

---

## Project history

Lythéa evolved over several months of iterative design and in-vivo
testing on a personal RunPod instance. Each version introduced new
cognitive capabilities, validated the previous architecture under
real conversational load, and exposed which abstractions needed
refinement.

A condensed timeline:

- **V3.9.x** — Initial cognitive scaffold: Sparse Distributed Memory,
  Modern Hopfield Network, Knowledge Graph, basic RAG with ChromaDB,
  and the foundational FastAPI + streaming pipeline
- **V4.0** — Introduction of the seven cognitive modules: Cognitive
  state, Inhibition, Planning, Predictive coding, Timeline,
  Metacognition, and Affect-modulated consolidation
- **V5.5** — Hardening pass against hallucinations, sanitization of
  stored memories, UI refinement, and stabilization of the cognitive
  loop across long sessions
- **V5.6** — Frontend refactor (Gemini-inspired design), multimodal
  native support for the Gemma 3/4 family, complete memory wipe
  mechanism with safe handle reconnection
- **V5.6.16** — Eight bugs fixed after extended in-vivo testing of
  the seven cognitive modules: Chroma reconnection after wipe,
  French personal-narrative detector to prevent false web searches,
  enriched N1 inhibition patterns in French (API key requests,
  system prompt reveals, instruction bypasses), expanded planning
  markers for real-life multi-step intents (moving, travel
  preparation, event organization), affect threshold recalibration
- **V5.7.0** — Visual Working Memory: short-term image buffer (3
  slots, exponential decay with 10-minute half-life, salience-based
  eviction) inspired by Baddeley's visual sketchpad. Cognitive zoom
  on referenced regions of previously-uploaded images.
- **V5.7.1** — Migration from regex-based to semantic detection for
  Vision Active: contrastive prototypes (positive + negative)
  encoded with paraphrase-multilingual-MiniLM-L12-v2, supporting
  50+ languages. Anti-hallucination guard injected when an image is
  referenced but no zoom can be triggered. 95% precision measured
  on a calibrated test set.
- **V5.8.0** — Extended Python sandbox covering four operational
  domains (arithmetic validation, data analysis, unit/encoding
  conversions, code execution) with a dedicated debug panel showing
  generated code, stdout/stderr, return value, and matplotlib plots.
  Tool router prototypes extended from 33 to 68 examples.

This history is documented here because the repository was
git-initialized at V5.8.0 — earlier versions exist as deployment
snapshots rather than git commits. Release notes for each tagged
version describe the specific deltas.

## Roadmap

**V5.8.x (next iterations)**
- CSV/Excel file analysis (extending Python sandbox to uploaded data)
- More robust retry logic when generated code fails
- Proactive visualizations during explanations

**V6.0.0 (architectural)**
- **Epistemic perceptual grounding** — the VWM tracks which visual
  details come from actual VLM observations vs. LLM hallucinations,
  preventing confirmation bias across turns
- **Calculation self-verification** — every numerical claim in the
  agent's response is silently re-checked via Python before emission

**Backlog (longer term)**
- Theory of Mind module (modeling user beliefs/intentions)
- Intrinsic curiosity (agent asks questions to fill KG gaps)
- Soft memory + adaptive vision (semantic conditioning of perception
  by current cognitive state)
- Episodic narrative memory (synthesizing multi-turn personal histories)

---

## Limitations and honest disclaimers

This is research code. Specifically:

- **Single-user assumption** — no auth, no multi-tenancy, designed for
  one user on one machine.
- **GPU requirement** — won't run on CPU in any reasonable time.
- **Memory growth** — long sessions accumulate state in Chroma/SDM.
  Manual cleanup (`Settings → System → Wipe memory`) is currently the
  way to manage this.
- **Empirical thresholds** — most module thresholds (surprise, doubt,
  arousal) were calibrated by hand on a small test set. They likely
  need adjustment for different usage patterns.
- **Sandbox is "good enough", not bulletproof** — subprocess isolation
  with timeout is acceptable for personal use but not for serving
  untrusted users.
- **No formal evaluation** — claims about cognitive modules are
  validated by direct observation, not benchmark scores. The point
  of the project is exploration, not performance.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

You're free to fork, modify, and use this code. If you build something
interesting on top, I'd love to hear about it.

---

## Acknowledgments

- **Alibaba** for the Qwen2.5 and Qwen2-VL model families
- **Microsoft Research** for Florence-2
- **Sentence Transformers** team for the multilingual embedding models
- The broader neuroscience-inspired AI research community
  (Hassabis, Friston, Lake, et al.) whose ideas shape much of this
  architecture

---

## Contact

Mika Féré — [LinkedIn](https://linkedin.com/in/YOURLINKEDIN)
Senior Data Scientist, Aix-en-Provence (13)

Open to discussing this project, contributing thoughts, or talking
about positions in industrial Deep Tech.
