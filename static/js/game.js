/* Rami 104 — client JS (vanilla, polling AJAX, sans dépendance) */

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Erreur inconnue");
  return data;
}

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Erreur inconnue");
  return data;
}

function playerKey(roomCode) {
  return `rami_player_${roomCode}`;
}

/* ============================================================
   Page d'accueil
   ============================================================ */
const RamiHome = {
  init() {
    document.getElementById("btn-create").addEventListener("click", () => this.create());
    document.getElementById("btn-join").addEventListener("click", () => this.join());
  },

  showError(msg) {
    const el = document.getElementById("home-error");
    el.textContent = msg;
    el.hidden = false;
  },

  async create() {
    const name = document.getElementById("create-name").value.trim();
    if (!name) return this.showError("Entrez votre nom pour créer la table.");
    try {
      const data = await apiPost("/api/room/create", { player_name: name });
      localStorage.setItem(playerKey(data.room_code), data.player_id);
      window.location.href = `/salon/${data.room_code}`;
    } catch (e) {
      this.showError(e.message);
    }
  },

  async join() {
    const code = document.getElementById("join-code").value.trim().toUpperCase();
    const name = document.getElementById("join-name").value.trim();
    if (!code) return this.showError("Entrez le code du salon.");
    if (!name) return this.showError("Entrez votre nom pour rejoindre la table.");
    try {
      const data = await apiPost("/api/room/join", { room_code: code, player_name: name });
      localStorage.setItem(playerKey(data.room_code), data.player_id);
      window.location.href = `/salon/${data.room_code}`;
    } catch (e) {
      this.showError(e.message);
    }
  },
};

/* ============================================================
   Table de jeu
   ============================================================ */
