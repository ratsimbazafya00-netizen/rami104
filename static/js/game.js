/* Rami 104 — client JS (vanilla, polling AJAX, sans dépendance) */

function getAuthToken() {
  return localStorage.getItem("rami_auth_token") || "";
}

function requireLogin(next = "/") {
  if (!getAuthToken()) {
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
    return false;
  }
  return true;
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(getAuthToken() ? { "Authorization": `Bearer ${getAuthToken()}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (res.status === 401) {
    localStorage.removeItem("rami_auth_token");
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error(data.error || "Connexion requise.");
  }
  if (!data.ok) throw new Error(data.error || "Erreur inconnue");
  return data;
}

async function apiGet(url) {
  const res = await fetch(url, {
    headers: getAuthToken() ? { "Authorization": `Bearer ${getAuthToken()}` } : {},
  });
  const data = await res.json();
  if (res.status === 401) {
    localStorage.removeItem("rami_auth_token");
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error(data.error || "Connexion requise.");
  }
  if (!data.ok) throw new Error(data.error || "Erreur inconnue");
  return data;
}

function playerKey(roomCode) {
  return `rami_player_${roomCode}`;
}



/* ============================================================
   Authentification — UI uniquement
   Les comptes réels, mots de passe et paiements seront branchés
   côté serveur ultérieurement. Aucun mot de passe n'est envoyé ici.
   ============================================================ */
const RamiAuth = {
  passwordToggles() {
    document.querySelectorAll(".password-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const visible = input.type === "text";
        input.type = visible ? "password" : "text";
        btn.textContent = visible ? "◉" : "◌";
      });
    });
  },
  message(text, type = "info") {
    const el = document.getElementById("auth-message");
    if (!el) return;
    el.textContent = text;
    el.className = `auth-message ${type}`;
    el.hidden = false;
  },
  redirectAfterAuth(defaultPath = "/") {
    const next = new URLSearchParams(window.location.search).get("next") || defaultPath;
    window.location.href = next.startsWith("/") ? next : defaultPath;
  },
  initLogin() {
    this.passwordToggles();
    const form = document.getElementById("login-form");
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const phone = document.getElementById("login-phone").value.trim();
      const password = document.getElementById("login-password").value;
      try {
        const data = await apiPost("/api/auth/login", { phone, password });
        localStorage.setItem("rami_auth_token", data.token);
        localStorage.setItem("rami_profile", JSON.stringify(data.account));
        this.message(`Bienvenue ${data.account.name} !`, "success");
        setTimeout(() => this.redirectAfterAuth("/"), 350);
      } catch (err) { this.message(err.message, "error"); }
    });
    document.getElementById("forgot-password")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.message("La récupération du mot de passe sera ajoutée avec le module SMS/OTP.", "info");
    });
  },
  initRegister() {
    this.passwordToggles();
    const form = document.getElementById("register-form");
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("register-name").value.trim();
      const phone = document.getElementById("register-phone").value.trim();
      const pass = document.getElementById("register-password").value;
      const confirm = document.getElementById("register-confirm").value;
      const promo = document.getElementById("register-promo")?.value.trim() || "";
      if (pass !== confirm) return this.message("Les deux mots de passe ne correspondent pas.", "error");
      if (pass.length < 6) return this.message("Le mot de passe doit contenir au moins 6 caractères.", "error");
      try {
        const data = await apiPost("/api/auth/register", { name, phone, password: pass, promo });
        localStorage.setItem("rami_auth_token", data.token);
        localStorage.setItem("rami_profile", JSON.stringify(data.account));
        this.message(`Compte créé. Bienvenue ${data.account.name} !`, "success");
        setTimeout(() => this.redirectAfterAuth("/"), 500);
      } catch (err) { this.message(err.message, "error"); }
    });
  },
};

/* ============================================================
   Notifications globales — invitations d'amis et de salons
   ============================================================ */
const RamiNotifications = {
  timer: null,
  activeId: null,
  seen: new Set(),

  init() {
    if (!getAuthToken()) return;
    this.ensureHost();
    this.poll();
    this.timer = setInterval(() => this.poll(), 5000);
  },

  ensureHost() {
    if (document.getElementById("rami-notification-host")) return;
    const host = document.createElement("div");
    host.id = "rami-notification-host";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  },

  async poll() {
    if (!getAuthToken() || this.activeId) return;
    try {
      const data = await apiGet("/api/notifications");
      const unread = (data.notifications || []).filter(n => !n.read && !this.seen.has(n.id));
      if (unread.length) this.show(unread[0]);
    } catch (_) {}
  },

  show(n) {
    this.ensureHost();
    this.activeId = n.id;
    this.seen.add(n.id);
    const host = document.getElementById("rami-notification-host");
    const isGame = n.kind === "room_invite";
    const icon = isGame ? "🎮" : "🤝";
    const title = escapeHtml(n.title || (isGame ? "Invitation à jouer" : "Nouvelle demande d'ami"));
    const message = escapeHtml(n.message || "Vous avez une nouvelle invitation.");
    const room = isGame ? escapeHtml(n.room_code || "") : "";
    host.innerHTML = `
      <div class="rami-notification-popup">
        <button class="notification-close" type="button" aria-label="Fermer">×</button>
        <div class="notification-icon">${icon}</div>
        <div class="notification-content">
          <span class="notification-kicker">NOTIFICATION</span>
          <strong>${title}</strong>
          <p>${message}</p>
          ${room ? `<small class="notification-room">SALON ${room}</small>` : ""}
          <div class="notification-actions">
            ${isGame
              ? `<button class="btn btn-primary notification-action" data-action="join">Rejoindre</button>`
              : `<button class="btn btn-primary notification-action" data-action="accept">Accepter</button>`}
            <button class="btn btn-secondary notification-action" data-action="dismiss">Fermer</button>
          </div>
        </div>
      </div>`;

    host.querySelector(".notification-close")?.addEventListener("click", () => this.dismiss(n));
    host.querySelector('[data-action="dismiss"]')?.addEventListener("click", () => this.dismiss(n));
    host.querySelector('[data-action="accept"]')?.addEventListener("click", async () => {
      try {
        await apiPost("/api/friends/accept", { requester_id: n.from_id });
        await this.markRead(n.id);
        this.remove();
        if (typeof RamiHome !== "undefined" && RamiHome.loadFriends) RamiHome.loadFriends();
      } catch (e) { alert(e.message); }
    });
    host.querySelector('[data-action="join"]')?.addEventListener("click", async () => {
      try {
        const data = await apiPost("/api/room/join", { room_code: n.room_code });
        localStorage.setItem(playerKey(data.room_code), data.player_id);
        await this.markRead(n.id);
        window.location.href = `/salon/${data.room_code}`;
      } catch (e) { alert(e.message); }
    });
  },

  async dismiss(n) {
    await this.markRead(n.id);
    this.remove();
    setTimeout(() => this.poll(), 100);
  },

  async markRead(id) {
    try { await apiPost("/api/notifications/read", { id }); } catch (_) {}
  },

  remove() {
    document.getElementById("rami-notification-host")?.replaceChildren();
    this.activeId = null;
  }
};

/* ============================================================
   Page d'accueil
   ============================================================ */
const RamiHome = {
  init() {
    const profile = JSON.parse(localStorage.getItem("rami_profile") || "null");
    const accountName = document.getElementById("account-name");
    const accountIdBadge = document.getElementById("account-id-badge");
    const createName = document.getElementById("create-player-name");
    const createId = document.getElementById("create-player-id");
    if (accountName) accountName.textContent = profile?.name || "Non connecté";
    if (accountIdBadge) accountIdBadge.textContent = profile?.id ? `• ${profile.id}` : "";
    if (createName) createName.textContent = profile?.name || "Connectez-vous";
    if (createId) createId.textContent = profile?.id || "—";

    const logout = document.getElementById("btn-logout");
    const login = document.getElementById("nav-login");
    const register = document.getElementById("nav-register");
    if (getAuthToken() && profile) {
      if (logout) logout.hidden = false;
      if (login) login.hidden = true;
      if (register) register.hidden = true;
    }

    document.getElementById("btn-create")?.addEventListener("click", () => this.create());
    document.getElementById("btn-join")?.addEventListener("click", () => this.join());
    document.getElementById("btn-random-match")?.addEventListener("click", () => this.randomMatch());
    document.getElementById("btn-friend-search")?.addEventListener("click", () => this.searchFriends());
    document.getElementById("friend-search")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.searchFriends(); }
    });
    if (getAuthToken() && profile) {
      this.loadFriends();
      this.loadPublicRooms();
      this._friendsTimer = setInterval(() => this.loadFriends(), 8000);
      this._roomsTimer = setInterval(() => this.loadPublicRooms(), 6000);
    }
    document.getElementById("btn-logout")?.addEventListener("click", () => {
      localStorage.removeItem("rami_auth_token");
      localStorage.removeItem("rami_profile");
      window.location.reload();
    });
  },

  async loadFriends() {
    if (!getAuthToken()) return;
    try {
      const data = await apiGet("/api/friends");
      const list = document.getElementById("friend-list");
      const pending = document.getElementById("friend-pending");
      const inv = document.getElementById("friend-invitations");
      const count = document.getElementById("online-friend-count");
      const friends = [...(data.friends || [])].sort((a,b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name)));
      const online = friends.filter(f => f.online).length;
      if (count) count.textContent = `${online} en ligne`;

      list.innerHTML = friends.length ? friends.map(f => `
        <div class="friend-row online-friend-row ${f.online ? "" : "offline"}">
          <span>
            <strong>${escapeHtml(f.name)}</strong>
            <small class="friend-state"><i></i>${f.online ? "En ligne" : "Hors ligne"}</small>
          </span>
          <button class="btn btn-small friend-invite-mini" data-id="${escapeHtml(f.id)}" ${f.online ? "" : "title=\"Hors ligne\""}>Inviter</button>
        </div>`).join("") : `<div class="friends-empty">Aucun ami. Ajoutez-en avec la recherche ci-dessous.</div>`;

      pending.innerHTML = data.pending?.length ? `<div class="friends-subtitle">Demandes reçues</div>` + data.pending.map(f => `
        <div class="friend-row"><span>🤝 <strong>${escapeHtml(f.name)}</strong></span><button class="btn btn-small friend-accept" data-id="${escapeHtml(f.id)}">Accepter</button></div>`).join("") : "";
      inv.innerHTML = data.invitations?.length ? `<div class="friends-subtitle">Invitations de jeu</div>` + data.invitations.map(i => `
        <div class="friend-row"><span>🎮 <strong>${escapeHtml(i.from_name)}</strong><small class="friend-id">Salon ${escapeHtml(i.room_code)}</small></span><button class="btn btn-small friend-join" data-code="${escapeHtml(i.room_code)}">Jouer</button></div>`).join("") : "";

      document.querySelectorAll(".friend-accept").forEach(b => b.addEventListener("click", async () => {
        try { await apiPost("/api/friends/accept", {requester_id:b.dataset.id}); this.loadFriends(); }
        catch(e){ this.showError(e.message); }
      }));
      document.querySelectorAll(".friend-invite").forEach(b => b.addEventListener("click", () => this.createAndInvite(b.dataset.id, b)));
      document.querySelectorAll(".friend-join").forEach(b => b.addEventListener("click", () => {
        document.getElementById("join-code").value=b.dataset.code;
        this.join();
      }));
    } catch(e) { this.showError(e.message); }
  },

  async loadPublicRooms() {
    if (!getAuthToken()) return;
    try {
      const data = await apiGet("/api/rooms/public");
      const list = document.getElementById("public-rooms-list");
      const count = document.getElementById("public-room-count");
      if (!list) return;
      const rooms = data.rooms || [];
      if (count) count.textContent = `${rooms.length} ${rooms.length > 1 ? "tables" : "table"}`;
      list.innerHTML = rooms.length ? rooms.map(r => `
        <div class="public-room-row">
          <span class="public-room-main"><strong>Salon ${escapeHtml(r.room_code)}</strong><small>♟ ${r.players}/${r.max_players} • ${escapeHtml(r.host_name || "Hôte")}</small></span>
          <button class="btn btn-small public-room-join" data-code="${escapeHtml(r.room_code)}">Rejoindre</button>
        </div>`).join("") : `<div class="friends-empty">Aucun salon public en attente.</div>`;
      list.querySelectorAll(".public-room-join").forEach(b => b.addEventListener("click", () => this.joinPublic(b.dataset.code, b)));
    } catch (e) {
      // La liste publique est secondaire : ne pas afficher une erreur bloquante.
    }
  },

  async joinPublic(code, button) {
    if (!requireLogin("/")) return;
    if (button) { button.disabled = true; button.textContent = "…"; }
    try {
      const data = await apiPost("/api/room/join", { room_code: code });
      localStorage.setItem(playerKey(data.room_code), data.player_id);
      window.location.href = `/salon/${data.room_code}`;
    } catch (e) {
      this.showError(e.message);
      if (button) { button.disabled = false; button.textContent = "Rejoindre"; }
      this.loadPublicRooms();
    }
  },

  async createAndInvite(friendId, button) {
    if (!requireLogin("/")) return;
    const original = button?.textContent || "Inviter";
    if (button) { button.disabled = true; button.textContent = "..."; }
    try {
      const room = await apiPost("/api/room/create", {visibility: "private"});
      await apiPost(`/api/room/${room.room_code}/invite-friend`, {target_id: friendId});
      localStorage.setItem(playerKey(room.room_code), room.player_id);
      window.location.href = `/salon/${room.room_code}`;
    } catch (e) {
      if (button) { button.disabled = false; button.textContent = original; }
      this.showError(e.message);
    }
  },

  async searchFriends() {
    const q = document.getElementById("friend-search")?.value.trim();
    if (!q) return;
    try {
      const data = await apiGet(`/api/friends/search?q=${encodeURIComponent(q)}`);
      const el = document.getElementById("friend-search-results");
      el.innerHTML = data.results.length ? `<div class="friends-subtitle">Résultats</div>` + data.results.map(a => `
        <div class="friend-row"><span><strong>${escapeHtml(a.name)}</strong><small class="friend-id">${escapeHtml(a.id || "")}</small></span><button class="btn btn-small friend-add" data-id="${escapeHtml(a.id)}">Ajouter</button></div>`).join("") : `<div class="friends-empty">Aucun compte trouvé.</div>`;
      document.querySelectorAll(".friend-add").forEach(b => b.addEventListener("click", async () => {
        try { await apiPost("/api/friends/request", {target_id:b.dataset.id}); b.textContent="Envoyée ✓"; b.disabled=true; }
        catch(e){ this.showError(e.message); }
      }));
    } catch(e) { this.showError(e.message); }
  },

  showError(msg) {
    const el = document.getElementById("home-error");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._errTimer);
    this._errTimer = setTimeout(() => (el.hidden = true), 3500);
  },

  async randomMatch() {
    if (!requireLogin("/")) return;
    const btn = document.getElementById("btn-random-match");
    const status = document.getElementById("match-status");
    const original = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = "Recherche d'un salon…"; }
    if (status) { status.classList.add("searching"); status.innerHTML = `<i></i><span>Recherche d'un joueur en ligne…</span>`; }
    try {
      const data = await apiPost("/api/matchmaking/random", {});
      localStorage.setItem(playerKey(data.room_code), data.player_id);
      if (status) status.innerHTML = data.matched ? `<i></i><span>Joueur trouvé • salon ${escapeHtml(data.room_code)}</span>` : `<i></i><span>Table créée • en attente d'un joueur</span>`;
      window.location.href = `/salon/${data.room_code}`;
    } catch (e) {
      if (status) status.innerHTML = `<i></i><span>Impossible de trouver une table</span>`;
      this.showError(e.message);
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  },

  async create() {
    if (!requireLogin("/")) return;
    const visibility = document.getElementById("room-visibility")?.value || "public";
    try {
      const data = await apiPost("/api/room/create", {visibility});
      localStorage.setItem(playerKey(data.room_code), data.player_id);
      window.location.href = `/salon/${data.room_code}`;
    } catch (e) { this.showError(e.message); }
  },

  async join() {
    if (!requireLogin("/")) return;
    const code = document.getElementById("join-code").value.trim().toUpperCase();
    if (!code) return this.showError("Entrez le code du salon.");
    try {
      const data = await apiPost("/api/room/join", { room_code: code });
      localStorage.setItem(playerKey(data.room_code), data.player_id);
      window.location.href = `/salon/${data.room_code}`;
    } catch (e) { this.showError(e.message); }
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
  lastChatSignature: "",

  declareMode: false,
  selectedHandId: null,
  selectedHandIds: new Set(),
  assignments: { tri: [], escalier: [], carre: [], groupe4: [] }, // listes de card ids
  handOrder: [], // ordre manuel des cartes en main (glisser-déposer)

  async init(roomCode) {
    this.roomCode = roomCode;
    if (!requireLogin(`/salon/${roomCode}`)) return;
    this.playerId = localStorage.getItem(playerKey(roomCode));

    if (!this.playerId) {
      try {
        const data = await apiPost("/api/room/join", { room_code: roomCode });
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

    document.getElementById("btn-leave")?.addEventListener("click", () => this.leaveRoom());
    document.getElementById("btn-leave-game")?.addEventListener("click", () => this.leaveRoom());
    document.getElementById("btn-invite-friends")?.addEventListener("click", () => this.toggleFriendInvites());
    document.getElementById("btn-invite-friends-game")?.addEventListener("click", () => this.toggleFriendInvites());

    document.getElementById("btn-start").addEventListener("click", async () => {
      const force = document.getElementById("force-start").checked;
      try {
        await apiPost(`/api/room/${this.roomCode}/start`, { player_id: this.playerId, force });
        this.poll();
      } catch (e) {
        this.showError(e.message);
      }
    });

    document.getElementById("btn-next-round")?.addEventListener("click", () => this.nextRound());

    ["lobby", "table", "finished"].forEach((place) => {
      const form = document.getElementById(`chat-form-${place}`);
      const input = document.getElementById(`chat-input-${place}`);
      if (!form || !input) return;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const message = input.value.trim();
        if (!message) return;
        const send = form.querySelector(".chat-send");
        if (send) send.disabled = true;
        try {
          await apiPost(`/api/room/${this.roomCode}/chat`, { player_id: this.playerId, message });
          input.value = "";
          await this.poll();
          input.focus();
        } catch (err) {
          this.showError(err.message);
        } finally {
          if (send) send.disabled = false;
        }
      });
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

  async toggleFriendInvites() {
    const panel = document.getElementById("room-friends-invite");
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    try {
      const data = await apiGet("/api/friends");
      panel.innerHTML = data.friends.length ? `<div class="friends-subtitle">Inviter dans le salon ${escapeHtml(this.roomCode)}</div>` + data.friends.map(f => `<div class="friend-row"><span>👤 <strong>${escapeHtml(f.name)}</strong><small class="friend-id">${escapeHtml(f.id || "")}</small></span><button class="btn btn-small room-invite-one" data-id="${f.id}">Inviter</button></div>`).join("") : `<div class="friends-empty">Ajoutez des amis depuis l'accueil pour pouvoir les inviter.</div>`;
      panel.hidden = false;
      panel.querySelectorAll(".room-invite-one").forEach(b => b.addEventListener("click", async () => {
        try { await apiPost(`/api/room/${this.roomCode}/invite-friend`, {target_id:b.dataset.id}); b.textContent="Envoyé ✓"; b.disabled=true; } catch(e){ this.showError(e.message); }
      }));
    } catch(e) { this.showError(e.message); }
  },

  flashHint(btnId, text) {
    const btn = document.getElementById(btnId);
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = original), 1500);
  },

  async loadFriends() {
    if (!getAuthToken()) return;
    try {
      const data = await apiGet("/api/friends");
      const list = document.getElementById("friend-list");
      const pending = document.getElementById("friend-pending");
      const inv = document.getElementById("friend-invitations");
      list.innerHTML = data.friends.length ? data.friends.map(f => `<div class="friend-row"><span>👤 <strong>${escapeHtml(f.name)}</strong></span><button class="btn btn-small friend-invite" data-id="${f.id}">Inviter</button></div>`).join("") : `<div class="friends-empty">Aucun ami pour le moment.</div>`;
      pending.innerHTML = data.pending.length ? `<div class="friends-subtitle">Demandes reçues</div>` + data.pending.map(f => `<div class="friend-row"><span>🤝 <strong>${escapeHtml(f.name)}</strong></span><button class="btn btn-small friend-accept" data-id="${f.id}">Accepter</button></div>`).join("") : "";
      inv.innerHTML = data.invitations.length ? `<div class="friends-subtitle">Invitations de jeu</div>` + data.invitations.map(i => `<div class="friend-row"><span>🎮 <strong>${escapeHtml(i.from_name)}</strong> vous invite • salon ${escapeHtml(i.room_code)}</span><button class="btn btn-small friend-join" data-code="${escapeHtml(i.room_code)}">Rejoindre</button></div>`).join("") : "";
      document.querySelectorAll(".friend-accept").forEach(b => b.addEventListener("click", async () => { try { await apiPost("/api/friends/accept", {requester_id:b.dataset.id}); this.loadFriends(); } catch(e){ this.showError(e.message); } }));
      document.querySelectorAll(".friend-invite").forEach(b => b.addEventListener("click", async () => {
        const code = prompt("Entrez le code du salon à inviter :"); if (!code) return;
        try { await apiPost(`/api/room/${code.trim().toUpperCase()}/invite-friend`, {target_id:b.dataset.id}); this.showError("Invitation envoyée."); } catch(e){ this.showError(e.message); }
      }));
      document.querySelectorAll(".friend-join").forEach(b => b.addEventListener("click", () => { document.getElementById("join-code").value=b.dataset.code; document.getElementById("join-code").focus(); window.scrollTo({top:document.getElementById("panel-join").offsetTop,behavior:"smooth"}); }));
    } catch(e) { this.showError(e.message); }
  },

  async searchFriends() {
    const q = document.getElementById("friend-search")?.value.trim();
    if (!q) return;
    try {
      const data = await apiGet(`/api/friends/search?q=${encodeURIComponent(q)}`);
      const el = document.getElementById("friend-search-results");
      el.innerHTML = data.results.length ? `<div class="friends-subtitle">Résultats</div>` + data.results.map(a => `<div class="friend-row"><span>👤 <strong>${escapeHtml(a.name)}</strong><small class="friend-id">${escapeHtml(a.id || "")}</small></span><button class="btn btn-small friend-add" data-id="${a.id}">Ajouter</button></div>`).join("") : `<div class="friends-empty">Aucun compte trouvé.</div>`;
      document.querySelectorAll(".friend-add").forEach(b => b.addEventListener("click", async () => { try { await apiPost("/api/friends/request", {target_id:b.dataset.id}); b.textContent="Envoyée"; b.disabled=true; } catch(e){ this.showError(e.message); } }));
    } catch(e) { this.showError(e.message); }
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
      if (data.state.my_player_id && data.state.my_player_id !== this.playerId) {
        this.playerId = data.state.my_player_id;
        localStorage.setItem(playerKey(this.roomCode), this.playerId);
      }
      this.render(data.state);
    } catch (e) {
      this.showError(e.message);
    }
  },

  async leaveRoom() {
    if (!confirm("Quitter ce salon ?")) return;
    try {
      await apiPost(`/api/room/${this.roomCode}/leave`, { player_id: this.playerId });
      localStorage.removeItem(playerKey(this.roomCode));
      window.location.href = "/";
    } catch (e) { this.showError(e.message); }
  },

  async nextRound() {
    try {
      await apiPost(`/api/room/${this.roomCode}/next-round`, { player_id: this.playerId });
      this.poll();
    } catch (e) { this.showError(e.message); }
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
    this.selectedHandIds = new Set();
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
    if (!this.declareMode) return;
    const selected = Array.from(this.selectedHandIds || []);
    if (!selected.length && this.selectedHandId) selected.push(this.selectedHandId);
    if (!selected.length) return;
    const assigned = this.assignedCardIds();
    const capacity = this.zoneCapacity(zone);
    let added = 0;
    for (const id of selected) {
      if (assigned.has(id)) continue;
      if (this.assignments[zone].length >= capacity) break;
      this.assignments[zone].push(id);
      added++;
    }
    if (added < selected.length) this.showError("Certaines cartes n'ont pas pu être placées : le groupe est plein.");
    this.selectedHandIds.clear();
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
    }
    this.renderChat(state);
    renderLiveHistory(state);
    if (state.phase === "finished") {
      // On continue de sonder pour voir quand l'hôte prépare la manche suivante.
      if (!this.pollTimer) this.pollTimer = setInterval(() => this.poll(), 1500);
    }
  },

  renderLobby(state) {
    const me = state.players.find((p) => p.is_me);
    const lobbyName = document.getElementById("lobby-player-name");
    const lobbyId = document.getElementById("lobby-player-id");
    if (lobbyName) lobbyName.textContent = me?.name || "Votre pseudo";
    if (lobbyId) lobbyId.textContent = me?.account_id || "—";
    const list = document.getElementById("seat-list");
    list.innerHTML = "";
    for (let seat = 0; seat < state.max_players; seat++) {
      const p = state.players.find((pl) => pl.seat === seat);
      const li = document.createElement("li");
      li.className = "seat-item" + (p ? " filled" : "");
      li.innerHTML = `<span class="seat-num">${seat + 1}</span>` +
        (p
          ? `<span class="seat-name"><strong>${escapeHtml(p.name)}${p.is_me ? " (vous)" : ""}${p.is_host ? " 👑" : ""}</strong><small class="seat-id">ID ${escapeHtml(p.account_id || p.id)}</small></span>` +
            (state.am_i_host && !p.is_me ? `<button type="button" class="btn btn-small kick-player" data-player-id="${escapeHtml(p.id)}" data-player-name="${escapeHtml(p.name.replace(/ \[BOT\]$/, ""))}">Expulser</button>` : "")
          : `<span class="seat-empty">En attente…</span>`);
      list.appendChild(li);
    }

    const btnStart = document.getElementById("btn-start");
    const forceLabel = document.getElementById("force-start-label");
    const hint = document.getElementById("lobby-hint");

    document.querySelectorAll(".kick-player").forEach((button) => {
      button.addEventListener("click", async () => {
        const name = button.dataset.playerName || "ce joueur";
        if (!confirm(`Expulser ${name} du salon ?`)) return;
        button.disabled = true;
        try {
          await apiPost(`/api/room/${this.roomCode}/kick`, {
            player_id: this.playerId,
            target_player_id: button.dataset.playerId,
          });
          this.poll();
        } catch (e) {
          button.disabled = false;
          this.showError(e.message);
        }
      });
    });

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
      const starterHint = document.getElementById("next-starter-hint");
      if (starterHint) starterHint.textContent = state.last_winner_name ? `Départ suivant : ${state.last_winner_name}.` : "Le premier hôte démarre la première manche.";
      document.getElementById("force-start").onchange = () => this.renderLobby(state);
    } else {
      btnStart.hidden = true;
      forceLabel.hidden = true;
      hint.textContent = `${state.nb_players}/${state.max_players} joueurs inscrits. En attente de l’hôte (${state.host_name || "—"})…`;
      const starterHint = document.getElementById("next-starter-hint");
      if (starterHint) starterHint.textContent = state.last_winner_name ? `Départ suivant : ${state.last_winner_name}.` : "";
    }
  },

  renderTable(state) {
    // Manche
    const roundBadge = document.getElementById("round-badge");
    if (roundBadge) roundBadge.textContent = `MANCHE ${state.round_number || 1}`;
    const visibilityBadge = document.getElementById("visibility-badge");
    if (visibilityBadge) {
      const privateRoom = state.visibility === "private";
      visibilityBadge.textContent = privateRoom ? "🔒 PRIVÉ" : "🌐 PUBLIC";
      visibilityBadge.classList.toggle("private", privateRoom);
    }
    const sidebarCount = document.getElementById("sidebar-player-count");
    if (sidebarCount) sidebarCount.textContent = `${state.nb_players}/${state.max_players}`;

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
    state.players.forEach((p) => {
      const chip = document.createElement("div");
      chip.className = "opp-chip" + (p.is_me ? " me-chip" : "") + (p.id === state.turn_player_id ? " active-turn" : "");
      chip.innerHTML = `<span class="opp-seat">${p.seat + 1}</span><span class="opp-avatar">${p.is_me ? "♙" : "♟"}</span><span class="opp-name">${escapeHtml(p.name)}${p.is_me ? " (vous)" : ""}${p.is_host ? " 👑" : ""}</span><span class="opp-id">${escapeHtml(p.account_id || p.id)}</span><span class="opp-count">${p.card_count} cartes</span>${p.is_bot ? `<span class="opp-bot">BOT</span>` : `<span class="opp-online">●</span>`}`;
      strip.appendChild(chip);
    });

    // Pioche / défausse
    document.getElementById("deck-count").textContent = state.deck_count;
    const discardButton = document.getElementById("pile-defausse");
    const discardEl = document.getElementById("discard-card");
    const topIsJoker = !!(state.discard_top && state.joker_info &&
      state.discard_top.rank === state.joker_info.rank && state.joker_info.suits.includes(state.discard_top.suit));
    discardButton.disabled = !state.is_my_turn || state.turn_stage !== "draw" || !state.discard_top || topIsJoker;
    discardButton.title = topIsJoker ? "Joker sur la défausse : pioche obligatoire dans le sabot" : "Prendre la défausse";
    if (state.discard_top) {
      discardEl.className = "card " + (state.discard_top.color === "Rouge" ? "red" : "black");
      if (topIsJoker) discardEl.classList.add("joker-card");
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
      if (this.declareMode && this.selectedHandIds.has(c.id)) el.classList.add("selected");
      el.textContent = c.label;
      el.dataset.id = c.id;

      el.addEventListener("click", () => {
        if (Drag.justDragged || !this.declareMode) return;
        if (assigned.has(c.id)) {
          this.unassign(c.id);
          return;
        }
        if (this.selectedHandIds.has(c.id)) this.selectedHandIds.delete(c.id);
        else this.selectedHandIds.add(c.id);
        this.selectedHandId = this.selectedHandIds.size === 1 ? Array.from(this.selectedHandIds)[0] : null;
        this.renderHandAndZones();
      });

      // En jeu normal, le rejet est volontaire : double-clic / double-tap uniquement.
      el.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        if (Drag.justDragged || this.declareMode || !canAct) return;
        this.discardCard(c.id);
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

  renderChat(state) {
    const messages = Array.isArray(state.chat) ? state.chat : [];
    const signature = messages.map(m => `${m.id || ""}:${m.message || ""}`).join("|");
    if (signature === this.lastChatSignature) return;
    this.lastChatSignature = signature;
    const places = ["lobby", "table", "finished"];
    places.forEach((place) => {
      const panel = document.getElementById(`chat-messages-${place}`);
      if (!panel) return;
      panel.innerHTML = messages.length ? messages.map((m) => {
        const mine = m.player_id === this.playerId ? " mine" : "";
        const when = m.created_at ? new Date(m.created_at * 1000).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "";
        return `<div class="chat-message${mine}"><div class="chat-meta"><strong>${escapeHtml(m.player_name || "Joueur")}</strong><span>${when}</span></div><div class="chat-text">${escapeHtml(m.message || "")}</div></div>`;
      }).join("") : `<div class="chat-empty">Aucun message. Soyez le premier à écrire 👋</div>`;
      panel.scrollTop = panel.scrollHeight;
    });
  },

  renderFinished(state) {
    const title = document.getElementById("finished-title");
    title.textContent = state.winner_name ? `🏆 ${state.winner_name} gagne !` : "Partie terminée";
    document.getElementById("finished-reason").textContent = state.win_reason || "";
    const nextBtn = document.getElementById("btn-next-round");
    if (nextBtn) nextBtn.hidden = !state.am_i_host;

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

// Journal + défausse : rendu à chaque poll pour que les événements
// apparaissent immédiatement chez tous les joueurs.
function renderLiveHistory(state) {
  const logPanel = document.getElementById("log-panel");
  if (logPanel) {
    const logs = state?.log || [];
    logPanel.innerHTML = logs.length
      ? logs.slice().reverse().map((l) => `<div class="log-row">${escapeHtml(l)}</div>`).join("")
      : `<div class="log-empty">Aucun événement pour le moment.</div>`;
    logPanel.scrollTop = 0;
  }

  const discardPanel = document.getElementById("discard-panel");
  if (discardPanel) {
    renderDiscardPanel();
  }

  const take = state?.last_discard_take;
  const alert = document.getElementById("discard-take-alert");
  if (!alert || !take) return;

  if (RamiTable.lastSeenDiscardTakeSeq !== take.seq) {
    RamiTable.lastSeenDiscardTakeSeq = take.seq;
    const c = take.card || {};
    const colorClass = c.color === "Rouge" ? "red" : "black";
    alert.innerHTML = `<span class="take-icon">🟢</span><span><strong>${escapeHtml(take.player_name)}</strong> a pris la carte <span class="take-card ${colorClass}">${escapeHtml(c.label || "—")}</span> dans la défausse${take.discarded_by ? ` — défaussée par <strong>${escapeHtml(take.discarded_by)}</strong>` : ""}. </span>`;
    alert.hidden = false;
    alert.classList.remove("flash");
    void alert.offsetWidth;
    alert.classList.add("flash");
    clearTimeout(RamiTable.discardAlertTimer);
    RamiTable.discardAlertTimer = setTimeout(() => { alert.hidden = true; }, 6000);
  }
}

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
    const take = state.last_discard_take;
    const isLatestTake = !!take && take.player_id === entry.player_id && take.card && take.card.id === c.id;
    const badge = i === 0 ? `<span class="discard-badge">dessus — prenable</span>` : "";
    const takeBadge = isLatestTake ? `<span class="discard-badge">🟢 carte prise</span>` : "";
    return `<div class="discard-row${isLatestTake ? " latest-take" : ""}">
      <span class="card mini ${colorClass}${jokerClass}">${c.label}</span>
      <span class="discard-meta">jetée par <strong>${escapeHtml(entry.player_name)}</strong>${badge}${takeBadge}</span>
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
  THRESHOLD: 10,
  LONG_PRESS_MS: 160, // mobile : maintien très court pour démarrer le glisser, mouvement franc = défilement
  dragTimer: null,
  lastPointer: null,

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
    this.lastPointer = e;

    // Sur écran tactile, laisser le navigateur faire le scroll horizontal.
    // Le glisser démarre après un maintien court afin d'éviter le conflit
    // entre réorganisation des cartes et défilement de la main.
    if (e.pointerType === "touch") {
      this.dragTimer = setTimeout(() => {
        if (!this.pendingEl || this.active) return;
        const p = this.lastPointer || e;
        this.startDrag(p);
      }, this.LONG_PRESS_MS);
    }

    const move = (ev) => this.onPointerMove(ev);
    const up = (ev) => this.onPointerUp(ev, move, up);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
    document.addEventListener("pointercancel", up, { once: true });
  },

  onPointerMove(e) {
    this.lastPointer = e;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (!this.active) {
      if (Math.abs(dx) < this.THRESHOLD && Math.abs(dy) < this.THRESHOLD) return;

      // Sur mobile, un déplacement horizontal franc avant le maintien
      // doit rester un scroll natif. Les petits mouvements sont tolérés
      // pour faciliter le démarrage du glisser.
      // Si le doigt bouge franchement avant le long-press, on abandonne le drag.
      if (e.pointerType === "touch") {
        clearTimeout(this.dragTimer);
        this.dragTimer = null;
        this.cleanupPending();
        return;
      }
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
    clearTimeout(this.dragTimer);
    this.dragTimer = null;
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
    clearTimeout(this.dragTimer);
    this.dragTimer = null;
    this.pendingEl = null;
    this.pendingCardId = null;
    this.pendingFromZone = null;
    this.lastPointer = null;
  },

  handleDrop(toZone, clientX) {
    const cardId = this.cardId;
    const fromZone = this.fromZone;
    const selected = RamiTable.declareMode && RamiTable.selectedHandIds.has(cardId)
      ? Array.from(RamiTable.selectedHandIds) : [cardId];

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
    if (fromZone === toZone) return;
    if (RamiTable.declareMode && fromZone === "hand" && selected.length > 1) {
      for (const id of selected) {
        if (RamiTable.assignments[toZone].length >= RamiTable.zoneCapacity(toZone)) break;
        RamiTable.tryAssignCardToZone(id, toZone);
      }
      RamiTable.selectedHandIds.clear();
      RamiTable.selectedHandId = null;
      RamiTable.renderHandAndZones();
    } else {
      RamiTable.tryAssignCardToZone(cardId, toZone);
    }
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

/* Notifications disponibles sur l'accueil comme dans un salon. */
window.addEventListener("DOMContentLoaded", () => RamiNotifications.init());
