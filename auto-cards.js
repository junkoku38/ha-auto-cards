/**
 * Comfort Card — découverte automatique
 * Regroupe température et humidité par pièce, sans configuration d'entités.
 */

const CARD_VERSION = "1.0.4";

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
      if (reg?.entity_category) return;

      const label = norm(`${id} ${st.attributes?.friendly_name || ""}`);
      if (exPat.some((p) => label.includes(p))) return;
      if (requireNumeric && Number.isNaN(Number(st.state))) return;
    }

    const areaId = areaOf(hass, id);
    if (areaFilter) {
      const an = norm(areaName(hass, areaId) || "");
      if (!areaFilter.includes(norm(areaId || "")) && !areaFilter.includes(an)) return;
    }

    out.push({
      entity_id: id,
      state: st.state,
      value: Number(st.state),
      device_class: st.attributes?.device_class,
      name: st.attributes?.friendly_name || id,
      area_id: areaId,
      area: areaName(hass, areaId),
    });
  });
  return out;
}

/* ---------- Card ---------- */

const DEFAULT_EXCLUDE = [
  "ballon", "forecast", "meteo", "weather",
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
      exclude: DEFAULT_EXCLUDE,
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
});