const RamiTable = {
  roomCode: null,
  playerId: null,
  pollTimer: null,
  lastState: null,

  declareMode: false,
  selectedHandId: null,
  assignments: { tri: [], escalier: [], carre: [], groupe4: [] }, // listes de card ids
  handOrder: [], // ordre manuel des cartes en main (glisser-déposer)

  async init(roomCode) {
    this.roomCode = roomCode;
    this.playerId = localStorage.getItem(playerKey(roomCode));

    if (!this.playerId) {
      const name = window.prompt("Vous n'êtes pas identifié sur ce salon.\nEntrez votre nom pour le rejoindre :");
      if (!name) {
        window.location.href = "/";
        return;
      }
      try {
        const data = await apiPost("/api/room/join", { room_code: roomCode, player_name: name });
        this.playerId = data.player_id;
        localStorage.setItem(playerKey(roomCode), this.playerId);
      } catch (e) {
        alert("Impossible de rejoindre le salon : " + e.message);
        window.location.href = "/";
        return;
      }
    }

    this.bindEvents();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 1500);
  },

  bindEvents() {
    document.getElementById("btn-copy-link").addEventListener("click", () => {
      const url = `${window.location.origin}/salon/${this.roomCode}`;
      navigator.clipboard?.writeText(url).then(
        () => this.flashHint("btn-copy-link", "Lien copié !"),
        () => window.prompt("Copiez ce lien :", url)
      );
    });

    document.getElementById("btn-start").addEventListener("click", async () => {
      const force = document.getElementById("force-start").checked;
      try {
        await apiPost(`/api/room/${this.roomCode}/start`, { player_id: this.playerId, force });
        this.poll();
      } catch (e) {
        this.showError(e.message);
      }
    });

    document.getElementById("pile-pioche").addEventListener("click", () => this.draw("pioche"));
    document.getElementById("pile-defausse").addEventListener("click", () => this.draw("defausse"));

    document.getElementById("btn-declare").addEventListener("click", () => this.openDeclareBuilder());
    document.getElementById("btn-cancel-declare").addEventListener("click", () => this.closeDeclareBuilder());
    document.getElementById("btn-validate-declare").addEventListener("click", () => this.validateDeclare());

    document.querySelectorAll(".zone[data-zone]").forEach((zoneEl) => {
      zoneEl.addEventListener("click", () => this.assignSelectedTo(zoneEl.dataset.zone));
    });
  },

  flashHint(btnId, text) {
    const btn = document.getElementById(btnId);
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = original), 1500);
  },

  showError(msg) {
    const el = document.getElementById("table-error");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._errTimer);
    this._errTimer = setTimeout(() => (el.hidden = true), 3200);
  },

  async poll() {
    try {
      const data = await apiGet(`/api/room/${this.roomCode}/state?player_id=${this.playerId}`);
      this.lastState = data.state;
      this.render(data.state);
    } catch (e) {
      this.showError(e.message);
    }
  },

  async draw(source) {
    if (this.declareMode) return;
    try {
      await apiPost(`/api/room/${this.roomCode}/draw`, { player_id: this.playerId, source });
      this.poll();
    } catch (e) {
      this.showError(e.message);
    }
  },

  async discardCard(cardId) {
    try {
      await apiPost(`/api/room/${this.roomCode}/discard`, { player_id: this.playerId, card_id: cardId });
      this.poll();
    } catch (e) {
      this.showError(e.message);
    }
  },

  /* ---------- Constructeur de déclaration ---------- */

  openDeclareBuilder() {
    this.declareMode = true;
    this.selectedHandId = null;
    this.assignments = { tri: [], escalier: [], carre: [], groupe4: [] };
    document.getElementById("declare-builder").hidden = false;
    document.getElementById("btn-declare").hidden = true;
    document.getElementById("btn-cancel-declare").hidden = false;
    document.getElementById("declare-error").hidden = true;
    this.renderHandAndZones();
  },

  closeDeclareBuilder() {
    this.declareMode = false;
    document.getElementById("declare-builder").hidden = true;
    document.getElementById("btn-declare").hidden = false;
    document.getElementById("btn-cancel-declare").hidden = true;
    this.renderHandAndZones();
  },

  assignedCardIds() {
    return new Set([
      ...this.assignments.tri, ...this.assignments.escalier,
      ...this.assignments.carre, ...this.assignments.groupe4,
    ]);
  },

  zoneCapacity(zone) {
    return { tri: 3, escalier: 3, carre: 4, groupe4: 3 }[zone];
  },

  /* ---------- Ordre manuel de la main (glisser-déposer) ---------- */

  syncHandOrder(hand) {
    const ids = hand.map((c) => c.id);
    const idSet = new Set(ids);
    // garde l'ordre existant pour les cartes toujours présentes
    let order = this.handOrder.filter((id) => idSet.has(id));
    // ajoute à la fin les cartes nouvelles (ex. carte piochée)
    for (const id of ids) {
      if (!order.includes(id)) order.push(id);
    }
    this.handOrder = order;
    return order.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
  },

  moveInHandOrder(cardId, beforeCardId) {
    const withoutCard = this.handOrder.filter((id) => id !== cardId);
    if (beforeCardId == null) {
      withoutCard.push(cardId);
    } else {
      const idx = withoutCard.indexOf(beforeCardId);
      withoutCard.splice(idx === -1 ? withoutCard.length : idx, 0, cardId);
    }
    this.handOrder = withoutCard;
  },

  /* ---------- Assignation / retrait par glisser-déposer ---------- */

  tryAssignCardToZone(cardId, zone) {
    if (!this.declareMode) return false;
    const assigned = this.assignedCardIds();
    if (assigned.has(cardId)) this.unassignSilent(cardId);
    if (this.assignments[zone].length >= this.zoneCapacity(zone)) {
      this.showError("Ce groupe est déjà complet.");
      this.renderHandAndZones();
      return false;
    }
    this.assignments[zone].push(cardId);
    this.selectedHandId = null;
    this.renderHandAndZones();
    return true;
  },

  unassignSilent(cardId) {
    for (const zone of Object.keys(this.assignments)) {
      this.assignments[zone] = this.assignments[zone].filter((id) => id !== cardId);
    }
  },

  assignSelectedTo(zone) {
    if (!this.declareMode || !this.selectedHandId) return;
    const assigned = this.assignedCardIds();
    if (assigned.has(this.selectedHandId)) return; // déjà placée
    if (this.assignments[zone].length >= this.zoneCapacity(zone)) {
      this.showError("Ce groupe est déjà complet.");
      return;
    }
    this.assignments[zone].push(this.selectedHandId);
    this.selectedHandId = null;
    this.renderHandAndZones();
  },

  unassign(cardId) {
    for (const zone of Object.keys(this.assignments)) {
      this.assignments[zone] = this.assignments[zone].filter((id) => id !== cardId);
    }
    this.renderHandAndZones();
  },

  async validateDeclare() {
    const hand = this.lastState.my_hand || [];
    const assigned = this.assignedCardIds();
    if (assigned.size !== 13) {
      this.showDeclareError("Répartissez exactement 13 cartes dans les 4 groupes (il en reste une, ce sera la défausse).");
      return;
    }
    const leftover = hand.filter((c) => !assigned.has(c.id));
    if (leftover.length !== 1) {
      this.showDeclareError("Il doit rester exactement une carte non assignée (la défausse).");
      return;
    }
    try {
      await apiPost(`/api/room/${this.roomCode}/declare`, {
        player_id: this.playerId,
        groups: this.assignments,
        discard_card_id: leftover[0].id,
      });
      this.declareMode = false;
      this.poll();
    } catch (e) {
      this.showDeclareError(e.message);
    }
  },

  showDeclareError(msg) {
    const el = document.getElementById("declare-error");
    el.textContent = msg;
    el.hidden = false;
  },

  /* ---------- Rendu ---------- */

  render(state) {
    document.getElementById("view-lobby").hidden = state.phase !== "lobby";
    document.getElementById("view-table").hidden = state.phase !== "playing";
    document.getElementById("view-finished").hidden = state.phase !== "finished";

    if (state.phase === "lobby") this.renderLobby(state);
    if (state.phase === "playing") this.renderTable(state);
    if (state.phase === "finished") {
      this.renderFinished(state);
      clearInterval(this.pollTimer);
    }
  },

  renderLobby(state) {
    const list = document.getElementById("seat-list");
    list.innerHTML = "";
    for (let seat = 0; seat < state.max_players; seat++) {
      const p = state.players.find((pl) => pl.seat === seat);
      const li = document.createElement("li");
      li.className = "seat-item" + (p ? " filled" : "");
      li.innerHTML = `<span class="seat-num">${seat + 1}</span>` +
        (p
          ? `<span class="seat-name">${escapeHtml(p.name)}${p.is_me ? " (vous)" : ""}</span>`
          : `<span class="seat-empty">En attente…</span>`);
      list.appendChild(li);
    }

    const btnStart = document.getElementById("btn-start");
    const forceLabel = document.getElementById("force-start-label");
    const hint = document.getElementById("lobby-hint");

    if (state.am_i_host) {
      btnStart.hidden = false;
      btnStart.disabled = state.nb_players < 3;
      const canForce = state.nb_players >= 3 && state.nb_players < state.max_players;
      forceLabel.hidden = !canForce;
      if (state.nb_players < state.max_players) {
        const checked = document.getElementById("force-start").checked;
        btnStart.disabled = state.nb_players < 3 || (!checked && state.nb_players < state.max_players);
      }
      hint.textContent = state.nb_players >= state.max_players
        ? "Tous les joueurs sont là. Démarrez la partie !"
        : `${state.nb_players}/${state.max_players} joueurs inscrits.`;
      document.getElementById("force-start").onchange = () => this.renderLobby(state);
    } else {
      btnStart.hidden = true;
      forceLabel.hidden = true;
      hint.textContent = `${state.nb_players}/${state.max_players} joueurs inscrits. En attente que le joueur 1 démarre la partie…`;
    }
  },

  renderTable(state) {
    // Joker
    const jokerBadge = document.getElementById("joker-badge");
    if (state.joker_info) {
      jokerBadge.textContent = `Joker : ${state.joker_info.rank} ${state.joker_info.suits.map(suitSymbol).join(" / ")}`;
    }

    // Tour
    const banner = document.getElementById("turn-banner");
    if (state.is_my_turn) {
      banner.textContent = state.turn_stage === "draw"
        ? "À vous : piochez une carte"
        : "À vous : défaussez ou proposez votre main";
      banner.classList.add("mine");
    } else {
      banner.textContent = `Au tour de ${state.turn_player_name}…`;
      banner.classList.remove("mine");
    }

    // Adversaires
    const strip = document.getElementById("opponents-strip");
    strip.innerHTML = "";
    state.players.filter((p) => !p.is_me).forEach((p) => {
      const chip = document.createElement("div");
      chip.className = "opp-chip" + (p.id === state.turn_player_id ? " active-turn" : "");
      chip.innerHTML = `<span class="opp-name">${escapeHtml(p.name)}</span><span class="opp-count">${p.card_count} cartes</span>`;
      strip.appendChild(chip);
    });

    // Pioche / défausse
    document.getElementById("deck-count").textContent = state.deck_count;
    const discardEl = document.getElementById("discard-card");
    if (state.discard_top) {
      discardEl.className = "card " + (state.discard_top.color === "Rouge" ? "red" : "black");
      discardEl.textContent = state.discard_top.label;
    } else {
      discardEl.className = "card card-empty";
      discardEl.textContent = "—";
    }

    // Barre d'action
    const actionBar = document.getElementById("action-bar");
    const canAct = state.is_my_turn && state.turn_stage === "discard" && !this.declareMode;
    actionBar.hidden = !(state.is_my_turn && state.turn_stage === "discard");
    document.getElementById("btn-declare").hidden = this.declareMode;

    this.renderHandAndZones();
  },

  renderHandAndZones() {
    const state = this.lastState;
    if (!state || !state.my_hand) return;
    const hand = state.my_hand;
    const orderedHand = this.syncHandOrder(hand);
    const assigned = this.declareMode ? this.assignedCardIds() : new Set();
    const canAct = state.is_my_turn && state.turn_stage === "discard";

    const handEl = document.getElementById("hand");
    handEl.innerHTML = "";
    orderedHand.forEach((c) => {
      const el = document.createElement("div");
      el.className = "card draggable " + (c.color === "Rouge" ? "red" : "black");
      if (state.joker_info && c.rank === state.joker_info.rank && state.joker_info.suits.includes(c.suit)) {
        el.classList.add("joker-card");
      }
      if (this.declareMode && assigned.has(c.id)) el.classList.add("assigned");
      if (this.declareMode && this.selectedHandId === c.id) el.classList.add("selected");
      el.textContent = c.label;
      el.dataset.id = c.id;

      el.addEventListener("click", () => {
        if (Drag.justDragged) return; // ignore le clic qui suit un glisser
        if (this.declareMode) {
          if (assigned.has(c.id)) {
            this.unassign(c.id);
          } else {
            this.selectedHandId = this.selectedHandId === c.id ? null : c.id;
            this.renderHandAndZones();
          }
        } else if (canAct) {
          this.discardCard(c.id);
        }
      });
      Drag.makeDraggable(el, c.id, "hand");
      handEl.appendChild(el);
    });

    if (this.declareMode) {
      document.getElementById("declare-builder").hidden = false;
      for (const zone of ["tri", "escalier", "carre", "groupe4"]) {
        const slotEl = document.querySelector(`[data-zone-slots="${zone}"]`);
        const capacity = this.zoneCapacity(zone);
        const ids = this.assignments[zone];

        const countEl = document.querySelector(`[data-count="${zone}"]`);
        if (countEl) countEl.textContent = `${ids.length}/${capacity}`;

        slotEl.innerHTML = "";
        ids.forEach((id) => {
          const c = hand.find((h) => h.id === id);
          if (!c) return;
          const chip = document.createElement("div");
          chip.className = "card draggable " + (c.color === "Rouge" ? "red" : "black");
          chip.textContent = c.label;
          chip.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (Drag.justDragged) return;
            this.unassign(c.id);
          });
          Drag.makeDraggable(chip, c.id, zone);
          slotEl.appendChild(chip);
        });
        // Emplacements vides visibles : on voit d'un coup d'oeil combien de
        // cartes manquent encore pour compléter le groupe.
        for (let i = ids.length; i < capacity; i++) {
          const empty = document.createElement("div");
          empty.className = "zone-slot-empty";
          slotEl.appendChild(empty);
        }
      }
      const discardSlot = document.querySelector('[data-zone-slots="discard"]');
      discardSlot.innerHTML = "";
      const leftover = hand.filter((c) => !assigned.has(c.id));
      if (leftover.length === 1) {
        const c = leftover[0];
        const chip = document.createElement("div");
        chip.className = "card " + (c.color === "Rouge" ? "red" : "black");
        chip.textContent = c.label;
        discardSlot.appendChild(chip);
      } else {
        discardSlot.innerHTML = `<span class="zone-placeholder">${leftover.length} carte(s) restante(s) à placer</span>`;
      }
    }
  },

  renderFinished(state) {
    const title = document.getElementById("finished-title");
    title.textContent = state.winner_name ? `🏆 ${state.winner_name} gagne !` : "Partie terminée";
    document.getElementById("finished-reason").textContent = state.win_reason || "";

    const wrap = document.getElementById("finished-hand");
    if (state.winning_hand) {
      wrap.hidden = false;
      const fill = (elId, cards) => {
        const el = document.getElementById(elId);
        el.innerHTML = "";
        (cards || []).forEach((c) => {
          const chip = document.createElement("div");
          chip.className = "card " + (c.color === "Rouge" ? "red" : "black");
          if (state.joker_info && c.rank === state.joker_info.rank && state.joker_info.suits.includes(c.suit)) {
            chip.classList.add("joker-card");
          }
          chip.textContent = c.label;
          el.appendChild(chip);
        });
      };
      fill("fh-tri", state.winning_hand.tri);
      fill("fh-escalier", state.winning_hand.escalier);
      fill("fh-carre", state.winning_hand.carre);
      fill("fh-groupe4", state.winning_hand.groupe4);
      fill("fh-discard", state.winning_hand.discard ? [state.winning_hand.discard] : []);
    } else {
      wrap.hidden = true;
    }
  },
};

