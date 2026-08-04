const CARD_VERSION = "1.0.0-minimal";
console.info(`%c COMFORT-CARD %c v${CARD_VERSION} `, "color:#eef1f6;background:#2a2f3a;font-weight:700;padding:2px 6px", "color:#8fb0c9;background:#15181e;padding:2px 6px");

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

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
  const { domains = null, deviceClasses = null, exclude = [], include = [], requireNumeric = false } = opts;
  const exPat = exclude.map(norm).filter(Boolean);
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
    out.push({ entity_id: id, state: st.state, value: Number(st.state), device_class: st.attributes?.device_class, name: st.attributes?.friendly_name || id, area_id: areaId, area: areaName(hass, areaId) });
  });
  return out;
}

const DEFAULT_EXCLUDE = ["ballon","forecast","meteo","weather","cpu","processeur","batterie","battery"];

class ComfortCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
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
      temp_low: 17,
      temp_high: 26,
      sort: "discomfort",
      ...(config || {}),
    };
    this._built = false;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  static getStubConfig() { return { type: "custom:comfort-card" }; }
  getCardSize() { return 8; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  _collect() {
    const c = this._config;
    const items = discover(this._hass, { domains: ["sensor"], deviceClasses: ["temperature", "humidity"], exclude: c.exclude, include: c.include, areas: c.areas, requireNumeric: true });
    const rooms = new Map();
    items.forEach((it) => {
      const key = it.area_id || "__none__";
      if (key === "__none__" && !c.show_unassigned) return;
      if (!rooms.has(key)) rooms.set(key, { key, name: it.area || "Sans pièce", temps: [], hums: [] });
      const r = rooms.get(key);
      if (it.device_class === "temperature") r.temps.push(it);
      else r.hums.push(it);
    });
    const pick = (arr) => {
      if (!arr.length) return { value: null, entity: null, count: 0 };
      if (c.multiple === "first" || arr.length === 1) return { value: arr[0].value, entity: arr[0].entity_id, count: arr.length };
      return { value: arr.reduce((a, b) => a + b.value, 0) / arr.length, entity: arr[0].entity_id, count: arr.length };
    };
    return [...rooms.values()].map((r) => {
      const t = pick(r.temps);
      const h = pick(r.hums);
      return { ...r, t, h };
    });
  }

  _build() {
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;}
      ha-card{border-radius:18px;padding:16px;background:var(--card-background-color,#1a1d24);border:1px solid rgba(255,255,255,.06);color:var(--primary-text-color,#eef1f6);font-family:var(--primary-font-family,sans-serif);}
      .title{font-size:14px;font-weight:600;margin-bottom:12px;}
      .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px;}
      .row:last-child{border-bottom:none;}
      .room{color:var(--primary-text-color);opacity:.8;}
      .temp{font-weight:600;}
      .hum{color:var(--state-icon-color,#8fb0c9);font-weight:600;margin-left:12px;}
      .kpi{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px;}
      .kpi-item{background:rgba(255,255,255,.04);border-radius:8px;padding:8px;text-align:center;}
      .kpi-label{font-size:9px;text-transform:uppercase;opacity:.5;}
      .kpi-value{font-size:14px;font-weight:600;margin-top:4px;}
      .empty{font-size:12px;opacity:.5;padding:20px 0;text-align:center;}
    </style>
    <ha-card>
      <div class="title"></div>
      <div class="kpi"></div>
      <div class="rows"></div>
      <div class="empty" style="display:none;"></div>
    </ha-card>`;
    this._built = true;
    this._els = {
      title: this.shadowRoot.querySelector(".title"),
      kpi: this.shadowRoot.querySelector(".kpi"),
      rows: this.shadowRoot.querySelector(".rows"),
      empty: this.shadowRoot.querySelector(".empty"),
    };
  }

  _fmt(v, dec = 1) {
    if (v == null || Number.isNaN(v)) return "—";
    return new Intl.NumberFormat("fr", { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
  }

  _update() {
    if (!this._hass || !this._built) return;
    const c = this._config;
    const e = this._els;
    const rows = this._collect();

    e.title.textContent = c.name;

    if (!rows.length) {
      e.empty.style.display = "block";
      e.empty.textContent = "Aucun capteur trouvé. Vérifiez que vos capteurs ont une device_class et sont affectés à une pièce.";
      e.kpi.innerHTML = "";
      e.rows.innerHTML = "";
      return;
    }

    e.empty.style.display = "none";
    const temps = rows.filter((r) => r.t.value != null).map((r) => r.t.value);
    const hums = rows.filter((r) => r.h.value != null).map((r) => r.h.value);
    const avgT = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    const avgH = hums.length ? hums.reduce((a, b) => a + b, 0) / hums.length : null;

    const w = Object.keys(this._hass.states).find((id) => id.startsWith("weather."));
    const out = w ? Number(this._hass.states[w].attributes?.temperature) : null;

    e.kpi.innerHTML = `
      <div class="kpi-item"><div class="kpi-label">Intérieur moy.</div><div class="kpi-value">${this._fmt(avgT)}°C</div></div>
      <div class="kpi-item"><div class="kpi-label">Humidité moy.</div><div class="kpi-value">${this._fmt(avgH, 0)}%</div></div>
      <div class="kpi-item"><div class="kpi-label">Extérieur</div><div class="kpi-value">${this._fmt(out)}°C</div></div>`;

    e.rows.innerHTML = rows.map((r) =>
      `<div class="row"><span class="room">${r.name}</span><span class="temp">${r.t.value != null ? this._fmt(r.t.value) + "°" : "—"}</span><span class="hum">${r.h.value != null ? this._fmt(r.h.value, 0) + "%" : "—"}</span></div>`
    ).join("");
  }
}

if (!customElements.get("comfort-card")) {
  customElements.define("comfort-card", ComfortCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "comfort-card",
  name: "Comfort Card (auto)",
  description: "Température et humidité regroupées par pièce, avec découverte automatique.",
  preview: false,
});
