/**
 * Battery & Availability Card — découverte automatique
 * Piles faibles et appareils injoignables, avec détection de panne commune.
 */

const BATTERY_CARD_VERSION = "1.0.0";

console.info(
  `%c BATTERY-CARD %c v${BATTERY_CARD_VERSION} `,
  "color:#15181e;background:#ff8a7d;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px",
  "color:#ff8a7d;background:#15181e;border-radius:0 3px 3px 0;padding:2px 6px"
);

/* ---------- Icons ---------- */

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
      name: "Piles et disponibilité",
      critical: 15,
      warning: 30,
      exclude: [],
      include: [],
      areas: null,
      show_offline: true,
      include_unknown: true,
      max_offline: 8,
      show_all_batteries: true,
      group_offline_by_device: true,
      outage_window: 180,
      outage_min: 3,
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

  getCardSize() { return 9; }

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

  _offline() {
    const c = this._config;
    if (!c.show_offline) return [];
    const hass = this._hass;
    const bad = c.include_unknown ? ["unavailable", "unknown"] : ["unavailable"];
    const exPat = c.exclude.map(norm).filter(Boolean);
    const out = [];

    Object.keys(hass.states).forEach((id) => {
      const st = hass.states[id];
      if (!bad.includes(st.state)) return;
      const domain = id.split(".")[0];
      if (!OFFLINE_DOMAINS.includes(domain)) return;
      const reg = hass.entities?.[id];
      if (reg?.hidden || reg?.disabled_by) return;
      const label = norm(`${id} ${st.attributes?.friendly_name || ""}`);
      if (exPat.some((p) => label.includes(p))) return;

      out.push({
        entity_id: id,
        name: st.attributes?.friendly_name || id,
        device: deviceName(hass, id),
        device_id: hass.entities?.[id]?.device_id || null,
        state: st.state,
        last_changed: st.last_changed,
        area: areaName(hass, areaOf(hass, id)),
      });
    });

    if (!c.group_offline_by_device) return out;

    const groups = new Map();
    out.forEach((o) => {
      const key = o.device_id || o.entity_id;
      if (!groups.has(key))
        groups.set(key, {
          key,
          name: o.device || o.name,
          entity_id: o.entity_id,
          state: o.state,
          last_changed: o.last_changed,
          area: o.area,
          count: 0,
        });
      const g = groups.get(key);
      g.count++;
      if (new Date(o.last_changed) < new Date(g.last_changed)) g.last_changed = o.last_changed;
    });
    return [...groups.values()].sort(
      (a, b) => new Date(b.last_changed) - new Date(a.last_changed)
    );
  }

  _outage(offline) {
    const c = this._config;
    if (offline.length < c.outage_min) return null;
    const times = offline
      .map((o) => new Date(o.last_changed).getTime())
      .sort((a, b) => a - b);
    let best = null;
    for (let i = 0; i < times.length; i++) {
      let j = i;
      while (j < times.length && times[j] - times[i] <= c.outage_window * 1000) j++;
      const n = j - i;
      if (n >= c.outage_min && (!best || n > best.n)) best = { n, at: times[i] };
    }
    return best;
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

        <div class="banner hidden">
          <span class="bd"></span>
          <div><b class="bt">—</b><span class="bs">—</span></div>
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

        <div class="secw sec-off hidden">
          <div class="sec off-title">Hors ligne</div>
          <div class="offs"></div>
        </div>

        <div class="cf hidden"></div>
      </ha-card>`;
    this._built = true;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._els = {
      sub: $(".ct .sub"),
      badge: $(".cc"),
      banner: $(".banner"),
      bTitle: $(".banner .bt"),
      bSub: $(".banner .bs"),
      secBatt: $(".sec-batt"),
      bad: $(".brs"),
      acc: $(".acc"),
      accTotal: $(".accs .rt"),
      accBody: $(".accb"),
      secOff: $(".sec-off"),
      offTitle: $(".off-title"),
      offs: $(".offs"),
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
    const offline = this._offline();
    const shownOff = offline.slice(0, c.max_offline);
    const outage = this._outage(offline);

    const sig =
      bats.map((b) => `${b.entity_id}:${Math.round(b.value)}`).join("|") +
      "#" +
      offline.map((o) => `${o.key || o.entity_id}:${o.state}`).join("|");

    const parts = [];
    if (crit.length) parts.push(`${crit.length} critique${crit.length > 1 ? "s" : ""}`);
    else if (bad.length) parts.push(`${bad.length} à surveiller`);
    if (offline.length) parts.push(`${offline.length} hors ligne`);
    e.sub.textContent = parts.length ? parts.join(" · ") : `${bats.length} piles suivies · tout va bien`;

    const total = crit.length + offline.length;
    e.badge.textContent = total || "OK";
    e.badge.className = `cc ${total ? (crit.length ? "red" : "warn") : "ok"}`;
    e.badge.classList.remove("hidden");

    if (outage) {
      e.banner.classList.remove("hidden");
      e.bTitle.textContent = `${outage.n} appareils tombés en même temps`;
      e.bSub.textContent = `Tous injoignables depuis ${this._hhmm(outage.at)} · panne de passerelle probable`;
    } else e.banner.classList.add("hidden");

    if (e.offTitle && offline.length)
      e.offTitle.textContent = `Hors ligne · depuis ${this._ago(offline[0].last_changed)}`;

    e.offs.querySelectorAll(".ofa").forEach((el, i) => {
      if (shownOff[i]) el.textContent = this._ago(shownOff[i].last_changed);
    });

    if (sig === this._sig) return;
    this._sig = sig;

    if (bad.length) {
      e.secBatt.classList.remove("hidden");
      e.bad.innerHTML = bad.map((b) => this._bRow(b)).join("");
    } else {
      e.secBatt.classList.add("hidden");
    }

    if (c.show_all_batteries && bats.length > bad.length) {
      e.acc.classList.remove("hidden");
      const others = bats.filter((b) => b.value > c.warning);
      e.accTotal.textContent = `${others.length} au-dessus de ${c.warning} %`;
      e.accBody.innerHTML = others.map((b) => this._bRow(b)).join("");
      e.acc.open = this._openAll;
    } else e.acc.classList.add("hidden");

    if (offline.length) {
      e.secOff.classList.remove("hidden");
      e.offs.innerHTML = shownOff
        .map(
          (o) => `<div class="of" data-e="${o.entity_id}">
            <span class="ofd ${o.state === "unknown" ? "unk" : ""}"></span>
            <span class="ofn">${o.name}${o.count > 1 ? `<i>${o.count} entités</i>` : ""}</span>
            <span class="ofa">${this._ago(o.last_changed)}</span></div>`
        )
        .join("");
    } else e.secOff.classList.add("hidden");

    this.shadowRoot.querySelectorAll("[data-e]").forEach((el) =>
      el.addEventListener("click", () =>
        fireEvent(this, "hass-more-info", { entityId: el.dataset.e })
      )
    );

    const bits = [];
    if (offline.length > c.max_offline)
      bits.push(`${offline.length - c.max_offline} autres appareils hors ligne`);
    if (bats.length) {
      const min = Math.min(...bats.map((b) => b.value));
      bits.push(`${bats.length} piles suivies · min ${Math.round(min)} %`);
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
    this._sections = { thresholds: true, display: false, offline: false };
  }

  setConfig(config) {
    this._config = {
      name: "Piles et disponibilité",
      critical: 15,
      warning: 30,
      exclude: [],
      include: [],
      areas: null,
      show_offline: true,
      include_unknown: true,
      max_offline: 8,
      show_all_batteries: true,
      group_offline_by_device: true,
      outage_window: 180,
      outage_min: 3,
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
      ${this._field("Titre", "name", "text", c.name, "Piles et disponibilité")}

      ${this._section("thresholds", "Seuils",
        this._field("Critique (%)", "critical", "number", c.critical) +
        this._field("À surveiller (%)", "warning", "number", c.warning)
      )}

      ${this._section("display", "Découverte & affichage",
        this._textarea("Exclure (mots-clés, virgules)", "exclude", c.exclude, "sensor.xxx") +
        this._textarea("Inclure (entity_id, virgules)", "include", c.include, "sensor.xxx") +
        this._textarea("Pièces (restreindre)", "areas", c.areas, "salon, cuisine") +
        this._checkbox("Afficher toutes les piles", "show_all_batteries", c.show_all_batteries)
      )}

      ${this._section("offline", "Hors ligne & pannes",
        this._checkbox("Afficher les appareils hors ligne", "show_offline", c.show_offline) +
        this._checkbox("Inclure les entités 'unknown'", "include_unknown", c.include_unknown) +
        this._checkbox("Regrouper par appareil", "group_offline_by_device", c.group_offline_by_device) +
        this._field("Max appareils affichés", "max_offline", "number", c.max_offline) +
        this._field("Fenêtre panne (secondes)", "outage_window", "number", c.outage_window) +
        this._field("Min appareils pour panne", "outage_min", "number", c.outage_min)
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