// Journal (log) + Défausse détaillée — communs à toute la page table
document.addEventListener("DOMContentLoaded", () => {
  const logToggle = document.getElementById("btn-log-toggle");
  if (logToggle) {
    logToggle.addEventListener("click", () => {
      const panel = document.getElementById("log-panel");
      const discardPanel = document.getElementById("discard-panel");
      if (discardPanel) discardPanel.hidden = true;
      panel.hidden = !panel.hidden;
      if (!panel.hidden && RamiTable.lastState) {
        panel.innerHTML = RamiTable.lastState.log.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
      }
    });
  }

  const discardToggle = document.getElementById("btn-discard-toggle");
  if (discardToggle) {
    discardToggle.addEventListener("click", () => {
      const panel = document.getElementById("discard-panel");
      const logPanel = document.getElementById("log-panel");
      if (logPanel) logPanel.hidden = true;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) renderDiscardPanel();
    });
  }
});

function renderDiscardPanel() {
  const panel = document.getElementById("discard-panel");
  const state = RamiTable.lastState;
  const pile = (state && state.discard_pile) || [];
  if (pile.length === 0) {
    panel.innerHTML = `<div class="discard-row discard-empty">La défausse est vide pour le moment.</div>`;
    return;
  }
  // Du plus récent (dessus de la pile, seul prenable) au plus ancien.
  const rows = pile.slice().reverse().map((entry, i) => {
    const c = entry.card;
    const colorClass = c.color === "Rouge" ? "red" : "black";
    const jokerClass = state.joker_info && c.rank === state.joker_info.rank && state.joker_info.suits.includes(c.suit)
      ? " joker-card" : "";
    const badge = i === 0 ? `<span class="discard-badge">dessus — prenable</span>` : "";
    return `<div class="discard-row">
      <span class="card mini ${colorClass}${jokerClass}">${c.label}</span>
      <span class="discard-meta">jetée par <strong>${escapeHtml(entry.player_name)}</strong>${badge}</span>
    </div>`;
  });
  panel.innerHTML = rows.join("");
}

