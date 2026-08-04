/**
 * Comfort Card — éditeur visuel
 * Sections repliables : Apparence, Découverte, Seuils, Tri
 */

class ComfortCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._sections = {};
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._render();
  }

  _changed(ev) {
    const field = ev.target.dataset.field;
    if (!field) return;
    let value = ev.target.value;

    // Convertir les types
    if (ev.target.type === "number") value = value === "" ? 0 : Number(value);
    else if (ev.target.type === "checkbox") value = ev.target.checked;
    else if (field === "exclude" || field === "include" || field === "areas") {
      value = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const newConfig = { ...this._config, [field]: value };
    this._config = newConfig;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: newConfig },
        bubbles: true,
        composed: true,
      })
    );
  }

  _toggleSection(name) {
    this._sections[name] = !this._sections[name];
    const el = this.shadowRoot.querySelector(`[data-section="${name}"]`);
    if (el) {
      el.classList.toggle("open", this._sections[name]);
      const chevron = el.querySelector(".chev");
      if (chevron) chevron.textContent = this._sections[name] ? "▾" : "▸";
    }
  }

  _section(name, label, icon, content) {
    const open = this._sections[name] || false;
    return `
      <div class="sec ${open ? "open" : ""}" data-section="${name}">
        <div class="sh" data-toggle="${name}">
          <ha-icon icon="${icon}"></ha-icon>
          <span>${label}</span>
          <span class="chev">${open ? "▾" : "▸"}</span>
        </div>
        <div class="sb">${content}</div>
      </div>`;
  }

  _field(label, field, type = "text", value, placeholder = "", extra = "") {
    const v = value ?? (type === "number" ? 0 : "");
    return `
      <div class="fld">
        <label>${label}</label>
        <input type="${type}" data-field="${field}" value="${v}" placeholder="${placeholder}" ${extra}
          @change="${(e) => this._changed(e)}" @input="${(e) => this._changed(e)}"/>
      </div>`;
  }

  _select(label, field, options, value) {
    const opts = options
      .map(
        (o) =>
          `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${o.label}</option>`
      )
      .join("");
    return `
      <div class="fld">
        <label>${label}</label>
        <select data-field="${field}" @change="${(e) => this._changed(e)}">${opts}</select>
      </div>`;
  }

  _checkbox(label, field, checked) {
    return `
      <div class="fld chk">
        <label>
          <input type="checkbox" data-field="${field}" ${checked ? "checked" : ""}
            @change="${(e) => this._changed(e)}"/>
          ${label}
        </label>
      </div>`;
  }

  _textarea(label, field, value, placeholder = "") {
    const v = Array.isArray(value) ? value.join(", ") : value || "";
    return `
      <div class="fld">
        <label>${label}</label>
        <textarea data-field="${field}" placeholder="${placeholder}"
          @change="${(e) => this._changed(e)}" @input="${(e) => this._changed(e)}">${v}</textarea>
      </div>`;
  }

  _render() {
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>${ComfortCardEditor.styles}</style>
      <div class="ed">
        ${this._field("Titre", "name", "text", c.name, "Confort par pièce")}

        ${this._section("discover", "Découverte", "mdi:magnify",
          this._textarea("Exclure (mots-clés, séparés par virgules)", "exclude", c.exclude, "ballon, weather, cpu") +
          this._textarea("Inclure (entity_id, séparés par virgules)", "include", c.include, "sensor.mon_capteur") +
          this._textarea("Pièces (restreindre, séparés par virgules)", "areas", c.areas, "salon, cuisine") +
          this._checkbox("Afficher les capteurs sans pièce", "show_unassigned", c.show_unassigned) +
          this._checkbox("Inclure les entités de diagnostic", "include_diagnostic", c.include_diagnostic) +
          this._select("Plusieurs capteurs par pièce", "multiple", [
            { value: "average", label: "Moyenne" },
            { value: "first", label: "Premier trouvé" },
          ], c.multiple)
        )}

        ${this._section("thresholds", "Seuils de confort", "mdi:thermostat",
          this._field("Température basse (°C)", "temp_low", "number", c.temp_low) +
          this._field("Température haute (°C)", "temp_high", "number", c.temp_high) +
          this._field("Humidité basse (%)", "humidity_low", "number", c.humidity_low) +
          this._field("Humidité haute (%)", "humidity_high", "number", c.humidity_high) +
          this._field("Humidité très haute (%)", "humidity_very_high", "number", c.humidity_very_high)
        )}

        ${this._section("display", "Affichage", "mdi:format-list-bulleted",
          this._field("Lignes max (0 = illimité)", "max_rows", "number", c.max_rows) +
          this._select("Tri", "sort", [
            { value: "discomfort", label: "Inconfort (défaut)" },
            { value: "name", label: "Nom de pièce" },
            { value: "temperature", label: "Température" },
            { value: "humidity", label: "Humidité" },
          ], c.sort) +
          this._field("Entité extérieur (auto si vide)", "outdoor", "text", c.outdoor, "weather.maison")
        )}
      </div>
    `;

    // Attacher les events de toggle
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => this._toggleSection(el.dataset.toggle));
    });
  }
}

ComfortCardEditor.styles = `
:host{display:block;}
*{box-sizing:border-box;}
.ed{display:flex;flex-direction:column;gap:8px;padding:12px;}

.fld{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}
.fld label{font-size:11px;font-weight:600;color:var(--primary-text-color);opacity:.7;}
.fld input, .fld select, .fld textarea{
  font-size:13px;padding:8px 10px;border-radius:8px;
  border:1px solid var(--input-border-color,#ccc);
  background:var(--input-background-color,#fff);
  color:var(--primary-text-color);
  font-family:inherit;
}
.fld textarea{min-height:50px;resize:vertical;}
.fld.chk label{display:flex;align-items:center;gap:8px;font-size:13px;}
.fld.chk input{width:auto;}

.sec{border:1px solid var(--divider-color,#e0e0e0);border-radius:10px;overflow:hidden;}
.sh{
  display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;
  background:var(--secondary-background-color,#f5f5f5);
  font-size:13px;font-weight:600;color:var(--primary-text-color);
}
.sh ha-icon{--mdc-icon-size:18px;color:var(--primary-color);}
.sh .chev{margin-left:auto;font-size:12px;opacity:.5;}
.sb{padding:10px 12px;display:none;}
.sec.open .sb{display:block;}
`;

if (!customElements.get("comfort-card-editor")) {
  customElements.define("comfort-card-editor", ComfortCardEditor);
}