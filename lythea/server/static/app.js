/* Lythéa V6.0.0-rc rev9 — Taëlys Frontend */
(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────
  const S = {
    sessions: [],
    currentSession: null,
    runBySession: {},   // sessionId → run_id actif : interjection scopée par discussion
    tasksBySession: {},   // sessionId -> [card DOM elements], newest first
    messages: [],
    attachedImages: [],   // {dataUrl, base64, mime}
    attachedDocuments: [],  // {filename, size, text, mode, n_chars}
    modelInfo: null,
    streaming: false,
    abortCtrl: null,
    ctxTarget: null,
    reactMode: true,      // agent ReAct loop; toggled via the ⚡ button
  };

  // ── DOM refs ───────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Markdown helpers ───────────────────────────────────────────────
  // V4.4 — pré-process LaTeX inline. Les modèles thinking (Qwen3,
  // QwQ, DeepSeek-R1) génèrent souvent du LaTeX style $17 \times 23$
  // pour les expressions mathématiques. On n'a pas KaTeX/MathJax, donc
  // on remplace les commandes les plus courantes par leur équivalent
  // Unicode (×, ÷, ≈, ±, …) et on retire les délimiteurs $...$ pour
  // que le texte reste lisible. Approche minimale : si Lythéa a besoin
  // d'un vrai rendu mathématique (matrices, intégrales…), il faudra
  // intégrer KaTeX en local.
  function preprocessLatex(text) {
    if (!text || typeof text !== "string") return text;
    // Découpe le texte en segments hors-code / dans-code (backticks).
    // On ne transforme que les segments hors-code pour ne pas casser
    // les blocs de code qui pourraient contenir $ comme variable shell.
    const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
    return parts.map((part, i) => {
      // Indice pair : hors code → on transforme. Impair : bloc code → intact.
      if (i % 2 === 1) return part;
      return part
        .replace(/\\times/g, "×")
        .replace(/\\div/g, "÷")
        .replace(/\\approx/g, "≈")
        .replace(/\\pm/g, "±")
        .replace(/\\neq/g, "≠")
        .replace(/\\leq/g, "≤")
        .replace(/\\geq/g, "≥")
        .replace(/\\cdot/g, "·")
        .replace(/\\ldots/g, "…")
        // \frac{a}{b} → a/b (rendu lisible, pas joli mais correct)
        .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2")
        // $$...$$ et $...$ → contenu seul (sans les délimiteurs)
        .replace(/\$\$([^$]+?)\$\$/g, "$1")
        .replace(/\$([^$\n]+?)\$/g, "$1");
    }).join("");
  }
  // Petit wrapper autour de marked.parse pour appliquer le preprocess
  // automatiquement. À utiliser à la place de marked.parse(text).
  function mdParse(text) {
    return marked.parse(preprocessLatex(text || ""));
  }

  const dom = {
    sidebar: $("#sidebar"),
    toggle: $("#sidebar-toggle"),
    sessionList: $("#session-list"),
    searchInput: $("#search-sessions"),
    messages: $("#messages"),
    welcome: $("#welcome"),
    input: $("#chat-input"),
    btnSend: $("#btn-send"),
    btnAgent: $("#btn-agent"),
    wsView: $("#ws-view"),
    tasksView: $("#tasks-view"),
    tasksList: $("#tasks-list"),
    tasksBadge: $("#tasks-badge"),
    tasksEmpty: $("#tasks-empty"),
    btnStop: $("#btn-stop"),
    btnNew: $("#btn-new-chat"),
    btnDeleteAll: $("#btn-delete-all"),
    btnReasoning: $("#btn-reasoning"),
    fileInput: $("#file-input"),
    imgPreviews: $("#image-previews"),
    modelLabel: $("#model-label"),
    modalOverlay: $("#modal-overlay"),
    memoryOverlay: $("#memory-overlay"),
    ctxMenu: $("#ctx-menu"),
    progressWrap: $("#load-progress"),
    progressFill: $("#progress-fill"),
    progressText: $("#progress-text"),
    entropySlider: $("#entropy-slider"),
    entropyVal: $("#entropy-val"),
  };

  // ── Init ───────────────────────────────────────────────────────────
  dayjs.extend(dayjs_plugin_relativeTime);
  dayjs.locale("fr");

  marked.setOptions({
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang))
        return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
  });

  /**
   * Habille les `<pre><code>` produits par marked d'un en-tête
   * (langage + bouton Copier). Idempotent : un bloc déjà habillé
   * (marqué via dataset.enhanced) est ignoré, ce qui permet d'appeler
   * cette fonction à chaque update du streaming sans flicker ni double
   * traitement.
   *
   * Le bouton Copier utilise navigator.clipboard ; sur les navigateurs
   * qui le bloquent (http non-localhost), on retombe sur un fallback
   * document.execCommand.
   */
  function enhanceCodeBlocks(container) {
    if (!container) return;
    const blocks = container.querySelectorAll("pre > code:not([data-enhanced])");
    for (const code of blocks) {
      const pre = code.parentElement;
      code.dataset.enhanced = "1";

      // V6 — Marqueur de chemin en 1ʳᵉ ligne du bloc
      // (« # file: src/app.py », « // file: … », « <!-- file: … --> »).
      // Si présent : on retient le nom de fichier (en-tête + download)
      // et on retire la ligne marqueur de l'affichage. Fait AVANT la
      // coloration pour que hljs travaille sur le contenu nettoyé.
      let filename = "";
      {
        const raw = code.textContent;
        const nl = raw.indexOf("\n");
        const firstLine = nl === -1 ? raw : raw.slice(0, nl);
        const mPath = firstLine.match(
          /^\s*(?:#|\/\/|--|;{1,2}|%|<!--)?\s*(?:file|path)\s*[:=]\s*([^\s*][^\s]*?)\s*(?:-->)?\s*$/i
        );
        if (mPath) {
          filename = mPath[1].replace(/^\.\//, "").replace(/^\/+/, "");
          code.textContent = nl === -1 ? "" : raw.slice(nl + 1);
        }
      }

      // Extraire le langage depuis la classe (marked met "language-xxx").
      let lang = "code";
      for (const cls of code.classList) {
        if (cls.startsWith("language-")) {
          lang = cls.slice("language-".length);
          break;
        }
      }

      // Coloration syntaxique. Marked v5+ ignore l'option highlight de
      // setOptions, donc on l'applique manuellement ici — c'est la
      // méthode recommandée par highlight.js depuis v11. La classe
      // `.hljs` ajoutée par highlightElement signale qu'on a déjà
      // coloré, évite un double traitement.
      if (typeof hljs !== "undefined" && !code.classList.contains("hljs")) {
        try {
          hljs.highlightElement(code);
        } catch (_) { /* langage inconnu → on laisse monochrome */ }
      }

      // Wrapper qui remplace le <pre> nu : header + pre original.
      const wrapper = document.createElement("div");
      wrapper.className = "code-block";

      const header = document.createElement("div");
      header.className = "code-header";

      const langSpan = document.createElement("span");
      langSpan.className = "code-lang";
      // V6 — si un nom de fichier est déclaré, l'afficher en évidence ;
      // le langage reste indiqué à côté en plus discret.
      if (filename) {
        langSpan.classList.add("has-filename");
        langSpan.innerHTML =
          `<span class="code-filename">📄 ${escHtml(filename)}</span>` +
          `<span class="code-lang-sub">${escHtml(lang)}</span>`;
      } else {
        langSpan.textContent = lang;
      }

      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-btn";
      copyBtn.type = "button";
      copyBtn.innerHTML = "📋 Copier";
      copyBtn.addEventListener("click", async () => {
        const text = code.textContent;
        let ok = false;
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            ok = true;
          } else {
            // Fallback http/anciens navigateurs.
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand("copy");
            ta.remove();
          }
        } catch (_) { ok = false; }
        const original = copyBtn.innerHTML;
        copyBtn.innerHTML = ok ? "✓ Copié" : "❌ Erreur";
        copyBtn.classList.toggle("copied", ok);
        setTimeout(() => {
          copyBtn.innerHTML = original;
          copyBtn.classList.remove("copied");
        }, 1500);
      });

      const actions = document.createElement("span");
      actions.className = "code-actions";
      if (filename) {
        const dlBtn = document.createElement("button");
        dlBtn.className = "copy-btn dl-btn";
        dlBtn.type = "button";
        dlBtn.title = "Télécharger ce fichier";
        dlBtn.innerHTML = "⬇";
        dlBtn.addEventListener("click", () => {
          const blob = new Blob([code.textContent], {
            type: "text/plain;charset=utf-8",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename.split("/").pop() || "fichier.txt";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        actions.appendChild(dlBtn);
      }
      actions.appendChild(copyBtn);
      header.appendChild(langSpan);
      header.appendChild(actions);

      // Insérer le wrapper avant le <pre>, puis déplacer <pre> dedans.
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    }
  }

  // ── V6 — Barre multi-fichiers (projet) ──────────────────────────────
  // Quand une réponse déclare ≥2 fichiers (marqueurs « # file: » ou
  // info-string path=), on propose un .zip de tout le projet et un envoi
  // direct dans le workspace. Le comptage suit la même logique que le
  // parseur serveur (lythea/server/codegen.py) : on ne compte un bloc que
  // s'il déclare un chemin, jamais sur de la prose.
  function countCodeFiles(md) {
    if (!md) return 0;
    const lines = md.split("\n");
    let count = 0, inFence = false, fenceChar = "", justOpened = false;
    for (const line of lines) {
      const fm = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
      if (fm) {
        if (!inFence) {
          inFence = true; fenceChar = fm[1][0]; justOpened = true;
          if (/(?:^|\s)(?:path|file)\s*=\s*\S+/i.test(fm[2])) count++;
          continue;
        } else if (fm[1][0] === fenceChar) {
          inFence = false; continue;
        }
      }
      if (inFence && justOpened) {
        justOpened = false;
        if (/^\s*(?:#|\/\/|--|;{1,2}|%|<!--)?\s*(?:file|path)\s*[:=]\s*\S+/i.test(line)) count++;
      }
    }
    return count;
  }

  async function downloadProjectZip(text, btn) {
    const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = "…";
    try {
      const res = await authFetch("/api/codegen/zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "projet-lythea.zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      btn.innerHTML = "✓ .zip";
    } catch (e) { console.error("zip failed", e); btn.innerHTML = "❌"; }
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1800);
  }

  async function commitProject(text, btn) {
    const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = "…";
    try {
      const data = await api("/api/codegen/commit", {
        method: "POST",
        body: { text, subdir: "" },
      });
      const ok = data.written.length;
      const ko = data.skipped.length;
      btn.innerHTML = ko ? `⚠ ${ok}/${ok + ko}` : `✓ ${ok} fichiers`;
      if (typeof workspaceRefresh === "function") workspaceRefresh();
    } catch (e) { console.error("commit failed", e); btn.innerHTML = "❌"; }
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
  }

  function maybeAddCodegenBar(textEl, rawText) {
    if (!textEl) return;
    // Idempotent : retire une barre précédente liée à ce message
    // (re-render d'historique ou finalisation du streaming).
    if (textEl._codegenBar) { textEl._codegenBar.remove(); textEl._codegenBar = null; }
    const n = countCodeFiles(rawText);
    if (n < 2) return;

    const bar = document.createElement("div");
    bar.className = "codegen-bar";

    const label = document.createElement("span");
    label.className = "codegen-count";
    label.textContent = `📦 ${n} fichiers`;

    const zipBtn = document.createElement("button");
    zipBtn.type = "button"; zipBtn.className = "codegen-btn";
    zipBtn.innerHTML = "⬇ .zip";
    zipBtn.addEventListener("click", () => downloadProjectZip(rawText, zipBtn));

    const wsBtn = document.createElement("button");
    wsBtn.type = "button"; wsBtn.className = "codegen-btn";
    wsBtn.innerHTML = "📁 Workspace";
    wsBtn.title = "Écrire ces fichiers dans le workspace (sidebar)";
    wsBtn.addEventListener("click", () => commitProject(rawText, wsBtn));

    bar.appendChild(label);
    bar.appendChild(zipBtn);
    bar.appendChild(wsBtn);
    textEl.insertAdjacentElement("afterend", bar);
    textEl._codegenBar = bar;
  }

  async function init() {
    detectTheme();
    // V5.6.2 — Rotation de la question d'accueil sous le greeting.
    // Une question différente à chaque ouverture de la page / nouvelle
    // session. SessionStorage évite de retomber sur la même 2x de suite.
    rotateWelcomeQuestion();
    // V5.6.14 — Démarre les micro-mouvements organiques du logo.
    // Mouvement aléatoire non-cyclique (sinusoïdes irrationnelles),
    // pour donner au logo l'impression d'être vivant et de respirer.
    startLogoLifeBreath();
    // Wait for the backend boot sequence to complete (auxiliary models
    // preloading). The splash screen is hidden once ready=true.
    await waitForBoot();
    await loadSessions();
    await loadCurrentModel();
    // Fetch the live config values from the backend so UI controls
    // reflect the actual state instead of HTML hardcoded defaults.
    // This avoids the "displayed value lies about backend state" bug
    // where the slider showed 0.6 while the backend ran on 0.2 — and
    // worse, where clicking Save would push the stale displayed value
    // back to the backend.
    await loadInitialConfig();
    setupEvents();
    setupDragDrop();

    // V5.3 — Click sur le badge version → afficher le snapshot santé mémoire.
    // Discret par défaut, accessible quand on en a besoin.
    // V5.6 — Le footer-version est caché pour éviter le doublon avec
    // le brand-version (sidebar header). Le binding marche sur les deux,
    // au cas où l'utilisateur a un thème custom qui réaffiche le footer.
    const versionBadge = document.getElementById("version-badge");
    if (versionBadge) {
      versionBadge.addEventListener("click", showMemoryHealth);
    }
    const brandVersion = document.getElementById("brand-version-clickable");
    if (brandVersion) {
      brandVersion.addEventListener("click", showMemoryHealth);
    }
  }

  /**
   * Fetch all backend config values and reflect them in the UI.
   *
   * Each fetch is wrapped individually so a single endpoint failure
   * doesn't prevent the others from initialising. Failures are logged
   * to the console but never block the UI — the HTML defaults remain
   * as a safety net.
   */
  async function loadInitialConfig() {
    // Entropy slider — was the most visible mismatch (HTML default 0.6
    // vs backend default 0.2 after the post-refactor calibration).
    try {
      const cfg = await api("/api/config/entropy");
      if (cfg && typeof cfg.threshold === "number") {
        dom.entropySlider.value = String(cfg.threshold);
        dom.entropyVal.textContent = String(cfg.threshold);
      }
    } catch (e) {
      console.warn("loadInitialConfig: entropy fetch failed", e);
    }

    // Debug toggle — backend remembers the state across reloads, so
    // the visual ``active`` class on the button must match it. Without
    // this fetch, the bouton always starts visually OFF after a page
    // reload even if the backend has it ON, leading to confusion.
    // (Reasoning toggle is already handled by ``/api/models/current``
    // which returns ``reasoning_enabled``, so it doesn't need its own
    // fetch here.)
    try {
      const cfg = await api("/api/config/debug");
      if (cfg && typeof cfg.enabled === "boolean") {
        const btn = $("#btn-debug");
        if (btn) {
          if (cfg.enabled) btn.classList.add("active");
          else btn.classList.remove("active");
        }
      }
    } catch (e) {
      console.warn("loadInitialConfig: debug fetch failed", e);
    }

    // Web search mode dropdown.
    try {
      const cfg = await api("/api/config/web-mode");
      if (cfg && typeof cfg.mode === "string") {
        const sel = $("#web-mode");
        if (sel) sel.value = cfg.mode;
      }
    } catch (e) {
      console.warn("loadInitialConfig: web-mode fetch failed", e);
    }

    // V3.9.4: Cascade Gemini toggle. Reflects the current state
    // (which could differ from .env due to runtime overrides via
    // POST /api/config/cascade/toggle). The status text gives the
    // user a quick read on quotas without opening the debug panel.
    try {
      await refreshCascadeUI();
    } catch (e) {
      console.warn("loadInitialConfig: cascade fetch failed", e);
    }

    // Generation sliders — populated from the active sampling profile,
    // which is automatically updated on model swap. Each model family
    // has its own recommended profile (see CATALOG in lythea/config.py).
    await refreshSamplingFromBackend();
  }

  /**
   * Pull the active sampling profile from the backend and reflect it
   * in the UI sliders + section subtitle.
   *
   * Called on initial load AND every time a model is swapped, since
   * the backend auto-applies the new model's recommended profile.
   */
  /**
   * V3.9.4: Refresh the cascade toggle and status line.
   *
   * Pulls the live state from /api/config/cascade and reflects it in
   * the UI: checkbox state + a one-line status (model, quotas).
   *
   * Called on initial load, after a manual toggle, and after each
   * conversation turn (the `done` payload triggers an indirect refresh
   * via _renderCascadeStatus elsewhere).
   */
  async function refreshCascadeUI() {
    const toggle = $("#cascade-toggle");
    const statusText = $("#cascade-status-text");
    if (!toggle || !statusText) return;

    try {
      const cfg = await api("/api/config/cascade");
      if (!cfg) {
        toggle.checked = false;
        statusText.textContent = "Endpoint indisponible";
        return;
      }

      toggle.checked = !!cfg.enabled;

      if (cfg.enabled) {
        const used = cfg.quota_used ?? 0;
        const remaining = cfg.quota_remaining ?? 0;
        const total = used + remaining;
        statusText.textContent =
          `${cfg.model} · quota ${used}/${total} aujourd'hui`;
      } else {
        // Surface why the cascade is off so the user understands
        const reason = cfg.reason || "disabled";
        const labels = {
          disabled: "Désactivée (LYTHEA_ENABLE_CASCADE=false dans .env)",
          no_api_key: "Clé Google manquante (ajoute LYTHEA_GOOGLE_API_KEY au .env)",
          init_failed: "Échec d'initialisation — vérifie le format de la clé",
        };
        statusText.textContent = labels[reason] || `Désactivée (${reason})`;
      }
    } catch (e) {
      console.warn("refreshCascadeUI failed:", e);
      statusText.textContent = "Erreur de récupération de l'état";
    }
  }

  /**
   * Pull the active sampling profile from the backend and reflect it
   * in the UI sliders + section subtitle.
   *
   * Called on initial load AND every time a model is swapped, since
   * the backend auto-applies the new model's recommended profile.
   */
  async function refreshSamplingFromBackend() {
    try {
      const cfg = await api("/api/config/sampling");
      if (!cfg) return;
      _applySamplingToUI(cfg);
    } catch (e) {
      console.warn("refreshSamplingFromBackend failed", e);
    }
  }

  /** Update the UI sliders + subtitle from a sampling-profile-shaped object. */
  function _applySamplingToUI(cfg) {
    const setSlider = (id, value, decimals = 2) => {
      const slider = $("#" + id);
      const label = $("#" + id + "-val");
      if (!slider || !label) return;
      // null/None on backend → represented as 0/1 on slider depending
      // on the param. The backend semantics: top_p=null means disabled
      // → display 1.0 (no filtering). top_k=null → 0 (disabled).
      // min_p=null → 0 (disabled).
      let v = value;
      if (v === null || v === undefined) {
        if (id === "sampling-top-p") v = 1.0;
        else v = 0;
      }
      slider.value = String(v);
      label.textContent = Number(v).toFixed(decimals);
    };

    setSlider("sampling-temperature", cfg.temperature, 2);
    setSlider("sampling-top-p", cfg.top_p, 2);
    setSlider("sampling-top-k", cfg.top_k, 0);
    setSlider("sampling-min-p", cfg.min_p, 2);
    setSlider("sampling-rep-penalty", cfg.repetition_penalty, 2);

    const maxInput = $("#sampling-max-tokens");
    if (maxInput) {
      maxInput.value = String(cfg.max_new_tokens || 1024);
    }

    // Subtitle: name the source model so user knows what these defaults
    // came from. Empty model_id (no model loaded) falls back to a
    // generic label.
    const subtitle = $("#sampling-source");
    if (subtitle) {
      if (cfg.model_id) {
        const label = (S.modelInfo && S.modelInfo.label) || cfg.model_id;
        subtitle.textContent = `Profil recommandé pour ${label}`;
      } else {
        subtitle.textContent = "Profil par défaut (aucun modèle chargé)";
      }
    }
  }

  // ── Boot splash ────────────────────────────────────────────────────
  async function waitForBoot() {
    const splash = document.getElementById("boot-splash");
    const fill = document.getElementById("boot-progress-fill");
    const step = document.getElementById("boot-step");
    const stagesEl = document.getElementById("boot-stages");
    const elapsedEl = document.getElementById("boot-elapsed");
    if (!splash) return;

    const STAGE_LABELS = {
      chromadb: "ChromaDB + index BM25",
      gliner: "GLiNER (extraction d'entités)",
      sentence_transformer: "SentenceTransformer",
      cross_encoder: "Cross-encoder (reranker)",
      captioner: "Captioner d'images",
    };
    const STAGE_ORDER = ["chromadb", "gliner", "sentence_transformer", "cross_encoder", "captioner"];

    function renderStages(state) {
      stagesEl.innerHTML = "";
      const components = state.components || {};
      const activeStage = (state.current_step || "").replace("loading_", "");
      for (const key of STAGE_ORDER) {
        const li = document.createElement("li");
        const label = STAGE_LABELS[key] || key;
        const status = components[key];
        let icon = "○";
        let cls = "";
        if (status === "ok") { icon = "✅"; cls = "done"; }
        else if (status === "failed") { icon = "❌"; cls = "failed"; }
        else if (status === "skipped") { icon = "⏭️"; cls = "skipped"; }
        else if (key === activeStage) { icon = "⏳"; cls = "active"; }
        li.className = cls;
        li.innerHTML = `<span class="icon">${icon}</span> <span>${label}</span>`;
        stagesEl.appendChild(li);
      }
    }

    let consecutiveFailures = 0;
    while (true) {
      try {
        const res = await fetch("/api/boot/status");
        const state = await res.json();
        consecutiveFailures = 0;

        fill.style.width = (state.progress_pct || 0) + "%";
        const stageKey = (state.current_step || "").replace("loading_", "");
        if (state.current_step === "done") {
          step.textContent = "Prête !";
        } else if (state.current_step === "init") {
          step.textContent = "Initialisation…";
        } else {
          const label = STAGE_LABELS[stageKey] || stageKey;
          step.textContent = state.details ? `${label} — ${state.details}` : label;
        }
        renderStages(state);
        elapsedEl.textContent = `${state.elapsed_s.toFixed(1)}s`;

        if (state.ready) {
          // Smooth fade-out
          await new Promise(r => setTimeout(r, 400));
          splash.classList.add("fade-out");
          setTimeout(() => splash.remove(), 500);
          return;
        }
      } catch (e) {
        consecutiveFailures++;
        if (consecutiveFailures > 30) {
          step.textContent = "❌ Le serveur ne répond pas. Recharge la page.";
          return;
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ── V5.6.2 — Rotation question d'accueil ──────────────────────────
  //
  // 10 questions ouvertes, piochées au hasard à chaque chargement de
  // la page (ou nouvelle session). La dernière question utilisée est
  // mémorisée en sessionStorage pour éviter de retomber 2x de suite
  // sur la même — petit détail qui rend la rotation plus agréable.
  //
  // Le greeting "À l'écoute." reste fixe (signature Lythéa), seule la
  // question dessous tourne. La liste reflète la posture de Lythéa :
  // une assistante cognitive qui invite à entrer dans le travail.

  const WELCOME_QUESTIONS = [
    "De quoi parle-t-on aujourd'hui ?",
    "Par où commence-t-on ?",
    "Qu'est-ce qui vous occupe ?",
    "Sur quoi réfléchit-on ?",
    "Quelle est la question du jour ?",
    "Que cherchez-vous à comprendre ?",
    "Qu'est-ce qui vous traverse l'esprit ?",
    "Quel est votre projet du moment ?",
    "De quoi avez-vous envie de parler ?",
    "Qu'est-ce qui mérite réflexion ?",
  ];

  function rotateWelcomeQuestion() {
    const el = document.getElementById("welcome-question");
    if (!el) return;
    let lastIdx = -1;
    try {
      const stored = sessionStorage.getItem("lythea_last_welcome_q");
      if (stored !== null) lastIdx = parseInt(stored, 10);
    } catch (e) { /* sessionStorage indispo : OK */ }

    // Pioche un index différent du précédent
    let idx;
    if (WELCOME_QUESTIONS.length <= 1) {
      idx = 0;
    } else {
      do {
        idx = Math.floor(Math.random() * WELCOME_QUESTIONS.length);
      } while (idx === lastIdx);
    }
    el.textContent = WELCOME_QUESTIONS[idx];
    try { sessionStorage.setItem("lythea_last_welcome_q", String(idx)); }
    catch (e) { /* idem */ }
  }

  // ── V5.6.14 — Logo vivant : micro-mouvement aléatoire non-cyclique ─
  // Les @keyframes CSS sont cycliques par essence : au bout de quelques
  // cycles, l'œil perçoit la répétition et le logo redevient mécanique.
  // On combine 3 sinusoïdes de fréquences irrationnelles entre elles
  // (golden ratio, sqrt(2), pi) → la somme ne se répète jamais.
  // Le résultat est un tilt + nudge subtils (max ±1.5° et ±2px) qui
  // donnent l'impression que le logo respire ET réagit à des courants
  // invisibles. Désactivé si prefers-reduced-motion est actif.
  let _logoLifeRAF = null;
  function startLogoLifeBreath() {
    if (_logoLifeRAF !== null) return;
    if (window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const PHI = 1.6180339887;
    const SQRT2 = 1.4142135624;
    const PI = 3.1415926536;
    const t0 = performance.now();

    function tick(now) {
      const t = (now - t0) / 1000;  // temps en secondes

      // Somme de sinusoïdes avec fréquences irrationnelles entre elles
      // → mouvement quasi-périodique mais qui ne se répète jamais.
      // Fréquences choisies en cycles/min pour un mouvement très lent.
      const tilt =
        Math.sin(t * PHI * 0.10) * 0.7 +
        Math.sin(t * SQRT2 * 0.07) * 0.5 +
        Math.sin(t * PI * 0.05) * 0.3;  // total ≤ ~1.5°

      const nudgeX =
        Math.sin(t * PHI * 0.08 + 1.3) * 1.2 +
        Math.sin(t * SQRT2 * 0.06 + 0.7) * 0.8;  // total ≤ ~2px

      const nudgeY =
        Math.sin(t * SQRT2 * 0.09 + 2.1) * 1.0 +
        Math.sin(t * PI * 0.06 + 0.4) * 0.6;  // total ≤ ~1.6px

      // Applique au welcome-logo (le grand, en accueil) ET au
      // sidebar-logo (le petit, juste le tilt, pas le nudge pour
      // ne pas faire bouger toute la barre latérale).
      const welcomeLogo = document.querySelector(".welcome-logo");
      if (welcomeLogo) {
        // On AJOUTE au transform CSS existant (drift) via une variable
        // custom. La CSS doit utiliser var(--logo-life-transform).
        welcomeLogo.style.setProperty(
          "--logo-life-tilt",
          `${tilt.toFixed(3)}deg`,
        );
        welcomeLogo.style.setProperty(
          "--logo-life-nudge-x",
          `${nudgeX.toFixed(2)}px`,
        );
        welcomeLogo.style.setProperty(
          "--logo-life-nudge-y",
          `${nudgeY.toFixed(2)}px`,
        );
      }
      const sidebarLogo = document.querySelector(".sidebar-logo");
      if (sidebarLogo) {
        sidebarLogo.style.setProperty(
          "--logo-life-tilt",
          `${(tilt * 0.6).toFixed(3)}deg`,  // 60% du tilt pour discrétion
        );
      }

      _logoLifeRAF = requestAnimationFrame(tick);
    }
    _logoLifeRAF = requestAnimationFrame(tick);
  }

  // Stop la life loop si on quitte la page (économie batterie).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (_logoLifeRAF !== null) {
        cancelAnimationFrame(_logoLifeRAF);
        _logoLifeRAF = null;
      }
    } else {
      startLogoLifeBreath();
    }
  });

  // ── Theme ──────────────────────────────────────────────────────────
  function detectTheme() {
    // V5.6 — la palette UI est conçue pour le mode dark. On ignore
    // les préférences claires sauvegardées avant V5.6 et on force
    // dark comme défaut. L'utilisateur peut toujours basculer via
    // toggleTheme (mais les couleurs du mode light ne sont pas
    // optimisées dans cette version).
    document.documentElement.dataset.theme = "dark";
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme;
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  }

  // ── API helpers ────────────────────────────────────────────────────
  const TOKEN_STORAGE_KEY = "lythea_auth_token";

  function getAuthToken() {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  }

  function setAuthToken(token) {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    // V6.0.0-rc rev9 : signaler à tous les modules (workspace, autres
    // futures features) qu'un token est désormais dispo. Évite que
    // chaque module demande son propre prompt au démarrage.
    if (token) {
      try { window.dispatchEvent(new Event("lythea-auth-ready")); }
      catch { /* anciens navigateurs */ }
    }
  }

  function authHeaders() {
    const token = getAuthToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    return headers;
  }

  async function promptForToken(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal modal-sm">
          <div class="modal-header">
            <h2>🔐 Token requis</h2>
          </div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">
              ${escHtml(message || "Le serveur Lythéa demande une authentification. Saisis ton token d'accès :")}
            </p>
            <input type="password" id="token-input" placeholder="LYTHEA_AUTH_TOKEN"
                   style="width:100%;padding:10px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:var(--font-mono);font-size:13px" />
            <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
              <button id="token-cancel" class="btn-icon" style="padding:8px 14px">Annuler</button>
              <button id="token-ok" class="btn-primary">Valider</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const input = overlay.querySelector("#token-input");
      input.focus();
      const cleanup = (val) => {
        document.body.removeChild(overlay);
        resolve(val);
      };
      overlay.querySelector("#token-ok").onclick = () => cleanup(input.value.trim());
      overlay.querySelector("#token-cancel").onclick = () => cleanup(null);
      input.onkeydown = (e) => {
        if (e.key === "Enter") cleanup(input.value.trim());
        if (e.key === "Escape") cleanup(null);
      };
    });
  }

  async function api(path, opts = {}) {
    let res = await fetch(path, {
      headers: authHeaders(),
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    // 401 — prompt for token, store, retry once.
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      const msg = data.detail || "Authentification requise.";
      const token = await promptForToken(msg);
      if (token) {
        setAuthToken(token);
        res = await fetch(path, {
          headers: authHeaders(),
          ...opts,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      // V6.0.0-rc rev9 : _extractApiError pour gérer correctement
      // les detail qui sont des objets (validation errors FastAPI),
      // sinon le throw new Error donne "[object Object]".
      throw new Error(_extractApiError(err, res.statusText));
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * authFetch: like fetch() but injects Authorization, and on 401
   * prompts for the token and retries once. Use this for SSE / streaming
   * endpoints where api() doesn't fit because we want the raw Response
   * object (to read its body stream).
   */
  async function authFetch(path, opts = {}) {
    // V6.0.0-α2 fix : si le body est un FormData (upload multipart),
    // on NE PAS forcer Content-Type. Le navigateur ajoute lui-même
    // "multipart/form-data; boundary=..." avec la boundary correcte.
    // Si on impose "application/json" par-dessus, le serveur reçoit
    // un body multipart mais avec le mauvais Content-Type → 422.
    const isFormData = opts.body instanceof FormData;
    const baseHeaders = isFormData
      ? (getAuthToken() ? { "Authorization": "Bearer " + getAuthToken() } : {})
      : authHeaders();
    const headers = { ...baseHeaders, ...(opts.headers || {}) };
    let res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      const msg = data.detail || "Authentification requise.";
      const token = await promptForToken(msg);
      if (token) {
        setAuthToken(token);
        const retryBase = isFormData
          ? { "Authorization": "Bearer " + token }
          : authHeaders();
        const retryHeaders = { ...retryBase, ...(opts.headers || {}) };
        res = await fetch(path, { ...opts, headers: retryHeaders });
      }
    }
    return res;
  }

  // ── Sessions ───────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      S.sessions = await api("/api/sessions");
      renderSessions();
    } catch (e) { console.error("loadSessions:", e); }
  }

  function renderSessions(filter = "") {
    const list = dom.sessionList;
    list.innerHTML = "";
    const lower = filter.toLowerCase();
    const filtered = S.sessions.filter(s =>
      !filter || s.title.toLowerCase().includes(lower)
    );

    const groups = { pinned: [], today: [], yesterday: [], week: [], older: [] };
    const now = dayjs();

    for (const s of filtered) {
      if (s.pinned) { groups.pinned.push(s); continue; }
      const d = dayjs(s.last_activity * 1000);
      if (now.diff(d, "day") === 0) groups.today.push(s);
      else if (now.diff(d, "day") === 1) groups.yesterday.push(s);
      else if (now.diff(d, "day") <= 7) groups.week.push(s);
      else groups.older.push(s);
    }

    const labels = {
      pinned: "📌 Épinglés", today: "Aujourd'hui",
      yesterday: "Hier", week: "7 derniers jours", older: "Plus ancien",
    };

    for (const [key, items] of Object.entries(groups)) {
      if (!items.length) continue;
      const label = document.createElement("div");
      label.className = "session-group-label";
      label.textContent = labels[key];
      list.appendChild(label);

      for (const s of items) {
        const el = document.createElement("div");
        el.className = "session-item" + (S.currentSession === s.session_id ? " active" : "");
        el.dataset.id = s.session_id;
        el.innerHTML = (s.pinned ? '<span class="pin-icon">📌</span>' : "") + escHtml(s.title);
        el.addEventListener("click", () => openSession(s.session_id));
        el.addEventListener("contextmenu", (e) => showCtxMenu(e, s));
        list.appendChild(el);
      }
    }
  }

  async function openSession(id) {
    try {
      const data = await api(`/api/sessions/${id}?limit=200`);
      S.currentSession = id;
      // Restaure le run actif PROPRE à cette discussion (ou null) → un envoi
      // ici interjecte le bon run, ou démarre un nouveau run si aucun.
      S.agentRunId = S.runBySession[id] || null;
      S.messages = data.messages;
      renderMessages();
      renderSessions();
      renderTasksForSession(id);     // afficher les tâches de cette discussion
    } catch (e) { console.error("openSession:", e); }
  }

  async function newChat() {
    try {
      const data = await api("/api/sessions", { method: "POST" });
      S.currentSession = data.session_id;
      S.agentRunId = S.runBySession[data.session_id] || null;   // nouvelle discussion = aucun run
      S.messages = [];
      // Une discussion = ses propres tâches : on bascule sur le panneau (vide)
      // de la nouvelle discussion, SANS détruire celles des autres ni arrêter
      // un run en cours dans une autre discussion.
      renderTasksForSession(S.currentSession);
      await loadSessions();
      renderMessages();
      // V5.6.2 — Nouvelle question d'accueil au démarrage d'une session
      rotateWelcomeQuestion();
    } catch (e) { console.error("newChat:", e); }
  }

  // ── Context menu ───────────────────────────────────────────────────
  function showCtxMenu(e, session) {
    e.preventDefault();
    S.ctxTarget = session;
    const m = dom.ctxMenu;
    m.classList.remove("hidden");
    m.style.left = e.clientX + "px";
    m.style.top = e.clientY + "px";
    const pin = m.querySelector('[data-action="pin"]');
    pin.textContent = session.pinned ? "📌 Désépingler" : "📌 Épingler";
  }

  function hideCtxMenu() {
    dom.ctxMenu.classList.add("hidden");
    S.ctxTarget = null;
  }

  async function ctxAction(action) {
    const s = S.ctxTarget;
    if (!s) return;
    hideCtxMenu();

    if (action === "rename") {
      const title = prompt("Nouveau titre :", s.title);
      if (title) {
        await api(`/api/sessions/${s.session_id}`, { method: "PATCH", body: { title } });
        await loadSessions();
      }
    } else if (action === "pin") {
      await api(`/api/sessions/${s.session_id}`, { method: "PATCH", body: { pinned: !s.pinned } });
      await loadSessions();
    } else if (action === "export") {
      const res = await authFetch(`/api/sessions/${s.session_id}/export`);
      const text = await res.text();
      downloadText(text, `${s.title}.md`);
    } else if (action === "delete") {
      if (confirm("Supprimer cette conversation ?")) {
        await api(`/api/sessions/${s.session_id}`, { method: "DELETE" });
        // Stop a run belonging to this discussion, then drop its task cards.
        if (S.agentRunId && S.agentCard && S.agentCard.card &&
            S.agentCard.card.dataset.sid === s.session_id) {
          try { stopAgentRun(S.agentRunId); } catch (e) {}
        }
        delete S.tasksBySession[s.session_id];
        if (S.currentSession === s.session_id) {
          // Stoppe un éventuel streaming de chat appartenant à cette
          // conversation (sinon sa réponse atterrirait dans la conversation
          // suivante). L'AbortError est géré proprement dans sendMessage.
          if (S.abortCtrl) { try { S.abortCtrl.abort(); } catch (e) {} }
          S.currentSession = null;
          S.messages = [];
          renderMessages();
          if (dom.tasksList) dom.tasksList.innerHTML = "";
          _tasksBadgeBump();
        }
        await loadSessions();
      }
    }
  }

  // ── Messages rendering ─────────────────────────────────────────────
  function renderMessages() {
    const c = dom.messages;
    c.innerHTML = "";
    if (!S.messages.length) {
      c.appendChild(dom.welcome.cloneNode(true));
      return;
    }

    for (const m of S.messages) {
      if (m.thoughts && m.thoughts.length) {
        appendCollapsible("cognitive", "Activité cognitive", m.thoughts);
      }
      appendMessage(m.role, m.content, m.doubt_index, m.epistemic);
    }
    scrollBottom();
  }

  function appendCollapsible(type, title, items) {
    // type: "cognitive" or "reasoning"
    const details = document.createElement("details");
    details.className = `msg-collapsible msg-${type}`;
    const summary = document.createElement("summary");
    summary.textContent = title;
    const body = document.createElement("div");
    body.className = "collapsible-body";
    if (Array.isArray(items)) {
      body.innerHTML = items.map(t => mdParse(t)).join("");
    } else {
      body.innerHTML = mdParse(items || "");
    }
    enhanceCodeBlocks(body);
    // V4.4 — remplacer les emojis des titres de section par les SVG
    // colorés du nouveau design. Le backend continue d'émettre des
    // titres markdown avec emojis (« 🔬 **Phase A — Apprentissage** »,
    // « 🌐 Recherche web »…), on les détecte et on insère le bon
    // logo en début de ligne. Cohérent avec les pills de phase.
    if (type === "cognitive" || type === "debug") {
      injectCognitiveIcons(body);
    }
    details.appendChild(summary);
    details.appendChild(body);
    dom.messages.appendChild(details);
    // Garde les pills animées strictement en bas, sous tous les
    // onglets dépliables.
    _ensurePillsAtBottom();
    return body;
  }

  // ── V5.8.0 — Panneau Debug Python (sandbox transparente) ──────────
  // Quand le debug 🔬 est actif et qu'une exécution Python vient
  // d'avoir lieu, on fetch /api/cognition/python_last et on rend un
  // panneau pliable spécialisé : code généré avec syntax highlighting,
  // stdout/stderr/result, durée, plots inline en base64.
  async function fetchAndRenderPythonDebug() {
    try {
      const data = await api("/api/cognition/python_last");
      if (!data || !data.has_execution) return;
      const r = data.result || {};
      const code = data.code || "";
      const ok = r.ok === true;
      const durationMs = r.duration_ms || 0;
      const stdout = r.stdout || "";
      const stderr = r.stderr || "";
      const result = r.result || "";
      const error = r.error || null;
      const plots = Array.isArray(r.plots) ? r.plots : [];

      // Construit le HTML du panneau
      const details = document.createElement("details");
      details.className = "msg-collapsible msg-python-debug";
      const summary = document.createElement("summary");
      const statusIcon = ok ? "✅" : "⚠️";
      summary.textContent = `🐍 Sandbox Python — ${statusIcon} ${durationMs}ms`;
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "collapsible-body python-debug-body";

      // Section : code généré
      if (code) {
        const codeHeader = document.createElement("div");
        codeHeader.className = "python-debug-section-title";
        codeHeader.textContent = "Code généré";
        body.appendChild(codeHeader);
        const pre = document.createElement("pre");
        const codeEl = document.createElement("code");
        codeEl.className = "language-python";
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        body.appendChild(pre);
      }

      // Section : stdout
      if (stdout.trim()) {
        const h = document.createElement("div");
        h.className = "python-debug-section-title";
        h.textContent = "stdout";
        body.appendChild(h);
        const pre = document.createElement("pre");
        pre.className = "python-debug-output";
        pre.textContent = stdout;
        body.appendChild(pre);
      }

      // Section : valeur de retour (si différente de stdout)
      if (result.trim() && result.trim() !== stdout.trim()) {
        const h = document.createElement("div");
        h.className = "python-debug-section-title";
        h.textContent = "Valeur retournée";
        body.appendChild(h);
        const pre = document.createElement("pre");
        pre.className = "python-debug-output";
        pre.textContent = result;
        body.appendChild(pre);
      }

      // Section : stderr / error
      if (stderr.trim() || error) {
        const h = document.createElement("div");
        h.className = "python-debug-section-title python-debug-error";
        h.textContent = error ? "❌ Erreur" : "stderr";
        body.appendChild(h);
        const pre = document.createElement("pre");
        pre.className = "python-debug-output python-debug-stderr";
        // V5.8.8 — Afficher error ET stderr quand on a les deux.
        // Sans ça, on perdait le vrai message d'erreur Python
        // (ModuleNotFoundError, NameError, etc.) parce que seul
        // "exit_code_1" était affiché.
        let errorText = "";
        if (error) errorText += error;
        if (stderr.trim()) {
          if (errorText) errorText += "\n\n";
          errorText += stderr.trim();
        }
        pre.textContent = errorText;
        body.appendChild(pre);
      }

      // Section : plots inline
      if (plots.length > 0) {
        const h = document.createElement("div");
        h.className = "python-debug-section-title";
        h.textContent = `📊 ${plots.length} plot(s)`;
        body.appendChild(h);
        plots.forEach((b64, idx) => {
          const img = document.createElement("img");
          img.className = "python-debug-plot";
          img.src = `data:image/png;base64,${b64}`;
          img.alt = `Plot ${idx + 1}`;
          body.appendChild(img);
        });
      }

      // Bouton copier le code
      if (code) {
        const copyBtn = document.createElement("button");
        copyBtn.className = "python-debug-copy-btn";
        copyBtn.textContent = "📋 Copier le code";
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(code).then(() => {
            copyBtn.textContent = "✓ Copié";
            setTimeout(() => copyBtn.textContent = "📋 Copier le code", 1500);
          });
        });
        body.appendChild(copyBtn);
      }

      details.appendChild(body);
      dom.messages.appendChild(details);
      _ensurePillsAtBottom();

      // Syntax highlight le code Python
      details.querySelectorAll("pre code").forEach(el => {
        try { hljs.highlightElement(el); } catch (e) { /* noop */ }
      });
      scrollBottom();
    } catch (e) {
      console.warn("fetchAndRenderPythonDebug failed:", e);
    }
  }

  // ── Injection des SVG dans le bloc cognitif ──────────────────
  // Le backend émet des items markdown qui commencent par un emoji
  // (« 🔬 », « 🧠 », « 🌐 », « 💭 ») suivi du titre de la section.
  // On les substitue par des SVG colorés alignés avec le système
  // de pills. Les sous-lignes indentées (« Saillant: True »…) ne
  // sont pas touchées — elles restent du texte pur.
  function injectCognitiveIcons(root) {
    // Mapping emoji → {svg, cls}. On utilise les mêmes SVG que les
    // pills (depuis PILL_SVGS) pour la cohérence visuelle.
    const REPLACEMENTS = [
      // 🔬 Phase A — Apprentissage : icône particules (ambre)
      { match: /^🔬\s+(?=(?:<strong>)?Phase A)/i, svg: PILL_SVGS.learning,
        cls: "cog-ico-learning" },
      // 🔬 Phase B — RAG : icône graph (vert)
      { match: /^🔬\s+(?=(?:<strong>)?Phase B)/i, svg: PILL_SVGS.memory,
        cls: "cog-ico-memory" },
      // 🔬 Post-génération : icône T + arcs (violet)
      { match: /^🔬\s+(?=(?:<strong>)?Post)/i, svg: PILL_SVGS.thinking,
        cls: "cog-ico-thinking" },
      // 🌐 Recherche web : loupe (cyan)
      { match: /^🌐\s+/, svg: PILL_SVGS.web, cls: "cog-ico-web" },
      // 🧠 Surprise globale : icône surprise (rouge)
      { match: /^🧠\s+(?=Surprise)/i,
        svg: '<svg viewBox="0 0 40 40">' +
               '<circle cx="20" cy="20" r="14" fill="none" stroke="#f87171" stroke-width="2" opacity="0.5"/>' +
               '<circle cx="20" cy="20" r="4" fill="#f87171"/>' +
             '</svg>',
        cls: "cog-ico-surprise" },
      // 🧠 Feuille de route : icône réflexion (violet)
      { match: /^🧠\s+/, svg: PILL_SVGS.thinking, cls: "cog-ico-thinking" },
      // 💭 (souvenirs / RAG) : icône mémoire (vert)
      { match: /^💭\s+/, svg: PILL_SVGS.memory, cls: "cog-ico-memory" },
    ];

    // Marked transforme chaque item en <p>...</p>. On parcourt les
    // paragraphes et on substitue le préfixe emoji par un <span>
    // contenant le SVG. Les autres balises de la ligne (<strong>,
    // texte) sont préservées.
    const paragraphs = root.querySelectorAll("p");
    paragraphs.forEach(p => {
      const html = p.innerHTML;
      for (const r of REPLACEMENTS) {
        if (r.match.test(html)) {
          const replaced = html.replace(
            r.match,
            `<span class="cog-ico ${r.cls}">${r.svg}</span>`
          );
          if (replaced !== html) {
            p.innerHTML = replaced;
            p.classList.add("cog-section-title");
            break;  // un seul remplacement par paragraphe
          }
        }
      }
    });
  }

  // ── Phase status pills ────────────────────────────────────────
  // A "pill" is a small animated badge announcing what Taëlys is
  // doing right now: web search, thinking, generation. The pill
  // shows an inline animated SVG and a label; it's created when the
  // server emits ``phase_status: start`` and removed on
  // ``phase_status: done``. Only one pill per phase can be live at
  // a time (a duplicate ``start`` is a no-op).
  //
  // V4.4 — refonte visuelle : remplacement des emojis par des SVG
  // inline animés avec une couleur dédiée par phase. Chaque pill
  // mute selon l'activité (apprentissage/mémoire/web/réflexion/
  // génération). Aujourd'hui seuls ``web`` et ``thinking`` sont émis
  // par le backend ; les autres entrées ci-dessous sont prêtes pour
  // une future extension (phase_status: learning/memory/generating).
  const PILL_SVGS = {
    // L3 — particules qui s'agrègent vers le centre (apprentissage)
    learning:
      '<svg viewBox="0 0 40 40">' +
        '<circle class="particle" cx="20" cy="20" r="2"/>' +
        '<circle class="particle" cx="20" cy="20" r="2"/>' +
        '<circle class="particle" cx="20" cy="20" r="2"/>' +
        '<circle class="particle" cx="20" cy="20" r="2"/>' +
        '<circle class="particle" cx="20" cy="20" r="2"/>' +
        '<circle class="particle" cx="20" cy="20" r="2"/>' +
        '<circle class="core" cx="20" cy="20" r="3.5"/>' +
      '</svg>',
    // M2 — graph de nœuds reliés qui pulsent (mémoire = KG)
    memory:
      '<svg viewBox="0 0 40 40">' +
        '<line class="edge" x1="10" y1="12" x2="20" y2="20"/>' +
        '<line class="edge" x1="30" y1="12" x2="20" y2="20"/>' +
        '<line class="edge" x1="10" y1="30" x2="20" y2="20"/>' +
        '<line class="edge" x1="30" y1="30" x2="20" y2="20"/>' +
        '<circle class="node" cx="10" cy="12" r="2.5"/>' +
        '<circle class="node" cx="30" cy="12" r="2.5"/>' +
        '<circle class="node" cx="10" cy="30" r="2.5"/>' +
        '<circle class="node" cx="30" cy="30" r="2.5"/>' +
        '<circle class="node" cx="20" cy="20" r="3"/>' +
      '</svg>',
    // W6 — loupe avec halo (recherche web)
    web:
      '<svg viewBox="0 0 40 40">' +
        '<circle class="lens-glow" cx="16" cy="16" r="9"/>' +
        '<circle class="lens" cx="16" cy="16" r="9"/>' +
        '<line class="handle" x1="23" y1="23" x2="32" y2="32"/>' +
      '</svg>',
    // R5 — T au centre + arcs (réflexion = signature Taëlys)
    thinking:
      '<svg viewBox="0 0 40 40">' +
        '<circle class="t-arc-outer" cx="20" cy="20" r="16"/>' +
        '<circle class="t-arc-inner" cx="20" cy="20" r="10"/>' +
        '<text class="t-letter" x="20" y="25.5" text-anchor="middle" ' +
          'font-size="15" font-family="-apple-system, sans-serif" font-weight="700">T</text>' +
      '</svg>',
    // G2 — typing trois points (génération)
    generating:
      '<svg viewBox="0 0 40 40">' +
        '<circle class="typing-dot" cx="10" cy="20" r="3"/>' +
        '<circle class="typing-dot" cx="20" cy="20" r="3"/>' +
        '<circle class="typing-dot" cx="30" cy="20" r="3"/>' +
      '</svg>',
  };
  const PHASE_PILLS = {
    learning:   { svg: PILL_SVGS.learning,   label: "Apprentissage…",     cls: "pill-learning"   },
    memory:     { svg: PILL_SVGS.memory,     label: "Consulte la mémoire…", cls: "pill-memory" },
    web:        { svg: PILL_SVGS.web,        label: "Recherche web…",     cls: "pill-web"        },
    thinking:   { svg: PILL_SVGS.thinking,   label: "Réflexion…",         cls: "pill-thinking"   },
    generating: { svg: PILL_SVGS.generating, label: "Génération…",        cls: "pill-generating" },
  };
  const activePhasePills = new Map();  // phase → element

  function showPhasePill(phase) {
    if (activePhasePills.has(phase)) return;  // already shown
    const spec = PHASE_PILLS[phase];
    if (!spec) return;
    // V4.4 — masquer le typing-indicator générique ("Taëlys réfléchit…")
    // quand une phase pill prend le relais. La pill dit déjà précisément
    // ce que Taëlys fait, le typing au-dessus fait doublon visuel.
    const typing = dom.messages.querySelector(".typing-indicator");
    if (typing) typing.classList.add("typing-indicator-hidden");
    // V4.4 — wrapper la pill dans un container max-width centré pour
    // qu'elle s'aligne sur le bord gauche de la zone de messages
    // (comme une réponse Taëlys). Avant, la pill avait margin:auto et
    // se retrouvait au CENTRE de la page, déconnectée du flux.
    const wrap = document.createElement("div");
    wrap.className = "phase-pill-wrap";
    const pill = document.createElement("div");
    pill.className = `phase-pill ${spec.cls}`;
    pill.setAttribute("data-phase", phase);
    const ic = document.createElement("span");
    ic.className = "phase-pill-icon";
    ic.innerHTML = spec.svg;
    const lbl = document.createElement("span");
    lbl.className = "phase-pill-label";
    lbl.textContent = spec.label;
    pill.appendChild(ic);
    pill.appendChild(lbl);
    wrap.appendChild(pill);
    // V5.9.5 — Toujours appendChild (donc en bas) ET re-positionner
    // toutes les pills existantes pour qu'elles restent strictement
    // en dessous des onglets dépliables. Sans ça, l'ordre temporel
    // peut produire des incohérences visuelles : par exemple la pill
    // "Réflexion…" apparaissait au-dessus de l'onglet Sandbox Python
    // parce qu'elle était insérée APRÈS le bloc Réflexion lui-même.
    dom.messages.appendChild(wrap);
    activePhasePills.set(phase, wrap);
    // Force le re-positionnement de TOUTES les pills à la fin
    _ensurePillsAtBottom();
    scrollBottom();
  }

  /**
   * Helper : déplace toutes les phase-pills actives à la fin du
   * conteneur messages. Garantit que les pills animées restent
   * toujours en bas, sous tous les onglets dépliables (Sandbox
   * Python, Activité cognitive, Réflexion).
   */
  function _ensurePillsAtBottom() {
    for (const wrap of activePhasePills.values()) {
      if (wrap.parentNode === dom.messages) {
        dom.messages.appendChild(wrap);
      }
    }
  }

  /**
   * Helper : s'assure que le bloc Réflexion reste avant le message
   * AI dans le DOM. Appelé à chaque event reasoning (le serveur en
   * émet plusieurs pendant le streaming) et à la création du message
   * AI. Idempotent : no-op si la Réflexion est déjà au bon endroit.
   *
   * Le placement attendu :
   *   [Activité cognitive]
   *   [Sandbox Python]
   *   [Réflexion]           ← ici
   *   [Message AI]
   *   [Pills animées]
   */
  function _ensureReasoningBeforeMessage(reasoningElement, aiElement) {
    if (!reasoningElement || !aiElement) return;
    const aiMsg = aiElement.closest(".msg");
    const reasoningDetails = reasoningElement.closest("details");
    if (!aiMsg || !reasoningDetails) return;
    if (aiMsg.parentNode !== dom.messages || reasoningDetails.parentNode !== dom.messages) return;
    // Compare position : reasoning doit être strictement avant aiMsg
    const children = Array.from(dom.messages.children);
    if (children.indexOf(reasoningDetails) > children.indexOf(aiMsg)) {
      dom.messages.insertBefore(reasoningDetails, aiMsg);
    }
  }


  function hidePhasePill(phase) {
    const pill = activePhasePills.get(phase);
    if (!pill) return;
    // Fade out smoothly so the transition isn't jarring.
    pill.classList.add("phase-pill-fading");
    setTimeout(() => pill.remove(), 250);
    activePhasePills.delete(phase);
  }

  function hideAllPhasePills() {
    for (const phase of Array.from(activePhasePills.keys())) {
      hidePhasePill(phase);
    }
  }

  function renderWebSources(aiTextEl, sources) {
    // Append a clickable [N] reference list under the assistant message
    // so the user can map citations in the response to actual URLs.
    // ``sources`` is a list of {index, title, url, body}.
    if (!aiTextEl || !sources || sources.length === 0) return;
    const wrap = aiTextEl.closest(".msg") || aiTextEl.parentElement;
    if (!wrap) return;

    const container = document.createElement("details");
    container.className = "msg-collapsible msg-sources";
    container.open = true;  // open by default; user can collapse
    const summary = document.createElement("summary");
    summary.textContent = `📎 Sources (${sources.length})`;
    container.appendChild(summary);

    const list = document.createElement("ol");
    list.className = "web-sources-list";
    list.style.paddingLeft = "0";
    list.style.listStyle = "none";

    for (const src of sources) {
      const li = document.createElement("li");
      li.style.marginBottom = "6px";

      const idx = document.createElement("span");
      idx.textContent = `[${src.index}] `;
      idx.style.opacity = "0.7";
      idx.style.fontFamily = "monospace";
      li.appendChild(idx);

      if (src.url) {
        const a = document.createElement("a");
        a.href = src.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = src.title || src.url;
        a.style.textDecoration = "underline";
        li.appendChild(a);

        const dom_match = src.url.match(/^https?:\/\/(?:www\.)?([^/]+)/);
        if (dom_match) {
          const dom = document.createElement("span");
          dom.textContent = ` — ${dom_match[1]}`;
          dom.style.opacity = "0.5";
          dom.style.fontSize = "0.85em";
          li.appendChild(dom);
        }
      } else {
        const title = document.createElement("span");
        title.textContent = src.title || "(sans titre)";
        li.appendChild(title);
      }

      list.appendChild(li);
    }
    container.appendChild(list);
    wrap.appendChild(container);
  }

  // V5.8.7 — Render Python matplotlib plots inline under the response.
  // Visible même hors mode debug 🔬 (≠ panneau debug 🐍 qui est en
  // option). Affichage simple : titre + chaque PNG empilé.
  function renderPythonPlots(aiTextEl, plots) {
    if (!aiTextEl || !plots || plots.length === 0) return;
    const wrap = aiTextEl.closest(".msg") || aiTextEl.parentElement;
    if (!wrap) return;

    const container = document.createElement("div");
    container.className = "msg-python-plots";
    container.style.marginTop = "12px";

    const title = document.createElement("div");
    title.style.fontSize = "12px";
    title.style.color = "var(--text-muted, #94a3b8)";
    title.style.marginBottom = "6px";
    title.textContent = plots.length === 1
      ? "📊 Graphique généré par la sandbox Python"
      : `📊 ${plots.length} graphiques générés par la sandbox Python`;
    container.appendChild(title);

    plots.forEach((b64, idx) => {
      const img = document.createElement("img");
      img.className = "msg-python-plot";
      img.src = `data:image/png;base64,${b64}`;
      img.alt = `Plot ${idx + 1}`;
      img.style.maxWidth = "100%";
      img.style.borderRadius = "8px";
      img.style.border = "1px solid var(--border, #2a2c33)";
      img.style.background = "white";
      img.style.marginBottom = "6px";
      img.style.display = "block";
      container.appendChild(img);
    });

    wrap.appendChild(container);
  }

  function appendMessage(role, content, doubt, epistemic, images, docs) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-" + (role === "user" ? "user" : "ai");

    const roleEl = document.createElement("div");
    roleEl.className = "msg-role";
    roleEl.textContent = role === "user" ? "Toi" : "Taëlys";

    const contentEl = document.createElement("div");
    contentEl.className = "msg-content";

    // Thumbnails d'images jointes (user messages)
    if (images && images.length > 0) {
      const thumbRow = document.createElement("div");
      thumbRow.className = "msg-thumbnails";
      for (const img of images) {
        const thumb = document.createElement("img");
        thumb.className = "msg-thumb";
        thumb.src = img.dataUrl;
        thumb.alt = "Image jointe";
        // Clic → ouvrir en plein écran dans un overlay
        thumb.addEventListener("click", () => {
          const overlay = document.createElement("div");
          overlay.className = "thumb-overlay";
          const full = document.createElement("img");
          full.src = img.dataUrl;
          overlay.appendChild(full);
          overlay.addEventListener("click", () => overlay.remove());
          document.body.appendChild(overlay);
        });
        thumbRow.appendChild(thumb);
      }
      contentEl.appendChild(thumbRow);
    }

    // Miniatures de documents joints (user messages)
    if (docs && docs.length > 0) {
      const docRow = document.createElement("div");
      docRow.className = "msg-doc-thumbnails";
      for (const doc of docs) {
        const card = document.createElement("div");
        card.className = "msg-doc-card";
        const icon = document.createElement("span");
        icon.className = "doc-icon";
        icon.textContent = "📄";
        const name = document.createElement("span");
        name.className = "msg-doc-name";
        name.textContent = doc.filename;
        const mode = document.createElement("span");
        mode.className = "msg-doc-mode";
        if (doc.mode === "ingest") {
          mode.textContent = doc.autoUpgraded
            ? "📚 ajouté à la mémoire (auto)"
            : "📚 ajouté à la mémoire";
        } else if (doc.mode === "mission") {
          mode.textContent = "📂 déposé dans la mission";
        } else {
          mode.textContent = "📎 joint";
        }
        card.appendChild(icon);
        card.appendChild(name);
        card.appendChild(mode);
        docRow.appendChild(card);
      }
      contentEl.appendChild(docRow);
    }

    const textEl = document.createElement("div");
    textEl.className = "msg-text";
    textEl.innerHTML = mdParse(content || "");
    enhanceCodeBlocks(textEl);

    contentEl.appendChild(textEl);

    // V6 — barre multi-fichiers si la réponse déclare ≥2 fichiers.
    // Appelé après l'insertion de textEl pour que insertAdjacentElement
    // ait un parent.
    if (role === "assistant") maybeAddCodegenBar(textEl, content || "");

    if (role === "assistant" && doubt != null) {
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = `${epistemic || ""} · doute ${(doubt * 100).toFixed(0)}%`;
      contentEl.appendChild(meta);
    }

    wrap.appendChild(roleEl);
    wrap.appendChild(contentEl);
    dom.messages.appendChild(wrap);
    return textEl;
  }

  function scrollBottom() {
    requestAnimationFrame(() => {
      dom.messages.scrollTop = dom.messages.scrollHeight;
    });
  }

  // ── V6 — Steering (beta) ────────────────────────────────────────
  async function loadSteering() {
    const host = document.getElementById("steering-axes");
    if (!host) return;
    let state;
    try { state = await api("/api/steering"); }
    catch { host.innerHTML = '<div class="steering-row muted">Modèle non chargé.</div>'; return; }
    S.steeringMax = state.alpha_max || 8;
    host.innerHTML = "";
    (state.axes || []).forEach(ax => {
      const row = document.createElement("div");
      row.className = "steering-row";
      const active = state.active_axis === ax.name;
      const val = active ? (state.alpha || 0) : 0;
      row.innerHTML = `
        <label title="${escHtml(ax.description)}">${escHtml(ax.label)}
          ${ax.calibrated ? "" : '<span class="muted">(non calibré)</span>'}</label>
        <input type="range" min="${-S.steeringMax}" max="${S.steeringMax}"
               step="0.5" value="${val}" data-axis="${ax.name}">
        <span class="steering-val">${val}</span>`;
      const slider = row.querySelector("input");
      const out = row.querySelector(".steering-val");
      slider.addEventListener("input", () => { out.textContent = slider.value; });
      slider.addEventListener("change", () => applySteering(ax.name, parseFloat(slider.value)));
      host.appendChild(row);
    });
  }

  async function applySteering(axis, alpha) {
    // One axis at a time: zero the other sliders in the UI.
    document.querySelectorAll("#steering-axes input[type=range]").forEach(s => {
      if (s.dataset.axis !== axis) {
        s.value = 0;
        const o = s.parentElement.querySelector(".steering-val");
        if (o) o.textContent = "0";
      }
    });
    S.steeringActiveAxis = alpha !== 0 ? axis : null;
    try {
      await api("/api/steering", { method: "POST", body: { axis, alpha } });
    } catch (e) {
      console.error("steering apply failed", e);
      alert("Steering : " + (e.message || "échec (calibration trop longue ?)"));
    }
  }

  // Interrupteur maître (dans l'onglet Cognition). OFF par défaut.
  function toggleSteeringEnabled(on) {
    S.steeringEnabled = !!on;
    const ctrl = document.getElementById("steering-controls");
    if (ctrl) ctrl.style.display = on ? "block" : "none";
    if (on) loadSteering();
    else disableSteering();
  }

  // Détache le steering côté serveur et remet les curseurs à 0.
  async function disableSteering() {
    document.querySelectorAll("#steering-axes input[type=range]").forEach(s => {
      s.value = 0;
      const o = s.parentElement.querySelector(".steering-val");
      if (o) o.textContent = "0";
    });
    const axis = S.steeringActiveAxis || "concision";
    S.steeringActiveAxis = null;
    try {
      await api("/api/steering", { method: "POST", body: { axis, alpha: 0 } });
    } catch (e) { /* modèle non chargé / rien d'attaché : sans incidence */ }
  }

  // ── V6 — Mode agent (carte multi-étapes) ───────────────────────────
  // ── Panneau droit : commutateur Workspace / Tâches ─────────────────
  function switchWsPanel(view) {
    document.querySelectorAll(".ws-tab").forEach(t =>
      t.classList.toggle("on", t.dataset.view === view));
    if (dom.wsView) dom.wsView.classList.toggle("hidden", view !== "ws");
    if (dom.tasksView) dom.tasksView.classList.toggle("hidden", view !== "tasks");
    const up = document.getElementById("btn-workspace-upload");
    const rf = document.getElementById("btn-workspace-refresh");
    const cl = document.getElementById("btn-tasks-clear");
    if (up) up.style.display = view === "ws" ? "" : "none";
    if (rf) rf.style.display = view === "ws" ? "" : "none";
    if (cl) cl.classList.toggle("hidden", view !== "tasks");
    // S'assurer que la sidebar est ouverte si on bascule sur Tâches.
    if (view === "tasks") {
      const sb = document.getElementById("workspace-sidebar");
      if (sb) sb.classList.remove("collapsed");
    }
  }

  function _tasksBadgeBump() {
    const n = dom.tasksList ? dom.tasksList.children.length : 0;
    if (dom.tasksBadge) {
      dom.tasksBadge.textContent = n;
      dom.tasksBadge.classList.toggle("hidden", n === 0);
    }
    if (dom.tasksEmpty) dom.tasksEmpty.classList.toggle("hidden", n > 0);
  }

  // Affiche les cartes de la discussion donnée (les autres restent en
  // mémoire, rattachées à leur session). Les nœuds DOM sont conservés, donc
  // leurs gestionnaires d'événements survivent au détachement/rattachement.
  function renderTasksForSession(sid) {
    if (!dom.tasksList) return;
    dom.tasksList.innerHTML = "";
    const cards = S.tasksBySession[sid] || [];
    for (const c of cards) dom.tasksList.appendChild(c);
    _tasksBadgeBump();
  }

  // Vide le panneau Tâches de la discussion COURANTE uniquement (et arrête
  // une mission en cours si elle appartient à cette discussion).
  function clearTasks() {
    const sid = S.currentSession;
    if (S.agentRunId && S.agentCard &&
        S.agentCard.card && S.agentCard.card.dataset.sid === sid) {
      try { stopAgentRun(S.agentRunId); } catch (e) {}
    }
    if (sid) delete S.tasksBySession[sid];
    if (dom.tasksList) dom.tasksList.innerHTML = "";
    _tasksBadgeBump();
  }

  // Poignées de redimensionnement des panneaux latéraux (à la souris).
  function setupResizers() {
    try {
      const sv = localStorage.getItem("--sidebar-w");
      if (sv) document.documentElement.style.setProperty("--sidebar-w", sv);
      const wv = localStorage.getItem("--workspace-w");
      if (wv) document.documentElement.style.setProperty("--workspace-w", wv);
    } catch (e) {}

    const mk = (panel, side, varName, min, max) => {
      if (!panel || panel.querySelector(":scope > .panel-resizer")) return;
      if (getComputedStyle(panel).position === "static") panel.style.position = "relative";
      const h = document.createElement("div");
      h.className = "panel-resizer " + side;
      panel.appendChild(h);
      let startX = 0, startW = 0, dragging = false;
      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        let w = side === "right" ? startW + dx : startW - dx;
        w = Math.max(min, Math.min(max, w));
        document.documentElement.style.setProperty(varName, w + "px");
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        try {
          localStorage.setItem(varName,
            getComputedStyle(document.documentElement).getPropertyValue(varName).trim());
        } catch (e) {}
      };
      h.addEventListener("mousedown", (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = panel.getBoundingClientRect().width;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    };
    mk(document.getElementById("sidebar"), "right", "--sidebar-w", 200, 520);
    mk(document.getElementById("workspace-sidebar"), "left", "--workspace-w", 240, 600);
  }

  function toggleAgentMode() {
    S.agentMode = !S.agentMode;
    if (dom.btnAgent) dom.btnAgent.classList.toggle("active", S.agentMode);
    if (dom.input) {
      dom.input.placeholder = S.agentMode
        ? (S.agentRunId ? "Consigne à l'agent en cours…" : "Décris la tâche à confier à l'agent…")
        : "Envoie un message à Taëlys…";
    }
  }

  function _agentCardBuild(task) {
    const card = document.createElement("div");
    card.className = "agent-card";
    card.innerHTML = `
      <div class="agent-head">
        <button class="agent-fold" type="button" title="Plier / déplier">▾</button>
        <span class="agent-title-wrap">
          <span class="agent-title">Mission</span>
          <small class="agent-sub">${escHtml(task)}</small>
        </span>
        <span class="agent-elapsed" title="Durée"></span>
        <span class="agent-status">Démarrage…</span>
        <button class="agent-stop" type="button" title="Arrêter">■</button>
        <button class="agent-close" type="button" title="Retirer la mission">×</button>
      </div>
      <div class="agent-synthesis" style="display:none"></div>
      <div class="agent-exec" style="display:none"></div>
      <div class="agent-files-done" style="display:none"></div>
      <div class="agent-body">
        <ul class="agent-plan"></ul>
        <div class="agent-steps"></div>
      </div>`;
    // La carte vit dans le panneau Tâches (plus dans le fil de chat), et
    // reste rattachée à sa discussion (survit aux changements de discussion).
    const sid = S.currentSession || "_nosession";
    card.dataset.sid = sid;
    (S.tasksBySession[sid] || (S.tasksBySession[sid] = [])).unshift(card);
    if (dom.tasksList) dom.tasksList.insertBefore(card, dom.tasksList.firstChild);
    _tasksBadgeBump();
    switchWsPanel("tasks");
    const refs = {
      card,
      status: card.querySelector(".agent-status"),
      plan: card.querySelector(".agent-plan"),
      steps: card.querySelector(".agent-steps"),
      stop: card.querySelector(".agent-stop"),
      close: card.querySelector(".agent-close"),
      fold: card.querySelector(".agent-fold"),
      title: card.querySelector(".agent-title"),
      titleWrap: card.querySelector(".agent-title-wrap"),
      synthesis: card.querySelector(".agent-synthesis"),
      exec: card.querySelector(".agent-exec"),
      elapsed: card.querySelector(".agent-elapsed"),
      filesDone: card.querySelector(".agent-files-done"),
    };
    // Live elapsed timer (cleared when the run ends, see _agentStopTimer).
    refs._t0 = Date.now();
    refs._timer = setInterval(() => {
      if (refs.elapsed) refs.elapsed.textContent = _fmtDur(Date.now() - refs._t0);
    }, 1000);
    const toggleFold = () => {
      const folded = card.classList.toggle("collapsed");
      refs.fold.textContent = folded ? "▸" : "▾";
    };
    refs.fold.addEventListener("click", toggleFold);
    refs.titleWrap.addEventListener("click", toggleFold);
    refs.stop.addEventListener("click", (e) => {
      e.stopPropagation();
      if (S.agentRunId) {
        _agentSetStatus(refs, "Arrêt demandé…");
        stopAgentRun(S.agentRunId);
      }
    });
    refs.close.addEventListener("click", (e) => {
      e.stopPropagation();
      // Si c'est la mission active, on l'arrête d'abord.
      if (S.agentCard === refs && S.agentRunId) stopAgentRun(S.agentRunId);
      _agentStopTimer(refs);
      card.remove();
      _tasksBadgeBump();
    });
    return refs;
  }

  function _agentSetStatus(refs, txt) {
    if (refs && refs.status) refs.status.textContent = txt;
  }

  function _fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m + "m" + String(s % 60).padStart(2, "0");
  }

  function _agentStopTimer(refs) {
    if (refs && refs._timer) { clearInterval(refs._timer); refs._timer = null; }
    if (refs && refs.elapsed && refs._t0) {
      refs.elapsed.textContent = _fmtDur(Date.now() - refs._t0);
    }
  }

  function _agentRenderPlan(refs, steps) {
    refs.plan.innerHTML = "";
    steps.forEach((s, i) => {
      const li = document.createElement("li");
      li.dataset.index = i + 1;
      li.innerHTML = `<span class="agent-mark">☐</span> ${escHtml(s)}`;
      refs.plan.appendChild(li);
    });
  }

  function _agentMark(refs, index, mark, cls) {
    const li = refs.plan.querySelector(`li[data-index="${index}"]`);
    if (!li) return;
    const m = li.querySelector(".agent-mark");
    if (m) m.textContent = mark;
    if (cls) li.classList.add(cls);
  }

  function _agentAppendStep(refs, ev) {
    const det = document.createElement("details");
    det.className = "agent-step" + (ev.needs_attention ? " warn" : "");
    const files = (ev.files || [])
      .map(f => f.error ? `⚠ ${escHtml(f.path)}` : `📄 ${escHtml(f.path)}`)
      .join(" · ");
    det.innerHTML = `
      <summary>Étape ${ev.index} — ${escHtml(ev.title || "")}
        <span class="agent-meta">${escHtml(ev.worker || "")} · doute ${(ev.doubt ?? 0) * 100 | 0}%</span>
      </summary>
      <div class="agent-step-body">${mdParse(ev.content || "")}</div>
      ${files ? `<div class="agent-files">${files}</div>` : ""}`;
    refs.steps.appendChild(det);
    enhanceCodeBlocks(det);
    scrollBottom();
  }

  async function startAgentRun(task, attachments) {
    appendMessage("user", task);            // trace de la demande dans le fil
    const refs = _agentCardBuild(task);
    refs.session = S.currentSession || "";   // fige la discussion d'origine du run
    S.agentCard = refs;
    if (dom.input) dom.input.placeholder = "Consigne à l'agent en cours…";
    try {
      const res = await authFetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task, subdir: "", session_id: S.currentSession || "",
          react: (S.reactMode !== false),   // UI toggle; default ON
          attachments: Array.isArray(attachments) ? attachments : [],
        }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            let data;
            try { data = JSON.parse(line.slice(6)); } catch { continue; }
            _agentHandle(refs, eventType, data);
          }
        }
      }
    } catch (e) {
      console.error("agent run failed", e);
      _agentSetStatus(refs, "Erreur");
    } finally {
      // Fin du run : on le retire de SA discussion. On ne remet agentRunId à
      // null QUE si on est encore dans cette discussion (sinon on est ailleurs
      // et agentRunId pointe déjà le run de la discussion courante).
      if (refs && refs.session != null) delete S.runBySession[refs.session];
      if (!refs || S.currentSession === refs.session) S.agentRunId = null;
      if (dom.input && S.agentMode) dom.input.placeholder = "Décris la tâche à confier à l'agent…";
    }
  }

  // Icônes SVG du journal agent (style « atelier cognitif »). Trait fin,
  // currentColor pour hériter de la couleur sémantique de la carte.
  const AGENT_ICONS = {
    think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5a6 6 0 0 0-3 11 2 2 0 0 1 .9 1.7v.3a1.5 1.5 0 0 0 1.5 1.5h2.2a1.5 1.5 0 0 0 1.5-1.5v-.3a2 2 0 0 1 .9-1.7 6 6 0 0 0-3-11z"/><path d="M9.5 21h2"/></svg>',
    write: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 13h6M9 17h4"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v5l-4.5 8a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 8V3"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a2 2 0 0 1 2-2h6v16H4a2 2 0 0 1-2-2z"/><path d="M22 5a2 2 0 0 0-2-2h-6v16h6a2 2 0 0 0 2-2z"/></svg>',
    run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5 4 14 8-14 8z"/></svg>',
    result: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    lesson: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5"/></svg>',
  };
  // Quel outil → quelle icône + quelle classe de couleur sémantique.
  function _agentToolStyle(name) {
    switch (name) {
      case "write_file": return { ico: AGENT_ICONS.write, cls: "tk-write", label: "Écrit un fichier" };
      case "edit_file": return { ico: AGENT_ICONS.edit, cls: "tk-write", label: "Corrige un fichier" };
      case "delete_file": return { ico: AGENT_ICONS.edit, cls: "tk-write", label: "Supprime un fichier" };
      case "run_tests": return { ico: AGENT_ICONS.test, cls: "tk-test", label: "Lance les tests" };
      case "run_command": return { ico: AGENT_ICONS.run, cls: "tk-test", label: "Exécute une commande" };
      case "run_python": return { ico: AGENT_ICONS.run, cls: "tk-test", label: "Exécute du Python" };
      case "serve_and_probe": return { ico: AGENT_ICONS.run, cls: "tk-test", label: "Teste un serveur" };
      case "web_search": return { ico: AGENT_ICONS.search, cls: "tk-search", label: "Recherche web" };
      case "web_fetch": return { ico: AGENT_ICONS.search, cls: "tk-search", label: "Lit une page web" };
      case "read_file": return { ico: AGENT_ICONS.read, cls: "tk-read", label: "Lit un fichier" };
      case "list_files": return { ico: AGENT_ICONS.read, cls: "tk-read", label: "Liste les fichiers" };
      case "search_files": return { ico: AGENT_ICONS.read, cls: "tk-read", label: "Cherche dans les fichiers" };
      default: return { ico: AGENT_ICONS.run, cls: "tk-read", label: name || "Outil" };
    }
  }

  function _agentHandle(refs, type, data) {
    switch (type) {
      case "run_start":
        S.agentRunId = data.run_id;
        // Mémorise le run sous SA discussion : l'interjection ne vaudra que
        // dans cette discussion-là, pas dans une autre ouverte entre-temps.
        if (refs && refs.session != null) S.runBySession[refs.session] = data.run_id;
        if (data.name && refs.title) refs.title.textContent = data.name;
        _agentSetStatus(refs, "Planification…");
        break;
      case "plan":
        _agentRenderPlan(refs, data.steps || []);
        _agentSetStatus(refs, `Exécution 0/${(data.steps || []).length}`);
        break;
      case "step_start":
        _agentMark(refs, data.index, "▶", null);
        _agentSetStatus(refs, `Exécution ${data.index}`);
        break;
      case "step_done":
        _agentMark(refs, data.index, data.needs_attention ? "⚠" : "☑",
                   data.needs_attention ? "warn" : "ok");
        _agentAppendStep(refs, data);
        break;
      case "interjection_applied": {
        const note = document.createElement("div");
        note.className = "agent-interject";
        note.textContent = "↪ consigne prise en compte : " + (data.messages || []).join(" ");
        refs.steps.appendChild(note);
        break;
      }
      case "synthesis":
        // Le compte-rendu de Taëlys va UNIQUEMENT dans le fil de chat,
        // plus dans la carte Tâches (qui reste un journal d'actions).
        if ((data.text || "").trim()) appendMessage("assistant", data.text);
        break;
      case "tool_call": {
        const a = data.arguments || {};
        const arg = a.path || a.command || a.name || a.module || "";
        const sig = (data.name || "") + "|" + String(arg);
        const last = refs._lastTool;
        if (last && last.dataset.sig === sig) {
          // Same action repeated back-to-back → bump a counter instead of
          // stacking identical rows (keeps the trace readable).
          const n = (parseInt(last.dataset.count || "1", 10) || 1) + 1;
          last.dataset.count = String(n);
          last.classList.remove("ok", "ko");
          last.classList.add("pending");
          const dot = last.querySelector(".tk-dot");
          if (dot) dot.textContent = "…";
          let badge = last.querySelector(".tk-x");
          if (!badge) {
            badge = document.createElement("span");
            badge.className = "tk-x";
            const head = last.querySelector(".tk-head");
            (head || last).appendChild(badge);
          }
          badge.textContent = "×" + n;
          _agentSetStatus(refs, `Action ${refs._stepNo || ""} · ${data.name || "outil"}…`);
          break;
        }
        // The model's reasoning that led to this action — collapsible panel.
        if (data.thought) {
          const teaser = data.thought.replace(/\s+/g, " ").slice(0, 90);
          const det = document.createElement("details");
          det.className = "tk-entry tk-think";
          det.innerHTML =
            `<summary class="tk-think-sum">${AGENT_ICONS.think}` +
            `<span>${escHtml(teaser)}${data.thought.length > 90 ? "…" : ""}</span></summary>` +
            `<div class="tk-think-body">${escHtml(data.thought)}</div>`;
          if (refs.steps) refs.steps.appendChild(det);
        }
        refs._stepNo = (refs._stepNo || 0) + 1;
        const st = _agentToolStyle(data.name);
        const el = document.createElement("div");
        el.className = "tk-entry tk-card pending " + st.cls;
        el.dataset.sig = sig;
        el.dataset.count = "1";
        el.innerHTML =
          `<span class="tk-ico">${st.ico}</span>` +
          `<div class="tk-main">` +
            `<div class="tk-head">` +
              `<span class="tk-title">${escHtml(st.label)}</span>` +
              `<span class="tk-tag">${escHtml(data.name || "")}</span>` +
              `<span class="tk-dot">…</span>` +
            `</div>` +
            (arg ? `<div class="tk-arg"><code>${escHtml(String(arg))}</code></div>` : "") +
          `</div>`;
        if (refs.steps) refs.steps.appendChild(el);
        refs._lastTool = el;
        _agentSetStatus(refs, `Action ${refs._stepNo} · ${data.name || "outil"}…`);
        break;
      }
      case "tool_result": {
        const el = refs._lastTool;
        if (el) {
          el.classList.remove("pending");
          el.classList.add(data.ok ? "ok" : "ko");
          const dot = el.querySelector(".tk-dot");
          if (dot) dot.textContent = data.ok ? "✓" : "⚠";
        }
        break;
      }
      case "exec_start":
        _agentSetStatus(refs, "Tests…");
        break;
      case "exec_install":
        _agentSetStatus(refs, `Installe ${data.package || ""}…`);
        if (refs.exec) {
          refs.exec.style.display = "block";
          const line = document.createElement("div");
          line.className = "agent-exec-line";
          line.textContent = (data.ok ? "✓ installé " : "⚠ échec install ") + (data.package || "");
          refs.exec.appendChild(line);
        }
        break;
      case "exec_result": {
        const ok = !!data.ok;
        _agentSetStatus(refs, ok ? "✓ Tests OK" : "⚠ Tests KO");
        if (refs.exec) {
          refs.exec.style.display = "block";
          const iso = data.isolation ? ` · ${data.isolation}` : "";
          const txt = (data.summary ? data.summary : (ok ? "réussis" : "échoués")) + iso;
          const last = refs._lastVerdict;
          if (last && last.dataset.txt === txt) {
            const n = (parseInt(last.dataset.count || "1", 10) || 1) + 1;
            last.dataset.count = String(n);
            const lbl = last.querySelector(".tk-pill-txt");
            if (lbl) lbl.textContent = txt + "  ×" + n;
          } else {
            const v = document.createElement("div");
            v.className = "tk-pill " + (ok ? "ok" : "ko");
            v.dataset.txt = txt;
            v.dataset.count = "1";
            v.innerHTML = `<span>${ok ? "✓" : "✕"}</span>` +
              `<span class="tk-pill-txt">${escHtml(txt)}</span>`;
            refs.exec.appendChild(v);
            refs._lastVerdict = v;
          }
        }
        refs.card.classList.toggle("exec-ko", !ok);
        break;
      }
      case "deliberation": {
        // A separate "reason harder when stuck" pass — shown expanded, marked
        // as deep reasoning so it stands out from the inline per-step thoughts.
        const det = document.createElement("details");
        det.className = "tk-entry tk-think tk-deep";
        det.open = true;
        det.innerHTML =
          `<summary class="tk-think-sum">${AGENT_ICONS.think}` +
          `<span>Réflexion approfondie</span></summary>` +
          `<div class="tk-think-body">${escHtml(data.text || "")}</div>`;
        if (refs.steps) refs.steps.appendChild(det);
        _agentSetStatus(refs, "Réflexion…");
        break;
      }
      case "critique": {
        // The reviewer/critic pass bounced a finish with concrete feedback.
        const det = document.createElement("details");
        det.className = "tk-entry tk-think tk-crit";
        det.open = true;
        det.innerHTML =
          `<summary class="tk-think-sum">${AGENT_ICONS.search}` +
          `<span>Revue critique</span></summary>` +
          `<div class="tk-think-body">${escHtml(data.text || "")}</div>`;
        if (refs.steps) refs.steps.appendChild(det);
        _agentSetStatus(refs, "Revue critique…");
        break;
      }
      case "agent_warning": {
        const det = document.createElement("details");
        det.className = "tk-entry tk-think tk-warn-e";
        det.open = true;
        det.innerHTML =
          `<summary class="tk-think-sum">${AGENT_ICONS.warn}` +
          `<span>Avertissement</span></summary>` +
          `<div class="tk-think-body">${escHtml(data.message || "")}</div>`;
        if (refs.steps) refs.steps.appendChild(det);
        break;
      }
      case "lesson_learned": {
        // A reusable lesson distilled from this run's errors, saved to the
        // shared (chat+agent) procedural memory.
        const det = document.createElement("details");
        det.className = "tk-entry tk-think tk-lesson-e";
        det.innerHTML =
          `<summary class="tk-think-sum">${AGENT_ICONS.lesson}` +
          `<span>Leçon retenue</span></summary>` +
          `<div class="tk-think-body">${escHtml(data.trigger || "")} → ` +
          `${escHtml(data.approach || "")}</div>`;
        if (refs.steps) refs.steps.appendChild(det);
        break;
      }
      case "run_done": {
        const ex = data.exec;
        const mark = ex ? (ex.ok ? "✓ " : "⚠ ") : "";
        // Dedupe by path: a file rewritten across steps must count once.
        const seen = new Set();
        const files = (data.files || []).filter(f => {
          const p = f.path || String(f);
          if (seen.has(p)) return false;
          seen.add(p);
          return true;
        });
        _agentSetStatus(refs, `${mark}Terminé · ${files.length} fichier(s)`);
        if (refs.filesDone && files.length) {
          refs.filesDone.style.display = "block";
          refs.filesDone.innerHTML = files
            .map(f => `<span class="tk-file">${AGENT_ICONS.write}${escHtml(f.path || String(f))}</span>`)
            .join("");
        }
        _agentCollapse(refs);
        if (typeof workspaceRefresh === "function") workspaceRefresh();
        break;
      }
      case "run_stopped":
        _agentSetStatus(refs, "Arrêté");
        _agentCollapse(refs);
        break;
      case "run_error":
        _agentSetStatus(refs, "Erreur : " + (data.error || ""));
        _agentCollapse(refs);
        break;
    }
  }

  // Plie la carte agent (corps masqué, en-tête + statut conservés).
  function _agentCollapse(refs) {
    if (!refs || !refs.card) return;
    _agentStopTimer(refs);
    refs.card.classList.add("collapsed");
    if (refs.fold) refs.fold.textContent = "▸";
  }

  async function interjectAgent(runId, text) {
    if (S.agentCard) {
      const note = document.createElement("div");
      note.className = "agent-interject pending";
      note.textContent = "↪ transmis à l'agent : " + text;
      S.agentCard.steps.appendChild(note);
      scrollBottom();
    }
    try {
      await api("/api/agent/interject", { method: "POST", body: { run_id: runId, text } });
    } catch (e) { console.error("interject failed", e); }
  }

  async function stopAgentRun(runId) {
    try {
      await api("/api/agent/stop", { method: "POST", body: { run_id: runId } });
    } catch (e) { console.error("stop failed", e); }
  }

  // ── Streaming chat (fetch + ReadableStream) ────────────────────────
  async function sendMessage() {
    const text = dom.input.value.trim();
    if (!text && !S.attachedImages.length && !S.attachedDocuments.length) return;
    if (S.streaming) return;

    // V6 — Mode agent : on détourne l'envoi vers la boucle agentique.
    // Si un run est actif, le message devient une interjection ; sinon il
    // démarre un nouveau run. Le chat normal n'est jamais affecté quand
    // S.agentMode est faux.
    if (S.agentMode) {
      // Pièces jointes en mode agent : l'agent ne lit pas le contexte du
      // chat, il lit le filesystem de sa mission. On transmet le contenu
      // texte des documents au run, qui les dépose dans missions/<slug>/
      // pour que read_file les voie. Les images ne sont pas supportées.
      if (S.attachedDocuments.some(d => d.uploading)) return;  // attendre l'extraction
      const agentAtts = S.attachedDocuments
        .filter(d => !d.uploading && !d.error && (d.text || "").length)
        .map(d => ({ filename: d.filename, content: d.text }));
      const hadImages = S.attachedImages.length > 0;
      if (!text) {
        // Pas de consigne : on n'ouvre pas de run, mais on ne jette pas non
        // plus les fichiers en silence — on explique quoi faire.
        if (agentAtts.length || hadImages) {
          appendMessage("assistant",
            "📎 En mode agent, joins le fichier ET donne une consigne dans le même message "
            + "(ex. « analyse data.csv et calcule la moyenne par colonne »). "
            + (hadImages ? "Les images ne sont pas prises en charge par l'agent. " : "")
            + "Le fichier sera déposé dans le dossier de la mission, lisible par l'agent.");
        }
        return;
      }
      dom.input.value = "";
      autoResize();
      if (agentAtts.length || hadImages) {
        clearDocuments();   // le contenu part avec le run
        clearImages();      // images ignorées en mode agent
      }
      if (S.agentRunId) {
        if (agentAtts.length) {
          appendMessage("assistant",
            "📎 Les fichiers ne se déposent qu'au démarrage d'une mission, pas en cours de route. "
            + "Consigne transmise sans les fichiers — démarre une nouvelle mission pour les joindre.");
        }
        interjectAgent(S.agentRunId, text);
      } else {
        // Créer une session si besoin → la conversation apparaît à gauche
        // (et devient supprimable), titrée avec la tâche.
        if (!S.currentSession) {
          await newChat();
          try {
            await api(`/api/sessions/${S.currentSession}`,
                      { method: "PATCH", body: { title: text.slice(0, 60) } });
            await loadSessions();
          } catch (e) {}
        }
        startAgentRun(text, agentAtts);
      }
      return;
    }
    // Bloquer l'envoi tant que les documents sont en cours d'upload —
    // sinon on enverrait des doc.text vides et le contexte serait perdu.
    if (S.attachedDocuments.some(d => d.uploading)) {
      return;
    }

    // Ensure session exists
    if (!S.currentSession) await newChat();

    // Fige la conversation d'origine de CE message. Si l'utilisateur change
    // ou supprime la conversation pendant le streaming, la réponse ne doit
    // PAS s'afficher dans une autre conversation (elle reste persistée côté
    // serveur dans la conversation d'origine). Vérifié dans handleSSE.
    const originSession = S.currentSession;

    // Snapshot des pièces jointes pour l'affichage et le payload.
    const imgs = S.attachedImages.length ? [...S.attachedImages] : null;
    const docs = S.attachedDocuments.length ? [...S.attachedDocuments] : null;

    // Show user message with image + document thumbnails
    appendMessage("user", text, null, null, imgs, docs);
    dom.input.value = "";
    autoResize();
    scrollBottom();

    // Prepare images + documents pour le payload
    const images = S.attachedImages.map(i => ({ data: i.base64, mime: i.mime }));
    const documents = S.attachedDocuments
      .filter(d => !d.error && !d.uploading)
      .map(d => ({
        filename: d.filename,
        mode: d.mode,
        // attach : texte complet (déjà borné à DOC_ATTACH_MAX_CHARS sinon
        //   auto-upgrade en ingest).
        // ingest : extrait tronqué à DOC_ATTACH_MAX_CHARS aussi — il
        //   sert juste pour le tour courant (synthèse immédiate). Le
        //   contenu intégral est déjà dans ChromaDB pour les tours
        //   suivants via le RAG. Sans cet extrait, la synthèse immédiate
        //   échoue : la query RAG porte sur la note système, ramène des
        //   chunks hors sujet, le modèle hallucine.
        text: (d.text || "").slice(0, DOC_ATTACH_MAX_CHARS),
      }));
    clearImages();
    clearDocuments();

    // Start streaming
    S.streaming = true;
    dom.btnSend.classList.add("hidden");
    dom.btnStop.classList.remove("hidden");

    const abortCtrl = new AbortController();
    S.abortCtrl = abortCtrl;

    // Add typing indicator
    const typing = document.createElement("div");
    typing.className = "typing-indicator";
    typing.innerHTML = 'Taëlys réfléchit<span class="dots"></span>';
    dom.messages.appendChild(typing);
    scrollBottom();

    let aiTextEl = null;
    // Sticky : passe à true dès que ce stream est « déplacé » (l'utilisateur a
    // changé/supprimé la conversation d'origine pendant le streaming). Une fois
    // déplacé, on n'affiche plus rien en direct — la réponse reste persistée
    // côté serveur et réapparaît à la réouverture de la conversation.
    let displaced = false;
    let finalText = "";
    let cognitiveEl = null;
    let reasoningEl = null;
    // Buffer for web search citations [1], [2], … received during the
    // stream. Rendered as a "Sources" block under the response when
    // the 'done' event fires.
    let pendingWebSources = null;
    // V5.8.7 — Plots matplotlib générés par la Sandbox Python.
    // Rendus inline sous la réponse au moment du 'done'. Différent du
    // panneau debug 🐍 qui n'apparaît que si le mode 🔬 est actif.
    let pendingPythonPlots = null;

    try {
      const res = await authFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          session_id: S.currentSession,
          message: text,
          images,
          documents,
        }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // V6.0.0-rc rev9 : _extractApiError gère les detail objets
        throw new Error(_extractApiError(err, "Erreur serveur"));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            var eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSE(eventType, data);
            } catch (e) { /* skip malformed */ }
            eventType = null;
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Stream error:", e);
        appendCollapsible("cognitive", "Activité cognitive", ["⚠️ *Erreur : " + e.message + "*"]);
      }
    } finally {
      typing.remove();
      S.streaming = false;
      S.abortCtrl = null;
      dom.btnSend.classList.remove("hidden");
      dom.btnStop.classList.add("hidden");
      scrollBottom();
      loadSessions();
    }

    function handleSSE(type, data) {
      // Anti-fuite inter-conversation. Si l'utilisateur a changé/supprimé la
      // conversation d'origine pendant le streaming, la réponse ne doit JAMAIS
      // s'afficher ailleurs. Deux signaux, STICKY (displaced ne se réarme pas
      // même au retour dans la conv d'origine : le DOM a été reconstruit entre
      // temps, nos éléments sont invalides) :
      //   1. la conversation active diverge de l'origine ;
      //   2. notre bulle a été détachée du DOM par un re-render (basculement).
      // Une fois déplacé, on draine le flux ; la réponse reste persistée côté
      // serveur et réapparaît à la prochaine ouverture de la conversation.
      if (displaced) return;
      if (S.currentSession !== originSession ||
          (aiTextEl && !dom.messages.contains(aiTextEl))) {
        displaced = true;
        return;
      }
      if (type === "cognitive") {
        cognitiveEl = appendCollapsible("cognitive", "Activité cognitive", data.items || []);
        scrollBottom();
      } else if (type === "reasoning") {
        typing.remove();
        if (!reasoningEl) {
          // Le bloc Réflexion s'insère dans le groupe des onglets
          // dépliables (Activité cognitive, Sandbox Python) en haut.
          reasoningEl = appendCollapsible("reasoning", "Réflexion de Taëlys", "");
        }
        // Reposition défensif : à chaque event reasoning (il en arrive
        // plusieurs pendant le streaming), on s'assure que la Réflexion
        // reste avant le message AI. Idempotent.
        _ensureReasoningBeforeMessage(reasoningEl, aiTextEl);
        reasoningEl.innerHTML = mdParse(data.text || "");
        enhanceCodeBlocks(reasoningEl);
        _ensurePillsAtBottom();
        scrollBottom();
      } else if (type === "partial") {
        typing.remove();
        if (!aiTextEl) {
          aiTextEl = appendMessage("assistant", "");
          // Si le bloc Réflexion existe déjà (cas où l'event reasoning
          // a précédé le premier chunk de réponse), s'assurer qu'il
          // reste avant le message AI.
          _ensureReasoningBeforeMessage(reasoningEl, aiTextEl);
          // V6.0.0-rc rev9 — Flush des workspace offers bufferées
          if (window._pendingWorkspaceOffers && window._pendingWorkspaceOffers.length > 0) {
            for (const offer of window._pendingWorkspaceOffers) {
              renderWorkspaceOffer(aiTextEl, offer);
            }
            window._pendingWorkspaceOffers = [];
          }
        }
        finalText = data.text;
        aiTextEl.innerHTML = mdParse(finalText);
        enhanceCodeBlocks(aiTextEl);
        maybeAddCodegenBar(aiTextEl, finalText);
        _ensurePillsAtBottom();
        scrollBottom();
      } else if (type === "entropy") {
        // Telemetry — could add indicator
      } else if (type === "debug") {
        appendCollapsible("debug", "🔬 Debug — État mémoire", data.items || []);
        scrollBottom();
      } else if (type === "web_sources") {
        // Render the numbered list of web references so the user can
        // map citations [1], [2], … in the response back to actual URLs.
        // Stored in pendingWebSources and rendered when 'done' fires
        // (after the response, not before — visual placement matters).
        pendingWebSources = data.sources || [];
      } else if (type === "python_plots") {
        // V5.8.7 — Plots matplotlib générés par la sandbox Python.
        // Stockés pour rendu en fin de tour, à la suite de la réponse.
        // Visibles MÊME hors mode debug (≠ panneau debug qui dépend de 🔬).
        pendingPythonPlots = data.plots || [];
      } else if (type === "workspace_file_offer") {
        // V6.0.0-rc rev9 — Lythéa propose un fichier au téléchargement.
        // ``data`` doit contenir {name, path, size, mime, ...} (un
        // FileEntry sérialisé). Si la réponse AI n'existe pas encore,
        // on bufferise. Sinon, on rend la card immédiatement.
        if (aiTextEl) {
          renderWorkspaceOffer(aiTextEl, data);
        } else {
          // Stocker pour rendu au moment du premier partial
          if (!window._pendingWorkspaceOffers) window._pendingWorkspaceOffers = [];
          window._pendingWorkspaceOffers.push(data);
        }
        // Rafraîchir le tree de la sidebar pour montrer le nouveau fichier
        workspaceRefresh();
      } else if (type === "phase_status") {
        // Live status pill announcing what Taëlys is doing right now.
        // ``data.phase`` ∈ {"web", "thinking", "generation"}.
        // ``data.state`` ∈ {"start", "done"}. Start creates a pulsing
        // pill, done removes it. The phase decides the colour + label.
        const phase = data.phase;
        const state = data.state;
        if (state === "start") {
          showPhasePill(phase);
        } else {
          hidePhasePill(phase);
          // V5.8.0 — Quand une exécution Python se termine ET que le
          // debug est actif, on fetch les détails et on les affiche
          // dans un panneau spécialisé. Hors debug, seul le signal
          // inline "🐍 J'exécute du Python..." reste visible.
          if (phase === "python") {
            const debugActive = $("#btn-debug")?.classList.contains("active");
            if (debugActive) {
              // Fetch async — ne bloque pas le rendu
              fetchAndRenderPythonDebug();
            }
          }
        }
      } else if (type === "done") {
        // Stream complete: kill any pulsing pill that might still be
        // around. Server normally closes them itself but we do it
        // again here as a safety net (e.g. on aborted streams).
        hideAllPhasePills();
        if (aiTextEl && data.final_text) {
          aiTextEl.innerHTML = mdParse(data.final_text);
          enhanceCodeBlocks(aiTextEl);
          maybeAddCodegenBar(aiTextEl, data.final_text);
        }
        if (data.doubt_index != null) {
          const meta = document.createElement("div");
          meta.className = "msg-meta";
          meta.textContent = `${data.epistemic || ""} · doute ${(data.doubt_index * 100).toFixed(0)}%`;
          aiTextEl?.parentElement?.appendChild(meta);
        }
        // Render web sources block now that the message is finalised.
        if (pendingWebSources && pendingWebSources.length > 0) {
          renderWebSources(aiTextEl, pendingWebSources);
          pendingWebSources = null;
        }
        // V5.8.7 — Render Python plots inline under the response.
        // Visible même hors mode debug, contrairement au panneau 🐍.
        if (pendingPythonPlots && pendingPythonPlots.length > 0) {
          renderPythonPlots(aiTextEl, pendingPythonPlots);
          pendingPythonPlots = null;
        }
        aiTextEl?.querySelectorAll("pre code").forEach(el => hljs.highlightElement(el));
        scrollBottom();
      } else if (type === "error") {
        hideAllPhasePills();
        appendCollapsible("cognitive", "Activité cognitive", ["⚠️ *" + (data.message || "Erreur inconnue") + "*"]);
        scrollBottom();
      }
    }
  }

  function stopGeneration() {
    if (S.abortCtrl) S.abortCtrl.abort();
  }

  // ── Images ─────────────────────────────────────────────────────────
  // Extensions documentaires supportées par /api/upload/document.
  // Doit rester aligné sur SUPPORTED_EXTENSIONS dans document_ingest.py.
  const DOC_EXTENSIONS = new Set([
    ".pdf", ".txt", ".md", ".markdown", ".docx", ".rst",
    ".html", ".htm", ".csv", ".json", ".xml",
  ]);
  // Seuil de bascule auto "joindre" → "mémoire" pour les gros docs.
  // Doit rester cohérent avec le contexte des modèles non-thinking
  // (Qwen 7B accepte ~32K tokens, on borne large pour laisser de la
  // place au reste du contexte).
  // Seuil de taille de document — défini DYNAMIQUEMENT depuis le
  // contexte du modèle chargé (récupéré via /api/models/current).
  // Mis à jour à chaque chargement de modèle. Fallback conservateur
  // de 16K chars si la valeur n'est pas encore connue. Voir la
  // fonction refreshDocLimitFromModel() qui synchronise cette valeur.
  let DOC_ATTACH_MAX_CHARS = 16000;

  function fileIsDocument(file) {
    const name = (file.name || "").toLowerCase();
    for (const ext of DOC_EXTENSIONS) {
      if (name.endsWith(ext)) return true;
    }
    return false;
  }

  function addFile(file) {
    // Aiguille un fichier vers le bon handler selon son type.
    if (file.type && file.type.startsWith("image/")) {
      addImage(file);
    } else if (fileIsDocument(file)) {
      addDocument(file);
    } else {
      console.warn("[Lythéa] Type de fichier non supporté:", file.name);
    }
  }

  async function addDocument(file) {
    if (S.attachedDocuments.length >= 8) return;
    // Ajoute un placeholder "uploading" pour feedback immédiat.
    const placeholder = {
      filename: file.name,
      size: file.size,
      text: "",
      mode: "attach",
      n_chars: 0,
      uploading: true,
      error: null,
      _file: file,  // gardé pour ré-upload éventuel en mode ingest
    };
    S.attachedDocuments.push(placeholder);
    renderDocumentPreviews();

    // Upload + extraction côté serveur (mode "attach" par défaut).
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mode", "attach");

    try {
      // Upload multipart : on ne peut pas passer par authFetch qui
      // force Content-Type: application/json — ça écraserait le
      // multipart/form-data automatique du navigateur et FastAPI ne
      // saurait pas parser. On met uniquement le Authorization à la main.
      const token = getAuthToken();
      const headers = {};
      if (token) headers["Authorization"] = "Bearer " + token;
      const resp = await fetch("/api/upload/document?mode=attach", {
        method: "POST", body: fd, headers,
      });
      if (!resp.ok) {
        // 413 = doc trop long pour le modèle. Parse le JSON detail
        // pour afficher le vrai message (qui dit la limite et
        // recommande un modèle plus gros ou de découper).
        let msg = `${resp.status}`;
        try {
          const errJson = await resp.json();
          msg = errJson.detail || msg;
        } catch (_) {
          msg = `${resp.status}: ${await resp.text()}`;
        }
        throw new Error(msg);
      }
      const data = await resp.json();
      placeholder.text = data.text || "";
      placeholder.n_chars = data.n_chars || 0;
      placeholder.uploading = false;
      // Pas d'auto-upgrade en ingest : la limite est désormais
      // imposée côté serveur en fonction du modèle chargé (25 % du
      // contexte). Si le doc dépasse, le serveur a déjà rejeté avec
      // 413 plus haut, donc on n'arrive jamais ici sur un doc trop
      // long. Le badge 📎/📚 reste 100 % manuel.
    } catch (e) {
      placeholder.uploading = false;
      placeholder.error = e.message || "Erreur d'upload";
      console.error("[Lythéa] Document upload failed:", e);
    }
    renderDocumentPreviews();
  }

  async function switchDocumentMode(doc, newMode, opts = {}) {
    // Basculer entre "attach" et "ingest" — quand on passe en "ingest"
    // l'upload doit être refait côté serveur (l'ingestion crée des
    // chunks dans ChromaDB et enrichit le KG). En "attach" on a déjà
    // le texte localement, pas besoin de re-uploader.
    if (newMode === "ingest" && doc.mode !== "ingest") {
      doc.uploading = true;
      doc.autoUpgraded = !!opts.auto;
      renderDocumentPreviews();
      try {
        // On a besoin du blob original, mais on ne l'a plus —
        // alternative simple : on demande au serveur d'ingérer à partir
        // du texte déjà extrait. Comme notre endpoint ne le supporte
        // pas, on fait un re-upload via le file picker.
        // Pour ce flux UX, on stocke le File pendant addDocument →
        // on l'utilise ici. Voir doc._file injecté plus bas.
        if (!doc._file) {
          throw new Error("Fichier source non disponible pour ré-upload");
        }
        const fd = new FormData();
        fd.append("file", doc._file);
        const token = getAuthToken();
        const headers = {};
        if (token) headers["Authorization"] = "Bearer " + token;
        const resp = await fetch("/api/upload/document?mode=ingest", {
          method: "POST", body: fd, headers,
        });
        if (!resp.ok) throw new Error(`${resp.status}`);
        const data = await resp.json();
        doc.mode = "ingest";
        doc.n_chunks = data.n_chunks || 0;
        doc.n_entities = data.n_entities || 0;
        // En mode ingest, on garde le texte localement comme fallback
        // (la note système suffit côté serveur, mais ça ne mange rien).
      } catch (e) {
        doc.error = e.message;
      } finally {
        doc.uploading = false;
      }
    } else if (newMode === "attach" && doc.mode !== "attach") {
      // Retour à "attach" : on garde le texte déjà extrait, pas besoin
      // de re-uploader. Note : si le doc avait été ingéré, les chunks
      // ChromaDB restent — l'utilisateur peut explicitement les purger
      // via ingest.py --purge si besoin.
      doc.mode = "attach";
      doc.autoUpgraded = false;
    }
    renderDocumentPreviews();
  }

  function renderDocumentPreviews() {
    let container = $("#document-previews");
    if (!container) {
      // Insérer le conteneur juste après #image-previews s'il n'existe pas.
      const imgPreviews = $("#image-previews");
      container = document.createElement("div");
      container.id = "document-previews";
      container.className = "document-previews";
      imgPreviews.parentNode.insertBefore(container, imgPreviews.nextSibling);
    }
    container.innerHTML = "";
    S.attachedDocuments.forEach((doc, i) => {
      const wrap = document.createElement("div");
      wrap.className = "doc-preview";

      // Icône + nom + taille
      const icon = document.createElement("div");
      icon.className = "doc-icon";
      icon.textContent = "📄";

      const info = document.createElement("div");
      info.className = "doc-info";
      const nameEl = document.createElement("div");
      nameEl.className = "doc-name";
      nameEl.textContent = doc.filename;
      const metaEl = document.createElement("div");
      metaEl.className = "doc-meta";
      const sizeKb = doc.size ? Math.max(1, Math.round(doc.size / 1024)) : 0;
      if (doc.uploading) {
        metaEl.textContent = "⏳ Extraction…";
      } else if (doc.error) {
        metaEl.textContent = "⚠️ " + doc.error;
      } else {
        metaEl.textContent = `${sizeKb} KB · ${doc.n_chars} chars`;
      }
      info.appendChild(nameEl);
      info.appendChild(metaEl);

      // V6.0.0-rc rev9 — Badge statique (plus de toggle attach/ingest).
      // Le mode "ingest" du 📎 a été retiré au profit d'un mécanisme
      // unique et explicite : pour ingérer un fichier en mémoire long-
      // terme, l'utilisateur passe par la sidebar workspace + clic-droit
      // → 🧠 Ingérer en mémoire. Le 📎 du chat est désormais TOUJOURS
      // éphémère ("pour ce message"). Plus de toggle obscur ; chaque
      // mécanisme a une intention claire :
      //   - 📎 dans le chat   = question one-shot
      //   - Workspace sidebar = espace de travail collaboratif
      //   - 🧠 (clic-droit)   = mémoire long-terme
      const badge = document.createElement("span");
      badge.className = "doc-mode-badge badge-attach";
      const updateBadge = () => {
        if (doc.uploading) {
          badge.textContent = "…";
        } else if (doc.autoUpgraded) {
          // Auto-upgrade : doc trop long pour le contexte, on l'a
          // basculé en ingest automatiquement. Cas exceptionnel.
          badge.textContent = "📚 En mémoire (auto, doc long)";
          badge.classList.add("badge-auto");
        } else {
          // Cas normal : badge informatif, non cliquable.
          badge.textContent = "📎 joint";
          badge.title = "Joint pour ce message uniquement";
        }
      };
      updateBadge();

      // Bouton retirer
      const removeBtn = document.createElement("button");
      removeBtn.className = "doc-remove";
      removeBtn.textContent = "✕";
      removeBtn.title = "Retirer";
      removeBtn.addEventListener("click", () => {
        S.attachedDocuments.splice(i, 1);
        renderDocumentPreviews();
      });

      wrap.appendChild(icon);
      wrap.appendChild(info);
      wrap.appendChild(badge);
      wrap.appendChild(removeBtn);
      container.appendChild(wrap);
    });
  }

  function clearDocuments() {
    S.attachedDocuments = [];
    const container = $("#document-previews");
    if (container) container.innerHTML = "";
  }

  function addImage(file) {
    if (S.attachedImages.length >= 4) return;
    if (!file.type.startsWith("image/")) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      const mime = file.type || "image/png";
      S.attachedImages.push({ dataUrl, base64, mime });
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  }

  function renderImagePreviews() {
    dom.imgPreviews.innerHTML = "";
    for (let i = 0; i < S.attachedImages.length; i++) {
      const wrap = document.createElement("div");
      wrap.className = "img-preview";
      const img = document.createElement("img");
      img.src = S.attachedImages[i].dataUrl;
      const btn = document.createElement("button");
      btn.className = "remove";
      btn.textContent = "✕";
      btn.onclick = () => { S.attachedImages.splice(i, 1); renderImagePreviews(); };
      wrap.appendChild(img);
      wrap.appendChild(btn);
      dom.imgPreviews.appendChild(wrap);
    }
  }

  function clearImages() {
    S.attachedImages = [];
    dom.imgPreviews.innerHTML = "";
  }

  function setupDragDrop() {
    const area = dom.input.closest(".input-row");

    document.addEventListener("dragover", (e) => { e.preventDefault(); area.classList.add("drag-over"); });
    document.addEventListener("dragleave", () => area.classList.remove("drag-over"));
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      area.classList.remove("drag-over");
      for (const f of e.dataTransfer.files) addFile(f);
    });

    document.addEventListener("paste", (e) => {
      for (const item of (e.clipboardData?.items || [])) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) addImage(file);
        }
      }
    });
  }

  // ── Model management ───────────────────────────────────────────────
  async function loadCurrentModel() {
    try {
      const m = await api("/api/models/current");
      S.modelInfo = m;
      dom.modelLabel.textContent = m?.loaded ? `${m.label} 📝${m.is_thinking ? " 🧪" : ""}` : "Aucun modèle";

      // V5.6 — afficher le hint "Charge un modèle…" dans le welcome
      // si aucun modèle n'est chargé.
      const hintModelNeeded = document.querySelector(".hint-model-needed");
      if (hintModelNeeded) {
        hintModelNeeded.style.display = m?.loaded ? "none" : "block";
      }

      // Synchroniser la limite de taille des documents avec le contexte
      // du modèle chargé. Le backend calcule max_doc_chars = 25 % du
      // contexte du modèle (en chars, ~4 chars/token). On l'utilise
      // pour le tooltip et pour borner les extraits envoyés au serveur.
      if (m?.max_doc_chars && m.max_doc_chars > 0) {
        DOC_ATTACH_MAX_CHARS = m.max_doc_chars;
      }

      const btnUnload = $("#btn-unload");

      if (m?.loaded) {
        btnUnload.classList.remove("hidden");
        dom.btnReasoning.classList.remove("hidden");

        if (m.is_thinking) {
          // Thinking model: raisonnement natif, bouton locked ON
          dom.btnReasoning.classList.add("active");
          dom.btnReasoning.disabled = true;
          dom.btnReasoning.textContent = "🧠 Raisonnement (natif)";
          dom.btnReasoning.title = "Ce modèle raisonne nativement";
        } else {
          // Standard model: toggleable
          dom.btnReasoning.disabled = false;
          dom.btnReasoning.textContent = "🧠 Raisonnement";
          dom.btnReasoning.title = "Raisonnement adaptatif (2 ou 4 étapes selon la complexité)";
          if (m.reasoning_enabled) {
            dom.btnReasoning.classList.add("active");
          } else {
            dom.btnReasoning.classList.remove("active");
          }
        }
      } else {
        btnUnload.classList.add("hidden");
        dom.btnReasoning.classList.add("hidden");
      }

      // V5.6.15 — Toggle du banner "Vision native" dans Settings → Vision.
      // Quand le modèle chargé est multimodal natif (Gemma 3/4), on
      // affiche le banner explicatif et on masque la liste des captionneurs
      // (qui ne servent à rien dans ce mode).
      const banner = document.getElementById("native-multimodal-banner");
      const captionerList = document.getElementById("captioner-list");
      const captionerIntro = document.getElementById("captioner-intro");
      const captionerStatus = document.getElementById("captioner-status");
      const modelNameSpan = document.getElementById("native-mm-model-name");
      if (banner) {
        if (m?.loaded && m.is_natively_multimodal) {
          banner.classList.remove("hidden");
          if (modelNameSpan) modelNameSpan.textContent = m.label || m.model_id;
          if (captionerList) captionerList.style.display = "none";
          if (captionerIntro) captionerIntro.style.display = "none";
          if (captionerStatus) captionerStatus.style.display = "none";
        } else {
          banner.classList.add("hidden");
          if (captionerList) captionerList.style.display = "";
          if (captionerIntro) captionerIntro.style.display = "";
          if (captionerStatus) captionerStatus.style.display = "";
        }
      }
    } catch (e) { /* ignore */ }

    // After (un)loading a model, the backend's active sampling profile
    // has been updated to match the new model's recommendations.
    // Pull those new values into the sliders so the UI reflects what
    // generation will actually use.
    try {
      await refreshSamplingFromBackend();
    } catch (e) { /* ignore */ }
  }

  async function toggleReasoning() {
    if (!S.modelInfo?.loaded || S.modelInfo.is_thinking) return;
    const newState = !S.modelInfo.reasoning_enabled;
    try {
      await api("/api/config/reasoning", { method: "POST", body: { enabled: newState } });
      S.modelInfo.reasoning_enabled = newState;
      if (newState) {
        dom.btnReasoning.classList.add("active");
      } else {
        dom.btnReasoning.classList.remove("active");
      }
    } catch (e) { console.error("toggleReasoning:", e); }
  }

  async function toggleDebug() {
    const btn = $("#btn-debug");
    const isActive = btn.classList.contains("active");
    const newState = !isActive;
    try {
      await api("/api/config/debug", { method: "POST", body: { enabled: newState } });
      if (newState) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    } catch (e) { console.error("toggleDebug:", e); }
  }

  async function unloadModel() {
    if (!confirm("Décharger le modèle ? (libère la VRAM)")) return;
    try {
      await api("/api/models/unload", { method: "POST" });
      await loadCurrentModel();
      await renderModelList();
    } catch (e) { console.error("unload:", e); }
  }

  async function renderModelList() {
    const list = $("#model-list");
    try {
      const models = await api("/api/models");
      list.innerHTML = "";

      // If at least one model is blocked but loadable_with_blip,
      // show a hint banner about switching captioner.
      const anyNeedBlip = models.some(
        m => !m.loaded && !m.loadable && m.loadable_with_blip,
      );
      if (anyNeedBlip) {
        const hint = document.createElement("div");
        hint.className = "model-card-vram-warn";
        hint.innerHTML = `💡 Le captionneur GPU consomme de la VRAM. Bascule sur <strong>BLIP (CPU)</strong> dans Paramètres → Vision pour libérer plus de modèles.`;
        list.appendChild(hint);
      }

      for (const m of models) {
        const card = document.createElement("div");
        const blocked = !m.loadable && !m.loaded;
        card.className = "model-card";
        if (m.loaded) card.classList.add("loaded");
        if (blocked) card.classList.add("blocked");
        if (blocked && m.block_reason) {
          card.dataset.blockReason = m.block_reason;
        }

        let badge = m.is_thinking ? "🧪 Think" : "LLM";
        if (blocked) badge = "🔒 VRAM";

        let extraInfo = "";
        if (blocked && m.loadable_with_blip) {
          extraInfo = `<span class="model-card-quick-fix" data-action="swap-blip" data-model="${m.id}">
            ↻ Switcher sur BLIP et charger ce modèle
          </span>`;
        }

        card.innerHTML = `
          <div class="model-card-info">
            <h4>${escHtml(m.label)}</h4>
            <span>${m.size_gb} GB${m.notes ? " · " + escHtml(m.notes) : ""}</span>
            ${extraInfo}
          </div>
          <span class="model-card-badge${m.is_thinking ? " thinking" : ""}">${badge}</span>
        `;

        // Quick-fix button: swap to BLIP then load
        const quickFix = card.querySelector('[data-action="swap-blip"]');
        if (quickFix) {
          quickFix.addEventListener("click", (ev) => {
            ev.stopPropagation();
            loadModelWithBlip(m.id);
          });
        }

        // Main click: load if loadable, no-op if blocked.
        // Auto-unload of previous LLM is handled server-side.
        card.addEventListener("click", () => {
          if (blocked) return;
          loadModel(m.id);
        });

        list.appendChild(card);
      }
    } catch (e) { list.innerHTML = "<p>Erreur chargement modèles</p>"; }
  }

  async function loadModelWithBlip(modelId) {
    dom.progressWrap.classList.remove("hidden");
    dom.progressFill.style.width = "0%";
    dom.progressText.textContent = "Bascule sur BLIP puis chargement…";
    try {
      const res = await authFetch("/api/models/load-with-blip", {
        method: "POST",
        body: JSON.stringify({ model_id: modelId }),
      });
      await consumeLoadStream(res);
      // Re-render so the captioner change is reflected
      await renderCaptionerList();
    } catch (e) {
      dom.progressText.textContent = "Erreur : " + e.message;
    }
  }

  async function consumeLoadStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const statusLabels = {
      switching_captioner: "Bascule du captionneur",
      captioner_switched: "Captionneur basculé",
      unloading_previous: "Déchargement du précédent",
      downloading: "Téléchargement",
      loading_weights: "Chargement des poids",
      tokenizer: "Tokenizer",
      hooks: "Finalisation",
      already_loaded: "Déjà chargé",
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.error) {
            dom.progressText.textContent = "Erreur : " + data.error;
            return;
          }
          dom.progressFill.style.width = (data.pct || 0) + "%";
          if (data.finished) {
            dom.progressText.textContent = "Modèle chargé !";
            await loadCurrentModel();
            await renderModelList();
            setTimeout(() => dom.progressWrap.classList.add("hidden"), 2000);
            return;
          }
          const label = statusLabels[data.status] || "Chargement";
          dom.progressText.textContent = `${label}… ${Math.round(data.pct || 0)}%`;
        } catch (e) { /* skip */ }
      }
    }
  }

  async function loadModel(modelId) {
    dom.progressWrap.classList.remove("hidden");
    dom.progressFill.style.width = "0%";
    dom.progressText.textContent = "Chargement en cours…";

    try {
      const res = await authFetch("/api/models/load", {
        method: "POST",
        body: JSON.stringify({ model_id: modelId }),
      });
      await consumeLoadStream(res);
    } catch (e) {
      dom.progressText.textContent = "Erreur : " + e.message;
    }
  }

  // ── Settings modal ─────────────────────────────────────────────────
  function openSettings() {
    dom.modalOverlay.classList.remove("hidden");
    renderModelList();
    renderCaptionerList();
    loadSystemInfo();
  }

  function closeSettings() {
    dom.modalOverlay.classList.add("hidden");
  }

  async function renderCaptionerList() {
    const list = $("#captioner-list");
    const status = $("#captioner-status");
    try {
      const data = await api("/api/captioner");
      list.innerHTML = "";

      for (const opt of data.options) {
        const card = document.createElement("div");
        const isActive = data.backend === opt.id || (opt.id === "auto" && data.selected === "auto");
        const isSelected = data.selected === opt.id;
        card.className = "model-card" + (isActive ? " loaded" : "");
        card.innerHTML = `
          <div class="model-card-info">
            <h4>${escHtml(opt.label)}</h4>
            <span>${opt.device ? opt.device.toUpperCase() + " · " : ""}${opt.size_gb} GB${opt.notes ? " · " + escHtml(opt.notes) : ""}</span>
          </div>
          <span class="model-card-badge${opt.id === 'none' ? '' : (opt.device === 'gpu' ? ' thinking' : '')}">${opt.id === 'none' ? '—' : opt.device.toUpperCase()}</span>
        `;
        card.addEventListener("click", async () => {
          status.textContent = "Chargement…";
          try {
            const res = await api("/api/captioner/select", { method: "POST", body: { choice: opt.id } });
            status.textContent = res.status === "loaded" ? `✅ ${res.backend.toUpperCase()} actif` :
                                  res.status === "disabled" ? "Captionneur désactivé" :
                                  "❌ Échec du chargement";
            await renderCaptionerList();
            // VRAM availability changed — refresh model list to update grayed-out state
            await renderModelList();
          } catch (e) {
            status.textContent = "❌ Erreur : " + e.message;
          }
        });
        list.appendChild(card);
      }

      // Auto option
      const autoCard = document.createElement("div");
      autoCard.className = "model-card" + (data.selected === "auto" ? " loaded" : "");
      autoCard.innerHTML = `
        <div class="model-card-info">
          <h4>Auto</h4>
          <span>Qwen2-VL si VRAM dispo, sinon BLIP</span>
        </div>
        <span class="model-card-badge">🔄</span>
      `;
      autoCard.addEventListener("click", async () => {
        status.textContent = "Détection automatique…";
        const res = await api("/api/captioner/select", { method: "POST", body: { choice: "auto" } });
        status.textContent = res.status === "loaded" ? `✅ ${res.backend.toUpperCase()} (auto)` : "❌ Échec";
        await renderCaptionerList();
        await renderModelList();
      });
      list.insertBefore(autoCard, list.firstChild);

      status.textContent = data.backend ? `Actif : ${data.backend.toUpperCase()}` : "Aucun captionneur actif";
    } catch (e) {
      list.innerHTML = "<p>Erreur chargement captionneurs</p>";
    }
  }

  async function loadSystemInfo() {
    try {
      const h = await api("/api/health");
      $("#system-info").innerHTML = `
        <p><strong>Plateforme :</strong> ${h.platform}</p>
        <p><strong>VRAM :</strong> ${h.vram_free_gb} / ${h.vram_total_gb} GB</p>
        <p><strong>Cache :</strong> ${h.cache_root}</p>
        <p><strong>Modèle :</strong> ${h.model_id || "aucun"}</p>
      `;
    } catch (e) { /* ignore */ }
  }

  // ── Memory modal ───────────────────────────────────────────────────
  async function openMemory() {
    dom.memoryOverlay.classList.remove("hidden");
    try {
      const status = await api("/api/memory/status");
      $("#memory-detail").innerHTML = `
        <p><strong>SDM :</strong> ${status.sdm.active_rows} / ${status.sdm.total_rows} lignes actives</p>
        <p><strong>MHN :</strong> ${status.mhn.stored} / ${status.mhn.max} patterns</p>
        <p><strong>KG :</strong> ${status.kg.entities} entités, ${status.kg.relations} relations</p>
        <p><strong>Chroma :</strong> ${status.chroma.count} documents</p>
        <p><strong>Échanges :</strong> ${status.exchange_count}</p>
      `;
    } catch (e) { /* ignore */ }
  }

  async function loadKGEntities() {
    try {
      const entities = await api("/api/memory/kg/entities");
      const el = $("#kg-entities");
      el.innerHTML = "";
      // Sort: most-mentioned first, then alphabetical
      entities.sort((a, b) => {
        const m = (b.mention_count || 1) - (a.mention_count || 1);
        return m !== 0 ? m : (a.value || "").localeCompare(b.value || "");
      });
      for (const e of entities) {
        const row = document.createElement("div");
        row.className = "kg-entity";
        // Build the badge: type + mention count if > 1
        const mentionBadge = (e.mention_count && e.mention_count > 1)
          ? `<span class="mentions" title="Nombre de mentions">×${e.mention_count}</span>`
          : "";
        // Confidence indicator: low (<0.6), medium (<0.8), high
        const conf = e.confidence ?? 0.5;
        const confClass = conf < 0.6 ? "low" : (conf < 0.8 ? "med" : "high");
        const confBadge = `<span class="confidence ${confClass}" title="Confiance ${(conf*100).toFixed(0)}%">●</span>`;
        // Aliases: show if any (alternative spellings, e.g. accents/case differences)
        const aliasesLine = (Array.isArray(e.aliases) && e.aliases.length)
          ? `<div class="aliases">aussi connu comme : ${e.aliases.map(escHtml).join(", ")}</div>`
          : "";
        row.innerHTML = `
          <div class="kg-main">
            <span class="kg-value">${escHtml(e.value)}</span>
            <span class="type">${escHtml(e.type)}</span>
            ${mentionBadge}
            ${confBadge}
            <button class="del-btn" data-id="${e.entity_id}">✕</button>
          </div>
          ${aliasesLine}
        `;
        row.querySelector(".del-btn").addEventListener("click", async () => {
          await api(`/api/memory/kg/entities/${e.entity_id}`, { method: "DELETE" });
          loadKGEntities();
        });
        el.appendChild(row);
      }
    } catch (e) { /* ignore */ }
  }

  // ── Event setup ────────────────────────────────────────────────────
  function setupEvents() {
    // Send message
    dom.btnSend.addEventListener("click", sendMessage);
    dom.btnStop.addEventListener("click", stopGeneration);
    if (dom.btnAgent) dom.btnAgent.addEventListener("click", toggleAgentMode);
    document.querySelectorAll(".ws-tab").forEach(t =>
      t.addEventListener("click", () => switchWsPanel(t.dataset.view)));
    const _btnClear = document.getElementById("btn-tasks-clear");
    if (_btnClear) _btnClear.addEventListener("click", clearTasks);
    setupResizers();
    const steerEnable = document.getElementById("steering-enable");
    if (steerEnable) {
      steerEnable.checked = false;                       // OFF par défaut
      steerEnable.addEventListener("change", () => toggleSteeringEnabled(steerEnable.checked));
      disableSteering();                                 // garantit l'état détaché côté serveur au chargement
    }

    dom.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-resize textarea
    dom.input.addEventListener("input", autoResize);

    // New chat
    dom.btnNew.addEventListener("click", newChat);

    // Delete all sessions (double confirm to prevent accidents)
    dom.btnDeleteAll.addEventListener("click", async () => {
      // Count first so the confirm prompt is informative.
      const sessions = await api("/api/sessions").catch(() => []);
      if (!sessions || sessions.length === 0) {
        alert("Aucune conversation à supprimer.");
        return;
      }
      const ok = confirm(
        `Supprimer définitivement les ${sessions.length} conversation(s) ?\n\n` +
        `Cette action est irréversible.`
      );
      if (!ok) return;
      try {
        const res = await api("/api/sessions", { method: "DELETE" });
        // Visual feedback: clear UI then reload list.
        dom.messages.innerHTML = "";
        S.currentSession = null;
        await loadSessions();
        // Open a fresh chat so the user lands on something usable.
        await newChat();
      } catch (e) {
        alert("Erreur lors de la suppression : " + e.message);
      }
    });

    // File input
    dom.fileInput.addEventListener("change", (e) => {
      for (const f of e.target.files) addFile(f);
      e.target.value = "";
    });
    // Le bouton 📎 ouvre le sélecteur via .click() explicite. On
    // n'utilise plus un <label> enveloppant : dans certains contextes
    // proxifiés / webview (accès RunPod), un input fichier déclenché par
    // un label n'ouvre pas le dialogue. Un .click() JS marche partout.
    const btnAttach = $("#btn-attach");
    if (btnAttach) {
      btnAttach.addEventListener("click", () => dom.fileInput.click());
    }

    // Sidebar toggle (mobile)
    dom.toggle.addEventListener("click", () => dom.sidebar.classList.toggle("open"));

    // V5.6 — Pliage de la sidebar (zone sessions). Le header (logo,
    // new chat, delete all) et le footer (settings, theme, version,
    // collapse) restent toujours visibles. Seules les sessions et la
    // recherche disparaissent. Préférence persistée en localStorage.
    const btnCollapse = $("#btn-collapse");
    if (btnCollapse) {
      const COLLAPSE_KEY = "lythea_sidebar_collapsed";
      // Restaurer l'état au chargement
      try {
        if (localStorage.getItem(COLLAPSE_KEY) === "1") {
          dom.sidebar.classList.add("collapsed");
          btnCollapse.title = "Déplier les sessions";
          btnCollapse.setAttribute("data-tooltip", "Déplier");
        }
      } catch (e) { /* localStorage indispo : OK, on ignore */ }

      btnCollapse.addEventListener("click", () => {
        const nowCollapsed = dom.sidebar.classList.toggle("collapsed");
        try { localStorage.setItem(COLLAPSE_KEY, nowCollapsed ? "1" : "0"); }
        catch (e) { /* idem */ }
        btnCollapse.title = nowCollapsed ? "Déplier les sessions" : "Replier les sessions";
        btnCollapse.setAttribute("data-tooltip", nowCollapsed ? "Déplier" : "Replier");
      });
    }

    // V5.6.3 — Positionnement vertical des tooltips quand sidebar
    // est repliée. Les tooltips utilisent position:fixed (sinon ils
    // sont clippés par overflow:hidden de .sidebar), du coup il faut
    // calculer dynamiquement le top à chaque hover. On pose une CSS
    // var --tooltip-y sur l'élément survolé, que le CSS lit dans le
    // ::after. Délégation d'événement pour gérer tous les boutons
    // de la sidebar collapsed sans en oublier.
    dom.sidebar.addEventListener("mouseover", (e) => {
      if (!dom.sidebar.classList.contains("collapsed")) return;
      const target = e.target.closest("[data-tooltip]");
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      target.style.setProperty("--tooltip-y", `${centerY}px`);
    });

    // V5.6.7 — Bouton thème retiré : la palette V5.6 est conçue
    // pour dark only, pas de mode light optimisé. Le binding et la
    // fonction toggleTheme sont conservés (mode dev / future palette
    // light) mais le bouton n'est plus exposé dans l'UI.

    // Settings
    $("#btn-settings").addEventListener("click", openSettings);
    $("#modal-close").addEventListener("click", closeSettings);
    dom.modalOverlay.addEventListener("click", (e) => {
      if (e.target === dom.modalOverlay) closeSettings();
    });

    // Memory
    $("#btn-memory").addEventListener("click", openMemory);
    $("#memory-close").addEventListener("click", () => dom.memoryOverlay.classList.add("hidden"));

    // Deep sleep
    $("#btn-deep-sleep").addEventListener("click", async () => {
      if (confirm("Lancer le sommeil profond ?")) {
        const res = await api("/api/memory/deep-sleep", { method: "POST" });
        alert(res.message);
      }
    });

    // Unload model
    $("#btn-unload").addEventListener("click", unloadModel);

    // Reasoning toggle
    $("#btn-reasoning").addEventListener("click", toggleReasoning);

    // Debug toggle
    $("#btn-debug").addEventListener("click", toggleDebug);

    // Tabs
    $$(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        $$(".tab").forEach(t => t.classList.remove("active"));
        $$(".tab-content").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        $(`#${tab.dataset.tab}`).classList.add("active");
        if (tab.dataset.tab === "tab-memory") loadKGEntities();
      });
    });

    // Context menu
    dom.ctxMenu.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => ctxAction(btn.dataset.action));
    });
    document.addEventListener("click", hideCtxMenu);

    // Session search
    dom.searchInput.addEventListener("input", (e) => renderSessions(e.target.value));

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        dom.input.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        newChat();
      }
      if (e.key === "Escape") {
        closeSettings();
        dom.memoryOverlay.classList.add("hidden");
        hideCtxMenu();
      }
    });

    // Entropy slider
    dom.entropySlider.addEventListener("input", (e) => {
      dom.entropyVal.textContent = e.target.value;
    });
    $("#btn-save-entropy").addEventListener("click", async () => {
      await api("/api/config/entropy", {
        method: "POST",
        body: { threshold: parseFloat(dom.entropySlider.value) },
      });
    });

    // Web mode
    $("#btn-save-web").addEventListener("click", async () => {
      await api("/api/config/web-mode", {
        method: "POST",
        body: { mode: $("#web-mode").value },
      });
    });

    // V3.9.4: cascade toggle. Flips the state via the runtime override
    // endpoint (does NOT touch .env). On reboot, .env wins again.
    const cascadeToggle = $("#cascade-toggle");
    if (cascadeToggle) {
      cascadeToggle.addEventListener("change", async () => {
        try {
          const desired = cascadeToggle.checked;
          await api("/api/config/cascade/toggle", {
            method: "POST",
            body: { enabled: desired },
          });
          await refreshCascadeUI();
        } catch (e) {
          console.error("cascade toggle:", e);
          // Roll back the checkbox to the actual state
          await refreshCascadeUI();
        }
      });
    }

    // V3.9.5: paste/clear the Gemini key from the UI (RAM-only override).
    // Empty + Enregistrer clears the override and falls back to .env.
    const cascadeKeySave = $("#cascade-key-save");
    const cascadeKeyInput = $("#cascade-key-input");
    if (cascadeKeySave && cascadeKeyInput) {
      cascadeKeySave.addEventListener("click", async () => {
        const raw = (cascadeKeyInput.value || "").trim();
        cascadeKeySave.disabled = true;
        try {
          const res = await api("/api/config/cascade/key", {
            method: "POST",
            body: { api_key: raw },
          });
          cascadeKeyInput.value = "";  // ne jamais garder la clé en clair
          if (res) {
            await refreshCascadeUI();
          } else {
            const st = $("#cascade-status-text");
            if (st) st.textContent = "Échec : clé refusée (format AIzaSy attendu).";
          }
        } catch (e) {
          console.error("cascade key:", e);
          const st = $("#cascade-status-text");
          if (st) st.textContent = "Échec d'enregistrement de la clé.";
        } finally {
          cascadeKeySave.disabled = false;
        }
      });
      cascadeKeyInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); cascadeKeySave.click(); }
      });
    }

    // ── V4 cognitive modules: live status + runtime toggle ────────
    // Mirrors the cascade-toggle pattern. A single GET refresh
    // populates every switch and its diagnostic line; each switch
    // POSTs an explicit { module, enabled } body. A toggle failure
    // rolls back the UI by re-fetching the canonical state.
    async function refreshV4UI() {
      try {
        const status = await api("/api/config/v4");
        if (!status) return;

        const setSwitch = (mod, on) => {
          const el = document.querySelector(
            `.v4-toggle[data-module="${mod}"]`
          );
          if (el) el.checked = !!on;
        };
        const setDiag = (mod, text) => {
          const el = document.querySelector(
            `.v4-diag[data-module="${mod}"]`
          );
          if (el) el.textContent = text;
        };

        // cognitive_state
        setSwitch("cognitive_state", status.cognitive_state?.enabled);
        if (status.cognitive_state?.enabled) {
          const cs = status.cognitive_state;
          setDiag(
            "cognitive_state",
            `Contagion ≤ ${cs.contagion_max} · decay ${cs.decay_half_life_sec}s · détecteur=${cs.detector}`
          );
        } else {
          setDiag("cognitive_state", "Désactivé");
        }

        // inhibition
        setSwitch("inhibition", status.inhibition?.enabled);
        if (status.inhibition?.enabled) {
          const inh = status.inhibition;
          const stats = inh.stats || {};
          setDiag(
            "inhibition",
            `N1 strict=${inh.n1_strict} · N3=${inh.n3_enabled} · action=${inh.default_action} · ` +
            `bloqués=${stats.n_blocked || 0}/${stats.n_checked || 0}`
          );
        } else {
          setDiag("inhibition", "Désactivé");
        }

        // planning
        setSwitch("planning", status.planning?.enabled);
        if (status.planning?.enabled) {
          const p = status.planning;
          let line = `Max steps=${p.max_steps} · LLM=${p.use_llm}`;
          if (p.active_goal) {
            line += ` · But actif: « ${p.active_goal.description.slice(0, 50)} » (${p.active_goal.current_step}/${p.active_goal.n_steps})`;
          } else {
            line += " · Aucun but actif";
          }
          setDiag("planning", line);
        } else {
          setDiag("planning", "Désactivé");
        }

        // predictive_coding + sub-flag apply_gating
        setSwitch("predictive_coding", status.predictive_coding?.enabled);
        setSwitch(
          "predictive_coding_apply_gating",
          status.predictive_coding?.apply_gating
        );
        if (status.predictive_coding?.enabled) {
          const last = status.predictive_coding.last_decision;
          if (last) {
            setDiag(
              "predictive_coding",
              `Dernier mode: ${last.mode} · err=${(last.error || 0).toFixed(3)} · ${last.reason || ""}`
            );
          } else {
            setDiag("predictive_coding", "En attente du premier message");
          }
        } else {
          setDiag("predictive_coding", "Désactivé");
        }

        // timeline
        setSwitch("timeline", status.timeline?.enabled);
        if (status.timeline?.enabled) {
          const t = status.timeline;
          setDiag(
            "timeline",
            `Max events=${t.max_events} · vague rendu=${t.render_vague}`
          );
        } else {
          setDiag("timeline", "Désactivé");
        }

        // metacognition
        setSwitch("metacognition", status.metacognition?.enabled);
        if (status.metacognition?.enabled) {
          const m = status.metacognition;
          const last = m.last_decision;
          const snap = m.snapshot || {};
          let line =
            `Calibration ${(snap.calibration_score ?? 0.5).toFixed(2)} ` +
            `(${snap.n_calibration_entries || 0} mesures) · hedge=${m.apply_hedge}`;
          if (last) {
            line += ` · Dernière: ${last.confidence_label}`;
            if (last.recommend_web) line += " · ⚠ web recommandé";
          }
          setDiag("metacognition", line);
        } else {
          setDiag("metacognition", "Désactivé");
        }

        // affect_modulates_consolidation (boolean directly at root)
        setSwitch(
          "affect_modulates_consolidation",
          status.affect_modulates_consolidation
        );
      } catch (e) {
        console.warn("refreshV4UI failed:", e);
      }
    }

    async function setV4Module(module, enabled) {
      await api("/api/config/v4/toggle", {
        method: "POST",
        body: { module, enabled },
      });
      await refreshV4UI();
    }

    // Wire each switch.
    document.querySelectorAll(".v4-toggle").forEach((el) => {
      el.addEventListener("change", async () => {
        const mod = el.dataset.module;
        try {
          await setV4Module(mod, el.checked);
        } catch (e) {
          console.error("v4 toggle:", mod, e);
          await refreshV4UI();
        }
      });
    });

    const btnRefreshV4 = $("#btn-refresh-v4");
    if (btnRefreshV4) {
      btnRefreshV4.addEventListener("click", () => refreshV4UI());
    }

    // Initial population on page load.
    refreshV4UI();

    // ── Sampling sliders (live label update) ──────────────────────
    // Each slider just updates its label as the user drags. Nothing
    // is sent to the backend until "Appliquer" is clicked. This
    // matches the entropy slider UX and avoids spamming /api on drag.
    const samplingSliders = [
      ["sampling-temperature", 2],
      ["sampling-top-p", 2],
      ["sampling-top-k", 0],
      ["sampling-min-p", 2],
      ["sampling-rep-penalty", 2],
    ];
    for (const [id, decimals] of samplingSliders) {
      const slider = $("#" + id);
      const label = $("#" + id + "-val");
      if (slider && label) {
        slider.addEventListener("input", (e) => {
          label.textContent = Number(e.target.value).toFixed(decimals);
        });
      }
    }

    // Apply button — sends the full set of slider values. Sliders set
    // to the "off" sentinel (top_p=1.0, top_k=0, min_p=0) are sent as
    // null so the backend disables that sampling step. This mirrors
    // how SamplingProfile uses None to mean "skip this filter".
    $("#btn-save-sampling").addEventListener("click", async () => {
      const temperature = parseFloat($("#sampling-temperature").value);
      const topP = parseFloat($("#sampling-top-p").value);
      const topK = parseInt($("#sampling-top-k").value, 10);
      const minP = parseFloat($("#sampling-min-p").value);
      const rep = parseFloat($("#sampling-rep-penalty").value);
      const maxTokens = parseInt($("#sampling-max-tokens").value, 10);

      const body = {
        temperature: temperature,
        top_p: topP >= 0.999 ? null : topP,   // 1.0 → disabled
        top_k: topK <= 0 ? null : topK,        // 0   → disabled
        min_p: minP <= 0.001 ? null : minP,    // 0   → disabled
        repetition_penalty: rep,
        max_new_tokens: maxTokens,
      };
      try {
        const cfg = await api("/api/config/sampling", { method: "POST", body });
        // Refresh the UI with the sanitised echo, so display matches
        // backend state if any value was clamped.
        if (cfg) _applySamplingToUI({ ...cfg, model_id: cfg.model_id });
      } catch (e) {
        console.error("save sampling failed:", e);
      }
    });

    // Reset to recommended — re-applies the loaded model's profile
    // by asking the backend to reset, then re-fetching. Implemented
    // as a re-fetch from /api/config/sampling AFTER calling load_model
    // again would be too disruptive, so instead we just push the
    // recommended values back manually.
    $("#btn-reset-sampling").addEventListener("click", async () => {
      // Re-fetch — but the active profile may already differ from
      // the catalogue if the user overrode it. To get the recommended
      // values back, we need to ask the backend to re-apply them.
      // We do that by calling /api/models/current to find the model_id,
      // then triggering a re-application via a dedicated path. For
      // now, the simplest reset is: refetch and re-apply locally,
      // then POST. The backend's get_sampling returns the *current*
      // overridden profile, so we need a different strategy.
      //
      // Strategy: call load_model again on the same model_id — the
      // backend re-applies the profile. We avoid that disruption by
      // instead reading the catalogue from the model info endpoint.
      try {
        const m = await api("/api/models/current");
        if (!m || !m.loaded || !m.recommended_sampling) {
          console.warn("No recommended sampling available to reset to");
          return;
        }
        const rec = m.recommended_sampling;
        const cfg = await api("/api/config/sampling", {
          method: "POST",
          body: rec,
        });
        if (cfg) _applySamplingToUI({ ...cfg, model_id: m.model_id });
      } catch (e) {
        console.error("reset sampling failed:", e);
      }
    });

    // V5.6.12 — Wipe memory (avec confirmation 2-clics)
    // Premier clic : préviens du danger et exige une confirmation explicite.
    // Deuxième clic dans les 5 secondes : exécute le wipe.
    let wipeArmed = false;
    let wipeTimer = null;
    $("#btn-wipe-memory").addEventListener("click", async () => {
      const btn = $("#btn-wipe-memory");
      const result = $("#wipe-result");

      if (!wipeArmed) {
        // Premier clic : arme le bouton
        wipeArmed = true;
        btn.textContent = "⚠️ Confirmer (clique à nouveau)";
        btn.style.background = "var(--warning, #f59e0b)";
        result.textContent = "Efface KG + Chroma + SDM + MHN + sessions + procedural. Irréversible.";
        result.style.color = "var(--danger)";

        // Désarme après 5 secondes
        if (wipeTimer) clearTimeout(wipeTimer);
        wipeTimer = setTimeout(() => {
          wipeArmed = false;
          btn.textContent = "🧠 Effacer toute la mémoire";
          btn.style.background = "var(--danger)";
          result.textContent = "";
          result.style.color = "var(--text-muted)";
        }, 5000);
        return;
      }

      // Deuxième clic : exécute
      if (wipeTimer) clearTimeout(wipeTimer);
      wipeArmed = false;
      btn.textContent = "⏳ Effacement…";
      btn.disabled = true;
      result.textContent = "";

      try {
        const res = await api("/api/memory/wipe_all", { method: "POST" });
        result.textContent = `✅ ${res.message}`;
        result.style.color = "var(--text-muted)";
        btn.textContent = "🧠 Effacer toute la mémoire";
        btn.style.background = "var(--danger)";
        btn.disabled = false;
        // Refresh des compteurs de mémoire dans l'UI principale
        if (typeof refreshMemoryStats === "function") {
          refreshMemoryStats();
        }
      } catch (e) {
        result.textContent = `❌ ${e.message}`;
        result.style.color = "var(--danger)";
        btn.textContent = "🧠 Effacer toute la mémoire";
        btn.style.background = "var(--danger)";
        btn.disabled = false;
      }
    });

    // Clear cache
    $("#btn-clear-cache").addEventListener("click", async () => {
      if (!confirm("Décharger le modèle + captionneur et supprimer tous les fichiers téléchargés ?\nIls seront retéléchargés au prochain chargement.")) return;
      try {
        const res = await api("/api/config/clear-cache", { method: "POST" });
        $("#cache-result").textContent = `✅ ${res.message}`;
        await loadCurrentModel();
        await renderModelList();
        await renderCaptionerList();
      } catch (e) {
        $("#cache-result").textContent = `❌ ${e.message}`;
      }
    });

    // Reset auth token
    const btnResetToken = $("#btn-reset-token");
    if (btnResetToken) {
      btnResetToken.addEventListener("click", () => {
        setAuthToken("");
        $("#token-reset-result").textContent =
          "✅ Token effacé du stockage local.";
      });
    }
  }

  function autoResize() {
    dom.input.style.height = "auto";
    dom.input.style.height = Math.min(dom.input.scrollHeight, 150) + "px";
  }

  // ── V5.3 — Memory health modal ─────────────────────────────────────
  // Affiche un overlay simple avec les 5 dimensions + score global.
  // Pas de framework, juste du DOM injecté. Removable au clic dehors
  // ou bouton fermer.
  async function showMemoryHealth() {
    let snapshot;
    try {
      snapshot = await api("/api/memory/health");
    } catch (e) {
      console.warn("Memory health fetch failed:", e);
      snapshot = { error: String(e), health_score: 0, cognitive_hint: "Indisponible" };
    }

    const dims = [
      ["Fraîcheur", snapshot.freshness, "récence des souvenirs"],
      ["Couverture", snapshot.coverage, "entités avec relations"],
      ["Cohérence", snapshot.coherence, "densité des thèmes"],
      ["Efficience", snapshot.efficiency, "ratio actif/pending"],
      ["Connectivité", snapshot.reachability, "intégration du graphe"],
    ];

    const overlay = document.createElement("div");
    overlay.id = "memory-health-overlay";
    overlay.style.cssText = (
      "position:fixed;inset:0;background:rgba(0,0,0,0.6);" +
      "display:flex;align-items:center;justify-content:center;" +
      "z-index:9999;backdrop-filter:blur(4px)"
    );
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const score = snapshot.health_score || 0;
    const scoreColor = score >= 70 ? "#4ade80" : score >= 40 ? "#fbbf24" : "#f87171";

    const card = document.createElement("div");
    card.style.cssText = (
      "background:var(--bg-elev, #1a1a2e);color:var(--fg, #e8e8ee);" +
      "border-radius:16px;padding:24px 28px;max-width:420px;width:90%;" +
      "box-shadow:0 20px 60px rgba(0,0,0,0.5);" +
      "font-family:system-ui,sans-serif"
    );

    const bars = dims.map(([label, value, hint]) => {
      const v = Math.max(0, Math.min(100, value || 0));
      const barColor = v >= 70 ? "#4ade80" : v >= 40 ? "#fbbf24" : "#f87171";
      return (
        `<div style="margin:10px 0">` +
          `<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px">` +
            `<span><strong>${label}</strong> <span style="opacity:.6;font-size:12px">${hint}</span></span>` +
            `<span style="font-variant-numeric:tabular-nums">${v}</span>` +
          `</div>` +
          `<div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">` +
            `<div style="height:100%;width:${v}%;background:${barColor};transition:width .4s"></div>` +
          `</div>` +
        `</div>`
      );
    }).join("");

    const stats = (
      `<div style="opacity:.6;font-size:12px;margin-top:14px;padding-top:14px;` +
      `border-top:1px solid rgba(255,255,255,0.08);line-height:1.6">` +
        `Entités KG : <strong>${snapshot.n_entities ?? 0}</strong> • ` +
        `Relations : <strong>${snapshot.n_relations ?? 0}</strong> • ` +
        `Communautés : <strong>${snapshot.n_communities ?? 0}</strong><br>` +
        `Chroma : <strong>${snapshot.n_chroma ?? 0}</strong> souvenirs • ` +
        `Pending : <strong>${snapshot.n_pending ?? 0}</strong>` +
      `</div>`
    );

    card.innerHTML = (
      `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">` +
        `<div>` +
          `<div style="font-size:12px;opacity:.6;letter-spacing:.5px;text-transform:uppercase">Santé mémoire</div>` +
          `<div style="font-size:48px;font-weight:600;color:${scoreColor};line-height:1;margin-top:4px">${score}<span style="font-size:18px;opacity:.5;font-weight:400">/100</span></div>` +
        `</div>` +
        `<button id="health-close" style="background:transparent;border:none;color:inherit;` +
          `font-size:24px;cursor:pointer;opacity:.5;padding:0 4px">×</button>` +
      `</div>` +
      `<div style="font-size:14px;opacity:.85;margin-bottom:12px;font-style:italic">` +
        `${escHtml(snapshot.cognitive_hint || "")}` +
      `</div>` +
      bars +
      stats
    );

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.getElementById("health-close").addEventListener("click", () => overlay.remove());

    // Échap pour fermer
    const escHandler = (e) => {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);
  }

  // ── Utils ──────────────────────────────────────────────────────────
  function escHtml(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  // ── V6.0.0-rc rev9 — Workspace module ───────────────────────────────────
  //
  // Sidebar latérale droite qui montre l'arbre des fichiers du
  // sandbox partagé Lythéa ↔ utilisateur. Drag-and-drop pour
  // uploader, clic droit pour télécharger/renommer/supprimer.
  //
  // Sync : refresh manuel via bouton ↻ ou auto après chaque upload.
  // Refresh auto aussi prévu quand Lythéa émet workspace_file_offer
  // (le fichier qu'elle vient de créer apparaît dans le tree).
  //
  // Tous les paths côté serveur sont relatifs à la racine du sandbox.
  // L'UI manipule des objets { name, path, is_dir, size, mime, ...}.

  const WORKSPACE_ICONS = {
    // Mapping MIME / extension → emoji icône. Cohérent avec les
    // conventions visuelles : texte = 📄, image = 🖼️, code = 🐍, etc.
    folder: "📁",
    text: "📄",
    markdown: "📝",
    image: "🖼️",
    data: "📊",
    python: "🐍",
    js: "📜",
    json: "🔧",
    yaml: "⚙️",
    svg: "📐",
    audio: "🎵",
    video: "🎬",
    archive: "📦",
    pdf: "📕",
    excel: "📈",
    word: "📘",
    fallback: "📄",
  };

  /**
   * Détermine l'icône appropriée pour un fichier d'après son nom ou
   * son MIME type. Fallback sur 📄 pour les inconnus.
   */
  function workspaceIconFor(name, mime) {
    if (!name) return WORKSPACE_ICONS.fallback;
    const lower = name.toLowerCase();
    // Extension d'abord (plus précis que MIME)
    if (lower.endsWith(".py")) return WORKSPACE_ICONS.python;
    if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".jsx")) return WORKSPACE_ICONS.js;
    if (lower.endsWith(".json")) return WORKSPACE_ICONS.json;
    if (lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".toml")) return WORKSPACE_ICONS.yaml;
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) return WORKSPACE_ICONS.markdown;
    if (lower.endsWith(".svg")) return WORKSPACE_ICONS.svg;
    if (lower.endsWith(".pdf")) return WORKSPACE_ICONS.pdf;
    if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return WORKSPACE_ICONS.data;
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return WORKSPACE_ICONS.excel;
    if (lower.endsWith(".docx") || lower.endsWith(".doc")) return WORKSPACE_ICONS.word;
    if (lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".gz") || lower.endsWith(".7z")) return WORKSPACE_ICONS.archive;
    // MIME ensuite
    if (mime) {
      if (mime.startsWith("image/")) return WORKSPACE_ICONS.image;
      if (mime.startsWith("audio/")) return WORKSPACE_ICONS.audio;
      if (mime.startsWith("video/")) return WORKSPACE_ICONS.video;
      if (mime.startsWith("text/")) return WORKSPACE_ICONS.text;
    }
    return WORKSPACE_ICONS.fallback;
  }

  /**
   * Formatte une taille en bytes en human-readable (KB/MB/GB).
   */
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  // État local du module workspace
  const workspace = {
    tree: null,
    stats: null,
    selectedPath: null,
    contextMenuTarget: null,
  };

  /**
   * Fetch la liste des fichiers et rafraîchit l'UI.
   * V6.0.0-rc rev9 : si pas authentifié, on échoue silencieusement.
   * La popup de token sera levée par la première action utilisateur
   * (envoyer un message, uploader, etc.), pas par notre fetch en
   * background. Évite double-popup au démarrage.
   */
  async function workspaceRefresh(opts = {}) {
    const silent = opts.silent !== false;  // silencieux par défaut
    try {
      // Fetch direct (pas authFetch) pour pouvoir gérer 401 nous-mêmes
      const token = getAuthToken();
      const headers = token ? { "Authorization": "Bearer " + token } : {};
      const res = await fetch("/api/workspace/files", { headers });
      if (res.status === 401) {
        // Pas authentifié — on ne lève pas la popup ici, l'utilisateur
        // le fera quand il interagira vraiment.
        if (!silent) {
          console.warn("workspace: not authenticated, will retry later");
        }
        return;
      }
      if (!res.ok) {
        console.warn("workspace fetch failed:", res.status);
        return;
      }
      const data = await res.json();
      workspace.tree = data.tree;
      workspace.stats = data.stats;
      renderWorkspaceTree();
      renderWorkspaceQuota();
    } catch (e) {
      if (!silent) console.warn("workspace refresh error:", e);
    }
  }

  /**
   * Render l'arbre des fichiers dans la sidebar.
   */
  function renderWorkspaceTree() {
    const container = document.getElementById("workspace-tree");
    if (!container) return;
    container.innerHTML = "";
    if (!workspace.tree || !workspace.tree.children || workspace.tree.children.length === 0) {
      container.innerHTML = `
        <div class="workspace-empty">
          <div style="font-size: 32px; margin-bottom: 8px;">📁</div>
          <div>Workspace vide</div>
          <div style="font-size: 11px; margin-top: 4px; opacity: 0.7;">
            Glisse un fichier ici ou clique sur ＋
          </div>
        </div>
      `;
      return;
    }
    for (const child of workspace.tree.children) {
      container.appendChild(renderWorkspaceNode(child, 0));
    }
  }

  /**
   * Render un nœud du tree (fichier ou dossier). Récursif.
   */
  function renderWorkspaceNode(entry, depth) {
    const node = document.createElement("div");
    node.className = "workspace-node" + (entry.is_dir ? " workspace-node-dir" : "");
    node.dataset.path = entry.path;
    node.dataset.isDir = entry.is_dir ? "1" : "0";
    node.dataset.name = entry.name;
    node.dataset.size = entry.size;
    node.dataset.mime = entry.mime || "";

    // Toggle expand pour les dossiers
    if (entry.is_dir) {
      const toggle = document.createElement("span");
      toggle.className = "workspace-node-toggle";
      toggle.textContent = "▶";
      node.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.style.width = "10px";
      spacer.style.display = "inline-block";
      node.appendChild(spacer);
    }

    // Icône typée
    const icon = document.createElement("span");
    icon.className = "workspace-node-icon";
    icon.textContent = entry.is_dir ? WORKSPACE_ICONS.folder : workspaceIconFor(entry.name, entry.mime);
    node.appendChild(icon);

    // Nom
    const name = document.createElement("span");
    name.className = "workspace-node-name";
    name.textContent = entry.name;
    name.title = entry.name;
    node.appendChild(name);

    // Taille (pour les fichiers)
    if (!entry.is_dir && entry.size > 0) {
      const size = document.createElement("span");
      size.className = "workspace-node-size";
      size.textContent = formatBytes(entry.size);
      node.appendChild(size);
    }

    // Actions par ligne (apparaissent au survol) — fichiers ET dossiers.
    const acts = document.createElement("span");
    acts.className = "workspace-node-acts";
    const mkAct = (label, title, fn, danger) => {
      const b = document.createElement("button");
      b.className = "workspace-act" + (danger ? " danger" : "");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    if (!entry.is_dir) {
      acts.appendChild(mkAct("⬇", "Télécharger", () => workspaceDownload(entry.path)));
    }
    acts.appendChild(mkAct("✎", "Renommer", () => workspaceRename(entry.path, entry.name)));
    acts.appendChild(mkAct("🗑", "Supprimer", () => workspaceDelete(entry.path), true));
    node.appendChild(acts);

    // Children container (pour les dossiers)
    let childrenWrap = null;
    if (entry.is_dir && entry.children && entry.children.length > 0) {
      childrenWrap = document.createElement("div");
      childrenWrap.className = "workspace-node-children";
      childrenWrap.style.display = "none";
      for (const c of entry.children) {
        childrenWrap.appendChild(renderWorkspaceNode(c, depth + 1));
      }
    }

    // Click handler
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      // Toggle dossier
      if (entry.is_dir && childrenWrap) {
        const toggle = node.querySelector(".workspace-node-toggle");
        const isExpanded = childrenWrap.style.display !== "none";
        childrenWrap.style.display = isExpanded ? "none" : "block";
        if (toggle) toggle.classList.toggle("expanded", !isExpanded);
      } else if (!entry.is_dir) {
        // Double-clic pour télécharger ; simple clic juste sélection
        document.querySelectorAll(".workspace-node.selected").forEach(n => n.classList.remove("selected"));
        node.classList.add("selected");
        workspace.selectedPath = entry.path;
      }
    });
    node.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (!entry.is_dir) {
        workspaceDownload(entry.path);
      }
    });

    // Context menu (clic droit)
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showWorkspaceContextMenu(e.clientX, e.clientY, entry);
    });

    // Wrap node + children
    const wrap = document.createElement("div");
    wrap.appendChild(node);
    if (childrenWrap) wrap.appendChild(childrenWrap);
    return wrap;
  }

  /**
   * Affiche le menu contextuel à la position curseur, ciblant un fichier.
   */
  function showWorkspaceContextMenu(x, y, entry) {
    const menu = document.getElementById("workspace-context-menu");
    if (!menu) return;
    workspace.contextMenuTarget = entry;
    // Un dossier : ni « télécharger » ni « ingérer » (fichiers seulement),
    // mais renommer + supprimer restent valides.
    const fileOnly = entry.is_dir ? "none" : "";
    const dl = menu.querySelector('[data-action="download"]');
    const ing = menu.querySelector('[data-action="ingest"]');
    if (dl) dl.style.display = fileOnly;
    if (ing) ing.style.display = fileOnly;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove("hidden");
    // Auto-close au prochain clic ailleurs
    setTimeout(() => {
      const closer = (e) => {
        if (!menu.contains(e.target)) {
          menu.classList.add("hidden");
          document.removeEventListener("click", closer);
        }
      };
      document.addEventListener("click", closer);
    }, 10);
  }

  /**
   * Render la barre de quota et le texte associé.
   */
  function renderWorkspaceQuota() {
    if (!workspace.stats) return;
    const fill = document.getElementById("workspace-quota-fill");
    const text = document.getElementById("workspace-quota-text");
    if (!fill || !text) return;
    const used = workspace.stats.total_size_bytes;
    const max = workspace.stats.max_size_bytes;
    const pct = workspace.stats.used_pct;
    fill.style.width = `${Math.min(100, pct)}%`;
    fill.classList.toggle("warning", pct > 80);
    text.textContent = `${formatBytes(used)} / ${formatBytes(max)}  ·  ${workspace.stats.total_files} fichier(s)`;
  }

  /**
   * Helper : extrait un message d'erreur lisible d'une réponse API.
   * FastAPI peut renvoyer ``detail`` comme string OU comme liste d'objets
   * (validation errors). On gère les deux cas pour éviter "[object Object]".
   */
  function _extractApiError(err, fallback = "Erreur inconnue") {
    if (!err) return fallback;
    const detail = err.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      // Validation errors : liste de {loc, msg, type, ...}
      return detail
        .map(e => {
          if (typeof e === "string") return e;
          const loc = Array.isArray(e.loc) ? e.loc.join(".") : (e.loc || "");
          const msg = e.msg || e.message || "validation error";
          return loc ? `${loc}: ${msg}` : msg;
        })
        .join("; ");
    }
    if (typeof detail === "object" && detail !== null) {
      try { return JSON.stringify(detail); } catch { return fallback; }
    }
    if (err.message) return String(err.message);
    return fallback;
  }

  /**
   * Upload un ou plusieurs fichiers vers le workspace.
   */
  async function workspaceUpload(files, targetDir = "") {
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      if (targetDir) formData.append("target_dir", targetDir);
      try {
        const res = await authFetch("/api/workspace/upload", {
          method: "POST",
          body: formData,
          // ne pas définir Content-Type, le navigateur ajoute la boundary
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          // V6.0.0-rc rev9 fix : extraction propre des erreurs FastAPI
          // (qui peuvent être string OU liste d'objets pour les
          // validation errors). Sans ça, on affichait "[object Object]".
          const msg = _extractApiError(err, res.statusText);
          console.warn("Upload failed:", file.name, "→", err, "HTTP", res.status);
          alert(`Upload échoué pour "${file.name}" :\n\n${msg}\n\n(HTTP ${res.status})`);
        }
      } catch (e) {
        console.warn("Upload error:", e);
        alert(`Erreur d'upload pour "${file.name}" : ${e.message}`);
      }
    }
    await workspaceRefresh();
  }

  /**
   * Télécharge un fichier (déclenche le download navigateur).
   *
   * V6.0.0-rc rev9 : on ne peut pas utiliser <a href="..." download>
   * directement parce que ça fait une requête SANS le header
   * Authorization. Le serveur renvoie 401 et le navigateur affiche
   * "Fichier non disponible". Solution : fetch authentifié, récupérer
   * le blob, créer un Object URL et déclencher le download dessus.
   */
  async function workspaceDownload(path) {
    const url = `/api/workspace/download?path=${encodeURIComponent(path)}`;
    try {
      const res = await authFetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = _extractApiError(err, res.statusText);
        alert(`Téléchargement échoué :\n\n${msg}`);
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      // Extraire le nom de fichier du Content-Disposition si possible,
      // sinon utiliser le basename du path.
      let filename = path.split("/").pop() || "download";
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename\*?=(?:UTF-8'')?["]?([^";\s]+)["]?/i);
      if (m && m[1]) {
        try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; }
      }
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Libérer l'URL Object après un délai (laisse le temps au DL)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (e) {
      alert(`Erreur de téléchargement : ${e.message}`);
    }
  }

  /**
   * Supprime un fichier après confirmation.
   */
  async function workspaceDelete(path) {
    if (!confirm(`Supprimer "${path}" du workspace ?\n\nCette action est irréversible.`)) return;
    try {
      const res = await authFetch("/api/workspace/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = _extractApiError(err, res.statusText);
        alert(`Suppression échouée :\n\n${msg}`);
        return;
      }
      await workspaceRefresh();
    } catch (e) {
      alert(`Erreur : ${e.message}`);
    }
  }

  /**
   * Renomme un fichier (prompt utilisateur).
   */
  async function workspaceRename(path, oldName) {
    const newName = prompt(`Nouveau nom pour "${oldName}" :`, oldName);
    if (!newName || newName === oldName) return;
    try {
      const res = await authFetch("/api/workspace/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, new_name: newName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = _extractApiError(err, res.statusText);
        alert(`Renommage échoué :\n\n${msg}`);
        return;
      }
      await workspaceRefresh();
    } catch (e) {
      alert(`Erreur : ${e.message}`);
    }
  }

  /**
   * V6.0.0-rc rev9 — Ingère un fichier du workspace dans la mémoire
   * long-terme de Lythéa (RAG ChromaDB + KG).
   *
   * Le fichier reste présent dans le workspace. La différence c'est
   * que son contenu devient "connaissance permanente" : Lythéa peut
   * répondre à des questions dessus sans qu'on lui mentionne
   * explicitement le fichier.
   */
  async function workspaceIngest(path, name) {
    const confirmed = confirm(
      `Ingérer "${name}" dans la mémoire long-terme de Lythéa ?\n\n` +
      `Le fichier sera vectorisé dans ChromaDB et ses entités ` +
      `extraites pour le knowledge graph. Cela peut prendre quelques ` +
      `secondes selon la taille.\n\n` +
      `Le fichier reste dans le workspace.`
    );
    if (!confirmed) return;
    try {
      const res = await authFetch("/api/workspace/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = _extractApiError(err, res.statusText);
        alert(`Ingestion échouée :\n\n${msg}`);
        return;
      }
      const data = await res.json();
      alert(
        `✓ Ingestion réussie\n\n` +
        `${data.n_chars || 0} caractères extraits\n` +
        `${data.n_chunks || 0} chunks dans ChromaDB\n` +
        `${data.n_entities || 0} entités extraites pour le KG`
      );
      // Refresh pour mettre à jour le badge 🧠
      await workspaceRefresh();
    } catch (e) {
      alert(`Erreur : ${e.message}`);
    }
  }

  /**
   * Toggle replier/déplier la sidebar workspace.
   */
  function workspaceToggle() {
    const sidebar = document.getElementById("workspace-sidebar");
    const toggle = document.getElementById("workspace-toggle");
    if (!sidebar) return;
    const collapsed = sidebar.classList.toggle("collapsed");
    if (toggle) toggle.classList.toggle("hidden", !collapsed);
  }

  /**
   * Render une card de téléchargement dans le chat. Appelée quand
   * Lythéa émet un event ``workspace_file_offer`` après avoir créé
   * un fichier qu'elle veut proposer à l'utilisateur.
   */
  function renderWorkspaceOffer(aiTextEl, fileEntry) {
    if (!aiTextEl || !fileEntry) return;
    const wrap = aiTextEl.closest(".msg") || aiTextEl.parentElement;
    if (!wrap) return;

    // Container (peut accumuler plusieurs cards si Lythéa propose
    // plusieurs fichiers en une réponse).
    let container = wrap.querySelector(".msg-workspace-offers");
    if (!container) {
      container = document.createElement("div");
      container.className = "msg-workspace-offers";
      wrap.appendChild(container);
    }

    const card = document.createElement("div");
    card.className = "workspace-offer-card";

    const icon = document.createElement("div");
    icon.className = "workspace-offer-icon";
    icon.textContent = workspaceIconFor(fileEntry.name, fileEntry.mime);
    card.appendChild(icon);

    const info = document.createElement("div");
    info.className = "workspace-offer-info";
    const name = document.createElement("div");
    name.className = "workspace-offer-name";
    name.textContent = fileEntry.name;
    name.title = fileEntry.name;
    info.appendChild(name);
    const meta = document.createElement("div");
    meta.className = "workspace-offer-meta";
    // Construit la meta : taille + type humain
    const sizeLabel = formatBytes(fileEntry.size);
    let typeLabel = "";
    if (fileEntry.mime) {
      const lower = fileEntry.name.toLowerCase();
      if (lower.endsWith(".md")) typeLabel = "Markdown";
      else if (lower.endsWith(".csv")) typeLabel = "CSV";
      else if (lower.endsWith(".json")) typeLabel = "JSON";
      else if (lower.endsWith(".py")) typeLabel = "Python";
      else if (lower.endsWith(".pdf")) typeLabel = "PDF";
      else if (fileEntry.mime.startsWith("image/")) typeLabel = `Image ${fileEntry.mime.split("/")[1].toUpperCase()}`;
      else if (fileEntry.mime.startsWith("text/")) typeLabel = "Texte";
      else typeLabel = fileEntry.mime;
    }
    meta.textContent = typeLabel ? `${sizeLabel} · ${typeLabel}` : sizeLabel;
    info.appendChild(meta);
    card.appendChild(info);

    const dlBtn = document.createElement("button");
    dlBtn.className = "workspace-offer-download";
    dlBtn.innerHTML = "📥 Télécharger";
    dlBtn.addEventListener("click", () => workspaceDownload(fileEntry.path));
    card.appendChild(dlBtn);

    container.appendChild(card);
  }

  /**
   * Initialise les listeners du module workspace.
   * Appelé une fois au boot.
   */
  function workspaceInit() {
    const sidebar = document.getElementById("workspace-sidebar");
    if (!sidebar) return;

    // Bouton upload (＋)
    const btnUpload = document.getElementById("btn-workspace-upload");
    const fileInput = document.getElementById("workspace-file-input");
    if (btnUpload && fileInput) {
      btnUpload.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length > 0) {
          workspaceUpload(Array.from(e.target.files));
          e.target.value = "";  // reset pour permettre de re-uploader le même fichier
        }
      });
    }

    // Bouton refresh (↻)
    const btnRefresh = document.getElementById("btn-workspace-refresh");
    if (btnRefresh) btnRefresh.addEventListener("click", workspaceRefresh);

    // Bouton toggle ReAct (⚡) — activé par défaut
    const btnReact = document.getElementById("btn-react-toggle");
    if (btnReact) btnReact.addEventListener("click", () => {
      S.reactMode = !S.reactMode;
      btnReact.classList.toggle("on", S.reactMode);
      btnReact.title = S.reactMode
        ? "Mode ReAct (agent autonome) — activé"
        : "Mode ReAct désactivé (pipeline linéaire)";
    });

    // Bouton collapse (»)
    const btnCollapse = document.getElementById("btn-workspace-collapse");
    if (btnCollapse) btnCollapse.addEventListener("click", workspaceToggle);

    // Toggle quand replié
    const btnToggle = document.getElementById("workspace-toggle");
    if (btnToggle) btnToggle.addEventListener("click", workspaceToggle);

    // Drag-and-drop sur toute la sidebar
    const overlay = document.getElementById("workspace-drop-overlay");
    let dragCounter = 0;  // Compte les enter/leave (les enfants comptent)
    sidebar.addEventListener("dragenter", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        e.stopPropagation();  // V6.0.0-rc fix : empêche le drop area
                              // général (.input-row) de s'allumer aussi
        dragCounter++;
        if (overlay) overlay.classList.add("active");
      }
    });
    sidebar.addEventListener("dragover", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }
    });
    sidebar.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        if (overlay) overlay.classList.remove("active");
      }
    });
    sidebar.addEventListener("drop", (e) => {
      e.preventDefault();
      // V6.0.0-rc fix : empêcher le drop de bubbler vers le handler
      // global document qui appellerait addFile() → addDocument() et
      // joindrait le fichier au chat. Le workspace est silencieux par
      // design (Option A) : déposer un fichier dans la sidebar ne
      // doit RIEN faire dans le chat.
      e.stopPropagation();
      dragCounter = 0;
      if (overlay) overlay.classList.remove("active");
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        workspaceUpload(Array.from(files));
      }
    });

    // Context menu actions
    const menu = document.getElementById("workspace-context-menu");
    if (menu) {
      menu.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const target = workspace.contextMenuTarget;
        menu.classList.add("hidden");
        if (!target) return;
        switch (action) {
          case "download":
            workspaceDownload(target.path);
            break;
          case "ingest":
            workspaceIngest(target.path, target.name);
            break;
          case "rename":
            workspaceRename(target.path, target.name);
            break;
          case "delete":
            workspaceDelete(target.path);
            break;
        }
      });
    }

    // Fetch initial — V6.0.0-rc rev9 : seulement si un token est
    // déjà en cache local. Sinon, on attendrait que la session
    // principale obtienne un token via son propre prompt, et on
    // déclencherait le refresh à ce moment-là (cf hookAfterAuth).
    // Sans ça, l'utilisateur se voit demander le token DEUX fois :
    // une fois pour workspace, une fois pour le chat.
    if (getAuthToken()) {
      workspaceRefresh();
    }
    // Hook : dès qu'un token est positionné par n'importe quelle
    // partie de l'app, on rafraîchit aussi le workspace.
    window.addEventListener("lythea-auth-ready", () => {
      workspaceRefresh();
    });
  }

  // ── End workspace module ───────────────────────────────────────────



  // ── Boot ───────────────────────────────────────────────────────────
  init();
  // V6.0.0-rc rev9 — Démarre le module workspace après init principal
  workspaceInit();
})();
