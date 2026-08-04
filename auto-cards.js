/**
 * Comfort Card — découverte automatique
 * Regroupe température et humidité par pièce, sans configuration d'entités.
 */

const CARD_VERSION = "1.6.3";

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
    units = null,
    includeDiagnostic = false,
    includeHidden = false,
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
      const unit = st.attributes?.unit_of_measurement;
      const dcOk = deviceClasses ? deviceClasses.includes(dc) : null;
      const unitOk = units ? units.includes(unit) : null;
      if (deviceClasses && units) {
        if (!dcOk && !unitOk) return;
      } else if (deviceClasses && !dcOk) return;
      else if (units && !unitOk) return;

      const reg = hass.entities?.[id];
      if (!includeHidden && (reg?.hidden || reg?.disabled_by)) return;
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
  window.haAutoCards.discover = discover;
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
    const numeric = discover(this._hass, {
      domains: ["sensor"],
      deviceClasses: ["battery"],
      includeDiagnostic: true,
      exclude: c.exclude,
      include: c.include,
      areas: c.areas,
    }).map((b) => {
      const v = Number(b.state);
      return { ...b, value: Number.isNaN(v) ? -1 : v, unavailable: Number.isNaN(v) };
    });

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
          <summary class="accs"><span class="k">Piles à 100%</span>
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
    if (b.unavailable) {
      return `<div class="br2 crit" data-e="${b.entity_id}">
        <span class="bn" title="${b.name}">${b.name}</span>
        <span class="bb"><i style="width:0%;background:#ff8a7d"></i></span>
        <span class="bp" style="color:#ff8a7d">N/A</span>
      </div>`;
    }
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
    const bad = bats.filter((b) => b.value <= c.warning || b.unavailable);
    const crit = bats.filter((b) => b.value <= c.critical || b.unavailable);

    const sig = bats.map((b) => `${b.entity_id}:${b.unavailable ? "N/A" : Math.round(b.value)}`).join("|");

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
    const notFull = bats.filter((b) => b.value < 100);
    const full = bats.filter((b) => b.value >= 100 && !b.unavailable);

    if (notFull.length) {
      e.secBatt.classList.remove("hidden");
      e.secBatt.querySelector(".sec").textContent = bad.length
        ? `${bad.length} à remplacer · ${notFull.length} piles < 100%`
        : `${notFull.length} piles · tout va bien`;
      e.bad.innerHTML = notFull.map((b) => this._bRow(b)).join("");
    } else {
      e.secBatt.classList.add("hidden");
    }

    /* Batteries à 100% dans la section repliable */
    if (full.length) {
      e.acc.classList.remove("hidden");
      e.accTotal.textContent = `${full.length} piles à 100%`;
      e.accBody.innerHTML = full.map((b) => this._bRow(b)).join("");
      e.acc.open = this._openAll;
    } else e.acc.classList.add("hidden");

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
}/**
 * System Health Card — découverte automatique
 * Intégrations en erreur, entités indisponibles par intégration, état général.
 */

const HEALTH_CARD_VERSION = "1.0.0";

console.info(
  `%c HEALTH-CARD %c v${HEALTH_CARD_VERSION} `,
  "color:#15181e;background:#ff8a7d;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#ff8a7d;background:#15181e;border-radius:0 3px 3px 0;padding:2px 6px"
);

const HEALTH_I = {
  alert: `<path d="M12 2 1 21h22L12 2zm0 6 7.5 13h-15L12 8zm-1 4v4h2v-4h-2zm0 5v2h2v-2h-2z"/>`,
  check: `<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 14.5-4-4L8.4 11l2.6 2.6L15.6 9 17 10.4l-6 6.1z"/>`,
  caret: `<path d="M7 10l5 5 5-5z"/>`,
};

const BAD_STATES = {
  setup_error: "Échec de configuration",
  setup_retry: "Nouvelle tentative",
  migration_error: "Erreur de migration",
  not_loaded: "Non chargée",
};

const HEALTH_OFFLINE_DOMAINS = [
  "sensor", "binary_sensor", "light", "switch", "cover", "climate",
  "lock", "media_player", "vacuum", "lawn_mower", "fan", "camera",
  "number", "select", "button", "device_tracker",
];

class HealthCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._els = {};
    this._entries = null;
    this._entriesError = null;
    this._fetchedAt = 0;
    this._busy = false;
    this._tick = null;
    this._sig = "";
  }

  setConfig(config) {
    this._config = {
      name: "Santé du système",
      refresh: 60,
      max_errors: 6,
      max_platforms: 5,
      show_unavailable: true,
      include_unknown: false,
      exclude: [],
      show_ok_when_healthy: true,
      ...(config || {}),
    };
    this._built = false;
    this._sig = "";
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  static getStubConfig() { return { type: "custom:health-card" }; }

  static getConfigElement() {
    return document.createElement("health-card-editor");
  }

  getCardSize() { return 8; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
    if (first) this._fetchEntries();
  }

  connectedCallback() {
    this._tick = setInterval(() => {
      this._update();
      if (Date.now() - this._fetchedAt > this._config.refresh * 1000) this._fetchEntries();
    }, 15000);
  }

  disconnectedCallback() {
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
  }

  async _fetchEntries() {
    if (this._busy || !this._hass) return;
    this._busy = true;
    try {
      const res = await this._hass.callWS({ type: "config_entries/get" });
      this._entries = Array.isArray(res) ? res : [];
      this._entriesError = null;
    } catch (err) {
      this._entries = [];
      this._entriesError = "Accès refusé (compte non administrateur)";
    } finally {
      this._busy = false;
      this._fetchedAt = Date.now();
      this._sig = "";
      this._update();
    }
  }

  async _reload(entryId, btn) {
    if (!this._hass || !entryId) return;
    if (btn) { btn.textContent = "…"; btn.classList.add("busy"); }
    try {
      await this._hass.callWS({ type: "config_entries/reload", entry_id: entryId });
    } catch (err) {}
    setTimeout(() => this._fetchEntries(), 1500);
  }

  _brokenEntries() {
    const c = this._config;
    const exPat = c.exclude.map(norm).filter(Boolean);
    return (this._entries || [])
      .filter((e) => BAD_STATES[e.state] && !e.disabled_by)
      .filter((e) => !exPat.some((p) => norm(`${e.domain} ${e.title}`).includes(p)))
      .sort((a, b) => (a.state === "setup_error" ? -1 : 1));
  }

  _unavailable() {
    const c = this._config;
    if (!c.show_unavailable) return { total: 0, byPlatform: [] };
    const hass = this._hass;
    const bad = c.include_unknown ? ["unavailable", "unknown"] : ["unavailable"];
    const exPat = c.exclude.map(norm).filter(Boolean);
    const byPlatform = new Map();
    let total = 0;

    Object.keys(hass.states).forEach((id) => {
      const st = hass.states[id];
      if (!bad.includes(st.state)) return;
      if (!HEALTH_OFFLINE_DOMAINS.includes(id.split(".")[0])) return;
      const reg = hass.entities?.[id];
      if (reg?.hidden || reg?.disabled_by) return;
      if (reg?.entity_category) return;
      const label = norm(`${id} ${st.attributes?.friendly_name || ""}`);
      if (exPat.some((p) => label.includes(p))) return;
      total++;
      const platform = reg?.platform || "inconnu";
      if (!byPlatform.has(platform)) byPlatform.set(platform, { platform, count: 0, sample: id });
      byPlatform.get(platform).count++;
    });

    return {
      total,
      byPlatform: [...byPlatform.values()].sort((a, b) => b.count - a.count),
    };
  }

  _entityCount() {
    return Object.keys(this._hass.states).filter((id) => {
      const reg = this._hass.entities?.[id];
      return !reg?.hidden && !reg?.disabled_by;
    }).length;
  }

  _build() {
    this.shadowRoot.innerHTML = `<style>${HealthCard.styles}</style>
      <ha-card>
        <div class="ch">
          <div class="ci"><svg viewBox="0 0 24 24">${HEALTH_I.alert}</svg></div>
          <div class="ct"><b>${this._config.name}</b><span class="sub">—</span></div>
          <div class="cc hidden">—</div>
        </div>
        <div class="kpi3"></div>
        <div class="secw sec-err hidden">
          <div class="sec">Intégrations en erreur</div>
          <div class="igs"></div>
        </div>
        <div class="secw sec-unav hidden">
          <div class="sec">Entités indisponibles par intégration</div>
          <div class="pls"></div>
        </div>
        <div class="okbox hidden">
          <svg viewBox="0 0 24 24">${HEALTH_I.check}</svg>
          <div><b>Aucun problème détecté</b><span class="oks">—</span></div>
        </div>
        <div class="cf hidden"></div>
      </ha-card>`;
    this._built = true;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._els = {
      icon: $(".ci"),
      sub: $(".ct .sub"),
      badge: $(".cc"),
      kpi: $(".kpi3"),
      secErr: $(".sec-err"),
      errs: $(".igs"),
      secUnav: $(".sec-unav"),
      plats: $(".pls"),
      okbox: $(".okbox"),
      okSub: $(".oks"),
      foot: $(".cf"),
    };
  }

  _update() {
    const c = this._config;
    const e = this._els;
    if (!this._hass || !this._built) return;

    const broken = this._brokenEntries();
    const unav = this._unavailable();
    const entities = this._entityCount();
    const loaded = (this._entries || []).filter((x) => x.state === "loaded").length;

    const parts = [];
    if (broken.length) parts.push(`${broken.length} intégration${broken.length > 1 ? "s" : ""} en erreur`);
    if (unav.total) parts.push(`${unav.total} entité${unav.total > 1 ? "s" : ""} indisponible${unav.total > 1 ? "s" : ""}`);
    e.sub.textContent = parts.length ? parts.join(" · ") : "Tout est opérationnel";

    const sev = broken.length ? "red" : unav.total ? "warn" : "ok";
    e.badge.textContent = broken.length || unav.total || "OK";
    e.badge.className = `cc ${sev}`;
    e.badge.classList.remove("hidden");
    e.icon.className = `ci ${sev}`;
    e.icon.innerHTML = `<svg viewBox="0 0 24 24">${sev === "ok" ? HEALTH_I.check : HEALTH_I.alert}</svg>`;

    e.kpi.innerHTML = `
      <div class="kc"><span>Entités</span><b>${entities}</b></div>
      <div class="kc ${unav.total ? "warn" : ""}"><span>Indispo.</span><b>${unav.total}</b></div>
      <div class="kc ${broken.length ? "red" : ""}"><span>Intégrations</span><b>${loaded || "—"}</b></div>`;

    const sig =
      broken.map((b) => `${b.entry_id}:${b.state}`).join("|") + "#" +
      unav.byPlatform.map((p) => `${p.platform}:${p.count}`).join("|") + "#" +
      (this._entriesError || "");
    if (sig === this._sig) return;
    this._sig = sig;

    if (broken.length) {
      e.secErr.classList.remove("hidden");
      e.errs.innerHTML = broken.slice(0, c.max_errors).map((b) =>
        `<div class="ig err">
          <svg viewBox="0 0 24 24">${HEALTH_I.alert}</svg>
          <div class="igt"><b>${b.title || b.domain}</b>
            <span>${b.reason || BAD_STATES[b.state]}</span></div>
          <span class="igb" data-entry="${b.entry_id}">${b.state === "setup_retry" ? "Réessayer" : "Recharger"}</span>
        </div>`
      ).join("");
      e.errs.querySelectorAll(".igb").forEach((btn) =>
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._reload(btn.dataset.entry, btn);
        })
      );
    } else e.secErr.classList.add("hidden");

    if (unav.byPlatform.length) {
      e.secUnav.classList.remove("hidden");
      const hi = unav.byPlatform[0].count || 1;
      e.plats.innerHTML = unav.byPlatform.slice(0, c.max_platforms).map((p) =>
        `<div class="pl" data-e="${p.sample}">
          <span class="pn">${p.platform}</span>
          <span class="pb"><i style="width:${((p.count / hi) * 100).toFixed(0)}%"></i></span>
          <span class="pc2">${p.count}</span></div>`
      ).join("");
      e.plats.querySelectorAll(".pl").forEach((el) =>
        el.addEventListener("click", () => fireEvent(this, "hass-more-info", { entityId: el.dataset.e }))
      );
    } else e.secUnav.classList.add("hidden");

    const healthy = !broken.length && !unav.total;
    if (healthy && c.show_ok_when_healthy) {
      e.okbox.classList.remove("hidden");
      e.okSub.textContent = `${entities} entités · ${loaded} intégrations chargées`;
    } else e.okbox.classList.add("hidden");

    const bits = [];
    if (this._entriesError) bits.push(this._entriesError);
    else {
      if (broken.length > c.max_errors) bits.push(`${broken.length - c.max_errors} autres intégrations en erreur`);
      if (unav.byPlatform.length > c.max_platforms) bits.push(`${unav.byPlatform.length - c.max_platforms} autres intégrations concernées`);
    }
    const ver = this._hass.config?.version;
    if (ver && !bits.length) bits.push(`Home Assistant ${ver}`);
    e.foot.textContent = bits.join(" · ");
    e.foot.classList.toggle("hidden", !bits.length);
  }
}

HealthCard.styles = `
:host{--hc-red:#ff8a7d;--hc-warn:#ffc76b;--hc-ok:#8fbfae;display:block;}
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
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  display:flex;align-items:center;justify-content:center;}
.ci svg{width:17px;height:17px;fill:rgba(255,255,255,.6);}
.ci.red{background:rgba(255,138,125,.10);border-color:rgba(255,138,125,.28);}
.ci.red svg{fill:var(--hc-red);}
.ci.warn{background:rgba(255,199,107,.10);border-color:rgba(255,199,107,.28);}
.ci.warn svg{fill:var(--hc-warn);}
.ci.ok{background:rgba(143,191,174,.10);border-color:rgba(143,191,174,.28);}
.ci.ok svg{fill:var(--hc-ok);}
.ct{flex:1;min-width:0;}
.ct b{display:block;font-size:14px;font-weight:600;}
.ct .sub{display:block;font-size:10.5px;color:rgba(255,255,255,.42);margin-top:2px;}
.cc{font-size:11px;font-weight:700;border-radius:9px;padding:5px 9px;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.6);}
.cc.warn{background:rgba(255,199,107,.12);border-color:rgba(255,199,107,.3);color:var(--hc-warn);}
.cc.red{background:rgba(255,138,125,.12);border-color:rgba(255,138,125,.3);color:var(--hc-red);}
.cc.ok{background:rgba(143,191,174,.12);border-color:rgba(143,191,174,.3);color:var(--hc-ok);}
.kpi3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:15px;}
.kc{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.075);
  border-radius:11px;padding:9px 6px;text-align:center;}
.kc.warn{background:rgba(255,199,107,.08);border-color:rgba(255,199,107,.22);}
.kc.red{background:rgba(255,138,125,.08);border-color:rgba(255,138,125,.24);}
.kc span{display:block;font-size:7.5px;letter-spacing:.8px;text-transform:uppercase;
  color:rgba(255,255,255,.38);font-weight:600;}
.kc b{display:block;font-size:14px;font-weight:600;margin-top:5px;
  font-variant-numeric:tabular-nums;}
.kc.warn b{color:var(--hc-warn);} .kc.red b{color:var(--hc-red);}
.sec{font-size:8.5px;letter-spacing:1.6px;text-transform:uppercase;
  color:rgba(255,255,255,.34);font-weight:600;margin:17px 0 8px;}
.igs{display:flex;flex-direction:column;gap:6px;}
.ig{display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:12px;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);}
.ig.err{background:rgba(255,138,125,.08);border-color:rgba(255,138,125,.24);}
.ig svg{width:15px;height:15px;fill:rgba(255,255,255,.4);flex-shrink:0;}
.ig.err svg{fill:var(--hc-red);}
.igt{flex:1;min-width:0;}
.igt b{display:block;font-size:11.5px;font-weight:600;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.igt span{display:block;font-size:9.5px;color:rgba(255,255,255,.36);margin-top:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.igb{font-size:9.5px;font-weight:600;color:#ffb3aa;flex-shrink:0;cursor:pointer;
  background:rgba(255,138,125,.14);border:1px solid rgba(255,138,125,.24);
  border-radius:8px;padding:5px 9px;transition:.15s;}
.igb:hover{background:rgba(255,138,125,.24);}
.igb.busy{opacity:.5;}
.pls{display:flex;flex-direction:column;}
.pl{display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;}
.pl:hover .pn{color:#eef1f6;}
.pn{font-size:11px;color:rgba(255,255,255,.58);width:128px;flex-shrink:0;transition:.15s;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pb{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden;}
.pb i{display:block;height:100%;border-radius:3px;background:var(--hc-warn);opacity:.7;}
.pc2{font-size:11px;font-weight:600;width:26px;text-align:right;
  color:rgba(255,255,255,.6);font-variant-numeric:tabular-nums;}
.okbox{display:flex;align-items:center;gap:11px;margin-top:15px;padding:12px 13px;
  border-radius:13px;background:rgba(143,191,174,.08);border:1px solid rgba(143,191,174,.24);}
.okbox svg{width:19px;height:19px;fill:var(--hc-ok);flex-shrink:0;}
.okbox b{display:block;font-size:12px;font-weight:600;}
.okbox span{display:block;font-size:10px;color:rgba(255,255,255,.45);margin-top:3px;}
.cf{margin-top:13px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07);
  font-size:9.5px;color:rgba(255,255,255,.34);line-height:1.5;}
`;

