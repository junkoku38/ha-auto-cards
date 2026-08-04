/**
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
}