/* ============================================================
   Glisser-déposer des cartes (souris ET tactile, via Pointer Events)
   - Dans la main : glisser une carte pour réordonner sa main.
   - Dans le constructeur de main : glisser une carte de la main vers un
     groupe, ou d'un groupe vers un autre / vers la main pour la retirer.
   ============================================================ */
const Drag = {
  active: false,
  justDragged: false, // vrai juste après un drop, pour ignorer le "click" qui suit
  cardId: null,
  fromZone: null, // "hand" | "tri" | "escalier" | "carre" | "groupe4"
  originEl: null,
  ghostEl: null,
  startX: 0,
  startY: 0,
  THRESHOLD: 6,

  makeDraggable(el, cardId, fromZone) {
    el.addEventListener("pointerdown", (e) => this.onPointerDown(e, el, cardId, fromZone));
  },

  onPointerDown(e, el, cardId, fromZone) {
    if (e.button !== undefined && e.button !== 0) return; // clic gauche / doigt uniquement
    this.pendingEl = el;
    this.pendingCardId = cardId;
    this.pendingFromZone = fromZone;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.pointerId = e.pointerId;

    const move = (ev) => this.onPointerMove(ev);
    const up = (ev) => this.onPointerUp(ev, move, up);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
    document.addEventListener("pointercancel", up, { once: true });
  },

  onPointerMove(e) {
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (!this.active) {
      if (Math.abs(dx) < this.THRESHOLD && Math.abs(dy) < this.THRESHOLD) return;
      this.startDrag(e);
    }
    if (this.active) {
      e.preventDefault();
      this.ghostEl.style.left = `${e.clientX - this.ghostOffsetX}px`;
      this.ghostEl.style.top = `${e.clientY - this.ghostOffsetY}px`;
      this.highlightDropTarget(e.clientX, e.clientY);
    }
  },

  startDrag(e) {
    this.active = true;
    this.cardId = this.pendingCardId;
    this.fromZone = this.pendingFromZone;
    this.originEl = this.pendingEl;
    this.originEl.classList.add("dragging");

    const rect = this.originEl.getBoundingClientRect();
    this.ghostOffsetX = e.clientX - rect.left;
    this.ghostOffsetY = e.clientY - rect.top;

    const ghost = this.originEl.cloneNode(true);
    ghost.className = "card drag-ghost " + (this.originEl.classList.contains("red") ? "red" : "black");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    this.ghostEl = ghost;
  },

  dropZoneEls() {
    return Array.from(document.querySelectorAll('[data-dropzone="hand"], .zone-slots[data-zone-slots]'))
      .filter((el) => el.dataset.zoneSlots !== "discard");
  },

  highlightDropTarget(x, y) {
    this.dropZoneEls().forEach((z) => z.classList.remove("drop-target"));
    const target = this.findDropTarget(x, y);
    if (target) target.classList.add("drop-target");
  },

  findDropTarget(x, y) {
    for (const el of this.dropZoneEls()) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  },

  onPointerUp(e, moveFn, upFn) {
    document.removeEventListener("pointermove", moveFn);
    if (!this.active) {
      this.cleanupPending();
      return;
    }
    e.preventDefault();
    const target = this.findDropTarget(e.clientX, e.clientY);
    this.dropZoneEls().forEach((z) => z.classList.remove("drop-target"));

    if (target) {
      const zoneName = target.dataset.dropzone === "hand" ? "hand" : target.dataset.zoneSlots;
      this.handleDrop(zoneName, e.clientX);
    }

    this.originEl.classList.remove("dragging");
    this.ghostEl.remove();
    this.ghostEl = null;
    this.active = false;
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false), 50);
    this.cleanupPending();
  },

  cleanupPending() {
    this.pendingEl = null;
    this.pendingCardId = null;
    this.pendingFromZone = null;
  },

  handleDrop(toZone, clientX) {
    const cardId = this.cardId;
    const fromZone = this.fromZone;

    if (toZone === "hand") {
      if (fromZone === "hand") {
        // réordonner la main : insère avant la carte survolée
        const cards = Array.from(document.querySelectorAll("#hand .card"));
        let beforeId = null;
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          if (c.dataset.id !== cardId && clientX < r.left + r.width / 2) {
            beforeId = c.dataset.id;
            break;
          }
        }
        RamiTable.moveInHandOrder(cardId, beforeId);
        RamiTable.renderHandAndZones();
      } else {
        // retire la carte de son groupe -> retour en main
        RamiTable.unassign(cardId);
      }
      return;
    }

    // toZone est un groupe (tri / escalier / carre / groupe4)
    if (fromZone === toZone) return; // rien à faire
    RamiTable.tryAssignCardToZone(cardId, toZone);
  },
};

function suitSymbol(suit) {
  return { Pique: "♠", Coeur: "♥", Carreau: "♦", Trefle: "♣" }[suit] || suit;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