if (!customElements.get("health-card")) {
  customElements.define("health-card", HealthCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "health-card",
  name: "System Health Card (auto)",
  description: "Intégrations en erreur et entités indisponibles, avec rechargement en un clic.",
  preview: false,
  documentationURL: "https://github.com/junkoku38/ha-auto-cards",
});

/* ---------- Visual editor ---------- */

class HealthCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._sections = { display: true, unavailable: false };
  }

  setConfig(config) {
    this._config = {
      name: "Santé du système",
      refresh: 60,
      max_errors: 6,
      max_platforms: 5,
      show_unavailable: true,
      include_unknown: false,
      exclude: [],
      show_ok_when_healthy: true,
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
    else if (["exclude"].includes(field)) {
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
      ${this._field("Titre", "name", "text", c.name, "Santé du système")}

      ${this._section("display", "Affichage",
        this._field("Rafraîchissement (secondes)", "refresh", "number", c.refresh) +
        this._field("Max intégrations en erreur", "max_errors", "number", c.max_errors) +
        this._field("Max plateformes indispo.", "max_platforms", "number", c.max_platforms) +
        this._checkbox("Afficher message OK si sain", "show_ok_when_healthy", c.show_ok_when_healthy)
      )}

      ${this._section("unavailable", "Entités indisponibles",
        this._checkbox("Afficher les indisponibles", "show_unavailable", c.show_unavailable) +
        this._checkbox("Inclure les entités 'unknown'", "include_unknown", c.include_unknown) +
        this._textarea("Exclure (mots-clés, virgules)", "exclude", c.exclude, "sensor.xxx")
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

if (!customElements.get("health-card-editor")) {
  customElements.define("health-card-editor", HealthCardEditor);
}/**
 * Access Card — découverte automatique
 * Portails, garages, volets, serrures et capteurs d'ouverture.
 */

const ACCESS_CARD_VERSION = "1.0.0";

console.info(
  `%c ACCESS-CARD %c v${ACCESS_CARD_VERSION} `,
  "color:#15181e;background:#8fbfae;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#8fbfae;background:#15181e;border-radius:0 3px 3px 0;padding:2px 6px"
);

const ACCESS_I = {
  gate: `<path d="M3 4h18v2H3V4zm1 4h6v12H4V8zm10 0h6v12h-6V8zM6 10v2h2v-2H6zm10 0v2h2v-2h-2z"/>`,
  garage: `<path d="M12 3 2 9v12h4v-8h12v8h4V9L12 3zM8 15h8v2H8v-2zm0 3h8v2H8v-2z"/>`,
  door: `<path d="M11 3H5v18h6v-2H7V5h4V3zm2 0v18h6V3h-6zm3 8.2a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>`,
  window: `<path d="M4 3h16v18H4V3zm2 2v7h5V5H6zm7 0v7h5V5h-5zM6 14v5h5v-5H6zm7 0v5h5v-5h-5z"/>`,
  shutter: `<path d="M3 3h18v3H3V3zm0 5h18v2H3V8zm0 4h18v2H3v-2zm0 4h18v2H3v-2zm0 4h18v2H3v-2z"/>`,
  lock: `<path d="M12 2a5 5 0 0 0-5 5v3H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V11a1 1 0 0 0-1-1h-1V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3z"/>`,
  caret: `<path d="M7 10l5 5 5-5z"/>`,
  up: `<path d="M12 6 5 14h14z"/>`,
  down: `<path d="M12 18 5 10h14z"/>`,
  stop: `<path d="M7 7h10v10H7z"/>`,
};

const COVER_ICON = { gate: ACCESS_I.gate, garage: ACCESS_I.garage, door: ACCESS_I.door, window: ACCESS_I.window, shutter: ACCESS_I.shutter, blind: ACCESS_I.shutter, awning: ACCESS_I.shutter, curtain: ACCESS_I.shutter, shade: ACCESS_I.shutter };
const OPEN_ICON = { door: ACCESS_I.door, garage_door: ACCESS_I.garage, window: ACCESS_I.window, opening: ACCESS_I.door };
const CLOSED_STATES = ["closed", "locked", "off"];

class AccessCard extends HTMLElement {
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
      name: "Accès",
      exclude: [],
      include: [],
      areas: null,
      cover_classes: null,
      exclude_classes: [],
      max_tiles: 6,
      show_locks: true,
      show_openings: true,
      show_all_openings: true,
      global_actions: true,
      ...(config || {}),
    };
    this._built = false;
    this._sig = "";
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  static getStubConfig() { return { type: "custom:access-card" }; }

  static getConfigElement() {
    return document.createElement("access-card-editor");
  }

  getCardSize() { return 8; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  _covers() {
    const c = this._config;
    let list = discover(this._hass, { domains: ["cover"], exclude: c.exclude, include: c.include, areas: c.areas });
    if (c.cover_classes) list = list.filter((x) => c.cover_classes.includes(x.device_class || "cover"));
    if (c.exclude_classes.length) list = list.filter((x) => !c.exclude_classes.includes(x.device_class || "cover"));
    const rank = { gate: 0, garage: 1, door: 2, window: 3 };
    return list.sort((a, b) => (rank[a.device_class] ?? 9) - (rank[b.device_class] ?? 9) || a.name.localeCompare(b.name));
  }

  _locks() {
    const c = this._config;
    if (!c.show_locks) return [];
    return discover(this._hass, { domains: ["lock"], exclude: c.exclude, areas: c.areas });
  }

  _openings() {
    const c = this._config;
    if (!c.show_openings) return [];
    return discover(this._hass, { domains: ["binary_sensor"], deviceClasses: ["door", "window", "garage_door", "opening"], exclude: c.exclude, areas: c.areas }).sort((a, b) => (b.state === "on") - (a.state === "on") || a.name.localeCompare(b.name));
  }

  _cover(action, entityId) {
    const map = { open: "open_cover", close: "close_cover", stop: "stop_cover", toggle: "toggle" };
    this._hass.callService("cover", map[action], { entity_id: entityId });
  }

  _all(action) {
    const ids = this._covers().map((x) => x.entity_id);
    if (!ids.length) return;
    this._hass.callService("cover", action === "open" ? "open_cover" : "close_cover", { entity_id: ids });
  }

  _toggleLock(entityId) {
    const st = this._hass.states[entityId];
    this._hass.callService("lock", st?.state === "locked" ? "unlock" : "lock", { entity_id: entityId });
  }

  _build() {
    this.shadowRoot.innerHTML = `<style>${AccessCard.styles}</style>
      <ha-card>
        <div class="ch">
          <div class="ci"><svg viewBox="0 0 24 24">${ACCESS_I.gate}</svg></div>
          <div class="ct"><b>${this._config.name}</b><span class="sub">—</span></div>
          <div class="cc hidden">—</div>
        </div>
        <div class="tiles"></div>
        <div class="acb hidden">
          <div class="ab2" data-a="open">Tout ouvrir</div>
          <div class="ab2" data-a="close">Tout fermer</div>
        </div>
        <div class="secw sec-open hidden">
          <div class="sec">Ouvertures</div>
          <div class="ops"></div>
        </div>
        <details class="acc hidden">
          <summary class="accs"><span class="k">Tout est fermé</span>
            <span class="accv"><span class="rt">—</span>
              <svg class="car" viewBox="0 0 24 24">${ACCESS_I.caret}</svg></span></summary>
          <div class="accb"></div>
        </details>
        <div class="cf hidden"></div>
      </ha-card>`;
    this._built = true;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._els = {
      icon: $(".ci"), sub: $(".ct .sub"), badge: $(".cc"),
      tiles: $(".tiles"), actions: $(".acb"),
      secOpen: $(".sec-open"), ops: $(".ops"),
      acc: $(".acc"), accLabel: $(".accs .k"), accTotal: $(".accs .rt"), accBody: $(".accb"),
      foot: $(".cf"),
    };
    this._els.actions.querySelectorAll(".ab2").forEach((btn) =>
      btn.addEventListener("click", () => this._all(btn.dataset.a))
    );
    this._els.acc.addEventListener("toggle", () => { this._openRest = this._els.acc.open; });
  }

  _ago(iso) {
    if (!iso) return "";
    const d = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (d < 60) return `${Math.round(d)} s`;
    if (d < 3600) return `${Math.round(d / 60)} min`;
    if (d < 86400) return `${Math.round(d / 3600)} h`;
    return `${Math.round(d / 86400)} j`;
  }

  _label(x) {
    const s = x.state;
    if (s === "open") return x.position != null && x.position < 100 ? `Ouvert ${x.position} %` : "Ouvert";
    if (s === "closed") return "Fermé";
    if (s === "opening") return "Ouverture…";
    if (s === "closing") return "Fermeture…";
    if (s === "locked") return "Verrouillé";
    if (s === "unlocked") return "Déverrouillé";
    if (s === "unavailable") return "Injoignable";
    return s;
  }

  _tile(x, kind) {
    const closed = CLOSED_STATES.includes(x.state);
    const moving = ["opening", "closing"].includes(x.state);
    const icon = kind === "lock" ? ACCESS_I.lock : COVER_ICON[x.device_class] || ACCESS_I.door;
    return `<div class="tl ${closed ? "closed" : moving ? "moving" : "open"}" data-e="${x.entity_id}" data-k="${kind}">
      <svg class="ti" viewBox="0 0 24 24">${icon}</svg>
      <b>${x.name}</b>
      <span>${this._label(x)}</span>
      ${kind === "cover" ? `<div class="tb"><span class="tbb" data-a="open"><svg viewBox="0 0 24 24">${ACCESS_I.up}</svg></span><span class="tbb" data-a="stop"><svg viewBox="0 0 24 24">${ACCESS_I.stop}</svg></span><span class="tbb" data-a="close"><svg viewBox="0 0 24 24">${ACCESS_I.down}</svg></span></div>` : ""}
    </div>`;
  }

  _update() {
    const c = this._config;
    const e = this._els;
    if (!this._hass || !this._built) return;

    const covers = this._covers();
    const locks = this._locks();
    const openings = this._openings();
    const openCovers = covers.filter((x) => !CLOSED_STATES.includes(x.state));
    const unlocked = locks.filter((x) => x.state !== "locked");
    const openSensors = openings.filter((x) => x.state === "on");
    const totalOpen = openCovers.length + unlocked.length + openSensors.length;

    e.sub.textContent = totalOpen ? `${totalOpen} ouvert${totalOpen > 1 ? "s" : ""} sur ${covers.length + locks.length + openings.length}` : "Tout est fermé";
    e.badge.textContent = totalOpen || "OK";
    e.badge.className = `cc ${totalOpen ? "warn" : "ok"}`;
    e.badge.classList.remove("hidden");
    e.icon.className = `ci ${totalOpen ? "warn" : "ok"}`;

    const sig = [...covers, ...locks, ...openings].map((x) => `${x.entity_id}:${x.state}:${x.position ?? ""}`).join("|") + `#${c.max_tiles}`;

    e.ops.querySelectorAll(".op").forEach((el) => {
      const st = this._hass.states[el.dataset.e];
      const t = el.querySelector(".opa");
      if (st && t) t.textContent = this._ago(st.last_changed);
    });

    if (sig === this._sig) return;
    this._sig = sig;

    const tiles = [
      ...covers.slice(0, c.max_tiles).map((x) => this._tile(x, "cover")),
      ...locks.slice(0, Math.max(0, c.max_tiles - covers.length)).map((x) => this._tile(x, "lock")),
    ];
    e.tiles.innerHTML = tiles.join("");
    e.tiles.classList.toggle("hidden", !tiles.length);

    e.tiles.querySelectorAll(".tl").forEach((el) => {
      const id = el.dataset.e;
      const kind = el.dataset.k;
      el.querySelectorAll(".tbb").forEach((btn) =>
        btn.addEventListener("click", (ev) => { ev.stopPropagation(); this._cover(btn.dataset.a, id); })
      );
      el.addEventListener("click", () => {
        if (kind === "lock") this._toggleLock(id);
        else fireEvent(this, "hass-more-info", { entityId: id });
      });
    });

    e.actions.classList.toggle("hidden", !c.global_actions || covers.length < 2);

    if (openSensors.length) {
      e.secOpen.classList.remove("hidden");
      e.ops.innerHTML = openSensors.map((x) =>
        `<div class="op" data-e="${x.entity_id}">
          <svg viewBox="0 0 24 24">${OPEN_ICON[x.device_class] || ACCESS_I.door}</svg>
          <span class="opn">${x.name}${x.area ? `<i>${x.area}</i>` : ""}</span>
          <span class="opa">${this._ago(x.last_changed)}</span></div>`
      ).join("");
      e.ops.querySelectorAll(".op").forEach((el) =>
        el.addEventListener("click", () => fireEvent(this, "hass-more-info", { entityId: el.dataset.e }))
      );
    } else e.secOpen.classList.add("hidden");

    const closedSensors = openings.filter((x) => x.state !== "on");
    if (c.show_all_openings && closedSensors.length) {
      e.acc.classList.remove("hidden");
      e.accLabel.textContent = openSensors.length ? "Ouvertures fermées" : "Tout est fermé";
      e.accTotal.textContent = `${closedSensors.length} capteur${closedSensors.length > 1 ? "s" : ""}`;
      e.accBody.innerHTML = closedSensors.map((x) =>
        `<div class="op cl" data-e="${x.entity_id}">
          <svg viewBox="0 0 24 24">${OPEN_ICON[x.device_class] || ACCESS_I.door}</svg>
          <span class="opn">${x.name}${x.area ? `<i>${x.area}</i>` : ""}</span>
          <span class="opa">Fermé</span></div>`
      ).join("");
      e.accBody.querySelectorAll(".op").forEach((el) =>
        el.addEventListener("click", () => fireEvent(this, "hass-more-info", { entityId: el.dataset.e }))
      );
      e.acc.open = this._openRest;
    } else e.acc.classList.add("hidden");

    const bits = [];
    const hidden = covers.length + locks.length - tiles.length;
    if (hidden > 0) bits.push(`${hidden} autre${hidden > 1 ? "s" : ""} ouvrant masqué`);
    const last = [...covers, ...locks, ...openings].sort((a, b) => new Date(b.last_changed) - new Date(a.last_changed))[0];
    if (last) bits.push(`Dernier mouvement · ${last.name} il y a ${this._ago(last.last_changed)}`);
    e.foot.textContent = bits.join(" · ");
    e.foot.classList.toggle("hidden", !bits.length);
  }
}

AccessCard.styles = `
:host{--ac-ok:#8fbfae;--ac-warn:#ffc76b;display:block;}
*{box-sizing:border-box;}
.hidden{display:none !important;}
ha-card{border-radius:var(--ha-card-border-radius,18px);padding:16px 16px 14px;background:linear-gradient(170deg,#1a1d24 0%,#15181e 60%,#111318 100%);border:1px solid rgba(255,255,255,.06);color:#eef1f6;font-family:var(--primary-font-family,"Inter","Segoe UI",Roboto,sans-serif);}
.ch{display:flex;align-items:center;gap:11px;}
.ci{width:34px;height:34px;border-radius:11px;flex-shrink:0;background:rgba(143,191,174,.10);border:1px solid rgba(143,191,174,.26);display:flex;align-items:center;justify-content:center;}
.ci svg{width:17px;height:17px;fill:var(--ac-ok);}
.ci.warn{background:rgba(255,199,107,.10);border-color:rgba(255,199,107,.28);}
.ci.warn svg{fill:var(--ac-warn);}
.ct{flex:1;min-width:0;}
.ct b{display:block;font-size:14px;font-weight:600;}
.ct .sub{display:block;font-size:10.5px;color:rgba(255,255,255,.42);margin-top:2px;}
.cc{font-size:11px;font-weight:700;border-radius:9px;padding:5px 9px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.6);}
.cc.warn{background:rgba(255,199,107,.12);border-color:rgba(255,199,107,.3);color:var(--ac-warn);}
.cc.ok{background:rgba(143,191,174,.12);border-color:rgba(143,191,174,.3);color:var(--ac-ok);}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:15px;}
@media(max-width:340px){.tiles{grid-template-columns:repeat(2,1fr);}}
.tl{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.075);border-radius:13px;padding:12px 8px 9px;text-align:center;cursor:pointer;transition:.15s;}
.tl:hover{background:rgba(255,255,255,.065);}
.ti{width:19px;height:19px;fill:var(--ac-ok);}
.tl.open .ti,.tl.moving .ti{fill:var(--ac-warn);}
.tl.open,.tl.moving{background:rgba(255,199,107,.08);border-color:rgba(255,199,107,.24);}
.tl b{display:block;font-size:11px;font-weight:600;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tl span{display:block;font-size:9.5px;color:var(--ac-ok);margin-top:3px;}
.tl.open span,.tl.moving span{color:var(--ac-warn);}
.tl.moving span{animation:ac-blink 1.2s infinite;}
@keyframes ac-blink{0%,100%{opacity:1}50%{opacity:.45}}
.tb{display:flex;gap:3px;margin-top:9px;justify-content:center;}
.tbb{flex:1;display:flex;align-items:center;justify-content:center;padding:5px 0;border-radius:7px;background:rgba(255,255,255,.05);transition:.15s;}
.tbb:hover{background:rgba(255,255,255,.12);}
.tbb svg{width:11px;height:11px;fill:rgba(255,255,255,.55);}
.tbb:hover svg{fill:#eef1f6;}
.acb{display:flex;gap:7px;margin-top:9px;}
.ab2{flex:1;text-align:center;font-size:12px;font-weight:600;padding:11px 0;border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);color:rgba(255,255,255,.62);cursor:pointer;transition:.15s;}
.ab2:hover{background:rgba(255,255,255,.08);color:#eef1f6;}
.sec{font-size:8.5px;letter-spacing:1.6px;text-transform:uppercase;color:rgba(255,255,255,.34);font-weight:600;margin:17px 0 6px;}
.ops{display:flex;flex-direction:column;}
.op{display:flex;align-items:center;gap:9px;padding:8px 0;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.045);}
.op:last-child{border-bottom:none;}
.op svg{width:14px;height:14px;fill:var(--ac-warn);flex-shrink:0;}
.op.cl svg{fill:rgba(255,255,255,.3);}
.opn{flex:1;font-size:11.5px;color:rgba(255,255,255,.72);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.opn i{font-style:normal;font-size:9px;color:rgba(255,255,255,.28);margin-left:7px;}
.op.cl .opn{color:rgba(255,255,255,.45);}
.opa{font-size:9.5px;color:var(--ac-warn);flex-shrink:0;font-variant-numeric:tabular-nums;}
.op.cl .opa{color:rgba(255,255,255,.28);}
.acc{margin-top:11px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);padding:0 12px;transition:.2s;}
.acc[open]{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.11);}
.accs{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 0;cursor:pointer;list-style:none;}
.accs::-webkit-details-marker{display:none;}
.k{font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:rgba(255,255,255,.42);font-weight:600;}
.accv{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;color:rgba(255,255,255,.45);}
.car{width:11px;height:11px;fill:rgba(255,255,255,.35);transition:transform .2s;}
.acc[open] .car{transform:rotate(180deg);}
.accb{padding:2px 0 8px;}
.cf{margin-top:13px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07);font-size:9.5px;color:rgba(255,255,255,.34);line-height:1.5;}
`;

if (!customElements.get("access-card")) { customElements.define("access-card", AccessCard); }

window.customCards = window.customCards || [];
window.customCards.push({
  type: "access-card",
  name: "Access Card (auto)",
  description: "Portails, garages, volets, serrures et ouvertures découverts automatiquement.",
  preview: false,
  documentationURL: "https://github.com/junkoku38/ha-auto-cards",
});

/* ---------- Visual editor ---------- */

class AccessCardEditor extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }); this._config = {}; this._sections = { display: true, filters: false }; }
  setConfig(config) {
    this._config = { name: "Accès", exclude: [], include: [], areas: null, cover_classes: null, exclude_classes: [], max_tiles: 6, show_locks: true, show_openings: true, show_all_openings: true, global_actions: true, ...config };
    this._render();
  }
  set hass(hass) { this._hass = hass; }
  _changed(ev) {
    const field = ev.target.dataset.field; if (!field) return;
    let value = ev.target.value;
    if (ev.target.type === "number") value = value === "" ? 0 : Number(value);
    else if (ev.target.type === "checkbox") value = ev.target.checked;
    else if (["exclude", "include", "areas", "exclude_classes"].includes(field)) { value = value.split(",").map((s) => s.trim()).filter(Boolean); }
    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }
  _toggle(name) {
    this._sections[name] = !this._sections[name];
    const el = this.shadowRoot.querySelector(`[data-section="${name}"]`);
    if (el) { el.classList.toggle("open", this._sections[name]); const chev = el.querySelector(".chev"); if (chev) chev.textContent = this._sections[name] ? "▾" : "▸"; }
  }
  _field(label, field, type, value, placeholder) { const v = value ?? (type === "number" ? 0 : ""); return `<div class="fld"><label>${label}</label><input type="${type}" data-field="${field}" value="${v}" placeholder="${placeholder || ""}"/></div>`; }
  _checkbox(label, field, checked) { return `<div class="fld chk"><label><input type="checkbox" data-field="${field}" ${checked ? "checked" : ""}/> ${label}</label></div>`; }
  _textarea(label, field, value, placeholder) { const v = Array.isArray(value) ? value.join(", ") : value || ""; return `<div class="fld"><label>${label}</label><textarea data-field="${field}" placeholder="${placeholder || ""}">${v}</textarea></div>`; }
  _section(name, label, content) { const open = this._sections[name] || false; return `<div class="sec ${open ? "open" : ""}" data-section="${name}"><div class="sh" data-toggle="${name}"><span>${label}</span><span class="chev">${open ? "▾" : "▸"}</span></div><div class="sb">${content}</div></div>`; }
  _render() {
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;}*{box-sizing:border-box;}
      .ed{display:flex;flex-direction:column;gap:8px;padding:12px;}
      .fld{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}
      .fld label{font-size:11px;font-weight:600;opacity:.7;}
      .fld input,.fld select,.fld textarea{font-size:13px;padding:8px 10px;border-radius:8px;border:1px solid var(--divider-color,#ccc);background:var(--secondary-background-color,#fff);color:var(--primary-text-color);font-family:inherit;}
      .fld textarea{min-height:50px;resize:vertical;}
      .fld.chk label{display:flex;align-items:center;gap:8px;font-size:13px;}
      .fld.chk input{width:auto;}
      .sec{border:1px solid var(--divider-color,#e0e0e0);border-radius:10px;overflow:hidden;}
      .sh{display:flex;align-items:center;padding:10px 12px;cursor:pointer;background:var(--secondary-background-color,#f5f5f5);font-size:13px;font-weight:600;}
      .sh .chev{margin-left:auto;font-size:12px;opacity:.5;}
      .sb{padding:10px 12px;display:none;}
      .sec.open .sb{display:block;}
    </style>
    <div class="ed">
      ${this._field("Titre", "name", "text", c.name, "Accès")}
      ${this._section("display", "Affichage",
        this._field("Max tuiles visibles", "max_tiles", "number", c.max_tiles) +
        this._checkbox("Afficher serrures", "show_locks", c.show_locks) +
        this._checkbox("Afficher ouvertures", "show_openings", c.show_openings) +
        this._checkbox("Afficher ouvertures fermées", "show_all_openings", c.show_all_openings) +
        this._checkbox("Boutons tout ouvrir/fermer", "global_actions", c.global_actions)
      )}
      ${this._section("filters", "Filtres",
        this._textarea("Exclure (mots-clés)", "exclude", c.exclude, "volet, porte") +
        this._textarea("Inclure (entity_id)", "include", c.include, "cover.xxx") +
        this._textarea("Pièces (restreindre)", "areas", c.areas, "salon, cuisine") +
        this._textarea("Classes à exclure", "exclude_classes", c.exclude_classes, "shutter, blind")
      )}
    </div>`;
    this.shadowRoot.querySelectorAll("input, select, textarea").forEach((el) => { el.addEventListener("change", (e) => this._changed(e)); el.addEventListener("input", (e) => this._changed(e)); });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => { el.addEventListener("click", () => this._toggle(el.dataset.toggle)); });
  }
}

if (!customElements.get("access-card-editor")) { customElements.define("access-card-editor", AccessCardEditor); }
/**
 * Equipment Card — découverte automatique
 * Capteurs techniques avec détection d'écart sur 7 jours.
 */

const EQUIPMENT_CARD_VERSION = "1.0.0";

console.info(
  `%c EQUIPMENT-CARD %c v${EQUIPMENT_CARD_VERSION} `,
  "color:#15181e;background:#ffc76b;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#ffc76b;background:#15181e;border-radius:0 3px 3px 0;padding:2px 6px"
);

const EQUIPMENT_I = {
  thermo: `<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0zM12 4a1 1 0 0 1 1 1v6h-2V5a1 1 0 0 1 1-1z"/>`,
  caret: `<path d="M7 10l5 5 5-5z"/>`,
  up: `<path d="M12 5l7 8h-4v6h-6v-6H5z"/>`,
  down: `<path d="M12 19l-7-8h4V5h6v6h4z"/>`,
};

const DEFAULT_MATCH = [
  "ballon","chauffe-eau","chauffe eau","chaudiere","pompe","portail","portillon",
  "garage","detecteur","alarme","congelateur","frigo","refrigerateur","cave",
  "atelier","local","technique","serveur","baie","onduleur","compteur",
  "piscine","bassin","vmc",
];

class EquipmentCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._els = {};
    this._base = null;
    this._fetchedAt = 0;
    this._busy = false;
    this._tick = null;
    this._sig = "";
    this._openAll = false;
  }

  setConfig(config) {
    this._config = {
      name: "Équipements",
      match: DEFAULT_MATCH,
      exclude: [],
      include: [],
      device_classes: ["temperature"],
      baseline_days: 7,
      deviation: 5,
      refresh: 3600,
      max_rows: 0,
      show_baseline: true,
      thresholds: {},
      ...(config || {}),
    };
    this._built = false;
    this._sig = "";
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  static getStubConfig() { return { type: "custom:equipment-card" }; }

  static getConfigElement() {
    return document.createElement("equipment-card-editor");
  }

  getCardSize() { return 8; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
    if (first) this._fetchBaseline();
  }

  connectedCallback() {
    this._tick = setInterval(() => {
      this._update();
      if (Date.now() - this._fetchedAt > this._config.refresh * 1000) this._fetchBaseline();
    }, 30000);
  }

  disconnectedCallback() {
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
  }

  _collect() {
    const c = this._config;
    const matchPat = c.match.map(norm).filter(Boolean);
    const all = discover(this._hass, {
      domains: ["sensor"],
      deviceClasses: c.device_classes,
      includeDiagnostic: true,
      exclude: c.exclude,
      include: c.include,
      requireNumeric: true,
    });
    return all
      .filter((it) => {
        if (c.include.includes(it.entity_id)) return true;
        const label = norm(`${it.entity_id} ${it.name} ${it.area || ""}`);
        return matchPat.some((p) => label.includes(p));
      })
      .map((it) => {
        const base = this._base?.[it.entity_id] ?? null;
        const th = c.thresholds[it.entity_id];
        let level = "ok";
        let note = "";
        if (th && Array.isArray(th)) {
          if (it.value < th[0]) { level = "warn"; note = `sous ${th[0]}`; }
          else if (it.value > th[1]) { level = "warn"; note = `au-dessus de ${th[1]}`; }
        } else if (base != null) {
          const d = it.value - base;
          if (Math.abs(d) >= c.deviation) { level = "warn"; note = `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} vs moy.`; }
        }
        return { ...it, base, level, note, delta: base != null ? it.value - base : null };
      })
      .sort((a, b) =>
        (b.level === "warn") - (a.level === "warn") ||
        Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || b.value - a.value
      );
  }

  async _fetchBaseline() {
    const c = this._config;
    if (!c.show_baseline || this._busy || !this._hass) return;
    const ids = this._collect().filter((it) => it.state_class === "measurement").map((it) => it.entity_id).slice(0, 40);
    if (!ids.length) { this._fetchedAt = Date.now(); return; }
    this._busy = true;
    try {
      const end = new Date();
      const start = new Date(end.getTime() - c.baseline_days * 86400 * 1000);
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: ids,
        period: "day",
        types: ["mean"],
      });
      const base = {};
      Object.keys(res || {}).forEach((id) => {
        const means = (res[id] || []).map((r) => r.mean).filter((v) => v != null);
        if (means.length) base[id] = means.reduce((a, b) => a + b, 0) / means.length;
      });
      this._base = base;
    } catch (err) {
      this._base = this._base || {};
    } finally {
      this._busy = false;
      this._fetchedAt = Date.now();
      this._sig = "";
      this._update();
    }
  }

  _build() {
    this.shadowRoot.innerHTML = `<style>${EquipmentCard.styles}</style>
      <ha-card>
        <div class="ch">
          <div class="ci"><svg viewBox="0 0 24 24">${EQUIPMENT_I.thermo}</svg></div>
          <div class="ct"><b>${this._config.name}</b><span class="sub">—</span></div>
          <div class="cc hidden">—</div>
        </div>
        <div class="secw sec-warn hidden"><div class="sec">Écarts détectés</div><div class="rows warn-rows"></div></div>
        <div class="secw sec-ok hidden"><div class="sec ok-title">Capteurs techniques</div><div class="rows ok-rows"></div></div>
        <details class="acc hidden"><summary class="accs"><span class="k">Tous les capteurs</span><span class="accv"><span class="rt">—</span><svg class="car" viewBox="0 0 24 24">${EQUIPMENT_I.caret}</svg></span></summary><div class="accb"></div></details>
        <div class="cf hidden"></div>
      </ha-card>`;
    this._built = true;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._els = {
      sub: $(".ct .sub"), badge: $(".cc"),
      secWarn: $(".sec-warn"), warnRows: $(".warn-rows"),
      secOk: $(".sec-ok"), okTitle: $(".ok-title"), okRows: $(".ok-rows"),
      acc: $(".acc"), accTotal: $(".accs .rt"), accBody: $(".accb"),
      foot: $(".cf"),
    };
    this._els.acc.addEventListener("toggle", () => { this._openAll = this._els.acc.open; });
  }

  _fmt(v, dec = 1) {
    if (v == null || Number.isNaN(v)) return "—";
    return new Intl.NumberFormat(this._hass?.locale?.language || "fr", { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
  }

  _cleanName(name) {
    return (name || "")
      .replace(/\s*Temperature\s*/gi, "")
      .replace(/\s*Humidity\s*/gi, "")
      .replace(/\s*Humidité\s*/gi, "")
      .replace(/\s*Power\s*/gi, "")
      .replace(/\s*Puissance\s*/gi, "")
      .replace(/\s*\[\w+\]\s*/g, "")
      .replace(/\s{2,}/g, " ")
      .trim() || name;
  }

  _verdictLabel(it) {
    if (it.level === "warn") {
      if (it.note) return it.note;
      return "Attention";
    }
    return "OK";
  }

  _row(it) {
    const unit = (it.unit || "").trim();
    const up = (it.delta ?? 0) > 0;
    const trend = it.delta != null && Math.abs(it.delta) >= 0.5
      ? `<span class="dl ${it.level}"><svg viewBox="0 0 24 24">${up ? EQUIPMENT_I.up : EQUIPMENT_I.down}</svg>${this._fmt(Math.abs(it.delta), 1)}${unit}</span>` : "";
    const cleanName = this._cleanName(it.name);
    const verdict = this._verdictLabel(it);
    return `<div class="eqr ${it.level}" data-e="${it.entity_id}">
      <span class="eq-ico"><svg viewBox="0 0 24 24">${EQUIPMENT_I.thermo}</svg></span>
      <div class="eq-info">
        <span class="eqn">${cleanName}${it.area ? `<i>${it.area}</i>` : ""}</span>
        <span class="eq-verdict ${it.level}">${verdict}</span>
      </div>
      ${trend}
      <span class="eqv">${this._fmt(it.value, 1)}<span class="eq-unit">${unit}</span></span>
    </div>`;
  }

  _update() {
    const c = this._config;
    const e = this._els;
    if (!this._hass || !this._built) return;
    const items = this._collect();
    const warn = items.filter((i) => i.level === "warn");
    const ok = items.filter((i) => i.level !== "warn");

    e.sub.textContent = items.length
      ? warn.length ? `${items.length} capteurs · ${warn.length} écart${warn.length > 1 ? "s" : ""}` : `${items.length} capteurs · tout est nominal`
      : "Aucun capteur technique trouvé";
    e.badge.textContent = warn.length || "OK";
    e.badge.className = `cc ${warn.length ? "warn" : "ok"}`;
    e.badge.classList.remove("hidden");

    const sig = items.map((i) => `${i.entity_id}:${i.value.toFixed(1)}:${i.level}`).join("|") + `#${this._base ? Object.keys(this._base).length : 0}`;
    if (sig === this._sig) return;
    this._sig = sig;

    if (warn.length) {
      e.secWarn.classList.remove("hidden");
      e.warnRows.innerHTML = warn.map((it) => this._row(it)).join("");
    } else e.secWarn.classList.add("hidden");

    const shown = c.max_rows ? ok.slice(0, c.max_rows) : ok;
    if (shown.length) {
      e.secOk.classList.remove("hidden");
      e.okTitle.textContent = warn.length ? "Autres capteurs" : "Capteurs techniques";
      e.okRows.innerHTML = shown.map((it) => this._row(it)).join("");
    } else e.secOk.classList.add("hidden");

    if (c.max_rows && ok.length > c.max_rows) {
      const rest = ok.slice(c.max_rows);
      e.acc.classList.remove("hidden");
      e.accTotal.textContent = `${rest.length} de plus`;
      e.accBody.innerHTML = rest.map((it) => this._row(it)).join("");
      e.acc.open = this._openAll;
    } else e.acc.classList.add("hidden");

    this.shadowRoot.querySelectorAll(".eqr").forEach((el) =>
      el.addEventListener("click", () => fireEvent(this, "hass-more-info", { entityId: el.dataset.e }))
    );

    const bits = [];
    if (this._base && Object.keys(this._base).length) bits.push(`Écarts calculés sur ${c.baseline_days} jours`);
    else if (c.show_baseline) bits.push("Statistiques indisponibles : écarts non calculés");
    if (!items.length) bits.push("Ajustez la liste « match » pour désigner vos capteurs techniques");
    e.foot.textContent = bits.join(" · ");
    e.foot.classList.toggle("hidden", !bits.length);
  }
}

EquipmentCard.styles = `
:host{--eq-warn:#ffc76b;--eq-ok:#8fbfae;display:block;}
*{box-sizing:border-box;}
.hidden{display:none !important;}
ha-card{border-radius:var(--ha-card-border-radius,18px);padding:16px 16px 14px;background:linear-gradient(170deg,#1a1d24 0%,#15181e 60%,#111318 100%);border:1px solid rgba(255,255,255,.06);color:#eef1f6;font-family:var(--primary-font-family,"Inter","Segoe UI",Roboto,sans-serif);}
.ch{display:flex;align-items:center;gap:11px;}
.ci{width:34px;height:34px;border-radius:11px;flex-shrink:0;background:rgba(255,199,107,.10);border:1px solid rgba(255,199,107,.26);display:flex;align-items:center;justify-content:center;}
.ci svg{width:17px;height:17px;fill:var(--eq-warn);}
.ct{flex:1;min-width:0;}
.ct b{display:block;font-size:14px;font-weight:600;}
.ct .sub{display:block;font-size:10.5px;color:rgba(255,255,255,.42);margin-top:2px;}
.cc{font-size:11px;font-weight:700;border-radius:9px;padding:5px 9px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.6);}
.cc.warn{background:rgba(255,199,107,.12);border-color:rgba(255,199,107,.3);color:var(--eq-warn);}
.cc.ok{background:rgba(143,191,174,.12);border-color:rgba(143,191,174,.3);color:var(--eq-ok);}
.sec{font-size:8.5px;letter-spacing:1.6px;text-transform:uppercase;color:rgba(255,255,255,.34);font-weight:600;margin:16px 0 4px;}
.rows{display:flex;flex-direction:column;}
.eqr{display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);}
.eqr:last-child{border-bottom:none;}
.eqr:hover .eqn{color:#eef1f6;}
.eq-ico{width:28px;height:28px;border-radius:8px;flex-shrink:0;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;}
.eq-ico svg{width:14px;height:14px;fill:rgba(255,255,255,.4);}
.eqr.warn .eq-ico{background:rgba(255,199,107,.12);}
.eqr.warn .eq-ico svg{fill:var(--eq-warn);}
.eq-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.eqn{font-size:12px;color:rgba(255,255,255,.75);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:.15s;}
.eqn i{font-style:normal;font-size:9px;color:rgba(255,255,255,.26);margin-left:7px;}
.eq-verdict{font-size:9.5px;font-weight:600;color:var(--eq-ok);}
.eq-verdict.warn{color:var(--eq-warn);}
.dl{display:flex;align-items:center;gap:3px;font-size:9.5px;font-weight:600;color:rgba(255,255,255,.35);flex-shrink:0;font-variant-numeric:tabular-nums;}
.dl svg{width:9px;height:9px;fill:currentColor;}
.dl.warn{color:var(--eq-warn);}
.eqv{font-size:14px;font-weight:600;width:80px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums;letter-spacing:-.2px;}
.eq-unit{font-size:10px;font-weight:500;color:rgba(255,255,255,.55);margin-left:2px;}
.eqr.warn .eqv{color:var(--eq-warn);}
.eqr.warn .eq-unit{color:var(--eq-warn);}
.acc{margin-top:11px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);padding:0 12px;transition:.2s;}
.acc[open]{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.11);}
.accs{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 0;cursor:pointer;list-style:none;}
.accs::-webkit-details-marker{display:none;}
.k{font-size:9px;letter-spacing:1.8px;text-transform:uppercase;color:rgba(255,255,255,.42);font-weight:600;}
.accv{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;color:rgba(255,255,255,.45);}
.car{width:11px;height:11px;fill:rgba(255,255,255,.35);transition:transform .2s;}
.acc[open] .car{transform:rotate(180deg);}
.accb{padding:2px 0 8px;}
.cf{margin-top:13px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07);font-size:9.5px;color:rgba(255,255,255,.34);line-height:1.5;}
`;

if (!customElements.get("equipment-card")) { customElements.define("equipment-card", EquipmentCard); }

window.customCards = window.customCards || [];
window.customCards.push({
  type: "equipment-card",
  name: "Equipment Card (auto)",
  description: "Capteurs techniques découverts automatiquement, avec détection d'écart sur 7 jours.",
  preview: false,
  documentationURL: "https://github.com/junkoku38/ha-auto-cards",
});

/* ---------- Visual editor ---------- */

class EquipmentCardEditor extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }); this._config = {}; this._sections = { match: true, display: false, baseline: false }; }
  setConfig(config) {
    this._config = { name: "Équipements", match: DEFAULT_MATCH, exclude: [], include: [], device_classes: ["temperature"], baseline_days: 7, deviation: 5, refresh: 3600, max_rows: 0, show_baseline: true, thresholds: {}, ...config };
    this._render();
  }
  set hass(hass) { this._hass = hass; }
  _changed(ev) {
    const field = ev.target.dataset.field; if (!field) return;
    let value = ev.target.value;
    if (ev.target.type === "number") value = value === "" ? 0 : Number(value);
    else if (ev.target.type === "checkbox") value = ev.target.checked;
    else if (["match", "exclude", "include", "device_classes"].includes(field)) { value = value.split(",").map((s) => s.trim()).filter(Boolean); }
    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }
  _toggle(name) {
    this._sections[name] = !this._sections[name];
    const el = this.shadowRoot.querySelector(`[data-section="${name}"]`);
    if (el) { el.classList.toggle("open", this._sections[name]); const chev = el.querySelector(".chev"); if (chev) chev.textContent = this._sections[name] ? "▾" : "▸"; }
  }
  _field(label, field, type, value, placeholder) { const v = value ?? (type === "number" ? 0 : ""); return `<div class="fld"><label>${label}</label><input type="${type}" data-field="${field}" value="${v}" placeholder="${placeholder || ""}"/></div>`; }
  _checkbox(label, field, checked) { return `<div class="fld chk"><label><input type="checkbox" data-field="${field}" ${checked ? "checked" : ""}/> ${label}</label></div>`; }
  _textarea(label, field, value, placeholder) { const v = Array.isArray(value) ? value.join(", ") : value || ""; return `<div class="fld"><label>${label}</label><textarea data-field="${field}" placeholder="${placeholder || ""}">${v}</textarea></div>`; }
  _section(name, label, content) { const open = this._sections[name] || false; return `<div class="sec ${open ? "open" : ""}" data-section="${name}"><div class="sh" data-toggle="${name}"><span>${label}</span><span class="chev">${open ? "▾" : "▸"}</span></div><div class="sb">${content}</div></div>`; }
  _render() {
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;}*{box-sizing:border-box;}
      .ed{display:flex;flex-direction:column;gap:8px;padding:12px;}
      .fld{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}
      .fld label{font-size:11px;font-weight:600;opacity:.7;}
      .fld input,.fld select,.fld textarea{font-size:13px;padding:8px 10px;border-radius:8px;border:1px solid var(--divider-color,#ccc);background:var(--secondary-background-color,#fff);color:var(--primary-text-color);font-family:inherit;}
      .fld textarea{min-height:50px;resize:vertical;}
      .fld.chk label{display:flex;align-items:center;gap:8px;font-size:13px;}
      .fld.chk input{width:auto;}
      .sec{border:1px solid var(--divider-color,#e0e0e0);border-radius:10px;overflow:hidden;}
      .sh{display:flex;align-items:center;padding:10px 12px;cursor:pointer;background:var(--secondary-background-color,#f5f5f5);font-size:13px;font-weight:600;}
      .sh .chev{margin-left:auto;font-size:12px;opacity:.5;}
      .sb{padding:10px 12px;display:none;}
      .sec.open .sb{display:block;}
    </style>
    <div class="ed">
      ${this._field("Titre", "name", "text", c.name, "Équipements")}
      ${this._section("match", "Capteurs à surveiller",
        this._textarea("Mots-clés (nom, pièce)", "match", c.match, "ballon, portail, frigo") +
        this._textarea("Exclure", "exclude", c.exclude, "sensor.xxx") +
        this._textarea("Inclure (entity_id)", "include", c.include, "sensor.xxx") +
        this._textarea("Device classes", "device_classes", c.device_classes, "temperature, humidity")
      )}
      ${this._section("display", "Affichage",
        this._field("Lignes max (0 = illimité)", "max_rows", "number", c.max_rows) +
        this._field("Écart d'alerte (unité)", "deviation", "number", c.deviation)
      )}
      ${this._section("baseline", "Statistiques",
        this._checkbox("Calculer les écarts", "show_baseline", c.show_baseline) +
        this._field("Période de référence (jours)", "baseline_days", "number", c.baseline_days) +
        this._field("Rafraîchissement (secondes)", "refresh", "number", c.refresh)
      )}
    </div>`;
    this.shadowRoot.querySelectorAll("input, select, textarea").forEach((el) => { el.addEventListener("change", (e) => this._changed(e)); el.addEventListener("input", (e) => this._changed(e)); });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => { el.addEventListener("click", () => this._toggle(el.dataset.toggle)); });
  }
}

if (!customElements.get("equipment-card-editor")) { customElements.define("equipment-card-editor", EquipmentCardEditor); }
