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
  if (!data.ok) {
    const err = new Error(data.error || "Erreur inconnue");
    err.status = res.status;
    throw err;
  }
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
  if (!data.ok) {
    const err = new Error(data.error || "Erreur inconnue");
    err.status = res.status;
    throw err;
  }
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
  pollInFlight: false,
  lastState: null,
  lastChatSignature: "",
  lastHistoryVersion: -1,
  historyInFlight: false,
  pendingDiscardId: null,
  handOrder: [],
  handDrag: null,
  suppressNextCardClick: false,

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
    this.poll(true);
    this.pollTimer = setInterval(() => this.poll(false), 700);
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
          await this.refreshHistory();
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

  async poll(withHistory = false) {
    if (this.actionInFlight || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const data = await apiGet(`/api/room/${this.roomCode}/state?player_id=${this.playerId}&history=${withHistory ? 1 : 0}`);
      const incoming = data.state || {};
      const previous = this.lastState;
      const stateChanged = !previous || previous.state_version !== incoming.state_version || previous.phase !== incoming.phase;

      this.lastState = {...(previous || {}), ...incoming};
      if (incoming.my_player_id && incoming.my_player_id !== this.playerId) {
        this.playerId = incoming.my_player_id;
        localStorage.setItem(playerKey(this.roomCode), this.playerId);
      }

      // IMPORTANT : ne reconstruit pas tout le DOM à chaque polling.
      // Le serveur incrémente state_version uniquement lorsqu'une vraie
      // modification de partie intervient. Cela évite une grosse charge
      // CPU/DOM sur mobile et réduit fortement la sensation de latence.
      if (stateChanged) this.render(this.lastState);

      if (withHistory) {
        // Le premier état peut déjà contenir l'historique complet : inutile
        // de faire immédiatement une deuxième requête /events.
        if (Array.isArray(incoming.log)) {
          this.lastHistoryVersion = incoming.history_version ?? -1;
          this.renderChat(this.lastState);
          renderLiveHistory(this.lastState);
        }
      } else if (this.lastHistoryVersion !== this.lastState.history_version) {
        await this.refreshHistory();
      }
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        clearInterval(this.pollTimer); this.pollTimer = null;
        localStorage.removeItem(playerKey(this.roomCode));
        window.location.replace("/");
        return;
      }
      this.showError(e.message);
    } finally {
      this.pollInFlight = false;
    }
  },

  async refreshHistory() {
    if (this.historyInFlight) return;
    this.historyInFlight = true;
    try {
      const data = await apiGet(`/api/room/${this.roomCode}/events?player_id=${this.playerId}`);
      if (!this.lastState) return;
      this.lastState.log = data.log || [];
      this.lastState.chat = data.chat || [];
      this.lastState.discard_pile = data.discard_pile || [];
      this.lastState.last_discard_take = data.last_discard_take || null;
      this.lastState.history_version = data.history_version;
      this.lastHistoryVersion = data.history_version;
      this.renderChat(this.lastState);
      renderLiveHistory(this.lastState);
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) this.showError(e.message);
    } finally {
      this.historyInFlight = false;
    }
  },

  async leaveRoom() {
    if (!confirm("Quitter ce salon ?\n\nAprès avoir quitté pendant une manche, vous ne pourrez plus reprendre votre place dans cette manche.")) return;
    try {
      // Stoppe immédiatement les GET d'état pour éviter qu'une requête en
      // cours ne maintienne visuellement l'ancien plateau.
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      await apiPost(`/api/room/${this.roomCode}/leave`, { player_id: this.playerId });
      localStorage.removeItem(playerKey(this.roomCode));
      window.location.replace("/");
    } catch (e) {
      // Si le serveur a déjà supprimé le joueur/salon, l'objectif du départ
      // est déjà atteint : nettoyer le client et retourner à l'accueil.
      if (e.status === 403 || e.status === 404) {
        localStorage.removeItem(playerKey(this.roomCode));
        window.location.replace("/");
        return;
      }
      if (!this.pollTimer) this.pollTimer = setInterval(() => this.poll(), 1500);
      this.showError(e.message);
    }
  },

  async nextRound() {
    try {
      await apiPost(`/api/room/${this.roomCode}/next-round`, { player_id: this.playerId });
      this.poll();
    } catch (e) { this.showError(e.message); }
  },

  async draw(source) {
    if (this.actionInFlight) return;
    this.actionInFlight = true;
    this.setActionBusy(true, source === "defausse" ? "Prise…" : "Pioche…");
    try {
      const data = await this.actionRequest(`/api/room/${this.roomCode}/draw`, { player_id: this.playerId, source, state_version: this.lastState?.state_version });
      if (data.state) {
        this.lastState = data.state;
        this.render(data.state);
      }
    } catch (e) {
      this.showError(e.message);
    } finally {
      this.setActionBusy(false);
      this.actionInFlight = false;
      await this.refreshHistory();
    }
  },

  async discardCard(cardId) {
    if (this.actionInFlight) return;
    this.actionInFlight = true;
    this.pendingDiscardId = null;
    this.setActionBusy(true, "Défausse…");
    try {
      const data = await this.actionRequest(`/api/room/${this.roomCode}/discard`, { player_id: this.playerId, card_id: cardId, state_version: this.lastState?.state_version });
      if (data.state) {
        this.lastState = data.state;
        this.render(data.state);
      }
    } catch (e) {
      this.showError(e.message);
    } finally {
      this.setActionBusy(false);
      this.actionInFlight = false;
      await this.refreshHistory();
    }
  },

  async actionRequest(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(getAuthToken() ? { "Authorization": `Bearer ${getAuthToken()}` } : {}),
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      const data = await res.json();
      if (res.status === 401) {
        localStorage.removeItem("rami_auth_token");
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        throw new Error(data.error || "Connexion requise.");
      }
      if (!data.ok) {
        const err = new Error(data.error || "Erreur inconnue");
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Le serveur met trop de temps à répondre. Réessayez.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  setActionBusy(busy, label = "") {
    this.actionInFlight = !!busy;
    const drawPile = document.getElementById("pile-pioche");
    const discardPile = document.getElementById("pile-defausse");
    if (drawPile) {
      drawPile.classList.toggle("action-busy", !!busy);
      drawPile.setAttribute("aria-busy", busy ? "true" : "false");
    }
    if (discardPile) {
      discardPile.classList.toggle("action-busy", !!busy);
      discardPile.setAttribute("aria-busy", busy ? "true" : "false");
    }
    const banner = document.getElementById("turn-banner");
    if (busy && banner && label) {
      banner.dataset.previousText = banner.textContent || "";
      banner.textContent = label;
    } else if (!busy && banner && banner.dataset.previousText) {
      banner.textContent = banner.dataset.previousText;
      delete banner.dataset.previousText;
    }
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
      const trueJokers = `${state.joker_info.rank} ${state.joker_info.suits.map(suitSymbol).join(" / ")}`;
      const falseJokers = (state.joker_info.false_jokers || [])
        .map(c => `${c.rank}${suitSymbol(c.suit)}`)
        .join(" ");
      jokerBadge.innerHTML = `<span class="joker-real">JOKER : <strong>${escapeHtml(trueJokers)}</strong></span>` +
        `<span class="joker-false">FAUX JOKER : <strong>${escapeHtml(falseJokers || "—")}</strong></span>`;
      jokerBadge.title = "Les faux jokers sont des cartes normales et ne comptent pas comme jokers.";
    }

    // Tour
    const banner = document.getElementById("turn-banner");
    if (state.is_my_turn) {
      banner.textContent = state.turn_stage === "draw"
        ? "À vous : piochez une carte"
        : "À vous : défaussez une carte";
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
    discardButton.disabled = this.actionInFlight || !state.is_my_turn || state.turn_stage !== "draw" || !state.discard_top || topIsJoker;
    discardButton.title = topIsJoker ? "Joker sur la défausse : pioche obligatoire dans le sabot" : "Prendre la défausse";
    if (state.discard_top) {
      discardEl.className = "card " + (state.discard_top.color === "Rouge" ? "red" : "black");
      if (topIsJoker) discardEl.classList.add("joker-card");
      discardEl.textContent = state.discard_top.label;
    } else {
      discardEl.className = "card card-empty";
      discardEl.textContent = "—";
    }

    this.renderHandAndZones();
  },

  renderHandAndZones() {
    const state = this.lastState;
    if (!state || !state.my_hand) return;
    const hand = state.my_hand;
    const ids = new Set(hand.map(c => c.id));

    // L'ordre est purement visuel : le serveur garde toujours la vraie main.
    // On conserve l'ordre choisi par le joueur et on ajoute les nouvelles
    // cartes à la fin après une pioche.
    this.handOrder = this.handOrder.filter(id => ids.has(id));
    hand.forEach(c => { if (!this.handOrder.includes(c.id)) this.handOrder.push(c.id); });
    const byId = new Map(hand.map(c => [c.id, c]));
    const orderedHand = this.handOrder.map(id => byId.get(id)).filter(Boolean);

    const canAct = !this.actionInFlight && state.is_my_turn && state.turn_stage === "discard";
    if (!canAct || !hand.some(c => c.id === this.pendingDiscardId)) this.pendingDiscardId = null;

    const handEl = document.getElementById("hand");
    handEl.innerHTML = "";
    handEl.classList.remove("drop-target");

    orderedHand.forEach((c) => {
      const el = document.createElement("div");
      el.className = "card draggable " + (c.color === "Rouge" ? "red" : "black");
      if (state.joker_info && c.rank === state.joker_info.rank && state.joker_info.suits.includes(c.suit)) el.classList.add("joker-card");
      el.textContent = c.label;
      el.dataset.id = c.id;
      el.title = "Glissez pour réorganiser votre main";

      if (canAct) {
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (this.suppressNextCardClick) {
            this.suppressNextCardClick = false;
            return;
          }
          this.pendingDiscardId = this.pendingDiscardId === c.id ? null : c.id;
          this.renderHandAndZones();
        });
      }

      if (canAct && this.pendingDiscardId === c.id) {
        el.classList.add("discard-pending");
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "discard-confirm";
        confirm.textContent = "✓";
        confirm.title = "Défausser";
        confirm.setAttribute("aria-label", `Défausser ${c.label}`);
        confirm.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        confirm.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.discardCard(c.id);
        });
        el.appendChild(confirm);
      }

      this.bindCardReorder(el, handEl);
      handEl.appendChild(el);
    });
  },

  bindCardReorder(el, handEl) {
    let timer = null;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let ghost = null;
    const cardId = el.dataset.id;

    const cleanup = () => {
      clearTimeout(timer);
      timer = null;
      if (ghost) ghost.remove();
      ghost = null;
      document.querySelectorAll(".hand .card.dragging").forEach(x => x.classList.remove("dragging"));
      handEl.classList.remove("drop-target");
      this.handDrag = null;
    };

    const begin = () => {
      if (this.actionInFlight) return;
      dragging = true;
      this.suppressNextCardClick = true;
      el.classList.add("dragging");
      ghost = el.cloneNode(true);
      ghost.classList.add("card-drag-ghost");
      ghost.style.width = `${el.getBoundingClientRect().width}px`;
      ghost.style.height = `${el.getBoundingClientRect().height}px`;
      document.body.appendChild(ghost);
      handEl.classList.add("drop-target");
      this.handDrag = {id: cardId};
    };

    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      if (ev.target.closest("button")) return;
      startX = ev.clientX; startY = ev.clientY;
      timer = setTimeout(begin, 180);
      try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    });

    el.addEventListener("pointermove", (ev) => {
      if (!timer && !dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 12) {
        // Petit déplacement avant le long-press = intention de faire défiler.
        clearTimeout(timer);
        timer = null;
        return;
      }
      if (!dragging) return;
      ev.preventDefault();
      if (ghost) {
        ghost.style.left = `${ev.clientX - ghost.offsetWidth / 2}px`;
        ghost.style.top = `${ev.clientY - ghost.offsetHeight / 2}px`;
      }
      const siblings = [...handEl.querySelectorAll(".card.draggable:not(.dragging)")];
      const target = siblings.find(other => {
        const r = other.getBoundingClientRect();
        return ev.clientX < r.left + r.width / 2;
      });
      if (target) handEl.insertBefore(el, target);
      else handEl.appendChild(el);
    });

    el.addEventListener("pointerup", () => {
      if (dragging) {
        const newOrder = [...handEl.querySelectorAll(".card.draggable")].map(x => x.dataset.id);
        this.handOrder = newOrder;
        cleanup();
        // Pas de requête réseau : le classement est uniquement visuel.
        setTimeout(() => { this.suppressNextCardClick = false; }, 0);
      } else {
        clearTimeout(timer);
        timer = null;
      }
    });

    el.addEventListener("pointercancel", cleanup);
    el.addEventListener("lostpointercapture", () => {
      if (dragging) {
        const newOrder = [...handEl.querySelectorAll(".card.draggable")].map(x => x.dataset.id);
        this.handOrder = newOrder;
        cleanup();
      } else {
        clearTimeout(timer);
        timer = null;
      }
    });
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
