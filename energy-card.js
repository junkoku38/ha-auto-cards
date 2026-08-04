/**
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

function discoverLocal(hass, opts = {}) {
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
  const areaFilter = areas ? areas.map((a) => norm(a)) : null;
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

    out.push({
      entity_id: id,
      state: st.state,
      value: Number(st.state),
      device_class: st.attributes?.device_class,
      unit: st.attributes?.unit_of_measurement,
      name: st.attributes?.friendly_name || id,
      area_id: areaId,
      area: areaName(hass, areaId),
    });
  });
  return out;
}

const discover = (hass, opts) =>
  (window.haAutoCards?.discover || discoverLocal)(hass, opts);

/* ---------- Icons ---------- */

const I = {
  bolt: `<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>`,
  caret: `<path d="M7 10l5 5 5-5z"/>`,
};

const DEFAULT_EXCLUDE = [
  "total", "somme", "cumul", "daily", "journalier",
  "yesterday", "hier", "monthly", "mensuel",
];

const fireEvent = (node, type, detail = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: false, composed: true });
  ev.detail = detail;
  node.dispatchEvent(ev);
};

/* ---------- Card ---------- */

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
      exclude: DEFAULT_EXCLUDE,
      include: [],
      areas: null,
      include_diagnostic: false,
      top: 5,
      standby_threshold: 5,
      min_display: 0.5,
      price: 0.25,
      price_entity: null,
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
          <div class="ci"><svg viewBox="0 0 24 24">${I.bolt}</svg></div>
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
              <svg class="car" viewBox="0 0 24 24">${I.caret}</svg></span></summary>
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
      price_entity: null,
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
        this._field("Prix du kWh", "price", "number", c.price) +
        this._field("Entité prix (optionnel)", "price_entity", "text", c.price_entity, "sensor.tarif_kwh") +
        this._field("Devise", "currency", "text", c.currency, "€") +
        this._field("Entité index total (optionnel)", "energy_total", "text", c.energy_total, "sensor.compteur_total")
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

if (!customElements.get("energy-card-editor")) {
  customElements.define("energy-card-editor", EnergyCardEditor);
}