/**
 * Comfort Card — découverte automatique
 * Regroupe température et humidité par pièce, sans configuration d'entités.
 */

const CARD_VERSION = "1.2.8";

console.info(
  `%c COMFORT-CARD %c v${CARD_VERSION} `,
  "color:#eef1f6;background:#2a2f3a;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#8fb0c9;background:#15181e;border-radius:0 3px 3px 0;padding:2px 6px"
);

/* ---------- Discovery engine ---------- */

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function areaOf(hass, entityId) {
  const ent = hass.entities?.[entityId];
  if (!ent) return null;
  if (ent.area_id) return ent.area_id;
  const dev = ent.device_id ? hass.devices?.[ent.device_id] : null;
  return dev?.area_id || null;
}

function areaName(hass, areaId) {
  return hass.areas?.[areaId]?.name || null;
}

function discover(hass, opts = {}) {
  const {
    domains = null,
    deviceClasses = null,
    exclude = [],
    include = [],
    areas = null,
    requireNumeric = false,
  } = opts;

  const exPat = exclude.map(norm).filter(Boolean);
  const areaFilter = areas ? areas.map(norm) : null;

  const out = [];
  Object.keys(hass.states).forEach((id) => {
    const st = hass.states[id];
    const forced = include.includes(id);

    if (!forced) {
      const domain = id.split(".")[0];
      if (domains && !domains.includes(domain)) return;
      const dc = st.attributes?.device_class;
      if (deviceClasses && !deviceClasses.includes(dc)) return;

      const reg = hass.entities?.[id];
      if (reg?.hidden || reg?.disabled_by) return;
      if (!includeDiagnostic && reg?.entity_category) return;

      const label = norm(`${id} ${st.attributes?.friendly_name || ""}`);
      if (exPat.some((p) => label.includes(p))) return;
      if (requireNumeric && Number.isNaN(Number(st.state))) return;
    }

    const areaId = areaOf(hass, id);
    if (areaFilter) {
      const an = norm(areaName(hass, areaId) || "");
      if (!areaFilter.includes(norm(areaId || "")) && !areaFilter.includes(an)) return;
    }

    const rawName = st.attributes?.friendly_name || id;
    const cleanName = rawName
      .replace(/\s*Electric\s*Consumption\s*\[W\]\s*/gi, "")
      .replace(/\s*Electric\s*power\s*consumption\s*/gi, "")
      .replace(/\s*Electric\s*Consumption\s*/gi, "")
      .replace(/\s*\[W\]\s*/g, "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .trim() || rawName;
    out.push({
      entity_id: id,
      state: st.state,
      value: Number(st.state),
      device_class: st.attributes?.device_class,
      name: cleanName,
      area_id: areaId,
      area: areaName(hass, areaId),
    });
  });
  return out;
}

/* ---------- Card ---------- */

const DEFAULT_EXCLUDE = [
  "cpu", "processeur", "batterie", "battery",
];

const fireEvent = (node, type, detail = {}) => {
  const ev = new Event(type, { bubbles: true, composed: true });
  ev.detail = detail;
  node.dispatchEvent(ev);
};

const SVG_HUM = `<path d="M12 3s6 6.4 6 10a6 6 0 1 1-12 0c0-3.6 6-10 6-10z"/>`;

class ComfortCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._els = {};
    this._sig = "";
  }

  setConfig(config) {
    this._config = {
      name: "Confort par pièce",
      exclude: ENERGY_DEFAULT_EXCLUDE,
      include: [],
      areas: null,
      show_unassigned: false,
      multiple: "average",
      max_rows: 0,
      humidity_low: 35,
      humidity_high: 60,
      humidity_very_high: 70,
      temp_low: 17,
      temp_high: 26,
      outdoor: null,
      sort: "discomfort",
      ...(config || {}),
    };
    this._built = false;
    this._sig = "";
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  static getStubConfig() { return { type: "custom:comfort-card" }; }

  static getConfigElement() {
    return document.createElement("comfort-card-editor");
  }

  getCardSize() { return 8; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  /* ---------- Discovery ---------- */

  _collect() {
    const c = this._config;
    const items = discover(this._hass, {
      domains: ["sensor"],
      deviceClasses: ["temperature", "humidity"],
      exclude: c.exclude,
      include: c.include,
      areas: c.areas,
      requireNumeric: true,
    });

    const rooms = new Map();
    items.forEach((it) => {
      const key = it.area_id || "__none__";
      if (key === "__none__" && !c.show_unassigned) return;
      if (!rooms.has(key))
        rooms.set(key, { key, name: it.area || "Sans pièce", temps: [], hums: [] });
      const r = rooms.get(key);
      if (it.device_class === "temperature") r.temps.push(it);
      else r.hums.push(it);
    });

    const pick = (arr) => {
      if (!arr.length) return { value: null, entity: null, count: 0 };
      if (c.multiple === "first" || arr.length === 1)
        return { value: arr[0].value, entity: arr[0].entity_id, count: arr.length };
      const avg = arr.reduce((a, b) => a + b.value, 0) / arr.length;
      return { value: avg, entity: arr[0].entity_id, count: arr.length };
    };

    const rows = [...rooms.values()].map((r) => {
      const t = pick(r.temps);
      const h = pick(r.hums);
      const verdict = this._verdict(t.value, h.value);
      return { ...r, t, h, ...verdict };
    });

    const sorters = {
      discomfort: (a, b) => b.score - a.score || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      temperature: (a, b) => (b.t.value ?? -99) - (a.t.value ?? -99),
      humidity: (a, b) => (b.h.value ?? -99) - (a.h.value ?? -99),
    };
    rows.sort(sorters[c.sort] || sorters.discomfort);
    return rows;
  }

  _verdict(t, h) {
    const c = this._config;
    let score = 0;
    let label = "Confort";
    let level = "ok";

    if (h != null) {
      if (h >= c.humidity_very_high) { score += 3; label = "Trop humide"; level = "warn"; }
      else if (h >= c.humidity_high) { score += 2; label = "Humide"; level = "warn"; }
      else if (h <= c.humidity_low - 15) { score += 2; label = "Sec"; level = "warn"; }
      else if (h <= c.humidity_low) { score += 1; label = "Un peu sec"; level = "warn"; }
    }
    if (t != null) {
      if (t >= c.temp_high + 4) { score += 3; label = "Trop chaud"; level = "warn"; }
      else if (t >= c.temp_high) { score += 1; if (level === "ok") label = "Chaud"; }
      else if (t <= c.temp_low - 3) { score += 3; label = "Trop froid"; level = "warn"; }
      else if (t <= c.temp_low) { score += 1; if (level === "ok") label = "Frais"; }
    }
    if (t == null && h == null) label = "—";
    return { score, label, level };
  }

  _outdoor() {
    const c = this._config;
    const hass = this._hass;
    if (c.outdoor) {
      const s = hass.states[c.outdoor];
      if (s) {
        const v = Number(s.attributes?.temperature ?? s.state);
        return Number.isNaN(v) ? null : v;
      }
    }
    const w = Object.keys(hass.states).find((id) => id.startsWith("weather."));
    if (w) {
      const v = Number(hass.states[w].attributes?.temperature);
      if (!Number.isNaN(v)) return v;
    }
    return null;
  }

  /* ---------- Render ---------- */

  _build() {
    this.shadowRoot.innerHTML = `<style>
      :host {
        --cf-warn: #ffc76b;
        --cf-ok: #8fbfae;
        --cf-bg: var(--card-background-color, #1a1d24);
        --cf-text: var(--primary-text-color, #eef1f6);
        --cf-border: var(--divider-color, rgba(255,255,255,.06));
        --cf-sub: rgba(255,255,255,.42);
        --cf-font: var(--primary-font-family, "Inter", "Segoe UI", Roboto, sans-serif);
        display: block;
      }
      * { box-sizing: border-box; }
      .hidden { display: none !important; }

      ha-card {
        border-radius: var(--ha-card-border-radius, 18px);
        padding: 16px 16px 14px;
        background: linear-gradient(170deg, #1a1d24 0%, #15181e 60%, #111318 100%);
        border: 1px solid var(--cf-border);
        color: var(--cf-text);
        font-family: var(--cf-font);
      }

      /* Header */
      .ch { display: flex; align-items: center; gap: 11px; }
      .ci {
        width: 34px; height: 34px; border-radius: 11px; flex-shrink: 0;
        background: rgba(143,176,201,.10);
        border: 1px solid rgba(143,176,201,.24);
        display: flex; align-items: center; justify-content: center;
      }
      .ci svg { width: 17px; height: 17px; fill: #8fb0c9; }
      .ct { flex: 1; min-width: 0; }
      .ct b { display: block; font-size: 14px; font-weight: 600; }
      .ct .sub { display: block; font-size: 10.5px; color: var(--cf-sub); margin-top: 2px; }

      .cc {
        font-size: 11px; font-weight: 700; border-radius: 9px; padding: 5px 9px;
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.1);
        color: rgba(255,255,255,.6);
      }
      .cc.warn {
        background: rgba(255,199,107,.12);
        border-color: rgba(255,199,107,.3);
        color: var(--cf-warn);
      }
      .cc.ok {
        background: rgba(143,191,174,.12);
        border-color: rgba(143,191,174,.3);
        color: var(--cf-ok);
      }

      /* KPI */
      .kpi3 { display: grid; grid-template-columns: repeat(3,1fr); gap: 6px; margin-top: 15px; }
      .kc {
        background: rgba(255,255,255,.04);
        border: 1px solid rgba(255,255,255,.075);
        border-radius: 11px; padding: 9px 6px; text-align: center;
      }
      .kc span {
        display: block; font-size: 7.5px; letter-spacing: .8px;
        text-transform: uppercase; color: rgba(255,255,255,.38); font-weight: 600;
      }
      .kc b {
        display: block; font-size: 14px; font-weight: 600; margin-top: 5px;
        font-variant-numeric: tabular-nums;
      }

      /* Table header */
      .rhd {
        display: flex; gap: 8px; margin: 15px 0 4px;
        font-size: 8px; letter-spacing: 1px; text-transform: uppercase;
        color: rgba(255,255,255,.3); font-weight: 600;
      }
      .rhd span:nth-child(1) { flex: 1; }
      .rhd span:nth-child(2) { width: 48px; text-align: right; }
      .rhd span:nth-child(3) { width: 46px; text-align: right; }
      .rhd span:nth-child(4) { width: 78px; text-align: right; }

      /* Rows */
      .rr {
        display: flex; align-items: center; gap: 8px; padding: 9px 0;
        cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.05);
      }
      .rr:last-child { border-bottom: none; }
      .rr:hover { background: rgba(255,255,255,.02); }

      .rn {
        flex: 1; font-size: 12px; color: rgba(255,255,255,.75); min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .rn i { font-style: normal; font-size: 8.5px; color: rgba(255,255,255,.28); margin-left: 6px; }

      .rt, .rh {
        font-size: 12.5px; font-weight: 600; text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .rt { width: 48px; }
      .rh { width: 46px; color: #8fb0c9; }

      .rl { width: 78px; text-align: right; font-size: 9.5px; color: rgba(255,255,255,.32); }
      .rr.warn .rl, .rr.warn .rh { color: var(--cf-warn); }

      .cf {
        margin-top: 13px; padding-top: 11px;
        border-top: 1px solid rgba(255,255,255,.07);
        font-size: 9.5px; color: rgba(255,255,255,.34); line-height: 1.5;
      }
    </style>
    <ha-card>
      <div class="ch">
        <div class="ci"><svg viewBox="0 0 24 24">${SVG_HUM}</svg></div>
        <div class="ct"><b>${this._config.name}</b><span class="sub">—</span></div>
        <div class="cc hidden">—</div>
      </div>
      <div class="kpi3"></div>
      <div class="rhd"><span>Pièce</span><span>Temp.</span><span>Hum.</span><span>État</span></div>
      <div class="rrs"></div>
      <div class="cf hidden"></div>
    </ha-card>`;
    this._built = true;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._els = {
      sub: $(".ct .sub"),
      badge: $(".cc"),
      kpi: $(".kpi3"),
      rows: $(".rrs"),
      foot: $(".cf"),
    };
  }

  _fmt(v, dec = 1) {
    if (v == null || Number.isNaN(v)) return "—";
    return new Intl.NumberFormat(this._hass?.locale?.language || "fr", {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    }).format(v);
  }

  _update() {
    const c = this._config;
    const e = this._els;
    if (!this._hass || !this._built) return;

    const rows = this._collect();
    const warn = rows.filter((r) => r.level === "warn").length;

    const sig = rows
      .map((r) => `${r.key}:${r.t.value?.toFixed(1)}:${r.h.value?.toFixed(0)}`)
      .join("|");

    e.sub.textContent = `${rows.length} pièce${rows.length > 1 ? "s" : ""}${
      warn ? ` · ${warn} à surveiller` : " · tout va bien"
    }`;
    e.badge.textContent = warn || "OK";
    e.badge.className = `cc ${warn ? "warn" : "ok"}`;
    e.badge.classList.remove("hidden");

    const temps = rows.filter((r) => r.t.value != null).map((r) => r.t.value);
    const hums = rows.filter((r) => r.h.value != null).map((r) => r.h.value);
    const avgT = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    const avgH = hums.length ? hums.reduce((a, b) => a + b, 0) / hums.length : null;
    const out = this._outdoor();

    e.kpi.innerHTML = `
      <div class="kc"><span>Intérieur moy.</span><b>${this._fmt(avgT, 1)} °C</b></div>
      <div class="kc"><span>Humidité moy.</span><b>${this._fmt(avgH, 0)} %</b></div>
      <div class="kc"><span>Extérieur</span><b>${this._fmt(out, 1)} °C</b></div>`;

    if (sig !== this._sig) {
      this._sig = sig;
      const shown = c.max_rows ? rows.slice(0, c.max_rows) : rows;
      e.rows.innerHTML = shown
        .map(
          (r) => `<div class="rr ${r.level}" data-e="${r.t.entity || r.h.entity || ""}">
            <span class="rn">${r.name}${
            r.t.count > 1 || r.h.count > 1 ? `<i>moy. ${Math.max(r.t.count, r.h.count)}</i>` : ""
          }</span>
            <span class="rt">${r.t.value != null ? `${this._fmt(r.t.value, 1)}°` : "—"}</span>
            <span class="rh">${r.h.value != null ? `${this._fmt(r.h.value, 0)} %` : "—"}</span>
            <span class="rl">${r.label}</span></div>`
        )
        .join("");
      e.rows.querySelectorAll(".rr").forEach((el) => {
        if (el.dataset.e)
          el.addEventListener("click", () =>
            fireEvent(this, "hass-more-info", { entityId: el.dataset.e })
          );
      });
      if (c.max_rows && rows.length > c.max_rows) {
        e.foot.textContent = `${rows.length - c.max_rows} autres pièces masquées`;
        e.foot.classList.remove("hidden");
      } else if (!rows.length) {
        e.foot.textContent =
          "Aucun capteur trouvé. Vérifiez que vos capteurs ont une device_class et sont affectés à une pièce.";
        e.foot.classList.remove("hidden");
      } else e.foot.classList.add("hidden");
    }
  }
}

if (!customElements.get("comfort-card")) {
  customElements.define("comfort-card", ComfortCard);
}

/* ---------- Visual editor ---------- */

class ComfortCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._sections = { discover: true, thresholds: false, display: false };
  }

  setConfig(config) {
    this._config = {
      name: "Confort par pièce",
      exclude: [],
      include: [],
      areas: null,
      show_unassigned: false,
      multiple: "average",
      max_rows: 0,
      humidity_low: 35,
      humidity_high: 60,
      humidity_very_high: 70,
      temp_low: 17,
      temp_high: 26,
      outdoor: null,
      sort: "discomfort",
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  _changed(ev) {
    const field = ev.target.dataset.field;
    if (!field) return;
    let value = ev.target.value;

    if (ev.target.type === "number") value = value === "" ? 0 : Number(value);
    else if (ev.target.type === "checkbox") value = ev.target.checked;
    else if (["exclude", "include", "areas"].includes(field)) {
      value = value.split(",").map((s) => s.trim()).filter(Boolean);
    }

    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _toggle(name) {
    this._sections[name] = !this._sections[name];
    const el = this.shadowRoot.querySelector(`[data-section="${name}"]`);
    if (el) {
      el.classList.toggle("open", this._sections[name]);
      const chev = el.querySelector(".chev");
      if (chev) chev.textContent = this._sections[name] ? "▾" : "▸";
    }
  }

  _field(label, field, type, value, placeholder) {
    const v = value ?? (type === "number" ? 0 : "");
    return `<div class="fld">
      <label>${label}</label>
      <input type="${type}" data-field="${field}" value="${v}" placeholder="${placeholder || ""}"/>
    </div>`;
  }

  _select(label, field, options, value) {
    const opts = options.map((o) =>
      `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${o.label}</option>`
    ).join("");
    return `<div class="fld">
      <label>${label}</label>
      <select data-field="${field}">${opts}</select>
    </div>`;
  }

  _checkbox(label, field, checked) {
    return `<div class="fld chk">
      <label><input type="checkbox" data-field="${field}" ${checked ? "checked" : ""}/> ${label}</label>
    </div>`;
  }

  _textarea(label, field, value, placeholder) {
    const v = Array.isArray(value) ? value.join(", ") : value || "";
    return `<div class="fld">
      <label>${label}</label>
      <textarea data-field="${field}" placeholder="${placeholder || ""}">${v}</textarea>
    </div>`;
  }

  _section(name, label, content) {
    const open = this._sections[name] || false;
    return `<div class="sec ${open ? "open" : ""}" data-section="${name}">
      <div class="sh" data-toggle="${name}">
        <span>${label}</span>
        <span class="chev">${open ? "▾" : "▸"}</span>
      </div>
      <div class="sb">${content}</div>
    </div>`;
  }

  _render() {
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>
      :host { display: block; }
      * { box-sizing: border-box; }
      .ed { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
      .fld { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
      .fld label { font-size: 11px; font-weight: 600; opacity: .7; }
      .fld input, .fld select, .fld textarea {
        font-size: 13px; padding: 8px 10px; border-radius: 8px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--secondary-background-color, #fff);
        color: var(--primary-text-color);
        font-family: inherit;
      }
      .fld textarea { min-height: 50px; resize: vertical; }
      .fld.chk label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .fld.chk input { width: auto; }
      .sec { border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px; overflow: hidden; }
      .sh {
        display: flex; align-items: center; padding: 10px 12px; cursor: pointer;
        background: var(--secondary-background-color, #f5f5f5);
        font-size: 13px; font-weight: 600;
      }
      .sh .chev { margin-left: auto; font-size: 12px; opacity: .5; }
      .sb { padding: 10px 12px; display: none; }
      .sec.open .sb { display: block; }
    </style>
    <div class="ed">
      ${this._field("Titre", "name", "text", c.name, "Confort par pièce")}

      ${this._section("discover", "Découverte",
        this._textarea("Exclure (mots-clés, virgules)", "exclude", c.exclude, "ballon, weather, cpu") +
        this._textarea("Inclure (entity_id, virgules)", "include", c.include, "sensor.mon_capteur") +
        this._textarea("Pièces (restreindre)", "areas", c.areas, "salon, cuisine") +
        this._checkbox("Afficher capteurs sans pièce", "show_unassigned", c.show_unassigned) +
        this._select("Plusieurs capteurs par pièce", "multiple", [
          { value: "average", label: "Moyenne" },
          { value: "first", label: "Premier trouvé" },
        ], c.multiple)
      )}

      ${this._section("thresholds", "Seuils de confort",
        this._field("Température basse (°C)", "temp_low", "number", c.temp_low) +
        this._field("Température haute (°C)", "temp_high", "number", c.temp_high) +
        this._field("Humidité basse (%)", "humidity_low", "number", c.humidity_low) +
        this._field("Humidité haute (%)", "humidity_high", "number", c.humidity_high) +
        this._field("Humidité très haute (%)", "humidity_very_high", "number", c.humidity_very_high)
      )}

      ${this._section("display", "Affichage",
        this._field("Lignes max (0 = illimité)", "max_rows", "number", c.max_rows) +
        this._select("Tri", "sort", [
          { value: "discomfort", label: "Inconfort (défaut)" },
          { value: "name", label: "Nom de pièce" },
          { value: "temperature", label: "Température" },
          { value: "humidity", label: "Humidité" },
        ], c.sort) +
        this._field("Entité extérieur (auto si vide)", "outdoor", "text", c.outdoor, "weather.maison")
      )}
    </div>`;

    this.shadowRoot.querySelectorAll("input, select, textarea").forEach((el) => {
      el.addEventListener("change", (e) => this._changed(e));
      el.addEventListener("input", (e) => this._changed(e));
    });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => this._toggle(el.dataset.toggle));
    });
  }
}

if (!customElements.get("comfort-card-editor")) {
  customElements.define("comfort-card-editor", ComfortCardEditor);
}

window.haAutoCards = window.haAutoCards || {};
window.haAutoCards.discover = discover;
window.haAutoCards.areaOf = areaOf;

window.customCards = window.customCards || [];
window.customCards.push({
  type: "comfort-card",
  name: "Comfort Card (auto)",
  description:
    "Température et humidité regroupées par pièce, avec découverte automatique des entités.",
  preview: false,
  documentationURL: "https://github.com/junkoku38/ha-auto-cards",
});/**
 * Energy Card — découverte automatique
 * Toutes les prises mesurées, triées par consommation, avec repli du secondaire.
 * Réutilise le moteur de découverte de la série HA Auto Cards.
 */

const ENERGY_CARD_VERSION = "1.0.0";

console.info(
  `%c ENERGY-CARD %c v${ENERGY_CARD_VERSION} `,
  "color:#15181e;background:#c9bd8f;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#c9bd8f;background:#15181e;border-radius:0 3px 3px 0;padding:2px 6px"
);

/* ---------- Discovery engine (shared) ---------- */

const ENERGY_DEFAULT_EXCLUDE = [
  "consumption",
  "total", "somme", "cumul", "daily", "journalier",
  "yesterday", "hier", "monthly", "mensuel",
];

/* ---------- Card ---------- */

const ENERGY_I = {
  bolt: `<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>`,
  caret: `<path d="M7 10l5 5 5-5z"/>`,
};

class EnergyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._els = {};
    this._sig = "";
    this._openRest = false;
  }

  setConfig(config) {
    this._config = {
      name: "Consommation",
      exclude: ENERGY_DEFAULT_EXCLUDE,
      include: [],
      areas: null,
      include_diagnostic: false,
      top: 5,
      standby_threshold: 5,
      min_display: 0.5,
      price: 0.25,
      price_entity: "sensor.tarif_actuel_tempo_6kva_ttc",
      currency: "€",
      energy_total: null,
      group: "none",
      show_rest: true,
      ...(config || {}),
    };
    this._built = false;
    this._sig = "";
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  static getStubConfig() { return { type: "custom:energy-card" }; }

  static getConfigElement() {
    return document.createElement("energy-card-editor");
  }

  getCardSize() { return 8; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  /* ---------- Discovery ---------- */

  _collect() {
    const c = this._config;
    const items = discover(this._hass, {
      domains: ["sensor"],
      deviceClasses: ["power"],
      units: ["W", "kW"],
      includeDiagnostic: c.include_diagnostic,
      exclude: c.exclude,
      include: c.include,
      areas: c.areas,
      requireNumeric: true,
    });
    return items
      .map((it) => ({
        ...it,
        watts: it.unit === "kW" ? it.value * 1000 : it.value,
      }))
      .filter((it) => !Number.isNaN(it.watts) && it.watts >= 0)
      .sort((a, b) => b.watts - a.watts);
  }

  _price() {
    const c = this._config;
    if (c.price_entity) {
      const s = this._hass.states[c.price_entity];
      const v = Number(s?.state);
      if (!Number.isNaN(v)) return v;
    }
    return Number(c.price) || 0;
  }

  _energyTotal() {
    const c = this._config;
    if (c.energy_total) {
      const s = this._hass.states[c.energy_total];
      const v = Number(s?.state);
      if (!Number.isNaN(v)) return { value: v, unit: s.attributes?.unit_of_measurement || "kWh" };
    }
    const cands = discover(this._hass, {
      domains: ["sensor"],
      deviceClasses: ["energy"],
      includeDiagnostic: true,
      requireNumeric: true,
      exclude: [],
    }).filter((e) => /total|general|maison|global|compteur/.test(norm(e.name)));
    if (cands.length) return { value: cands[0].value, unit: cands[0].unit || "kWh" };
    return null;
  }

  /* ---------- Render ---------- */

  _build() {
    this.shadowRoot.innerHTML = `<style>${EnergyCard.styles}</style>
      <ha-card>
        <div class="ch">
          <div class="ci"><svg viewBox="0 0 24 24">${ENERGY_I.bolt}</svg></div>
          <div class="ct"><b>${this._config.name}</b><span class="sub">—</span></div>
        </div>
        <div class="ehero">
          <div class="ev2">—<span>W</span></div>
          <div class="es"><div class="es1">—</div><div class="es2">—</div></div>
        </div>
        <div class="sec">—</div>
        <div class="ebs"></div>
        <details class="acc hidden">
          <summary class="accs"><span class="k">—</span>
            <span class="accv"><span class="rt">—</span>
              <svg class="car" viewBox="0 0 24 24">${ENERGY_I.caret}</svg></span></summary>
          <div class="accb"></div>
        </details>
        <div class="cf"></div>
      </ha-card>`;
    this._built = true;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._els = {
      sub: $(".ct .sub"),
      total: $(".ev2"),
      cost: $(".es1"),
      index: $(".es2"),
      sec: $(".sec"),
      bars: $(".ebs"),
      acc: $(".acc"),
      accLabel: $(".accs .k"),
      accTotal: $(".accs .rt"),
      accBody: $(".accb"),
      foot: $(".cf"),
    };
    this._els.acc.addEventListener("toggle", () => {
      this._openRest = this._els.acc.open;
    });
  }

  _fmt(v, dec) {
    if (v == null || Number.isNaN(v)) return "—";
    const d = dec !== undefined ? dec : Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    return new Intl.NumberFormat(this._hass?.locale?.language || "fr", {
      minimumFractionDigits: 0,
      maximumFractionDigits: d,
    }).format(v);
  }

  _bar(it, hi) {
    const pct = hi ? Math.max(1, (it.watts / hi) * 100) : 0;
    const label = it.area ? `${it.name} · ${it.area}` : it.name;
    return `<div class="eb" data-e="${it.entity_id}">
      <span class="en" title="${label}">${it.name}</span>
      <span class="ebb"><i style="width:${pct.toFixed(0)}%"></i></span>
      <span class="ev">${this._fmt(it.watts, it.watts >= 100 ? 0 : 1)}<small>W</small></span>
    </div>`;
  }

  _update() {
    const c = this._config;
    const e = this._els;
    if (!this._hass || !this._built) return;

    const items = this._collect();
    const total = items.reduce((a, b) => a + b.watts, 0);
    const price = this._price();
    const idx = this._energyTotal();

    const active = items.filter((i) => i.watts >= c.min_display);
    const standby = items.filter((i) => i.watts > 0 && i.watts < c.standby_threshold);
    const off = items.filter((i) => i.watts === 0);

    const top = active.slice(0, c.top);
    const rest = active.slice(c.top);
    const restSum = rest.reduce((a, b) => a + b.watts, 0);
    const topShare = total ? ((total - restSum) / total) * 100 : 0;

    e.sub.textContent = `${items.length} prise${items.length > 1 ? "s" : ""} mesurée${
      items.length > 1 ? "s" : ""
    }`;
    e.total.innerHTML = `${this._fmt(total, 0)}<span>W</span>`;
    e.cost.textContent = price
      ? `≈ ${this._fmt((total / 1000) * price, 2)} ${c.currency}/h`
      : "";
    e.index.textContent = idx ? `index ${this._fmt(idx.value, 1)} ${idx.unit}` : "";

    e.sec.textContent = top.length
      ? `${top.length} plus gros postes · ${Math.round(topShare)} % du total`
      : "Aucune consommation mesurée";

    const sig = items.map((i) => `${i.entity_id}:${i.watts.toFixed(1)}`).join("|");
    if (sig === this._sig) return;
    this._sig = sig;

    const hi = top.length ? top[0].watts : 1;
    e.bars.innerHTML = top.map((it) => this._bar(it, hi)).join("");

    if (c.show_rest && rest.length) {
      e.acc.classList.remove("hidden");
      e.accLabel.textContent = `${rest.length} autre${rest.length > 1 ? "s" : ""} prise${
        rest.length > 1 ? "s" : ""
      }`;
      e.accTotal.textContent = `${this._fmt(restSum, 0)} W`;
      e.accBody.innerHTML = rest.map((it) => this._bar(it, hi)).join("");
      e.acc.open = this._openRest;
    } else e.acc.classList.add("hidden");

    this.shadowRoot.querySelectorAll(".eb").forEach((el) =>
      el.addEventListener("click", () =>
        fireEvent(this, "hass-more-info", { entityId: el.dataset.e })
      )
    );

    const bits = [];
    if (standby.length)
      bits.push(
        `${standby.length} en veille · ${this._fmt(
          standby.reduce((a, b) => a + b.watts, 0),
          0
        )} W`
      );
    if (off.length) bits.push(`${off.length} à l'arrêt`);
    e.foot.textContent = bits.join(" · ");
    e.foot.style.display = bits.length ? "" : "none";
  }
}

/* ---------- Styles ---------- */

EnergyCard.styles = `
:host{--en-accent:#c9bd8f;display:block;}
*{box-sizing:border-box;}
.hidden{display:none !important;}
ha-card{
  border-radius:var(--ha-card-border-radius,18px);padding:16px 16px 14px;
  background:linear-gradient(170deg,#1a1d24 0%,#15181e 60%,#111318 100%);
  border:1px solid rgba(255,255,255,.06);color:#eef1f6;
  font-family:var(--primary-font-family,"Inter","Segoe UI",Roboto,sans-serif);
}
.ch{display:flex;align-items:center;gap:11px;}
.ci{width:34px;height:34px;border-radius:11px;flex-shrink:0;
  background:rgba(201,189,143,.10);border:1px solid rgba(201,189,143,.26);
  display:flex;align-items:center;justify-content:center;}
.ci svg{width:17px;height:17px;fill:var(--en-accent);}
.ct{flex:1;min-width:0;}
.ct b{display:block;font-size:14px;font-weight:600;}
.ct .sub{display:block;font-size:10.5px;color:rgba(255,255,255,.42);margin-top:2px;}

.ehero{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:16px;}
.ev2{font-size:40px;font-weight:200;letter-spacing:-2.2px;line-height:1;
  font-variant-numeric:tabular-nums;}
.ev2 span{font-size:15px;font-weight:300;color:rgba(255,255,255,.42);margin-left:3px;
  letter-spacing:0;}
.es{text-align:right;padding-bottom:3px;}
.es1{font-size:12px;font-weight:600;color:var(--en-accent);font-variant-numeric:tabular-nums;}
.es2{font-size:10px;color:rgba(255,255,255,.36);margin-top:3px;font-variant-numeric:tabular-nums;}

.sec{font-size:8.5px;letter-spacing:1.6px;text-transform:uppercase;
  color:rgba(255,255,255,.34);font-weight:600;margin:17px 0 8px;}
.ebs{display:flex;flex-direction:column;gap:1px;}
.eb{display:flex;align-items:center;gap:9px;padding:5px 0;cursor:pointer;}
.eb:hover .en{color:#eef1f6;}
.en{font-size:11px;color:rgba(255,255,255,.6);width:146px;flex-shrink:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:.15s;}
.ebb{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden;}
.ebb i{display:block;height:100%;border-radius:3px;background:var(--en-accent);
  opacity:.8;transition:width .4s;}
.ev{font-size:11.5px;font-weight:600;width:58px;text-align:right;
  font-variant-numeric:tabular-nums;}
.ev small{font-size:8.5px;font-weight:400;color:rgba(255,255,255,.4);margin-left:2px;}

.acc{margin-top:12px;border-radius:12px;background:rgba(255,255,255,.035);
  border:1px solid rgba(255,255,255,.07);padding:0 12px;transition:.2s;}
.acc[open]{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.11);}
.accs{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:11px 0;cursor:pointer;list-style:none;}
.accs::-webkit-details-marker{display:none;}
.k{font-size:9px;letter-spacing:1.8px;text-transform:uppercase;
  color:rgba(255,255,255,.42);font-weight:600;}
.accv{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;
  color:rgba(255,255,255,.5);font-variant-numeric:tabular-nums;}
.car{width:11px;height:11px;fill:rgba(255,255,255,.35);transition:transform .2s;}
.acc[open] .car{transform:rotate(180deg);}
.accb{padding:2px 0 10px;}

.cf{margin-top:13px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07);
  font-size:9.5px;color:rgba(255,255,255,.34);font-variant-numeric:tabular-nums;}
`;

/* ---------- Registration ---------- */

if (!customElements.get("energy-card")) {
  customElements.define("energy-card", EnergyCard);
}

window.haAutoCards = window.haAutoCards || {};
if (!window.haAutoCards.discover) {
  window.haAutoCards.discover = discoverLocal;
  window.haAutoCards.areaOf = areaOf;
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "energy-card",
  name: "Energy Card (auto)",
  description:
    "Toutes les prises mesurées découvertes automatiquement, triées, avec repli du secondaire.",
  preview: false,
  documentationURL: "https://github.com/junkoku38/ha-auto-cards",
});

/* ---------- Visual editor ---------- */

class EnergyCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._sections = { discover: true, display: false, cost: false };
  }

  setConfig(config) {
    this._config = {
      name: "Consommation",
      exclude: [],
      include: [],
      areas: null,
      include_diagnostic: false,
      top: 5,
      standby_threshold: 5,
      min_display: 0.5,
      price: 0.25,
      price_entity: "sensor.tarif_actuel_tempo_6kva_ttc",
      currency: "€",
      energy_total: null,
      show_rest: true,
      ...config,
    };
    this._render();
  }

  set hass(hass) { this._hass = hass; }

  _changed(ev) {
    const field = ev.target.dataset.field;
    if (!field) return;
    let value = ev.target.value;
    if (ev.target.type === "number") value = value === "" ? 0 : Number(value);
    else if (ev.target.type === "checkbox") value = ev.target.checked;
    else if (["exclude", "include", "areas"].includes(field)) {
      value = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }

  _toggle(name) {
    this._sections[name] = !this._sections[name];
    const el = this.shadowRoot.querySelector(`[data-section="${name}"]`);
    if (el) {
      el.classList.toggle("open", this._sections[name]);
      const chev = el.querySelector(".chev");
      if (chev) chev.textContent = this._sections[name] ? "▾" : "▸";
    }
  }

  _field(label, field, type, value, placeholder) {
    const v = value ?? (type === "number" ? 0 : "");
    return `<div class="fld"><label>${label}</label>
      <input type="${type}" data-field="${field}" value="${v}" placeholder="${placeholder || ""}"/></div>`;
  }

  _select(label, field, options, value) {
    const opts = options.map((o) =>
      `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${o.label}</option>`
    ).join("");
    return `<div class="fld"><label>${label}</label><select data-field="${field}">${opts}</select></div>`;
  }

  _checkbox(label, field, checked) {
    return `<div class="fld chk"><label><input type="checkbox" data-field="${field}" ${checked ? "checked" : ""}/> ${label}</label></div>`;
  }

  _textarea(label, field, value, placeholder) {
    const v = Array.isArray(value) ? value.join(", ") : value || "";
    return `<div class="fld"><label>${label}</label>
      <textarea data-field="${field}" placeholder="${placeholder || ""}">${v}</textarea></div>`;
  }

  _section(name, label, content) {
    const open = this._sections[name] || false;
    return `<div class="sec ${open ? "open" : ""}" data-section="${name}">
      <div class="sh" data-toggle="${name}"><span>${label}</span><span class="chev">${open ? "▾" : "▸"}</span></div>
      <div class="sb">${content}</div></div>`;
  }

  _entityPicker(label, field, value, includeDomains) {
    const v = value || "";
    const domains = includeDomains ? ` include-domains='${JSON.stringify(includeDomains)}'` : "";
    return `<div class="fld">
      <label>${label}</label>
      <ha-entity-picker data-field="${field}" .value="${v}" .hass="${this._hass || ""}"${domains}></ha-entity-picker>
    </div>`;
  }

  _render() {
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;}*{box-sizing:border-box;}
      .ed{display:flex;flex-direction:column;gap:8px;padding:12px;}
      .fld{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}
      .fld label{font-size:11px;font-weight:600;opacity:.7;}
      .fld input,.fld select,.fld textarea,ha-entity-picker{
        font-size:13px;padding:8px 10px;border-radius:8px;
        border:1px solid var(--divider-color,#ccc);
        background:var(--secondary-background-color,#fff);
        color:var(--primary-text-color);font-family:inherit;}
      .fld textarea{min-height:50px;resize:vertical;}
      .fld.chk label{display:flex;align-items:center;gap:8px;font-size:13px;}
      .fld.chk input{width:auto;}
      .sec{border:1px solid var(--divider-color,#e0e0e0);border-radius:10px;overflow:hidden;}
      .sh{display:flex;align-items:center;padding:10px 12px;cursor:pointer;
        background:var(--secondary-background-color,#f5f5f5);font-size:13px;font-weight:600;}
      .sh .chev{margin-left:auto;font-size:12px;opacity:.5;}
      .sb{padding:10px 12px;display:none;}
      .sec.open .sb{display:block;}
    </style>
    <div class="ed">
      ${this._field("Titre", "name", "text", c.name, "Consommation")}

      ${this._section("discover", "Découverte",
        this._textarea("Exclure (mots-clés, virgules)", "exclude", c.exclude, "total, daily, hier") +
        this._textarea("Inclure (entity_id, virgules)", "include", c.include, "sensor.prise_xxx") +
        this._textarea("Pièces (restreindre)", "areas", c.areas, "salon, cuisine") +
        this._checkbox("Inclure les entités de diagnostic", "include_diagnostic", c.include_diagnostic)
      )}

      ${this._section("display", "Affichage",
        this._field("Top (nb de postes visibles)", "top", "number", c.top) +
        this._field("Seuil veille (W)", "standby_threshold", "number", c.standby_threshold) +
        this._field("Conso min affichée (W)", "min_display", "number", c.min_display) +
        this._checkbox("Afficher le repli du secondaire", "show_rest", c.show_rest)
      )}

      ${this._section("cost", "Coût & index",
        this._field("Prix du kWh (si pas d'entité)", "price", "number", c.price) +
        this._entityPicker("Entité prix dynamique", "price_entity", c.price_entity, ["sensor","input_number"]) +
        this._field("Devise", "currency", "text", c.currency, "€") +
        this._entityPicker("Entité index total", "energy_total", c.energy_total, ["sensor"])
      )}
    </div>`;

    this.shadowRoot.querySelectorAll("input, select, textarea").forEach((el) => {
      el.addEventListener("change", (e) => this._changed(e));
      el.addEventListener("input", (e) => this._changed(e));
    });
    this.shadowRoot.querySelectorAll("ha-entity-picker").forEach((el) => {
      el.addEventListener("change", (e) => this._changed(e));
    });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => this._toggle(el.dataset.toggle));
    });
  }
}

if (!customElements.get("energy-card-editor")) {
  customElements.define("energy-card-editor", EnergyCardEditor);
}

function deviceName(hass, entityId) {
  const ent = hass.entities?.[entityId];
  const dev = ent?.device_id ? hass.devices?.[ent.device_id] : null;
  return dev?.name_by_user || dev?.name || null;
}

const BATTERY_I = {
  batt: `<path d="M15.7 4H14V2h-4v2H8.3C7.6 4 7 4.6 7 5.3v15.4c0 .7.6 1.3 1.3 1.3h7.4c.7 0 1.3-.6 1.3-1.3V5.3c0-.7-.6-1.3-1.3-1.3z"/>`,
  caret: `<path d="M7 10l5 5 5-5z"/>`,
  plug: `<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2.5a7.5 7.5 0 0 1 5.9 12.1L6.4 6.1A7.5 7.5 0 0 1 12 4.5zM4.5 12a7.5 7.5 0 0 1 .6-2.9l11.8 11.8A7.5 7.5 0 0 1 4.5 12z"/>`,
};

const OFFLINE_DOMAINS = [
  "sensor", "binary_sensor", "light", "switch", "cover", "climate",
  "lock", "media_player", "vacuum", "lawn_mower", "fan", "camera",
  "device_tracker", "number", "select", "button",
];

/* La détection hors ligne ne s'applique qu'aux entités dont le nom
   contient "batterie" ou "battery" — évite d'afficher les litières,
   alarmes, tensions, etc. */
const OFFLINE_INCLUDE = ["batterie", "battery"];

/* ---------- Card ---------- */

class BatteryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._els = {};
    this._sig = "";
    this._openAll = false;
  }

  setConfig(config) {
    this._config = {
      name: "Piles",
      critical: 15,
      warning: 30,
      exclude: [],
      include: [],
      areas: null,
      show_all: true,
      max_rows: 0,
      ...(config || {}),
    };
    this._built = false;
    this._sig = "";
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  static getStubConfig() { return { type: "custom:battery-card" }; }

  static getConfigElement() {
    return document.createElement("battery-card-editor");
  }

  getCardSize() { return 6; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  /* ---------- Discovery ---------- */

  _batteries() {
    const c = this._config;
    const discover = window.haAutoCards?.discover || discoverLocal;
    const numeric = discover(this._hass, {
      domains: ["sensor"],
      deviceClasses: ["battery"],
      includeDiagnostic: true,
      exclude: c.exclude,
      include: c.include,
      areas: c.areas,
    }).filter((b) => !Number.isNaN(b.value));

    const binary = discover(this._hass, {
      domains: ["binary_sensor"],
      deviceClasses: ["battery"],
      includeDiagnostic: true,
      exclude: c.exclude,
      areas: c.areas,
    }).map((b) => ({ ...b, low: b.state === "on", value: b.state === "on" ? 10 : 100 }));

    return [...numeric, ...binary].sort((a, b) => a.value - b.value);
  }

  /* ---------- Render ---------- */

  _build() {
    this.shadowRoot.innerHTML = `<style>${BatteryCard.styles}</style>
      <ha-card>
        <div class="ch">
          <div class="ci"><svg viewBox="0 0 24 24">${BATTERY_I.batt}</svg></div>
          <div class="ct"><b>${this._config.name}</b><span class="sub">—</span></div>
          <div class="cc hidden">—</div>
        </div>

        <div class="secw sec-batt">
          <div class="sec">À remplacer</div>
          <div class="brs"></div>
        </div>

        <details class="acc hidden">
          <summary class="accs"><span class="k">Toutes les piles</span>
            <span class="accv"><span class="rt">—</span>
              <svg class="car" viewBox="0 0 24 24">${BATTERY_I.caret}</svg></span></summary>
          <div class="accb"></div>
        </details>

        <div class="cf hidden"></div>
      </ha-card>`;
    this._built = true;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._els = {
      sub: $(".ct .sub"),
      badge: $(".cc"),
      secBatt: $(".sec-batt"),
      bad: $(".brs"),
      acc: $(".acc"),
      accTotal: $(".accs .rt"),
      accBody: $(".accb"),
      foot: $(".cf"),
    };
    this._els.acc.addEventListener("toggle", () => {
      this._openAll = this._els.acc.open;
    });
  }

  _ago(iso) {
    if (!iso) return "";
    const d = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (d < 60) return `${Math.round(d)} s`;
    if (d < 3600) return `${Math.round(d / 60)} min`;
    if (d < 86400) return `${Math.round(d / 3600)} h`;
    return `${Math.round(d / 86400)} j`;
  }

  _hhmm(t) {
    return new Date(t).toLocaleTimeString(this._hass?.locale?.language || "fr", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  _bRow(b) {
    const c = this._config;
    const crit = b.value <= c.critical;
    const warn = b.value <= c.warning;
    const col = crit ? "#ff8a7d" : warn ? "#ffc76b" : "#8fbfae";
    const label = b.low !== undefined ? (b.low ? "Faible" : "OK") : `${Math.round(b.value)} %`;
    return `<div class="br2 ${crit ? "crit" : warn ? "warn" : ""}" data-e="${b.entity_id}">
      <span class="bn" title="${b.name}">${b.name}</span>
      <span class="bb"><i style="width:${Math.max(0, Math.min(100, b.value))}%;background:${col}"></i></span>
      <span class="bp">${label}</span>
    </div>`;
  }

  _update() {
    const c = this._config;
    const e = this._els;
    if (!this._hass || !this._built) return;

    const bats = this._batteries();
    const bad = bats.filter((b) => b.value <= c.warning);
    const crit = bats.filter((b) => b.value <= c.critical);

    const sig = bats.map((b) => `${b.entity_id}:${Math.round(b.value)}`).join("|");

    const parts = [];
    if (crit.length) parts.push(`${crit.length} critique${crit.length > 1 ? "s" : ""}`);
    else if (bad.length) parts.push(`${bad.length} à surveiller`);
    e.sub.textContent = parts.length ? parts.join(" · ") : `${bats.length} piles · tout va bien`;

    e.badge.textContent = crit.length || bad.length || "OK";
    e.badge.className = `cc ${crit.length ? "red" : bad.length ? "warn" : "ok"}`;
    e.badge.classList.remove("hidden");

    if (sig === this._sig) return;
    this._sig = sig;

    /* Toutes les piles triées par % (les plus faibles en premier) */
    if (bats.length) {
      e.secBatt.classList.remove("hidden");
      e.secBatt.querySelector(".sec").textContent = bad.length
        ? `${bad.length} à remplacer · ${bats.length} au total`
        : `${bats.length} piles · tout va bien`;
      const shown = c.max_rows ? bats.slice(0, c.max_rows) : bats;
      e.bad.innerHTML = shown.map((b) => this._bRow(b)).join("");
    } else {
      e.secBatt.classList.add("hidden");
    }

    /* Section repliable masquée — tout est affiché ci-dessus */
    e.acc.classList.add("hidden");

    this.shadowRoot.querySelectorAll("[data-e]").forEach((el) =>
      el.addEventListener("click", () =>
        fireEvent(this, "hass-more-info", { entityId: el.dataset.e })
      )
    );

    const bits = [];
    if (bats.length) {
      const min = Math.min(...bats.map((b) => b.value));
      bits.push(`${bats.length} piles · min ${Math.round(min)} %`);
    }
    e.foot.textContent = bits.join(" · ");
    e.foot.classList.toggle("hidden", !bits.length);
  }
}

/* ---------- Styles ---------- */

BatteryCard.styles = `
:host{--bc-red:#ff8a7d;--bc-warn:#ffc76b;--bc-ok:#8fbfae;display:block;}
*{box-sizing:border-box;}
.hidden{display:none !important;}
ha-card{
  border-radius:var(--ha-card-border-radius,18px);padding:16px 16px 14px;
  background:linear-gradient(170deg,#1a1d24 0%,#15181e 60%,#111318 100%);
  border:1px solid rgba(255,255,255,.06);color:#eef1f6;
  font-family:var(--primary-font-family,"Inter","Segoe UI",Roboto,sans-serif);
}
.ch{display:flex;align-items:center;gap:11px;}
.ci{width:34px;height:34px;border-radius:11px;flex-shrink:0;
  background:rgba(255,138,125,.10);border:1px solid rgba(255,138,125,.26);
  display:flex;align-items:center;justify-content:center;}
.ci svg{width:17px;height:17px;fill:var(--bc-red);}
.ct{flex:1;min-width:0;}
.ct b{display:block;font-size:14px;font-weight:600;}
.ct .sub{display:block;font-size:10.5px;color:rgba(255,255,255,.42);margin-top:2px;}
.cc{font-size:11px;font-weight:700;border-radius:9px;padding:5px 9px;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.6);}
.cc.warn{background:rgba(255,199,107,.12);border-color:rgba(255,199,107,.3);color:var(--bc-warn);}
.cc.red{background:rgba(255,107,92,.12);border-color:rgba(255,107,92,.3);color:var(--bc-red);}
.cc.ok{background:rgba(143,191,174,.12);border-color:rgba(143,191,174,.3);color:var(--bc-ok);}

.banner{display:flex;align-items:center;gap:10px;margin-top:15px;padding:10px 12px;
  border-radius:13px;background:rgba(255,107,92,.09);border:1px solid rgba(255,107,92,.26);}
.bd{width:7px;height:7px;border-radius:50%;background:var(--bc-red);flex-shrink:0;}
.banner b{display:block;font-size:11.5px;font-weight:600;}
.banner .bs{display:block;font-size:10px;color:rgba(255,255,255,.5);margin-top:2px;}

.sec{font-size:8.5px;letter-spacing:1.6px;text-transform:uppercase;
  color:rgba(255,255,255,.34);font-weight:600;margin:16px 0 8px;}
.brs{display:flex;flex-direction:column;}
.br2{display:flex;align-items:center;gap:9px;padding:7px 0;cursor:pointer;}
.br2:hover .bn{color:#eef1f6;}
.bn{font-size:11.5px;color:rgba(255,255,255,.62);width:132px;flex-shrink:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:.15s;}
.bb{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;}
.bb i{display:block;height:100%;border-radius:3px;opacity:.85;transition:width .4s;}
.bp{font-size:11px;font-weight:600;width:42px;text-align:right;
  color:rgba(255,255,255,.6);font-variant-numeric:tabular-nums;}
.br2.warn .bp{color:var(--bc-warn);}
.br2.crit .bp{color:var(--bc-red);}

.acc{margin-top:10px;border-radius:12px;background:rgba(255,255,255,.035);
  border:1px solid rgba(255,255,255,.07);padding:0 12px;transition:.2s;}
.acc[open]{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.11);}
.accs{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:11px 0;cursor:pointer;list-style:none;}
.accs::-webkit-details-marker{display:none;}
.k{font-size:9px;letter-spacing:1.8px;text-transform:uppercase;
  color:rgba(255,255,255,.42);font-weight:600;}
.accv{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;
  color:rgba(255,255,255,.45);font-variant-numeric:tabular-nums;}
.car{width:11px;height:11px;fill:rgba(255,255,255,.35);transition:transform .2s;}
.acc[open] .car{transform:rotate(180deg);}
.accb{padding:2px 0 10px;}

.offs{display:flex;flex-direction:column;}
.of{display:flex;align-items:center;gap:9px;padding:8px 0;font-size:11.5px;
  color:rgba(255,255,255,.55);border-bottom:1px solid rgba(255,255,255,.045);cursor:pointer;}
.of:last-child{border-bottom:none;}
.of:hover{color:rgba(255,255,255,.8);}
.ofd{width:6px;height:6px;border-radius:50%;background:#6b7480;flex-shrink:0;}
.ofd.unk{background:transparent;border:1px solid #6b7480;}
.ofn{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ofn i{font-style:normal;font-size:8.5px;color:rgba(255,255,255,.28);margin-left:7px;}
.ofa{font-size:9.5px;color:rgba(255,255,255,.3);flex-shrink:0;
  font-variant-numeric:tabular-nums;}

.cf{margin-top:13px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07);
  font-size:9.5px;color:rgba(255,255,255,.34);font-variant-numeric:tabular-nums;}
`;

/* ---------- Registration ---------- */

if (!customElements.get("battery-card")) {
  customElements.define("battery-card", BatteryCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "battery-card",
  name: "Battery & Availability Card (auto)",
  description:
    "Piles faibles et appareils injoignables découverts automatiquement, avec détection de panne commune.",
  preview: false,
  documentationURL: "https://github.com/junkoku38/ha-auto-cards",
});

/* ---------- Visual editor ---------- */

class BatteryCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._sections = { thresholds: true, display: false };
  }

  setConfig(config) {
    this._config = {
      name: "Piles",
      critical: 15,
      warning: 30,
      exclude: [],
      include: [],
      areas: null,
      show_all: true,
      max_rows: 0,
      ...config,
    };
    this._render();
  }

  set hass(hass) { this._hass = hass; }

  _changed(ev) {
    const field = ev.target.dataset.field;
    if (!field) return;
    let value = ev.target.value;
    if (ev.target.type === "number") value = value === "" ? 0 : Number(value);
    else if (ev.target.type === "checkbox") value = ev.target.checked;
    else if (["exclude", "include", "areas"].includes(field)) {
      value = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }

  _toggle(name) {
    this._sections[name] = !this._sections[name];
    const el = this.shadowRoot.querySelector(`[data-section="${name}"]`);
    if (el) {
      el.classList.toggle("open", this._sections[name]);
      const chev = el.querySelector(".chev");
      if (chev) chev.textContent = this._sections[name] ? "▾" : "▸";
    }
  }

  _field(label, field, type, value, placeholder) {
    const v = value ?? (type === "number" ? 0 : "");
    return `<div class="fld"><label>${label}</label>
      <input type="${type}" data-field="${field}" value="${v}" placeholder="${placeholder || ""}"/></div>`;
  }

  _checkbox(label, field, checked) {
    return `<div class="fld chk"><label><input type="checkbox" data-field="${field}" ${checked ? "checked" : ""}/> ${label}</label></div>`;
  }

  _textarea(label, field, value, placeholder) {
    const v = Array.isArray(value) ? value.join(", ") : value || "";
    return `<div class="fld"><label>${label}</label>
      <textarea data-field="${field}" placeholder="${placeholder || ""}">${v}</textarea></div>`;
  }

  _section(name, label, content) {
    const open = this._sections[name] || false;
    return `<div class="sec ${open ? "open" : ""}" data-section="${name}">
      <div class="sh" data-toggle="${name}"><span>${label}</span><span class="chev">${open ? "▾" : "▸"}</span></div>
      <div class="sb">${content}</div></div>`;
  }

  _render() {
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;}*{box-sizing:border-box;}
      .ed{display:flex;flex-direction:column;gap:8px;padding:12px;}
      .fld{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}
      .fld label{font-size:11px;font-weight:600;opacity:.7;}
      .fld input,.fld select,.fld textarea{
        font-size:13px;padding:8px 10px;border-radius:8px;
        border:1px solid var(--divider-color,#ccc);
        background:var(--secondary-background-color,#fff);
        color:var(--primary-text-color);font-family:inherit;}
      .fld textarea{min-height:50px;resize:vertical;}
      .fld.chk label{display:flex;align-items:center;gap:8px;font-size:13px;}
      .fld.chk input{width:auto;}
      .sec{border:1px solid var(--divider-color,#e0e0e0);border-radius:10px;overflow:hidden;}
      .sh{display:flex;align-items:center;padding:10px 12px;cursor:pointer;
        background:var(--secondary-background-color,#f5f5f5);font-size:13px;font-weight:600;}
      .sh .chev{margin-left:auto;font-size:12px;opacity:.5;}
      .sb{padding:10px 12px;display:none;}
      .sec.open .sb{display:block;}
    </style>
    <div class="ed">
      ${this._field("Titre", "name", "text", c.name, "Piles")}

      ${this._section("thresholds", "Seuils",
        this._field("Critique (%)", "critical", "number", c.critical) +
        this._field("À surveiller (%)", "warning", "number", c.warning)
      )}

      ${this._section("display", "Découverte & affichage",
        this._textarea("Exclure (mots-clés, virgules)", "exclude", c.exclude, "sensor.xxx") +
        this._textarea("Inclure (entity_id, virgules)", "include", c.include, "sensor.xxx") +
        this._textarea("Pièces (restreindre)", "areas", c.areas, "salon, cuisine") +
        this._checkbox("Afficher toutes les piles", "show_all", c.show_all) +
        this._field("Lignes max (0 = illimité)", "max_rows", "number", c.max_rows)
      )}
    </div>`;

    this.shadowRoot.querySelectorAll("input, select, textarea").forEach((el) => {
      el.addEventListener("change", (e) => this._changed(e));
      el.addEventListener("input", (e) => this._changed(e));
    });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => this._toggle(el.dataset.toggle));
    });
  }
}

if (!customElements.get("battery-card-editor")) {
  customElements.define("battery-card-editor", BatteryCardEditor);
}