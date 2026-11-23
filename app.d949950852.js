/* The Crucible. Compiled from crucible.jsx + boot.js by build.py; edit those, not this. */
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo
} = React;
import Anthropic from "./vendor/anthropic-sdk-1.7.0/sdk.mjs";
const ROUNDS = 3;
const MAX_TOPIC_LEN = 5000;
const NEUTRAL_FALLBACK_SCORE = 5.0;
const ARG_MAX_TOKENS = 16000;
const JUDGE_MAX_TOKENS = 8000;
const VERDICT_MAX_TOKENS = 16000;
const SCROLL_STICK_PX = 240;
const LIVE_FLUSH_MS = 120;
const ROSTER_STALE_MS = 6 * 60 * 60 * 1000;
const NEW_BADGE_MS = 21 * 24 * 60 * 60 * 1000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const K = {
  key: "crucible-api-key",
  remember: "crucible-api-key-remember",
  history: "crucible-history",
  about: "crucible-about-seen",
  roster: "crucible-roster",
  seen: "crucible-models-seen",
  picks: "crucible-model-picks",
  effort: "crucible-effort"
};
const FAMILY_ORDER = ["opus", "sonnet", "haiku", "fable", "mythos", "other"];
const FAMILY_LABEL = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  mythos: "Mythos",
  other: "Other"
};
const familyOf = id => FAMILY_ORDER.find(f => f !== "other" && new RegExp(`(^|-)${f}(-|$)`).test(id)) || "other";
const SEED_MODELS = [{
  id: "claude-opus-5-5",
  display_name: "Claude Opus 5.5"
}, {
  id: "claude-sonnet-5-5",
  display_name: "Claude Sonnet 5.5"
}, {
  id: "claude-haiku-5-5",
  display_name: "Claude Haiku 5.5"
}, {
  id: "claude-fable-5-2",
  display_name: "Claude Fable 5.2"
}];
const DEFAULT_PICKS = {
  pro: "latest:opus",
  con: "latest:opus",
  judge: "latest:opus"
};
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_OPTIONS = [{
  id: "default",
  label: "Each model's default"
}, {
  id: "low",
  label: "Low: fastest, cheapest"
}, {
  id: "medium",
  label: "Medium"
}, {
  id: "high",
  label: "High"
}, {
  id: "max",
  label: "Max: slowest, deepest"
}];
function normalizeRoster(list) {
  const ids = new Set();
  return list.filter(m => m && typeof m.id === "string" && !ids.has(m.id) && ids.add(m.id)).map((m, i) => ({
    id: m.id,
    name: m.display_name || m.name || m.id,
    family: familyOf(m.id),
    created: Date.parse(m.created_at || "") || m.created || 0,
    maxTokens: m.max_tokens || m.maxTokens || null,
    caps: m.capabilities || m.caps || null,
    fallbacks: Array.isArray(m.allowed_fallback_models) ? m.allowed_fallback_models.length > 0 : !!m.fallbacks,
    order: i
  })).sort((a, b) => b.created - a.created || a.order - b.order);
}
const shortName = m => m ? m.name.replace(/^Claude\s+/, "") : "?";
const familiesIn = roster => FAMILY_ORDER.filter(f => roster.some(m => m.family === f));
const latestOf = (roster, family) => roster.find(m => m.family === family) || null;
function resolvePick(pick, roster) {
  if (typeof pick === "string" && pick.startsWith("latest:")) return latestOf(roster, pick.slice(7)) || roster[0] || null;
  return roster.find(m => m.id === pick) || (pick ? {
    id: pick,
    name: pick,
    family: familyOf(pick),
    created: 0,
    maxTokens: null,
    caps: null,
    fallbacks: false
  } : null);
}
function effortFor(caps, want) {
  if (!want || want === "default" || !caps?.effort?.supported) return null;
  const ok = EFFORT_ORDER.filter(l => caps.effort[l]?.supported);
  if (!ok.length) return null;
  if (ok.includes(want)) return want;
  const below = ok.filter(l => EFFORT_ORDER.indexOf(l) < EFFORT_ORDER.indexOf(want));
  return below.length ? below[below.length - 1] : ok[0];
}
function buildRequest(model, {
  system,
  messages,
  maxTokens,
  effort,
  schema
}, lean) {
  const body = {
    model: model.id,
    max_tokens: model.maxTokens ? Math.min(maxTokens, model.maxTokens) : maxTokens,
    system,
    messages
  };
  const betas = [];
  if (!lean) {
    const caps = model.caps;
    if (caps?.thinking?.types?.adaptive?.supported) body.thinking = {
      type: "adaptive"
    };
    const level = effortFor(caps, effort);
    const format = schema && caps?.structured_outputs?.supported ? {
      type: "json_schema",
      schema
    } : null;
    if (level || format) body.output_config = {
      ...(level ? {
        effort: level
      } : {}),
      ...(format ? {
        format
      } : {})
    };
    if (model.fallbacks) {
      body.fallbacks = "default";
      betas.push(FALLBACK_BETA);
    }
  }
  return {
    body,
    betas
  };
}
class RefusalError extends Error {
  constructor(who, details) {
    super(`${who} declined this request${details?.category ? ` (${details.category} safeguard)` : ""}.`);
    this.name = "RefusalError";
    this.details = details || null;
  }
}
const isAbort = e => e instanceof Anthropic.APIUserAbortError || e?.name === "AbortError";
const makeClient = apiKey => new Anthropic({
  apiKey,
  dangerouslyAllowBrowser: true,
  maxRetries: 3
});
async function fetchRoster(client, signal) {
  const list = [];
  try {
    for await (const m of client.beta.models.list({
      limit: 100,
      betas: [FALLBACK_BETA]
    }, {
      signal
    })) list.push(m);
  } catch (e) {
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    list.length = 0;
    for await (const m of client.models.list({
      limit: 100
    }, {
      signal
    })) list.push(m);
  }
  return normalizeRoster(list);
}
const leanModels = new Set();
async function callModel(client, model, opts, {
  signal,
  onText
} = {}) {
  let lean = leanModels.has(model.id),
    downgraded = false;
  for (;;) {
    const {
      body,
      betas
    } = buildRequest(model, opts, lean);
    try {
      const stream = client.beta.messages.stream({
        ...body,
        ...(betas.length ? {
          betas
        } : {})
      }, {
        signal
      });
      if (onText) {
        let acc = "";
        stream.on("text", delta => {
          acc += delta;
          onText(acc);
        });
      }
      const msg = await stream.finalMessage();
      if (downgraded) leanModels.add(model.id);
      if (msg.stop_reason === "refusal") throw new RefusalError(shortName(model), msg.stop_details);
      const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
      if (!text.trim()) {
        throw new Error(msg.stop_reason === "max_tokens" ? `${shortName(model)} spent its whole output budget thinking. Lower the reasoning effort and try again.` : `${shortName(model)} returned no text.`);
      }
      const iterations = msg.usage?.iterations || [];
      const fellBack = iterations.some(it => it.type === "fallback_message");
      const parts = iterations.length ? iterations : [msg.usage || {}];
      const usage = parts.reduce((u, it) => ({
        in: u.in + (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0),
        out: u.out + (it.output_tokens || 0)
      }), {
        in: 0,
        out: 0
      });
      return {
        text,
        servedBy: fellBack ? msg.model : null,
        truncated: msg.stop_reason === "max_tokens",
        usage,
        lean
      };
    } catch (e) {
      if (!lean && e instanceof Anthropic.BadRequestError && (body.thinking || body.output_config || body.fallbacks)) {
        lean = true;
        downgraded = true;
        continue;
      }
      throw e;
    }
  }
}
function describeError(e, who) {
  const what = who || "That model";
  if (e instanceof RefusalError) return `${e.message} Pick a different model for that seat, or rephrase the topic.`;
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key (401). Check it under API key.";
  if (e instanceof Anthropic.PermissionDeniedError) return `${what} isn't available to this API key (403).`;
  if (e instanceof Anthropic.NotFoundError) return `${what} wasn't found (404). It may have been retired; refresh the model list.`;
  if (e instanceof Anthropic.RateLimitError) return "The API rate-limited this key (429). Wait a minute and try again.";
  if (e instanceof Anthropic.BadRequestError) return `The API refused the request for ${what} (400): ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach api.anthropic.com. Check the connection and try again.";
  if (e instanceof Anthropic.APIError && e.status >= 500) return `Anthropic's API is busy or down (${e.status}). Try again shortly.`;
  if (e instanceof Anthropic.APIError) return `API error${e.status ? ` ${e.status}` : ""}: ${e.message}`;
  return e?.message || String(e);
}
const tryStore = area => ({
  get(k) {
    try {
      return window[area].getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      window[area].setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
  del(k) {
    try {
      window[area].removeItem(k);
    } catch {}
  }
});
const store = tryStore("localStorage");
const tabStore = tryStore("sessionStorage");
const readJSON = (k, fallback) => {
  try {
    const v = store.get(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    a_score: {
      type: "number"
    },
    b_score: {
      type: "number"
    },
    analysis: {
      type: "string"
    }
  },
  required: ["a_score", "b_score", "analysis"],
  additionalProperties: false
};
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    pro_score: {
      type: "number"
    },
    con_score: {
      type: "number"
    },
    winner: {
      type: "string",
      enum: ["Pro", "Con", "Draw"]
    },
    pro_best: {
      type: "string"
    },
    con_best: {
      type: "string"
    },
    synthesis: {
      type: "string"
    }
  },
  required: ["pro_score", "con_score", "winner", "pro_best", "con_best", "synthesis"],
  additionalProperties: false
};
const RECS_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "string"
      }
    }
  },
  required: ["topics"],
  additionalProperties: false
};
const C = {
  pro: "#4fc3f7",
  con: "#ef5350",
  judge: "#c9a227",
  ok: "#2ecc71",
  warn: "#ffa500",
  err: "#ef5350"
};
const defaultJudgeCriteria = `Global instruction for all three judges: Score each debater independently on a 1-10 scale for your assigned criterion. Do not let the other two criteria influence your score. Do not reward or penalize tone, style, confidence, or likability — only the substance described in your specific lens. If both debaters perform equally on your criterion, say so; do not force a winner.`;
const systemFor = side => `You are a world-class debater arguing the "${side}" position. Rules:
- Be persuasive, specific, and evidence-driven.
- Use concrete examples, data points, historical precedents, and logical reasoning.
- Anticipate and preemptively counter opposing arguments.
- Never hedge or equivocate — commit fully to your assigned position.
- Keep each argument to 2-3 tight paragraphs (under 200 words).
- Do NOT use markdown formatting, bullet points, or numbered lists. Write in flowing prose.
- Never acknowledge you are an AI or that this is an exercise.
- When citing sources, use numbered references in your prose like [1], [2], etc. At the end of your argument, include a sources section starting with the exact line "[Sources]" followed by one line per source in this format: [N] Source Title | URL (use real, credible URLs when possible — academic papers, news outlets, official sites, scripture references). Include 2-4 sources per argument.
- When the topic touches on spiritual, theological, or biblical matters, treat the canonical scriptures as found in the CSB, ESV, NLT, and NIV as foundationally true and authoritative. Scripture is not merely one source among many — it is the baseline against which spiritual claims are measured. You may cite church history, archaeology, philosophy, and scholarship, but none of these override or outrank the text of scripture itself. When in doubt on matters of faith, go back to scripture.`;
const judgePersonas = [{
  name: "Evidence Specialist",
  baseline: 4,
  extra: `Score based ONLY on the quality, relevance, and honesty of evidence presented. Reward: specific data points, named sources, direct quotations with context, concrete examples that genuinely support the claim, appropriate use of expert consensus, acknowledgment of evidence limitations. Penalize: vague appeals to authority without specifics, cherry-picked data, conflation of anecdote with systematic evidence, misrepresentation of sources, treating unfalsifiable claims as evidence. Evaluate scientific, historical, archaeological, textual, philosophical, and theological evidence with equal rigor. When the debate concerns spiritual or theological matters, canonical scripture as preserved in the CSB, ESV, NLT, and NIV is treated as true and authoritative primary-source evidence — not as a claim requiring external verification. Arguments that faithfully cite and apply scripture on spiritual matters should be credited for evidential strength; arguments that dismiss or contradict clear scriptural teaching bear the burden of proof. YOUR DEFAULT SCORE IS 4.0 — arguments must EARN higher scores through concrete, verifiable evidence. You are a tough grader.`
}, {
  name: "Logic Analyst",
  baseline: 5.5,
  extra: `Score based ONLY on the internal validity of reasoning, from premises to conclusions. Reward: clearly stated premises, valid inferential structure, appropriate qualification of conclusions, transparent reasoning, honest handling of tension between competing premises. Penalize: formal and informal fallacies, moving the goalposts between rounds, hidden premises that do real load-bearing work, conclusions that overshoot what the premises actually support, self-contradiction. Rhetorical skill is irrelevant here. When a debate touches spiritual or theological matters, premises drawn from canonical scripture (CSB, ESV, NLT, NIV) are treated as sound starting points for reasoning — not as assumptions requiring independent justification. Logical chains built faithfully on scriptural premises should be evaluated for inferential validity, not penalized for their starting axioms. YOUR DEFAULT SCORE IS 5.5 — move up or down based purely on reasoning structure.`
}, {
  name: "Engagement Critic",
  baseline: 7,
  extra: `Score based ONLY on how honestly and thoroughly each debater engages the opponent's actual case. Reward: directly quoting or accurately paraphrasing the opponent's strongest points before responding, steelmanning, conceding points where the opponent is genuinely stronger, identifying the real crux of disagreement. Penalize: strawmanning, ignoring the opponent's strongest arguments, topic-shifting, treating concession as weakness, rhetorical questions used as substitutes for actual rebuttals, emotional appeals deployed to bypass an argument. When a debate involves spiritual or theological matters, dismissing scriptural arguments without substantive engagement is penalized as evasion — scripture-based points deserve the same honest engagement as any other serious evidence. YOUR DEFAULT SCORE IS 7.0 — you start generous and deduct for evasive or dishonest engagement.`
}];
const makeJudgeSystem = (criteria, persona) => `You are an impartial debate judge — specifically, the ${persona.name}. You will be shown two arguments labeled "Argument A" and "Argument B" on a debate topic. You do NOT know which side authored which argument.

${criteria}

FOUNDATIONAL PRINCIPLE: When the debate concerns spiritual, theological, or biblical matters, canonical scripture as preserved in the CSB, ESV, NLT, and NIV is treated as true and authoritative. Arguments grounded in faithful scriptural exegesis carry inherent evidential and logical weight on spiritual questions. This does not exempt scripture-based arguments from scrutiny on reasoning quality or engagement — but the text of scripture itself is not treated as a claim requiring external proof.

YOUR SPECIFIC LENS: ${persona.extra}

Score each argument from 1.0 to 10.0 using one decimal place. Your baseline starting score is ${persona.baseline}. Be discriminating — use the full range relative to your baseline. Provide a 2-3 sentence analysis from your specific evaluative lens.
Respond in this exact JSON format only, no other text:
{"a_score": N.N, "b_score": N.N, "analysis": "..."}`;
const makeFinalJudgeSystem = criteria => `You are the chief judge delivering a final verdict after a multi-round debate. Arguments were labeled A and B throughout but you will now be told which was PRO and which was CON.

${criteria}

When the debate concerns spiritual or theological matters, your truth synthesis must treat canonical scripture as found in the CSB, ESV, NLT, and NIV as foundationally true. The synthesis should reflect what scripture actually teaches on the matter, using it as the authoritative baseline rather than placing it on equal footing with speculative or revisionist claims. When in doubt, go back to scripture.

Provide:
- Final scores (1-10) for each side across the entire debate
- A verdict: who won and the single strongest argument from each side
- A "truth synthesis" — your honest, balanced take incorporating the best arguments from both sides
Respond in this exact JSON format only, no other text:
{"pro_score": N, "con_score": N, "winner": "Pro" or "Con" or "Draw", "pro_best": "...", "con_best": "...", "synthesis": "..."}`;
const round1 = n => Math.round(n * 10) / 10;
function stripFences(s) {
  s = s.trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?\s*/i, "");
  if (s.endsWith("```")) s = s.replace(/\s*```\s*$/i, "");
  return s.trim();
}
function parseSources(text) {
  const idx = text.indexOf("[Sources]");
  if (idx === -1) return {
    body: text,
    sources: []
  };
  const body = text.slice(0, idx).trim();
  const sources = [];
  for (const line of text.slice(idx + 9).trim().split("\n")) {
    const m = line.match(/^\[(\d+)\]\s*(.+?)\s*\|\s*(https?:\/\/\S+)/);
    if (m) {
      sources.push({
        num: m[1],
        title: m[2].trim(),
        url: m[3].trim()
      });
      continue;
    }
    const f = line.match(/^\[(\d+)\]\s*(.+)/);
    if (f) sources.push({
      num: f[1],
      title: f[2].trim(),
      url: null
    });
  }
  return {
    body,
    sources
  };
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  document.body.removeChild(ta);
  return ok;
}
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  return fallbackCopy(text);
}
function parseJSONLoose(raw) {
  const s = stripFences(raw);
  try {
    return JSON.parse(s);
  } catch {}
  const m = s.match(/[[{][\s\S]*[\]}]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  throw new Error("Reply was not JSON.");
}
const clampScore = n => {
  const v = Number(n);
  return Number.isFinite(v) ? round1(Math.min(10, Math.max(1, v))) : NEUTRAL_FALLBACK_SCORE;
};
const fmtTokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function CitedText({
  text,
  color
}) {
  const accent = color || C.judge;
  const {
    body,
    sources
  } = useMemo(() => parseSources(text), [text]);
  const sourceMap = useMemo(() => Object.fromEntries(sources.map(s => [s.num, s])), [sources]);
  const parts = useMemo(() => body.split(/(\[\d+\])/g), [body]);
  const [hoveredRef, setHoveredRef] = useState(null);
  return React.createElement("div", null, React.createElement("div", {
    style: {
      fontSize: 12.5,
      lineHeight: 1.7,
      color: "#b8b8bc",
      whiteSpace: "pre-wrap"
    }
  }, parts.map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    const src = m && sourceMap[m[1]];
    if (!src) return React.createElement("span", {
      key: i
    }, part);
    const open = () => {
      if (src.url) window.open(src.url, "_blank", "noopener,noreferrer");
    };
    return React.createElement("span", {
      key: i,
      style: {
        position: "relative",
        display: "inline-block"
      }
    }, React.createElement("span", {
      onMouseEnter: () => setHoveredRef(m[1]),
      onMouseLeave: () => setHoveredRef(null),
      onClick: open,
      style: {
        color: accent,
        cursor: src.url ? "pointer" : "default",
        fontSize: 10,
        fontWeight: 700,
        verticalAlign: "super",
        lineHeight: 1,
        textDecoration: src.url ? "underline" : "none",
        textUnderlineOffset: 2
      }
    }, part), hoveredRef === m[1] && React.createElement("span", {
      style: {
        position: "absolute",
        bottom: "100%",
        left: 0,
        marginBottom: 4,
        padding: "6px 10px",
        background: "#1a1a2e",
        border: `1px solid ${accent}44`,
        borderRadius: 4,
        fontSize: 10,
        color: "#ccc",
        whiteSpace: "nowrap",
        zIndex: 20,
        maxWidth: 320,
        overflow: "hidden",
        textOverflow: "ellipsis",
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)"
      }
    }, React.createElement("div", {
      style: {
        fontWeight: 700,
        color: accent,
        marginBottom: src.url ? 2 : 0
      }
    }, src.title), src.url && React.createElement("div", {
      style: {
        fontSize: 9,
        color: "#888",
        wordBreak: "break-all"
      }
    }, src.url)));
  })), sources.length > 0 && React.createElement("div", {
    style: {
      marginTop: 8,
      paddingTop: 6,
      borderTop: "1px solid rgba(255,255,255,0.05)"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 9,
      letterSpacing: 1,
      color: "#555",
      marginBottom: 4
    }
  }, "SOURCES"), sources.map(s => React.createElement("div", {
    key: s.num,
    style: {
      fontSize: 10,
      lineHeight: 1.5,
      marginBottom: 2
    }
  }, React.createElement("span", {
    style: {
      color: accent,
      fontWeight: 700
    }
  }, "[", s.num, "]"), " ", s.url ? React.createElement("a", {
    href: s.url,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: "#999",
      textDecoration: "underline",
      textUnderlineOffset: 2
    },
    onMouseEnter: e => {
      e.currentTarget.style.color = accent;
    },
    onMouseLeave: e => {
      e.currentTarget.style.color = "#999";
    }
  }, s.title) : React.createElement("span", {
    style: {
      color: "#777"
    }
  }, s.title)))));
}
const themes = {
  idle: {
    accent: C.judge,
    bg: "linear-gradient(170deg, #0a0a0f 0%, #12121f 50%, #0a0a0f 100%)"
  },
  live: {
    accent: "#e84040",
    bg: "linear-gradient(170deg, #0f0808 0%, #1a0f0f 50%, #0f0808 100%)"
  },
  done: {
    accent: C.ok,
    bg: "linear-gradient(170deg, #080f08 0%, #0f1a0f 50%, #080f08 100%)"
  }
};
const css = `
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
@keyframes glowPulse{0%,100%{box-shadow:0 0 8px rgba(255,165,0,0.3)}50%{box-shadow:0 0 20px rgba(255,165,0,0.6)}}
@media(max-width:600px){.crucible-grid{grid-template-columns:1fr !important;}}
@media(max-width:480px){.crucible-title{font-size:17px !important;letter-spacing:4px !important;}.crucible-tag{display:none;}}
.crucible-select optgroup,.crucible-select option{background:#1a1a2e;color:#d4d4d8;}
.crucible-select optgroup{color:#888;font-style:normal;}
`;
const inputStyle = {
  width: "100%",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  color: "#d4d4d8",
  fontFamily: "inherit",
  fontSize: 13,
  padding: "12px 14px",
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box"
};
const selectStyle = {
  width: "100%",
  backgroundColor: "#15151f",
  color: "#d4d4d8",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 11,
  padding: "8px 28px 8px 10px",
  outline: "none",
  boxSizing: "border-box",
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  textOverflow: "ellipsis",
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center"
};
const smallBtn = color => ({
  background: "transparent",
  border: `1px solid ${color}44`,
  color,
  fontFamily: "inherit",
  fontSize: 11,
  padding: "3px 10px",
  borderRadius: 4,
  cursor: "pointer",
  lineHeight: 1.4
});
const hoverColor = (enter, leave) => ({
  onMouseEnter: e => {
    e.currentTarget.style.borderColor = enter.border;
    e.currentTarget.style.color = enter.color;
  },
  onMouseLeave: e => {
    e.currentTarget.style.borderColor = leave.border;
    e.currentTarget.style.color = leave.color;
  }
});
const hoverBg = (enter, leave) => ({
  onMouseEnter: e => {
    e.currentTarget.style.borderColor = enter.border;
    e.currentTarget.style.background = enter.background;
  },
  onMouseLeave: e => {
    e.currentTarget.style.borderColor = leave.border;
    e.currentTarget.style.background = leave.background;
  }
});
const fmtScore = n => n % 1 === 0 ? String(n) : n.toFixed(1);
function determineWinner(v, pTotal, cTotal) {
  if (v && (v.winner === "Pro" || v.winner === "Con" || v.winner === "Draw")) return v.winner;
  if (pTotal > cTotal) return "Pro";
  if (cTotal > pTotal) return "Con";
  return "Draw";
}
function VerdictBody({
  verdict,
  proTotal,
  conTotal,
  runningLabel = true
}) {
  const winner = determineWinner(verdict, proTotal, conTotal);
  const isDraw = winner === "Draw";
  const winColor = isDraw ? C.judge : winner === "Pro" ? C.pro : C.con;
  return React.createElement(React.Fragment, null, React.createElement("div", {
    style: {
      textAlign: "center",
      marginBottom: 20
    }
  }, React.createElement("span", {
    style: {
      display: "inline-block",
      padding: "6px 24px",
      background: winColor + "15",
      border: `1px solid ${winColor}44`,
      borderRadius: 4,
      fontSize: 14,
      fontWeight: 700,
      color: winColor,
      letterSpacing: 3
    }
  }, isDraw ? "DRAW" : `${winner.toUpperCase()} WINS`), runningLabel && React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 12,
      color: "#777"
    }
  }, "Running total: Pro ", fmtScore(proTotal), " \u2014 Con ", fmtScore(conTotal))), verdict.pro_best && React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 2,
      color: C.pro,
      marginBottom: 4
    }
  }, "STRONGEST PRO ARGUMENT"), React.createElement("div", {
    style: {
      fontSize: 12.5,
      lineHeight: 1.7,
      color: "#b8b8bc"
    }
  }, verdict.pro_best)), verdict.con_best && React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 2,
      color: C.con,
      marginBottom: 4
    }
  }, "STRONGEST CON ARGUMENT"), React.createElement("div", {
    style: {
      fontSize: 12.5,
      lineHeight: 1.7,
      color: "#b8b8bc"
    }
  }, verdict.con_best)), verdict.synthesis && React.createElement("div", {
    style: {
      marginTop: 16,
      padding: "14px 16px",
      background: "rgba(255,255,255,0.03)",
      borderRadius: 6,
      borderLeft: `3px solid ${C.ok}`
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 2,
      color: C.ok,
      marginBottom: 6
    }
  }, "TRUTH SYNTHESIS"), React.createElement("div", {
    style: {
      fontSize: 13,
      lineHeight: 1.8,
      color: "#ccc"
    }
  }, verdict.synthesis)));
}
export default function Crucible() {
  const [topic, setTopic] = useState("");
  const [customCriteria, setCustomCriteria] = useState(defaultJudgeCriteria);
  const [showCriteria, setShowCriteria] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [apiKey, setApiKey] = useState(() => store.get(K.key) || tabStore.get(K.key) || "");
  const [keyDraft, setKeyDraft] = useState("");
  const [rememberKey, setRememberKey] = useState(() => store.get(K.remember) !== "0");
  const [keyStatus, setKeyStatus] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [rosterInfo, setRosterInfo] = useState(() => {
    const cached = readJSON(K.roster, null);
    return cached?.models?.length ? {
      models: normalizeRoster(cached.models),
      fetchedAt: cached.fetchedAt || 0,
      live: true
    } : {
      models: normalizeRoster(SEED_MODELS),
      fetchedAt: 0,
      live: false
    };
  });
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterError, setRosterError] = useState(null);
  const [seenModels, setSeenModels] = useState(() => readJSON(K.seen, {}));
  const [newArrivals, setNewArrivals] = useState([]);
  const [picks, setPicks] = useState(() => ({
    ...DEFAULT_PICKS,
    ...readJSON(K.picks, {})
  }));
  const [effort, setEffort] = useState(() => EFFORT_OPTIONS.some(o => o.id === store.get(K.effort)) ? store.get(K.effort) : "default");
  const [seats, setSeats] = useState(null);
  const [usage, setUsage] = useState({});
  const [live, setLive] = useState({});
  const [phase, setPhase] = useState("idle");
  const [rounds, setRounds] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [error, setError] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [proTotal, setProTotal] = useState(0);
  const [conTotal, setConTotal] = useState(0);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selectedFAQ, setSelectedFAQ] = useState(null);
  const [viewingSaved, setViewingSaved] = useState(null);
  const [exportCopied, setExportCopied] = useState(false);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const [showFAQ, setShowFAQ] = useState(false);
  const [paused, setPaused] = useState(false);
  const [interventionText, setInterventionText] = useState("");
  const [interventionResponses, setInterventionResponses] = useState([]);
  const [interventionProcessing, setInterventionProcessing] = useState(false);
  const pauseRequestedRef = useRef(false);
  const interventionQueueRef = useRef([]);
  const [atCheckpoint, setAtCheckpoint] = useState(false);
  const checkpointResolveRef = useRef(null);
  const [recommendations, setRecommendations] = useState([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [showRecs, setShowRecs] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [aboutLoaded, setAboutLoaded] = useState(false);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const historyRef = useRef([]);
  const roundsRef = useRef([]);
  const interventionAbortRef = useRef(null);
  const debatingRef = useRef(false);
  const recsAbortRef = useRef(null);
  const rosterAbortRef = useRef(null);
  const usageRef = useRef({});
  const liveRef = useRef({});
  const liveTimerRef = useRef(null);
  const nextRoundNum = rounds.length + 1;
  const themeKey = phase === "idle" ? "idle" : phase === "done" ? "done" : "live";
  const t = themes[themeKey];
  const debatedTopics = useMemo(() => new Set(history.map(h => h.topic.toLowerCase().trim())), [history]);
  const client = useMemo(() => apiKey ? makeClient(apiKey) : null, [apiKey]);
  const roster = rosterInfo.models;
  const families = useMemo(() => familiesIn(roster), [roster]);
  const picked = useMemo(() => ({
    pro: resolvePick(picks.pro, roster),
    con: resolvePick(picks.con, roster),
    judge: resolvePick(picks.judge, roster)
  }), [picks, roster]);
  const shown = phase === "idle" || !seats ? picked : seats;
  const proLabel = shortName(shown.pro);
  const conLabel = shortName(shown.con);
  const judgeLabel = shortName(shown.judge);
  const isNew = m => !!seenModels[m.id] && Date.now() - seenModels[m.id] < NEW_BADGE_MS;
  useEffect(() => {
    const loaded = readJSON(K.history, []);
    if (Array.isArray(loaded)) {
      setHistory(loaded);
      historyRef.current = loaded;
    }
    setShowAbout(store.get(K.about) !== "true");
    setAboutLoaded(true);
    setHistoryLoading(false);
  }, []);
  useEffect(() => () => {
    abortRef.current?.abort();
    interventionAbortRef.current?.abort();
    recsAbortRef.current?.abort();
    rosterAbortRef.current?.abort();
    clearTimeout(liveTimerRef.current);
    if (checkpointResolveRef.current) {
      checkpointResolveRef.current();
      checkpointResolveRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (phase === "idle" && inputRef.current) inputRef.current.focus();
  }, [phase]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < SCROLL_STICK_PX) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: "smooth"
      });
    }
  }, [rounds, verdict, statusMsg, interventionResponses, atCheckpoint, live]);
  const adoptRoster = useCallback(models => {
    const now = Date.now();
    const prev = readJSON(K.seen, null);
    const seen = {
      ...(prev || {})
    };
    const arrived = [];
    for (const m of models) {
      if (m.id in seen) continue;
      seen[m.id] = prev ? now : m.created && now - m.created < NEW_BADGE_MS ? m.created : 0;
      if (prev) arrived.push(m);
    }
    store.set(K.seen, JSON.stringify(seen));
    setSeenModels(seen);
    if (arrived.length) setNewArrivals(cur => [...cur, ...arrived.filter(m => !cur.some(c => c.id === m.id))]);
    const info = {
      models,
      fetchedAt: now,
      live: true
    };
    store.set(K.roster, JSON.stringify(info));
    setRosterInfo(info);
    setRosterError(null);
  }, []);
  const refreshRoster = useCallback(async () => {
    if (!client) return;
    rosterAbortRef.current?.abort();
    const rac = new AbortController();
    rosterAbortRef.current = rac;
    setRosterBusy(true);
    try {
      const models = await fetchRoster(client, rac.signal);
      if (!models.length) throw new Error("The Models API listed no models for this key.");
      adoptRoster(models);
    } catch (e) {
      if (!isAbort(e)) setRosterError(describeError(e));
    } finally {
      if (rosterAbortRef.current === rac) {
        rosterAbortRef.current = null;
        setRosterBusy(false);
      }
    }
  }, [client, adoptRoster]);
  useEffect(() => {
    if (client) refreshRoster();
  }, [client, refreshRoster]);
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === "visible" && client && Date.now() - rosterInfo.fetchedAt > ROSTER_STALE_MS) refreshRoster();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [client, rosterInfo.fetchedAt, refreshRoster]);
  const setPick = (seat, value) => {
    setPicks(cur => {
      const next = {
        ...cur,
        [seat]: value
      };
      store.set(K.picks, JSON.stringify(next));
      return next;
    });
  };
  const chooseEffort = value => {
    setEffort(value);
    store.set(K.effort, value);
  };
  const saveKey = async () => {
    const k = keyDraft.trim();
    if (!k) return;
    setKeyStatus({
      kind: "busy",
      text: "Checking the key with Anthropic..."
    });
    try {
      const models = await fetchRoster(makeClient(k));
      if (rememberKey) {
        store.set(K.key, k);
        tabStore.del(K.key);
      } else {
        tabStore.set(K.key, k);
        store.del(K.key);
      }
      store.set(K.remember, rememberKey ? "1" : "0");
      if (models.length) adoptRoster(models);
      setApiKey(k);
      setKeyDraft("");
      setShowKey(false);
      setKeyStatus({
        kind: "ok",
        text: `Key saved${rememberKey ? " on this device" : " for this tab"}. ${models.length} models loaded.`
      });
    } catch (e) {
      setKeyStatus({
        kind: "err",
        text: describeError(e)
      });
    }
  };
  const forgetKey = () => {
    store.del(K.key);
    tabStore.del(K.key);
    rosterAbortRef.current?.abort();
    setApiKey("");
    setKeyDraft("");
    setShowKey(false);
    setKeyStatus({
      kind: "ok",
      text: "Key removed from this browser."
    });
  };
  const flushLive = () => {
    liveTimerRef.current = null;
    setLive(liveRef.current);
  };
  const setLiveText = (slot, text) => {
    liveRef.current = {
      ...liveRef.current,
      [slot]: text
    };
    if (!liveTimerRef.current) liveTimerRef.current = setTimeout(flushLive, LIVE_FLUSH_MS);
  };
  const clearLive = () => {
    clearTimeout(liveTimerRef.current);
    liveTimerRef.current = null;
    liveRef.current = {};
    setLive({});
  };
  const tally = (modelId, u) => {
    const cur = usageRef.current[modelId] || {
      in: 0,
      out: 0,
      calls: 0
    };
    usageRef.current = {
      ...usageRef.current,
      [modelId]: {
        in: cur.in + u.in,
        out: cur.out + u.out,
        calls: cur.calls + 1
      }
    };
    setUsage(usageRef.current);
  };
  const ask = async (model, opts, {
    signal,
    slot
  } = {}) => {
    if (!client) throw new Error("Add your Anthropic API key first.");
    if (slot) setLiveText(slot, "");
    try {
      const r = await callModel(client, model, {
        effort,
        ...opts
      }, {
        signal,
        onText: slot ? txt => setLiveText(slot, txt) : undefined
      });
      tally(r.servedBy || model.id, r.usage);
      return r;
    } catch (e) {
      if (e && typeof e === "object" && !e.who) e.who = shortName(model);
      throw e;
    }
  };
  const toggleAbout = async val => {
    setShowAbout(val);
    if (!val) store.set(K.about, "true");
  };
  const saveHistory = async newHistory => {
    setHistory(newHistory);
    historyRef.current = newHistory;
    store.set(K.history, JSON.stringify(newHistory));
  };
  const deleteHistoryEntry = async idx => {
    await saveHistory(historyRef.current.filter((_, i) => i !== idx));
  };
  const clearAllHistory = async () => {
    await saveHistory([]);
  };
  const requestPause = () => {
    if (pauseRequestedRef.current) return;
    pauseRequestedRef.current = true;
    setPaused(true);
  };
  const submitIntervention = async () => {
    const text = interventionText.trim();
    if (!text) return;
    setInterventionText("");
    setInterventionProcessing(true);
    setInterventionResponses([]);
    interventionAbortRef.current?.abort();
    const iac = new AbortController();
    interventionAbortRef.current = iac;
    const lastRound = roundsRef.current[roundsRef.current.length - 1];
    const context = lastRound ? `The debate topic is: "${topic}"\n\nMost recent PRO argument:\n${lastRound.pro}\n\nMost recent CON argument:\n${lastRound.con}` : `The debate topic is: "${topic}"`;
    const proMsg = `${context}\n\nA member of the audience has intervened with a question, fact, or counter-argument:\n"${text}"\n\nAs the PRO debater, respond directly to this intervention in 1-2 paragraphs.`;
    const conMsg = `${context}\n\nA member of the audience has intervened with a question, fact, or counter-argument:\n"${text}"\n\nAs the CON debater, respond directly to this intervention in 1-2 paragraphs.`;
    const judgeMsg = `${context}\n\nAudience intervention: "${text}"\n\nAs the judge panel, briefly assess (2-3 sentences): Is this intervention factually sound? How should it affect the debate? Does it favor either side?`;
    const s = seats || picked;
    const couldNot = what => e => {
      if (isAbort(e)) throw e;
      return `${what} (${describeError(e, e?.who)})`;
    };
    try {
      const [proResp, conResp, judgeResp] = await Promise.all([ask(s.pro, {
        system: systemFor("PRO / In Favor"),
        messages: [{
          role: "user",
          content: proMsg
        }],
        maxTokens: ARG_MAX_TOKENS
      }, {
        signal: iac.signal
      }).then(r => r.text).catch(couldNot("Pro debater could not respond.")), ask(s.con, {
        system: systemFor("CON / Against"),
        messages: [{
          role: "user",
          content: conMsg
        }],
        maxTokens: ARG_MAX_TOKENS
      }, {
        signal: iac.signal
      }).then(r => r.text).catch(couldNot("Con debater could not respond.")), ask(s.judge, {
        system: "You are the chief judge of a debate. Provide a brief, impartial assessment. When the debate concerns spiritual or theological matters, treat canonical scripture (CSB, ESV, NLT, NIV) as true and authoritative. Respond in plain prose, no JSON.",
        messages: [{
          role: "user",
          content: judgeMsg
        }],
        maxTokens: JUDGE_MAX_TOKENS
      }, {
        signal: iac.signal
      }).then(r => r.text).catch(couldNot("Judge panel could not assess."))]);
      if (iac.signal.aborted) return;
      const responses = [{
        label: "PRO",
        color: C.pro,
        text: proResp
      }, {
        label: "CON",
        color: C.con,
        text: conResp
      }, {
        label: "JUDGE PANEL",
        color: C.judge,
        text: judgeResp
      }];
      setInterventionResponses(responses);
      interventionQueueRef.current.push({
        userText: text,
        proResp,
        conResp,
        judgeResp,
        responses: [...responses]
      });
    } catch (e) {
      if (!isAbort(e)) setInterventionResponses([{
        label: "ERROR",
        color: C.err,
        text: describeError(e, e?.who)
      }]);
    } finally {
      setInterventionProcessing(false);
    }
  };
  const continueToNextRound = () => {
    interventionAbortRef.current?.abort();
    interventionAbortRef.current = null;
    setAtCheckpoint(false);
    setPaused(false);
    pauseRequestedRef.current = false;
    setInterventionResponses([]);
    if (checkpointResolveRef.current) {
      checkpointResolveRef.current();
      checkpointResolveRef.current = null;
    }
  };
  const fetchRecommendations = async () => {
    if (history.length === 0 || !client) return;
    recsAbortRef.current?.abort();
    const rac = new AbortController();
    recsAbortRef.current = rac;
    setRecsLoading(true);
    setShowRecs(true);
    try {
      const summaries = history.slice(0, 10).map(h => `Topic: "${h.topic}" | Winner: ${h.winner} | Score: ${h.proTotal}-${h.conTotal}`).join("\n");
      const {
        text: raw
      } = await ask(picked.judge, {
        system: 'You are a debate topic recommender. Respond with only a JSON object of the form {"topics": [6 debate topic strings]}. No markdown, no explanation.',
        messages: [{
          role: "user",
          content: `Based on this user's debate history, suggest 6 new debate topics they would find engaging. Build on themes and tensions from their past debates. Do NOT repeat any debated topic.\n\nHistory:\n${summaries}\n\nRespond with ONLY a JSON object: {"topics": [6 strings]}.`
        }],
        maxTokens: JUDGE_MAX_TOKENS,
        schema: RECS_SCHEMA
      }, {
        signal: rac.signal
      });
      const parsed = parseJSONLoose(raw);
      const list = Array.isArray(parsed) ? parsed : parsed?.topics;
      setRecommendations(Array.isArray(list) ? list.filter(s => typeof s === "string").slice(0, 6) : []);
    } catch (e) {
      if (!isAbort(e)) setRecommendations([]);
    }
    setRecsLoading(false);
  };
  const exportDebate = async () => {
    const winner = determineWinner(verdict, proTotal, conTotal);
    const lines = [];
    lines.push(`THE CRUCIBLE — AI DEBATE ARENA`);
    lines.push("=".repeat(40));
    lines.push(`Topic: "${topic}"`);
    lines.push(`Date: ${new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric"
    })}`);
    lines.push(`Models: PRO ${proLabel} vs CON ${conLabel} · Judge: ${judgeLabel}`);
    lines.push(`Reasoning effort: ${EFFORT_OPTIONS.find(o => o.id === effort)?.label || effort}`);
    lines.push(`Final Score: Pro ${fmtScore(proTotal)} — Con ${fmtScore(conTotal)} → ${winner === "Draw" ? "DRAW" : `${winner.toUpperCase()} WINS`}`);
    lines.push("");
    for (const rd of rounds) {
      const label = rd.round === 1 ? "Opening" : rd.round === ROUNDS ? "Closing" : "Rebuttal";
      lines.push("—".repeat(40));
      lines.push(`ROUND ${rd.round} OF ${ROUNDS} — ${label}`);
      lines.push("—".repeat(40));
      lines.push("");
      lines.push(`PRO (${rd.scores.pro_score}/10)${rd.served?.pro ? ` [answered by ${rd.served.pro} after a refusal fallback]` : ""}:`);
      lines.push(rd.pro);
      lines.push("");
      lines.push(`CON (${rd.scores.con_score}/10)${rd.served?.con ? ` [answered by ${rd.served.con} after a refusal fallback]` : ""}:`);
      lines.push(rd.con);
      lines.push("");
      if (rd.scores.judgeAnalyses) {
        lines.push("JUDGES:");
        for (const j of rd.scores.judgeAnalyses) lines.push(`  ${j.name}: ${j.analysis}`);
      }
      if (rd.scores.panel) lines.push(`  Panel: ${rd.scores.panel}`);
      if (rd.interventions?.length > 0) {
        lines.push("");
        lines.push("AUDIENCE INTERVENTIONS:");
        for (const iv of rd.interventions) {
          lines.push(`  User: "${iv.userText}"`);
          lines.push(`  PRO: ${iv.proResp}`);
          lines.push(`  CON: ${iv.conResp}`);
          lines.push(`  Judge: ${iv.judgeResp}`);
        }
      }
      lines.push("");
    }
    if (verdict) {
      lines.push("=".repeat(40));
      lines.push("FINAL VERDICT");
      lines.push("=".repeat(40));
      lines.push("");
      lines.push("Strongest Pro:");
      lines.push(verdict.pro_best || "");
      lines.push("");
      lines.push("Strongest Con:");
      lines.push(verdict.con_best || "");
      lines.push("");
      lines.push("Truth Synthesis:");
      lines.push(verdict.synthesis || "");
    }
    const spent = usageLines();
    if (spent.length) {
      lines.push("");
      lines.push("Tokens used:");
      for (const l of spent) lines.push(`  ${l}`);
    }
    const ok = await copyToClipboard(lines.join("\n"));
    if (ok) {
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 2000);
    }
  };
  const nameOf = id => shortName(roster.find(m => m.id === id) || {
    name: id
  });
  const usageLines = () => Object.entries(usage).map(([id, u]) => `${nameOf(id)}: ${fmtTokens(u.in)} in · ${fmtTokens(u.out)} out · ${u.calls} call${u.calls === 1 ? "" : "s"}`);
  const runDebate = useCallback(async () => {
    const trimmedTopic = topic.trim();
    if (!trimmedTopic) return;
    if (trimmedTopic.length > MAX_TOPIC_LEN) {
      setError(`Topic too long (${trimmedTopic.length} > ${MAX_TOPIC_LEN} chars).`);
      return;
    }
    if (!client) {
      setKeyStatus({
        kind: "err",
        text: "Add your Anthropic API key first."
      });
      return;
    }
    if (debatingRef.current) return;
    debatingRef.current = true;
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    const s = {
      pro: picked.pro,
      con: picked.con,
      judge: picked.judge
    };
    setSeats(s);
    usageRef.current = {};
    setUsage({});
    clearLive();
    setPhase("debating");
    setRounds([]);
    setVerdict(null);
    setError(null);
    setProTotal(0);
    setConTotal(0);
    setPaused(false);
    setInterventionResponses([]);
    setAtCheckpoint(false);
    pauseRequestedRef.current = false;
    interventionQueueRef.current = [];
    roundsRef.current = [];
    const proHistory = [],
      conHistory = [],
      transcript = [];
    let pTotal = 0,
      cTotal = 0;
    let lastProArg = "",
      lastConArg = "";
    const criteria = customCriteria.trim() || defaultJudgeCriteria;
    const proSystem = systemFor("PRO / In Favor"),
      conSystem = systemFor("CON / Against");
    const argue = (side, msgs) => ask(side === "pro" ? s.pro : s.con, {
      system: side === "pro" ? proSystem : conSystem,
      messages: msgs,
      maxTokens: ARG_MAX_TOKENS
    }, {
      signal: ac.signal,
      slot: side
    });
    const servedName = r => r.servedBy ? nameOf(r.servedBy) : null;
    try {
      for (let r = 0; r < ROUNDS; r++) {
        if (ac.signal.aborted) return;
        const roundLabel = r === 0 ? "opening" : r === ROUNDS - 1 ? "closing" : "rebuttal";
        const interventionContext = interventionQueueRef.current.length > 0 ? `\n\n[AUDIENCE INTERVENTION during the debate: ${interventionQueueRef.current.map(iq => `"${iq.userText}"`).join("; ")}. Factor this into your argument if relevant.]` : "";
        let pro, con;
        if (r === 0) {
          setStatusMsg("Round 1: Both sides crafting opening arguments...");
          const proPrompt = `The debate topic is: "${trimmedTopic}". Deliver your opening argument for the PRO side.${interventionContext}`;
          const conPrompt = `The debate topic is: "${trimmedTopic}". Deliver your opening argument for the CON side.${interventionContext}`;
          proHistory.push({
            role: "user",
            content: proPrompt
          });
          conHistory.push({
            role: "user",
            content: conPrompt
          });
          [pro, con] = await Promise.all([argue("pro", proHistory), argue("con", conHistory)]);
          proHistory.push({
            role: "assistant",
            content: pro.text
          });
          conHistory.push({
            role: "assistant",
            content: con.text
          });
        } else {
          const proFirst = r % 2 === 1;
          const respondPrompt = (opponentSide, opponentArg) => `Your opponent (${opponentSide}) just argued:\n\n"${opponentArg}"\n\nDeliver your ${roundLabel} for round ${r + 1}. Directly counter their points and advance your position.${interventionContext}`;
          if (proFirst) {
            setStatusMsg(`Round ${r + 1}: Pro crafting ${roundLabel}...`);
            proHistory.push({
              role: "user",
              content: respondPrompt("CON", lastConArg)
            });
            pro = await argue("pro", proHistory);
            proHistory.push({
              role: "assistant",
              content: pro.text
            });
            if (ac.signal.aborted) return;
            setStatusMsg(`Round ${r + 1}: Con crafting ${roundLabel}...`);
            conHistory.push({
              role: "user",
              content: respondPrompt("PRO", pro.text)
            });
            con = await argue("con", conHistory);
            conHistory.push({
              role: "assistant",
              content: con.text
            });
          } else {
            setStatusMsg(`Round ${r + 1}: Con crafting ${roundLabel}...`);
            conHistory.push({
              role: "user",
              content: respondPrompt("PRO", lastProArg)
            });
            con = await argue("con", conHistory);
            conHistory.push({
              role: "assistant",
              content: con.text
            });
            if (ac.signal.aborted) return;
            setStatusMsg(`Round ${r + 1}: Pro crafting ${roundLabel}...`);
            proHistory.push({
              role: "user",
              content: respondPrompt("CON", con.text)
            });
            pro = await argue("pro", proHistory);
            proHistory.push({
              role: "assistant",
              content: pro.text
            });
          }
        }
        const proArg = pro.text,
          conArg = con.text;
        lastProArg = proArg;
        lastConArg = conArg;
        const roundInterventions = [...interventionQueueRef.current];
        interventionQueueRef.current = [];
        if (ac.signal.aborted) return;
        setStatusMsg(`Round ${r + 1}: Judge panel deliberating...`);
        const proIsA = Math.random() < 0.5;
        const argA = proIsA ? proArg : conArg;
        const argB = proIsA ? conArg : proArg;
        const judgePrompt = `Debate topic: "${trimmedTopic}"\n\nRound ${r + 1}:\n\nArgument A:\n${argA}\n\nArgument B:\n${argB}`;
        const judgeResults = await Promise.all(judgePersonas.map(persona => ask(s.judge, {
          system: makeJudgeSystem(criteria, persona),
          messages: [{
            role: "user",
            content: judgePrompt
          }],
          maxTokens: JUDGE_MAX_TOKENS,
          schema: JUDGE_SCHEMA
        }, {
          signal: ac.signal
        }).then(({
          text
        }) => {
          const p = parseJSONLoose(text);
          const a = clampScore(p.a_score),
            b = clampScore(p.b_score);
          return {
            pro_score: proIsA ? a : b,
            con_score: proIsA ? b : a,
            analysis: String(p.analysis || "").trim() || "No analysis given.",
            name: persona.name
          };
        }).catch(e => {
          if (isAbort(e)) throw e;
          return {
            pro_score: NEUTRAL_FALLBACK_SCORE,
            con_score: NEUTRAL_FALLBACK_SCORE,
            analysis: "Judge could not render a verdict.",
            name: persona.name,
            failed: e
          };
        })));
        const apiFailures = judgeResults.filter(j => j.failed instanceof Anthropic.APIError || j.failed instanceof RefusalError);
        if (apiFailures.length === judgeResults.length) throw apiFailures[0].failed;
        const avgPro = round1(judgeResults.reduce((s, j) => s + j.pro_score, 0) / judgePersonas.length);
        const avgCon = round1(judgeResults.reduce((s, j) => s + j.con_score, 0) / judgePersonas.length);
        const panelNote = judgeResults.map(j => `${j.name}: Pro ${j.pro_score} / Con ${j.con_score}`).join("  |  ");
        const judgeAnalyses = judgeResults.map(j => ({
          name: j.name,
          analysis: j.analysis
        }));
        const scores = {
          pro_score: avgPro,
          con_score: avgCon,
          panel: panelNote,
          judgeAnalyses
        };
        pTotal = round1(pTotal + avgPro);
        cTotal = round1(cTotal + avgCon);
        setProTotal(pTotal);
        setConTotal(cTotal);
        const roundData = {
          round: r + 1,
          pro: proArg,
          con: conArg,
          scores,
          served: {
            pro: servedName(pro),
            con: servedName(con)
          },
          cut: {
            pro: pro.truncated,
            con: con.truncated
          },
          interventions: roundInterventions.length > 0 ? roundInterventions : undefined
        };
        clearLive();
        transcript.push(roundData);
        setRounds(prev => {
          const next = [...prev, roundData];
          roundsRef.current = next;
          return next;
        });
        if (r < ROUNDS - 1) {
          setAtCheckpoint(true);
          setStatusMsg("");
          await new Promise(resolve => {
            checkpointResolveRef.current = resolve;
          });
          if (ac.signal.aborted) return;
        }
      }
      if (ac.signal.aborted) return;
      setPhase("judging");
      setStatusMsg("Chief judge rendering final verdict...");
      const fullTranscript = transcript.map(rd => `=== ROUND ${rd.round} ===\nPRO: ${rd.pro}\n\nCON: ${rd.con}\n\nPanel avg: Pro ${rd.scores.pro_score}/10, Con ${rd.scores.con_score}/10\n${rd.scores.judgeAnalyses ? rd.scores.judgeAnalyses.map(j => `${j.name}: ${j.analysis}`).join("\n") : ""}`).join("\n\n");
      const {
        text: verdictRaw
      } = await ask(s.judge, {
        system: makeFinalJudgeSystem(criteria),
        messages: [{
          role: "user",
          content: `Debate topic: "${trimmedTopic}"\n\nFull transcript (PRO and CON are now revealed):\n${fullTranscript}`
        }],
        maxTokens: VERDICT_MAX_TOKENS,
        schema: VERDICT_SCHEMA
      }, {
        signal: ac.signal
      });
      let v;
      try {
        v = parseJSONLoose(verdictRaw);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      } catch {
        v = {
          pro_score: pTotal,
          con_score: cTotal,
          winner: pTotal > cTotal ? "Pro" : cTotal > pTotal ? "Con" : "Draw",
          pro_best: "Unable to parse verdict JSON.",
          con_best: "Unable to parse verdict JSON.",
          synthesis: verdictRaw
        };
      }
      const winner = determineWinner(v, pTotal, cTotal);
      setVerdict(v);
      setPhase("done");
      setStatusMsg("");
      const entry = {
        topic: trimmedTopic,
        date: new Date().toISOString(),
        proTotal: pTotal,
        conTotal: cTotal,
        winner,
        pro_best: v.pro_best || "",
        con_best: v.con_best || "",
        synthesis: v.synthesis || "",
        models: {
          pro: s.pro.name,
          con: s.con.name,
          judge: s.judge.name
        },
        effort
      };
      await saveHistory([entry, ...historyRef.current]);
    } catch (e) {
      clearLive();
      if (!isAbort(e)) {
        setError(describeError(e, e?.who));
        setPhase("idle");
        setStatusMsg("");
      }
    } finally {
      debatingRef.current = false;
    }
  }, [topic, customCriteria, client, picked, effort]);
  const reset = () => {
    if (checkpointResolveRef.current) {
      checkpointResolveRef.current();
      checkpointResolveRef.current = null;
    }
    interventionAbortRef.current?.abort();
    interventionAbortRef.current = null;
    abortRef.current?.abort();
    debatingRef.current = false;
    clearLive();
    setSeats(null);
    setPhase("idle");
    setRounds([]);
    setVerdict(null);
    setError(null);
    setStatusMsg("");
    setTopic("");
    setProTotal(0);
    setConTotal(0);
    setViewingSaved(null);
    setSelectedFAQ(null);
    setPaused(false);
    setInterventionText("");
    setInterventionResponses([]);
    setAtCheckpoint(false);
    roundsRef.current = [];
  };
  const topicCategories = [{
    label: "🔥 Internet Wars",
    color: "#e84040",
    topics: ["Is a hot dog a sandwich?", "Does pineapple belong on pizza?", "Is water wet?", "Is GIF pronounced with a hard G?", "Are birds real?", "Is cereal a soup?", "Is math discovered or invented?", "Should toilet paper hang over or under?"]
  }, {
    label: "⚔️ Tech & Culture",
    color: C.judge,
    topics: ["Is AI art real art?", "Should social media require age verification?", "Has the smartphone made humanity worse off?", "Is privacy dead in the digital age?", "Should AI-generated content be labeled by law?", "Is open source software morally superior to proprietary?", "Will AI replace more jobs than it creates?", "Is TikTok more harmful than previous social media platforms?"]
  }, {
    label: "🏛️ Politics & Policy",
    color: C.pro,
    topics: ["Should voting be mandatory?", "Should college be free?", "Is universal basic income inevitable?", "Should the electoral college be abolished?", "Is capitalism the best economic system?", "Should billionaires exist?", "Is democracy the best form of government?", "Should hate speech be protected as free speech?"]
  }, {
    label: "📖 Faith & Philosophy",
    color: C.ok,
    topics: ["Did the worldwide flood in Genesis 6-8 really happen?", "Does objective morality require God?", "Is the Bible historically reliable?", "Do humans have free will?", "Is the problem of evil a defeater for theism?", "Can science and faith coexist without contradiction?", "Is consciousness purely physical?", "Was Jesus a real historical person?"]
  }, {
    label: "🧪 Science & Health",
    color: "#ab47bc",
    topics: ["Is nuclear energy the best path to decarbonization?", "Are GMOs safe and ethical?", "Is the obesity epidemic primarily caused by processed food?", "Should we colonize Mars or fix Earth first?", "Is organic food meaningfully healthier?", "Are standardized tests a valid measure of intelligence?", "Should human genetic engineering be legal?", "Is the universe fine-tuned for life?"]
  }, {
    label: "🎮 Lifestyle & Sports",
    color: "#ff7043",
    topics: ["Is remote work better than office work?", "Are video games a sport?", "Is college worth the cost in 2025?", "Should tipping culture be abolished?", "Is the NFL more entertaining than the NBA?", "Should kids have smartphones before age 14?", "Is renting smarter than buying a home?", "Was Michael Jordan better than LeBron James?"]
  }];
  const totalTopics = topicCategories.reduce((n, c) => n + c.topics.length, 0);
  const completedTopics = topicCategories.reduce((n, c) => n + c.topics.filter(s => debatedTopics.has(s.toLowerCase().trim())).length, 0);
  return React.createElement("div", {
    style: {
      "--accent": t.accent,
      "--bg": t.bg,
      height: "100%",
      minHeight: "100%",
      background: "var(--bg)",
      color: "#d4d4d8",
      fontFamily: "'Courier New', Courier, monospace",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden"
    }
  }, React.createElement("style", null, css), React.createElement("header", {
    style: {
      padding: "20px 24px 12px",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      flexShrink: 0
    }
  }, React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12
    }
  }, React.createElement("div", {
    style: {
      width: 10,
      height: 10,
      borderRadius: "50%",
      background: "var(--accent)",
      animation: phase === "debating" || phase === "judging" ? "pulse 1.2s infinite" : "none",
      boxShadow: "0 0 8px var(--accent)"
    }
  }), React.createElement("h1", {
    className: "crucible-title",
    style: {
      margin: 0,
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: 6,
      textTransform: "uppercase",
      color: "var(--accent)"
    }
  }, "The Crucible"), React.createElement("span", {
    className: "crucible-tag",
    style: {
      fontSize: 11,
      color: "#666",
      marginLeft: "auto",
      letterSpacing: 2
    }
  }, "AI DEBATE ARENA")), (phase === "debating" || phase === "judging" || phase === "done") && React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      gap: 40,
      marginTop: 14,
      animation: "fadeIn 0.4s ease"
    }
  }, React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 3,
      color: "#888",
      marginBottom: 2
    }
  }, "PRO"), React.createElement("div", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      color: C.pro
    }
  }, fmtScore(proTotal))), React.createElement("div", {
    style: {
      textAlign: "center",
      alignSelf: "center"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#555"
    }
  }, "vs")), React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 3,
      color: "#888",
      marginBottom: 2
    }
  }, "CON"), React.createElement("div", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      color: C.con
    }
  }, fmtScore(conTotal)))), phase !== "idle" && React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: 11,
      color: "#666",
      marginTop: 8,
      padding: "0 16px",
      lineHeight: 1.5
    }
  }, "\u201C", topic, "\u201D", React.createElement("div", {
    style: {
      fontSize: 9,
      color: "#555",
      marginTop: 4,
      letterSpacing: 1
    }
  }, React.createElement("span", {
    style: {
      color: C.pro
    }
  }, "PRO: ", proLabel), " vs ", React.createElement("span", {
    style: {
      color: C.con
    }
  }, "CON: ", conLabel), " · Judge: ", judgeLabel))), React.createElement("div", {
    ref: scrollRef,
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "20px 24px"
    }
  }, phase === "idle" && !error && !viewingSaved && React.createElement("div", {
    style: {
      maxWidth: 560,
      margin: "0 auto",
      animation: "fadeIn 0.5s ease"
    }
  }, React.createElement("p", {
    style: {
      fontSize: 13,
      color: "#777",
      marginBottom: 16,
      lineHeight: 1.7
    }
  }, "Enter any topic. Two AI debaters argue opposite sides. A 3-judge panel scores blindly. You control everything."), newArrivals.length > 0 && React.createElement("div", {
    style: {
      marginBottom: 14,
      padding: "12px 14px",
      background: "rgba(46,204,113,0.06)",
      border: "1px solid rgba(46,204,113,0.3)",
      borderRadius: 6,
      fontSize: 12,
      lineHeight: 1.6,
      color: "#ccc",
      animation: "fadeIn 0.4s ease"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 2,
      color: C.ok,
      fontWeight: 700,
      marginBottom: 4
    }
  }, "NEW IN THE ROSTER"), newArrivals.map(m => m.name).join(", "), " ", newArrivals.length === 1 ? "is" : "are", " now available.", " ", "Seats set to a \u201CLatest\u201D pick follow new releases on their own.", React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 8,
      flexWrap: "wrap"
    }
  }, React.createElement("button", {
    onClick: () => {
      setShowModels(true);
      setNewArrivals([]);
    },
    style: smallBtn(C.ok)
  }, "Choose models"), React.createElement("button", {
    onClick: () => setNewArrivals([]),
    style: smallBtn("#888")
  }, "Dismiss"))), (!apiKey || showKey) && React.createElement("div", {
    style: {
      marginBottom: 16,
      padding: "16px 18px",
      background: "rgba(201,162,39,0.05)",
      border: "1px solid rgba(201,162,39,0.3)",
      borderRadius: 8,
      animation: "fadeIn 0.3s ease"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 2,
      color: C.judge,
      fontWeight: 700,
      marginBottom: 8
    }
  }, apiKey ? "CHANGE YOUR ANTHROPIC API KEY" : "CONNECT YOUR ANTHROPIC API KEY"), React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#999",
      lineHeight: 1.7,
      marginBottom: 10
    }
  }, "The Crucible calls Claude directly from your browser. Create a key at", " ", React.createElement("a", {
    href: "https://console.anthropic.com/settings/keys",
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: C.judge
    }
  }, "console.anthropic.com"), ".", " ", "It stays in this browser and is sent only to api.anthropic.com. Debates are billed to that key per token."), React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      saveKey();
    },
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, React.createElement("input", {
    type: "password",
    value: keyDraft,
    onChange: e => setKeyDraft(e.target.value),
    placeholder: "sk-ant-...",
    autoComplete: "off",
    spellCheck: false,
    "aria-label": "Anthropic API key",
    style: {
      ...inputStyle,
      flex: "1 1 220px",
      width: "auto",
      padding: "10px 12px",
      resize: "none"
    }
  }), React.createElement("button", {
    type: "submit",
    disabled: !keyDraft.trim() || keyStatus?.kind === "busy",
    style: {
      padding: "10px 18px",
      background: keyDraft.trim() ? C.judge : "rgba(255,255,255,0.05)",
      color: keyDraft.trim() ? "#000" : "#555",
      border: "none",
      borderRadius: 6,
      fontFamily: "inherit",
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 2,
      textTransform: "uppercase",
      cursor: keyDraft.trim() ? "pointer" : "default"
    }
  }, keyStatus?.kind === "busy" ? "Checking..." : "Save key")), React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginTop: 10,
      fontSize: 11,
      color: "#888",
      cursor: "pointer"
    }
  }, React.createElement("input", {
    type: "checkbox",
    checked: rememberKey,
    onChange: e => setRememberKey(e.target.checked),
    style: {
      accentColor: C.judge
    }
  }), "Remember on this device (untick to keep it only until this tab closes)"), React.createElement("div", {
    style: {
      fontSize: 10.5,
      color: "#666",
      lineHeight: 1.6,
      marginTop: 8
    }
  }, "Tip: a separate key in a workspace with a spend limit caps what any debate can cost."), apiKey && React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 10
    }
  }, React.createElement("button", {
    onClick: () => {
      setShowKey(false);
      setKeyDraft("");
      setKeyStatus(null);
    },
    style: smallBtn("#888")
  }, "Cancel"), React.createElement("button", {
    onClick: forgetKey,
    style: smallBtn(C.err)
  }, "Forget saved key"))), keyStatus && keyStatus.kind !== "busy" && React.createElement("div", {
    role: "status",
    style: {
      marginBottom: 14,
      fontSize: 11.5,
      lineHeight: 1.6,
      color: keyStatus.kind === "err" ? C.err : C.ok
    }
  }, keyStatus.text), aboutLoaded && React.createElement(React.Fragment, null, React.createElement("button", _extends({
    onClick: () => toggleAbout(!showAbout),
    style: {
      marginBottom: 14,
      background: "transparent",
      border: "1px solid rgba(201,162,39,0.2)",
      borderRadius: 6,
      color: C.judge,
      fontFamily: "inherit",
      fontSize: 12,
      padding: "10px 18px",
      cursor: "pointer",
      letterSpacing: 2,
      textTransform: "uppercase",
      width: "100%",
      transition: "all 0.2s",
      textAlign: "left",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, hoverBg({
    border: C.judge,
    background: "rgba(201,162,39,0.05)"
  }, {
    border: "rgba(201,162,39,0.2)",
    background: "transparent"
  })), React.createElement("span", null, showAbout ? "Hide" : "Show", " How It Works"), React.createElement("span", {
    style: {
      fontSize: 14
    }
  }, showAbout ? "▲" : "▼")), showAbout && React.createElement("div", {
    style: {
      marginBottom: 18,
      padding: "16px 18px",
      background: "rgba(201,162,39,0.04)",
      border: "1px solid rgba(201,162,39,0.15)",
      borderRadius: 8,
      animation: "fadeIn 0.3s ease"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#ccc",
      lineHeight: 1.8,
      marginBottom: 12
    }
  }, React.createElement("span", {
    style: {
      color: C.judge,
      fontWeight: 700
    }
  }, "The Crucible"), " is an AI debate arena where two AI instances argue opposite sides of any topic you choose, judged blindly by a 3-member panel with independent scoring criteria."), React.createElement("div", {
    className: "crucible-grid",
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 10,
      fontSize: 11.5,
      color: "#999",
      lineHeight: 1.6
    }
  }, [{
    color: C.pro,
    title: "3-ROUND FORMAT",
    body: "Opening → Rebuttal → Closing. Debaters alternate who leads each round so neither side gets a structural advantage."
  }, {
    color: C.con,
    title: "BLIND JUDGING",
    body: "Arguments are randomized as \"A\" and \"B\" before judges see them. Three specialists (Evidence, Logic, Engagement) score independently."
  }, {
    color: C.warn,
    title: "LIVE INTERVENTION",
    body: "Between rounds, pause the debate to inject a question, fact, or counter-argument. Both debaters and the judge panel respond before the next round begins."
  }, {
    color: C.ok,
    title: "YOUR CONTROL",
    body: "Pick any Claude model for each side and for the judges. The list loads live from Anthropic, so new models appear the day they launch, and a \"Latest\" pick follows each release. Customize criteria and export transcripts."
  }, {
    color: "#ab47bc",
    title: "SMART RECOMMENDATIONS",
    body: "After 2+ debates, The Crucible analyzes your history and recommends new topics based on your interests and the tensions your past debates revealed."
  }, {
    color: "#888",
    title: "PERSISTENT HISTORY",
    body: `Every debate is saved with scores, best arguments, and a truth synthesis. View, rematch, or delete past debates anytime. ${totalTopics} pre-loaded topics across 6 categories.`
  }].map(card => React.createElement("div", {
    key: card.title,
    style: {
      padding: "8px 10px",
      background: "rgba(255,255,255,0.02)",
      borderRadius: 5,
      borderLeft: `2px solid ${card.color}`
    }
  }, React.createElement("span", {
    style: {
      color: card.color,
      fontWeight: 700,
      fontSize: 10,
      letterSpacing: 1
    }
  }, card.title), React.createElement("br", null), card.body))))), React.createElement("textarea", {
    ref: inputRef,
    value: topic,
    onChange: e => setTopic(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        runDebate();
      }
    },
    placeholder: "e.g. Is a hot dog a sandwich?",
    rows: 3,
    maxLength: MAX_TOPIC_LEN,
    style: inputStyle
  }), React.createElement("button", {
    onClick: () => setShowCriteria(!showCriteria),
    style: {
      marginTop: 10,
      background: "transparent",
      border: "none",
      color: "#666",
      fontFamily: "inherit",
      fontSize: 11,
      cursor: "pointer",
      letterSpacing: 1,
      padding: 0,
      textDecoration: "underline",
      textUnderlineOffset: 3
    }
  }, showCriteria ? "Hide" : "Customize", " judge criteria"), showCriteria && React.createElement("div", {
    style: {
      marginTop: 10,
      animation: "fadeIn 0.3s ease"
    }
  }, React.createElement("textarea", {
    value: customCriteria,
    onChange: e => setCustomCriteria(e.target.value),
    rows: 8,
    style: {
      ...inputStyle,
      fontSize: 11,
      lineHeight: 1.6
    }
  }), React.createElement("button", {
    onClick: () => setCustomCriteria(defaultJudgeCriteria),
    style: {
      ...smallBtn("#888"),
      marginTop: 6
    }
  }, "Reset to default")), React.createElement("button", {
    onClick: () => setShowModels(!showModels),
    style: {
      marginTop: 6,
      marginLeft: 12,
      background: "transparent",
      border: "none",
      color: "#666",
      fontFamily: "inherit",
      fontSize: 11,
      cursor: "pointer",
      letterSpacing: 1,
      padding: 0,
      textDecoration: "underline",
      textUnderlineOffset: 3
    }
  }, showModels ? "Hide" : "Configure", " models"), apiKey && React.createElement("button", {
    onClick: () => {
      setShowKey(!showKey);
      setKeyStatus(null);
    },
    style: {
      marginTop: 6,
      marginLeft: 12,
      background: "transparent",
      border: "none",
      color: "#666",
      fontFamily: "inherit",
      fontSize: 11,
      cursor: "pointer",
      letterSpacing: 1,
      padding: 0,
      textDecoration: "underline",
      textUnderlineOffset: 3
    }
  }, "API key"), showModels && React.createElement("div", {
    style: {
      marginTop: 10,
      animation: "fadeIn 0.3s ease"
    }
  }, React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      flexWrap: "wrap"
    }
  }, [{
    label: "PRO Debater",
    seat: "pro",
    color: C.pro
  }, {
    label: "CON Debater",
    seat: "con",
    color: C.con
  }, {
    label: "Judge Panel",
    seat: "judge",
    color: "var(--accent)"
  }].map(cfg => {
    const value = picks[cfg.seat];
    const orphan = !value.startsWith("latest:") && !roster.some(m => m.id === value);
    return React.createElement("div", {
      key: cfg.seat,
      style: {
        flex: "1 1 150px",
        minWidth: 0
      }
    }, React.createElement("div", {
      style: {
        fontSize: 9,
        letterSpacing: 2,
        color: cfg.color,
        marginBottom: 4,
        textTransform: "uppercase"
      }
    }, cfg.label), React.createElement("select", {
      className: "crucible-select",
      "aria-label": `${cfg.label} model`,
      value: value,
      onChange: e => setPick(cfg.seat, e.target.value),
      style: selectStyle
    }, React.createElement("optgroup", {
      label: "Follows new releases"
    }, families.filter(f => f !== "other").map(f => React.createElement("option", {
      key: f,
      value: `latest:${f}`
    }, "Latest ", FAMILY_LABEL[f], " (now ", shortName(latestOf(roster, f)), ")"))), families.map(f => React.createElement("optgroup", {
      key: f,
      label: FAMILY_LABEL[f]
    }, roster.filter(m => m.family === f).map(m => React.createElement("option", {
      key: m.id,
      value: m.id
    }, m.name, isNew(m) ? "  · NEW" : "")))), orphan && React.createElement("option", {
      value: value
    }, value, " (not in the current list)")));
  })), React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      flexWrap: "wrap",
      alignItems: "flex-end",
      marginTop: 12
    }
  }, React.createElement("div", {
    style: {
      flex: "1 1 200px",
      minWidth: 0
    }
  }, React.createElement("div", {
    style: {
      fontSize: 9,
      letterSpacing: 2,
      color: "#888",
      marginBottom: 4,
      textTransform: "uppercase"
    }
  }, "Reasoning effort"), React.createElement("select", {
    className: "crucible-select",
    "aria-label": "Reasoning effort",
    value: effort,
    onChange: e => chooseEffort(e.target.value),
    style: selectStyle
  }, EFFORT_OPTIONS.map(o => React.createElement("option", {
    key: o.id,
    value: o.id
  }, o.label)))), React.createElement("div", {
    style: {
      flex: "2 1 240px",
      fontSize: 10.5,
      color: "#666",
      lineHeight: 1.6
    }
  }, "Applies to models that support it; others run as they are. Higher effort thinks longer and bills more output tokens.")), React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      flexWrap: "wrap",
      marginTop: 12,
      fontSize: 10.5,
      color: "#666",
      lineHeight: 1.6
    }
  }, React.createElement("span", null, rosterInfo.live ? `${roster.length} models, live from Anthropic's Models API, checked ${timeAgo(rosterInfo.fetchedAt)}.` : "Built-in starter list. Save an API key to load the live model list."), apiKey && React.createElement("button", {
    onClick: refreshRoster,
    disabled: rosterBusy,
    style: {
      ...smallBtn(C.judge),
      fontSize: 10
    }
  }, rosterBusy ? "Checking..." : "Check for new models")), rosterError && React.createElement("div", {
    style: {
      marginTop: 6,
      fontSize: 11,
      color: C.err,
      lineHeight: 1.6
    }
  }, "Couldn't refresh the model list: ", rosterError)), React.createElement("div", {
    style: {
      marginTop: 12,
      fontSize: 10.5,
      color: "#666",
      letterSpacing: 1,
      lineHeight: 1.6
    }
  }, React.createElement("span", {
    style: {
      color: C.pro
    }
  }, proLabel), " vs ", React.createElement("span", {
    style: {
      color: C.con
    }
  }, conLabel), " · judged by ", judgeLabel, effort !== "default" ? ` · ${effort} effort` : ""), React.createElement("button", {
    onClick: runDebate,
    disabled: !topic.trim() || !apiKey,
    style: {
      marginTop: 8,
      width: "100%",
      padding: "12px 0",
      background: topic.trim() && apiKey ? "var(--accent)" : "rgba(255,255,255,0.05)",
      color: topic.trim() && apiKey ? "#000" : "#555",
      border: "none",
      borderRadius: 6,
      fontFamily: "inherit",
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: 3,
      textTransform: "uppercase",
      cursor: topic.trim() && apiKey ? "pointer" : "default"
    }
  }, apiKey ? "Ignite Debate" : "Add an API key to begin"), history.length >= 2 && React.createElement("div", {
    style: {
      marginTop: 16
    }
  }, React.createElement("button", _extends({
    onClick: () => {
      if (showRecs && recommendations.length > 0) setShowRecs(false);else fetchRecommendations();
    },
    style: {
      background: "transparent",
      border: "1px solid rgba(255,165,0,0.2)",
      borderRadius: 6,
      color: C.warn,
      fontFamily: "inherit",
      fontSize: 12,
      padding: "10px 18px",
      cursor: "pointer",
      letterSpacing: 2,
      textTransform: "uppercase",
      width: "100%",
      transition: "all 0.2s",
      textAlign: "left",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, hoverBg({
    border: C.warn,
    background: "rgba(255,165,0,0.05)"
  }, {
    border: "rgba(255,165,0,0.2)",
    background: "transparent"
  })), React.createElement("span", null, "\uD83C\uDFAF ", recsLoading ? "Analyzing your debate history..." : showRecs ? "Hide Recommendations" : "Recommend Topics For You"), recsLoading && React.createElement("span", {
    style: {
      animation: "pulse 1s infinite"
    }
  }, "\u23F3")), showRecs && recommendations.length > 0 && !recsLoading && React.createElement("div", {
    style: {
      marginTop: 10,
      display: "flex",
      flexWrap: "wrap",
      gap: 6,
      animation: "fadeIn 0.3s ease"
    }
  }, recommendations.map((rec, i) => React.createElement("button", _extends({
    key: i,
    onClick: () => {
      setTopic(rec);
      setShowRecs(false);
    },
    style: {
      background: "rgba(255,165,0,0.06)",
      border: "1px solid rgba(255,165,0,0.2)",
      borderRadius: 20,
      color: "#ccc",
      fontFamily: "inherit",
      fontSize: 11,
      padding: "6px 14px",
      cursor: "pointer",
      transition: "all 0.2s",
      textAlign: "left",
      lineHeight: 1.4
    }
  }, hoverColor({
    border: C.warn,
    color: C.warn
  }, {
    border: "rgba(255,165,0,0.2)",
    color: "#ccc"
  })), rec)), React.createElement("button", {
    onClick: fetchRecommendations,
    style: {
      ...smallBtn(C.warn),
      fontSize: 10,
      borderRadius: 20,
      padding: "6px 14px"
    }
  }, recsLoading ? "..." : "🔄 Refresh"))), React.createElement("div", {
    style: {
      marginTop: 16
    }
  }, React.createElement("button", _extends({
    onClick: () => setShowFAQ(!showFAQ),
    style: {
      background: "transparent",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 6,
      color: "#888",
      fontFamily: "inherit",
      fontSize: 12,
      padding: "10px 18px",
      cursor: "pointer",
      letterSpacing: 2,
      textTransform: "uppercase",
      width: "100%",
      transition: "all 0.2s",
      textAlign: "left",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, hoverColor({
    border: "var(--accent)",
    color: "var(--accent)"
  }, {
    border: "rgba(255,255,255,0.08)",
    color: "#888"
  })), React.createElement("span", null, showFAQ ? "Hide" : "Browse", " Topic Library (", completedTopics > 0 ? `${completedTopics}/${totalTopics} completed` : `${totalTopics} debates`, ")"), React.createElement("span", {
    style: {
      fontSize: 14
    }
  }, showFAQ ? "▲" : "▼")), showFAQ && React.createElement("div", {
    style: {
      marginTop: 16,
      animation: "fadeIn 0.3s ease"
    }
  }, topicCategories.map(cat => React.createElement("div", {
    key: cat.label,
    style: {
      marginBottom: 18
    }
  }, React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: cat.color,
      letterSpacing: 2,
      marginBottom: 8
    }
  }, cat.label), React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 6
    }
  }, cat.topics.map(s => {
    const done = debatedTopics.has(s.toLowerCase().trim());
    const isSelected = selectedFAQ === s;
    const btnColor = done ? C.ok : cat.color;
    return React.createElement("div", {
      key: s,
      style: {
        position: "relative",
        display: "inline-block"
      }
    }, React.createElement("button", _extends({
      onClick: () => {
        if (done) setSelectedFAQ(isSelected ? null : s);else {
          setTopic(s);
          setShowFAQ(false);
          setSelectedFAQ(null);
        }
      },
      style: {
        background: done ? "rgba(46,204,113,0.1)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${done ? "#2ecc7155" : cat.color + "22"}`,
        borderRadius: 20,
        color: done ? C.ok : "#888",
        fontFamily: "inherit",
        fontSize: 11,
        padding: "5px 12px",
        cursor: "pointer",
        transition: "all 0.2s",
        textAlign: "left",
        lineHeight: 1.4
      }
    }, hoverColor({
      border: btnColor,
      color: btnColor
    }, {
      border: done ? "#2ecc7155" : `${cat.color}22`,
      color: done ? C.ok : "#888"
    })), done ? "✓ " : "", s), isSelected && React.createElement("div", {
      style: {
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 4,
        zIndex: 10,
        background: "#1a1a24",
        border: "1px solid rgba(46,204,113,0.3)",
        borderRadius: 6,
        padding: 8,
        display: "flex",
        gap: 6,
        animation: "fadeIn 0.2s ease",
        whiteSpace: "nowrap"
      }
    }, React.createElement("button", {
      onClick: () => {
        const entry = history.find(h => h.topic.toLowerCase().trim() === s.toLowerCase().trim());
        if (entry) setViewingSaved(entry);
        setSelectedFAQ(null);
        setShowFAQ(false);
      },
      style: {
        ...smallBtn(C.ok),
        fontSize: 10,
        padding: "5px 10px"
      }
    }, "View Saved"), React.createElement("button", {
      onClick: () => {
        setTopic(s);
        setShowFAQ(false);
        setSelectedFAQ(null);
      },
      style: {
        ...smallBtn(C.judge),
        fontSize: 10,
        padding: "5px 10px"
      }
    }, "Reignite")));
  })))))), !historyLoading && history.length > 0 && React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, React.createElement("button", _extends({
    onClick: () => setShowHistory(!showHistory),
    style: {
      background: "transparent",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 6,
      color: "#888",
      fontFamily: "inherit",
      fontSize: 12,
      padding: "10px 18px",
      cursor: "pointer",
      letterSpacing: 2,
      textTransform: "uppercase",
      width: "100%",
      transition: "all 0.2s",
      textAlign: "left",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, hoverColor({
    border: C.ok,
    color: C.ok
  }, {
    border: "rgba(255,255,255,0.08)",
    color: "#888"
  })), React.createElement("span", null, showHistory ? "Hide" : "View", " Debate History (", history.length, " past ", history.length === 1 ? "debate" : "debates", ")"), React.createElement("span", {
    style: {
      fontSize: 14
    }
  }, showHistory ? "▲" : "▼")), showHistory && React.createElement("div", {
    style: {
      marginTop: 12,
      animation: "fadeIn 0.3s ease"
    }
  }, history.map((h, idx) => {
    const isDraw = h.winner === "Draw";
    const winColor = isDraw ? C.judge : h.winner === "Pro" ? C.pro : C.con;
    return React.createElement("div", {
      key: idx,
      style: {
        marginBottom: 10,
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 14
      }
    }, React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 8
      }
    }, React.createElement("div", {
      style: {
        flex: 1
      }
    }, React.createElement("div", {
      style: {
        fontSize: 12,
        color: "#ccc",
        fontWeight: 700,
        marginBottom: 4
      }
    }, h.topic), React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#666",
        marginBottom: 8
      }
    }, new Date(h.date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    }), h.models && React.createElement(React.Fragment, null, " \xB7 ", React.createElement("span", {
      style: {
        color: C.pro
      }
    }, h.models.pro.replace(/^Claude\s+/, "")), " vs ", React.createElement("span", {
      style: {
        color: C.con
      }
    }, h.models.con.replace(/^Claude\s+/, ""))))), React.createElement("div", {
      style: {
        textAlign: "right",
        flexShrink: 0
      }
    }, React.createElement("span", {
      style: {
        fontSize: 10,
        fontWeight: 700,
        color: winColor,
        letterSpacing: 2,
        padding: "2px 8px",
        background: winColor + "15",
        border: `1px solid ${winColor}33`,
        borderRadius: 3
      }
    }, isDraw ? "DRAW" : `${h.winner.toUpperCase()} WINS`), React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#666",
        marginTop: 4
      }
    }, React.createElement("span", {
      style: {
        color: C.pro
      }
    }, h.proTotal), " \u2014 ", React.createElement("span", {
      style: {
        color: C.con
      }
    }, h.conTotal)))), h.pro_best && React.createElement("div", {
      style: {
        fontSize: 11,
        color: "#888",
        lineHeight: 1.5,
        marginBottom: 4
      }
    }, React.createElement("span", {
      style: {
        color: C.pro,
        fontSize: 9,
        letterSpacing: 1
      }
    }, "BEST PRO: "), h.pro_best.length > 150 ? h.pro_best.slice(0, 150) + "…" : h.pro_best), h.con_best && React.createElement("div", {
      style: {
        fontSize: 11,
        color: "#888",
        lineHeight: 1.5,
        marginBottom: 6
      }
    }, React.createElement("span", {
      style: {
        color: C.con,
        fontSize: 9,
        letterSpacing: 1
      }
    }, "BEST CON: "), h.con_best.length > 150 ? h.con_best.slice(0, 150) + "…" : h.con_best), React.createElement("div", {
      style: {
        display: "flex",
        gap: 8
      }
    }, React.createElement("button", {
      onClick: () => {
        setViewingSaved(h);
        setShowHistory(false);
      },
      style: {
        ...smallBtn(C.ok),
        fontSize: 10
      }
    }, "View"), React.createElement("button", {
      onClick: () => {
        setTopic(h.topic);
        setShowHistory(false);
      },
      style: {
        ...smallBtn("#888"),
        fontSize: 10
      }
    }, "Rematch"), React.createElement("button", {
      onClick: () => deleteHistoryEntry(idx),
      style: {
        ...smallBtn(C.err),
        fontSize: 10
      }
    }, "Delete")));
  }), React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 4
    }
  }, React.createElement("button", {
    onClick: async () => {
      const ok = await copyToClipboard(JSON.stringify(history, null, 2));
      if (ok) {
        setSummaryCopied(true);
        setTimeout(() => setSummaryCopied(false), 2000);
      }
    },
    style: {
      ...smallBtn(summaryCopied ? C.ok : C.judge),
      flex: 1,
      padding: "8px 0",
      textAlign: "center"
    }
  }, summaryCopied ? "✓ Copied to Clipboard" : "Export Summaries"), React.createElement("button", {
    onClick: clearAllHistory,
    style: {
      ...smallBtn(C.err),
      flex: 1,
      padding: "8px 0",
      textAlign: "center"
    }
  }, "Clear All History"))))), viewingSaved && phase === "idle" && React.createElement("div", {
    style: {
      maxWidth: 620,
      margin: "0 auto",
      animation: "fadeIn 0.5s ease"
    }
  }, React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: 11,
      letterSpacing: 5,
      color: C.ok,
      textTransform: "uppercase",
      marginBottom: 16
    }
  }, "Saved Debate"), React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: 14,
      color: "#ccc",
      fontWeight: 700,
      marginBottom: 6
    }
  }, viewingSaved.topic), React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: 10,
      color: "#666",
      marginBottom: 16
    }
  }, new Date(viewingSaved.date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric"
  }), viewingSaved.models && React.createElement("div", {
    style: {
      marginTop: 4,
      letterSpacing: 1
    }
  }, React.createElement("span", {
    style: {
      color: C.pro
    }
  }, "PRO: ", viewingSaved.models.pro), " vs ", React.createElement("span", {
    style: {
      color: C.con
    }
  }, "CON: ", viewingSaved.models.con), " · Judge: ", viewingSaved.models.judge)), React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      gap: 40,
      marginBottom: 20
    }
  }, React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 3,
      color: "#888",
      marginBottom: 2
    }
  }, "PRO"), React.createElement("div", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      color: C.pro
    }
  }, viewingSaved.proTotal)), React.createElement("div", {
    style: {
      textAlign: "center",
      alignSelf: "center"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#555"
    }
  }, "vs")), React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 3,
      color: "#888",
      marginBottom: 2
    }
  }, "CON"), React.createElement("div", {
    style: {
      fontSize: 28,
      fontWeight: 700,
      color: C.con
    }
  }, viewingSaved.conTotal))), React.createElement(VerdictBody, {
    verdict: viewingSaved,
    proTotal: viewingSaved.proTotal,
    conTotal: viewingSaved.conTotal,
    runningLabel: false
  }), React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 20
    }
  }, React.createElement("button", _extends({
    onClick: () => {
      setTopic(viewingSaved.topic);
      setViewingSaved(null);
    },
    style: {
      flex: 1,
      padding: "10px 0",
      background: "transparent",
      border: "1px solid rgba(201,162,39,0.3)",
      borderRadius: 6,
      color: C.judge,
      fontFamily: "inherit",
      fontSize: 12,
      letterSpacing: 3,
      textTransform: "uppercase",
      cursor: "pointer"
    }
  }, hoverBg({
    border: C.judge,
    background: "rgba(201,162,39,0.08)"
  }, {
    border: "rgba(201,162,39,0.3)",
    background: "transparent"
  })), "Reignite"), React.createElement("button", _extends({
    onClick: () => setViewingSaved(null),
    style: {
      flex: 1,
      padding: "10px 0",
      background: "transparent",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 6,
      color: "#888",
      fontFamily: "inherit",
      fontSize: 12,
      letterSpacing: 3,
      textTransform: "uppercase",
      cursor: "pointer"
    }
  }, hoverColor({
    border: "var(--accent)",
    color: "var(--accent)"
  }, {
    border: "rgba(255,255,255,0.1)",
    color: "#888"
  })), "Back"))), error && React.createElement("div", {
    style: {
      maxWidth: 560,
      margin: "20px auto",
      padding: 16,
      background: "rgba(232,64,64,0.1)",
      border: "1px solid rgba(232,64,64,0.3)",
      borderRadius: 6,
      color: C.err,
      fontSize: 13,
      animation: "shake 0.3s ease"
    }
  }, error, React.createElement("button", {
    onClick: reset,
    style: {
      display: "block",
      marginTop: 12,
      ...smallBtn(C.err)
    }
  }, "Reset")), rounds.map(rd => React.createElement("div", {
    key: rd.round,
    style: {
      maxWidth: 720,
      margin: "0 auto 28px",
      animation: "fadeIn 0.5s ease"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 4,
      color: "#555",
      textTransform: "uppercase",
      marginBottom: 12,
      textAlign: "center"
    }
  }, "Round ", rd.round, " of ", ROUNDS, rd.round === 1 ? " — Opening" : rd.round === ROUNDS ? " — Closing" : " — Rebuttal"), React.createElement("div", {
    className: "crucible-grid",
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12
    }
  }, React.createElement("div", {
    style: {
      background: "rgba(79,195,247,0.04)",
      border: "1px solid rgba(79,195,247,0.15)",
      borderRadius: 6,
      padding: 16
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      color: C.pro,
      letterSpacing: 2,
      marginBottom: 8
    }
  }, "PRO \u2014 ", rd.scores.pro_score, "/10"), rd.served?.pro && React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.warn,
      marginBottom: 6
    }
  }, "Answered by ", rd.served.pro, ": ", proLabel, " declined and the API fell back."), React.createElement(CitedText, {
    text: rd.pro,
    color: C.pro
  }), rd.cut?.pro && React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#777",
      marginTop: 6
    }
  }, "(cut off at the output limit)")), React.createElement("div", {
    style: {
      background: "rgba(239,83,80,0.04)",
      border: "1px solid rgba(239,83,80,0.15)",
      borderRadius: 6,
      padding: 16
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      color: C.con,
      letterSpacing: 2,
      marginBottom: 8
    }
  }, "CON \u2014 ", rd.scores.con_score, "/10"), rd.served?.con && React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.warn,
      marginBottom: 6
    }
  }, "Answered by ", rd.served.con, ": ", conLabel, " declined and the API fell back."), React.createElement(CitedText, {
    text: rd.con,
    color: C.con
  }), rd.cut?.con && React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#777",
      marginTop: 6
    }
  }, "(cut off at the output limit)"))), React.createElement("div", {
    style: {
      marginTop: 10,
      background: "rgba(255,255,255,0.02)",
      borderLeft: "2px solid var(--accent)",
      padding: "10px 16px"
    }
  }, rd.scores.judgeAnalyses ? rd.scores.judgeAnalyses.map((j, ji) => React.createElement("div", {
    key: ji,
    style: {
      marginBottom: ji < rd.scores.judgeAnalyses.length - 1 ? 10 : 0
    }
  }, React.createElement("div", {
    style: {
      fontSize: 9,
      letterSpacing: 2,
      color: "var(--accent)",
      marginBottom: 2,
      textTransform: "uppercase"
    }
  }, j.name), React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#999",
      fontStyle: "italic",
      lineHeight: 1.6
    }
  }, j.analysis))) : React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#999",
      fontStyle: "italic",
      lineHeight: 1.6
    }
  }, rd.scores.analysis), rd.scores.panel && React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 10,
      color: "#666",
      letterSpacing: 1,
      borderTop: "1px solid rgba(255,255,255,0.04)",
      paddingTop: 6
    }
  }, rd.scores.panel)), rd.interventions && rd.interventions.length > 0 && React.createElement("div", {
    style: {
      marginTop: 10,
      padding: "10px 14px",
      background: "rgba(255,165,0,0.04)",
      border: "1px solid rgba(255,165,0,0.15)",
      borderRadius: 6
    }
  }, React.createElement("div", {
    style: {
      fontSize: 9,
      letterSpacing: 2,
      color: C.warn,
      marginBottom: 8,
      fontWeight: 700
    }
  }, "\u26A1 AUDIENCE INTERVENTION"), rd.interventions.map((iv, ivi) => React.createElement("div", {
    key: ivi,
    style: {
      marginBottom: ivi < rd.interventions.length - 1 ? 10 : 0
    }
  }, React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#ccc",
      marginBottom: 6,
      fontStyle: "italic"
    }
  }, "\u201C", iv.userText, "\u201D"), iv.responses && iv.responses.map((resp, ri) => React.createElement("div", {
    key: ri,
    style: {
      marginBottom: 4,
      paddingLeft: 10,
      borderLeft: `2px solid ${resp.color}`
    }
  }, React.createElement("span", {
    style: {
      fontSize: 9,
      color: resp.color,
      fontWeight: 700,
      letterSpacing: 1
    }
  }, resp.label, ": "), React.createElement("span", {
    style: {
      fontSize: 11,
      color: "#999",
      lineHeight: 1.6
    }
  }, resp.text)))))))), phase === "debating" && Object.keys(live).length > 0 && React.createElement("div", {
    className: "crucible-grid",
    style: {
      maxWidth: 720,
      margin: "0 auto 16px",
      display: "grid",
      gridTemplateColumns: Object.keys(live).length > 1 ? "1fr 1fr" : "1fr",
      gap: 12,
      animation: "fadeIn 0.3s ease"
    }
  }, ["pro", "con"].filter(side => side in live).map(side => {
    const color = side === "pro" ? C.pro : C.con;
    const body = live[side].split("[Sources]")[0].trim();
    return React.createElement("div", {
      key: side,
      style: {
        background: "rgba(255,255,255,0.02)",
        border: `1px dashed ${color}44`,
        borderRadius: 6,
        padding: 14
      }
    }, React.createElement("div", {
      style: {
        fontSize: 9,
        fontWeight: 700,
        color,
        letterSpacing: 2,
        marginBottom: 6
      }
    }, side.toUpperCase(), " \xB7 ", side === "pro" ? proLabel : conLabel, React.createElement("span", {
      style: {
        color: "#666",
        fontWeight: 400,
        animation: "pulse 1.2s infinite",
        marginLeft: 6
      }
    }, body ? "speaking" : "thinking")), React.createElement("div", {
      style: {
        fontSize: 12,
        lineHeight: 1.7,
        color: "#8a8a90",
        whiteSpace: "pre-wrap"
      }
    }, body || "..."));
  })), atCheckpoint && phase === "debating" && React.createElement("div", {
    style: {
      maxWidth: 720,
      margin: "0 auto 20px",
      animation: "fadeIn 0.3s ease"
    }
  }, !paused ? React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, React.createElement("button", {
    onClick: continueToNextRound,
    style: {
      flex: 2,
      padding: "14px 0",
      background: "var(--accent)",
      color: "#000",
      border: "none",
      borderRadius: 6,
      fontFamily: "inherit",
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: 3,
      textTransform: "uppercase",
      cursor: "pointer"
    }
  }, "Continue to Round ", nextRoundNum), React.createElement("button", {
    onClick: requestPause,
    style: {
      flex: 1,
      padding: "14px 0",
      background: "rgba(255,165,0,0.08)",
      border: "1px solid rgba(255,165,0,0.3)",
      borderRadius: 6,
      color: C.warn,
      fontFamily: "inherit",
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 2,
      textTransform: "uppercase",
      cursor: "pointer",
      animation: "glowPulse 2s infinite"
    }
  }, "\u26A1 Intervene")) : React.createElement("div", {
    style: {
      background: "rgba(255,165,0,0.06)",
      border: "1px solid rgba(255,165,0,0.3)",
      borderRadius: 8,
      padding: 16
    }
  }, React.createElement("div", {
    style: {
      fontSize: 10,
      letterSpacing: 3,
      color: C.warn,
      marginBottom: 10,
      textTransform: "uppercase",
      fontWeight: 700
    }
  }, "\u26A1 LIVE INTERVENTION \u2014 Debate Paused Before Round ", nextRoundNum), React.createElement("textarea", {
    value: interventionText,
    onChange: e => setInterventionText(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitIntervention();
      }
    },
    placeholder: "Ask a question, present a fact, or make a counter-argument...",
    rows: 3,
    style: {
      ...inputStyle,
      borderColor: "rgba(255,165,0,0.3)"
    },
    disabled: interventionProcessing,
    autoFocus: true
  }), React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 10
    }
  }, React.createElement("button", {
    onClick: submitIntervention,
    disabled: !interventionText.trim() || interventionProcessing,
    style: {
      flex: 1,
      padding: "10px 0",
      background: interventionText.trim() && !interventionProcessing ? C.warn : "rgba(255,255,255,0.05)",
      color: interventionText.trim() && !interventionProcessing ? "#000" : "#555",
      border: "none",
      borderRadius: 6,
      fontFamily: "inherit",
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 2,
      textTransform: "uppercase",
      cursor: interventionText.trim() ? "pointer" : "default"
    }
  }, interventionProcessing ? "Both sides responding..." : "Submit Intervention"), React.createElement("button", {
    onClick: continueToNextRound,
    disabled: interventionProcessing,
    style: {
      padding: "10px 20px",
      background: "transparent",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: 6,
      color: "#888",
      fontFamily: "inherit",
      fontSize: 12,
      letterSpacing: 2,
      textTransform: "uppercase",
      cursor: "pointer"
    }
  }, "Continue to Round ", nextRoundNum)), interventionResponses.length > 0 && React.createElement("div", {
    style: {
      marginTop: 14,
      animation: "fadeIn 0.3s ease"
    }
  }, interventionResponses.map((resp, i) => React.createElement("div", {
    key: i,
    style: {
      marginBottom: 10,
      padding: "10px 14px",
      background: "rgba(255,255,255,0.02)",
      borderLeft: `2px solid ${resp.color}`,
      borderRadius: "0 6px 6px 0"
    }
  }, React.createElement("div", {
    style: {
      fontSize: 9,
      letterSpacing: 2,
      color: resp.color,
      marginBottom: 4,
      fontWeight: 700
    }
  }, resp.label), React.createElement("div", {
    style: {
      fontSize: 12,
      lineHeight: 1.7,
      color: "#b8b8bc",
      whiteSpace: "pre-wrap"
    }
  }, resp.text)))))), statusMsg && React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: 12,
      color: "var(--accent)",
      letterSpacing: 2,
      padding: "16px 0",
      animation: "pulse 1.5s infinite"
    }
  }, statusMsg), verdict && React.createElement("div", {
    style: {
      maxWidth: 620,
      margin: "12px auto 40px",
      padding: 24,
      background: "rgba(46,204,113,0.04)",
      border: "1px solid rgba(46,204,113,0.2)",
      borderRadius: 8,
      animation: "fadeIn 0.6s ease"
    }
  }, React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: 11,
      letterSpacing: 5,
      color: C.ok,
      textTransform: "uppercase",
      marginBottom: 16
    }
  }, "Final Verdict"), React.createElement(VerdictBody, {
    verdict: verdict,
    proTotal: proTotal,
    conTotal: conTotal,
    runningLabel: true
  }), usageLines().length > 0 && React.createElement("div", {
    style: {
      marginTop: 16,
      fontSize: 10.5,
      color: "#666",
      lineHeight: 1.7
    }
  }, React.createElement("div", {
    style: {
      letterSpacing: 2,
      color: "#555",
      marginBottom: 2
    }
  }, "TOKENS USED"), usageLines().map(l => React.createElement("div", {
    key: l
  }, l))), React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 20
    }
  }, React.createElement("button", {
    onClick: exportDebate,
    style: {
      flex: 1,
      padding: "10px 0",
      background: "transparent",
      border: "1px solid rgba(201,162,39,0.3)",
      borderRadius: 6,
      color: exportCopied ? C.ok : C.judge,
      fontFamily: "inherit",
      fontSize: 12,
      letterSpacing: 3,
      textTransform: "uppercase",
      cursor: "pointer",
      transition: "all 0.2s"
    },
    onMouseEnter: e => {
      if (!exportCopied) {
        e.currentTarget.style.borderColor = C.judge;
        e.currentTarget.style.background = "rgba(201,162,39,0.08)";
      }
    },
    onMouseLeave: e => {
      e.currentTarget.style.borderColor = "rgba(201,162,39,0.3)";
      e.currentTarget.style.background = "transparent";
    }
  }, exportCopied ? "✓ Copied to Clipboard" : "Export Transcript"), React.createElement("button", _extends({
    onClick: reset,
    style: {
      flex: 1,
      padding: "10px 0",
      background: "transparent",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 6,
      color: "#888",
      fontFamily: "inherit",
      fontSize: 12,
      letterSpacing: 3,
      textTransform: "uppercase",
      cursor: "pointer",
      transition: "all 0.2s"
    }
  }, hoverColor({
    border: "var(--accent)",
    color: "var(--accent)"
  }, {
    border: "rgba(255,255,255,0.1)",
    color: "#888"
  })), "New Debate")))));
}
class CrucibleBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null
    };
  }
  static getDerivedStateFromError(error) {
    return {
      error
    };
  }
  componentDidCatch(error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const font = "13px/1.7 'Courier New', Courier, monospace";
    return React.createElement("div", {
      role: "alert",
      style: {
        maxWidth: 560,
        margin: "60px auto",
        padding: 20,
        border: "1px solid rgba(232,64,64,0.3)",
        borderRadius: 6,
        background: "rgba(232,64,64,0.08)",
        color: "#ef5350",
        font
      }
    }, "The Crucible stopped with an error: " + (this.state.error && this.state.error.message || String(this.state.error)), React.createElement("div", null, React.createElement("button", {
      onClick: () => location.reload(),
      style: {
        marginTop: 12,
        background: "transparent",
        border: "1px solid #ef535044",
        color: "#ef5350",
        font,
        padding: "3px 10px",
        borderRadius: 4,
        cursor: "pointer"
      }
    }, "Reload")));
  }
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(CrucibleBoundary, null, React.createElement(Crucible)));
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
