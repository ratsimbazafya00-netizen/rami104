# -*- coding: utf-8 -*-
"""Rami 104 - serveur Flask multijoueur avec comptes obligatoires."""
from functools import wraps
from flask import Flask, request, jsonify, render_template

from game.engine import room_manager
from game.storage import StorageError
from game.accounts import account_manager

app = Flask(__name__)


def error_response(exc, code=400):
    return jsonify({"ok": False, "error": str(exc)}), code


def current_account():
    auth = request.headers.get("Authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not token:
        token = (request.get_json(silent=True) or {}).get("auth_token", "")
    return account_manager.account_from_token(token)


def require_account():
    account = current_account()
    if account is None:
        return None, error_response("Connexion requise pour jouer.", 401)
    try:
        account_manager.mark_online(account)
    except StorageError:
        pass
    return account, None


# ---------------------------------------------------------------- Pages ---

@app.route("/")
def home():
    return render_template("home.html")


@app.route("/salon/<code>")
def salon(code):
    return render_template("game.html", room_code=code.upper())


@app.route("/login")
def login():
    return render_template("login.html")


@app.route("/inscription")
def inscription():
    return render_template("register.html")


# -------------------------------------------------------- Auth API -------

@app.route("/api/auth/register", methods=["POST"])
def api_register():
    data = request.get_json(force=True) or {}
    try:
        account = account_manager.register(
            data.get("name", ""),
            data.get("phone", ""),
            data.get("password", ""),
            data.get("promo", ""),
        )
        token = account_manager.token_for(account)
        return jsonify({
            "ok": True,
            "token": token,
            "account": {"id": account["id"], "name": account["name"], "phone": account["phone"]},
        })
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True) or {}
    try:
        account = account_manager.login(data.get("phone", ""), data.get("password", ""))
        token = account_manager.token_for(account)
        return jsonify({
            "ok": True,
            "token": token,
            "account": {"id": account["id"], "name": account["name"], "phone": account["phone"]},
        })
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)


@app.route("/api/auth/me")
def api_me():
    account, error = require_account()
    if error:
        return error
    try:
        friends, pending = account_manager.friends_for(account["id"])
        return jsonify({"ok": True, "account": {"id": account["id"], "name": account["name"], "phone": account["phone"]}, "friends": friends, "pending": pending, "invitations": account.get("invitations", [])[-20:]})
    except StorageError as e:
        return error_response(e, 503)


# ------------------------------------------------------ Amis / invitations -

def public_account(account):
    return {"id": account["id"], "name": account["name"], "online": account_manager.is_online(account), "last_seen": account.get("last_seen", 0)}

@app.route("/api/friends")
def api_friends():
    account, error = require_account()
    if error:
        return error
    try:
        friends, pending = account_manager.friends_for(account["id"])
        invitations = account.get("invitations", [])[-20:]
        return jsonify({"ok": True, "friends": friends, "pending": pending, "invitations": invitations})
    except StorageError as e:
        return error_response(e, 503)

@app.route("/api/friends/search")
def api_friends_search():
    account, error = require_account()
    if error:
        return error
    try:
        results = [a for a in account_manager.find_accounts(request.args.get("q", ""), 20) if a["id"] != account["id"]]
        return jsonify({"ok": True, "results": results})
    except StorageError as e:
        return error_response(e, 503)

@app.route("/api/friends/request", methods=["POST"])
def api_friend_request():
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    try:
        target, created = account_manager.add_friend_request(account["id"], str(data.get("target_id", "")))
        if created:
            account_manager.add_notification(
                target["id"], "friend_request", "Nouvelle demande d'ami",
                f'{account["name"]} souhaite devenir votre ami.',
                from_id=account["id"], from_name=account["name"], ref_id=account["id"],
            )
        return jsonify({"ok": True, "target": public_account(target), "created": created})
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)

@app.route("/api/friends/accept", methods=["POST"])
def api_friend_accept():
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    try:
        requester_id = str(data.get("requester_id", ""))
        other = account_manager.accept_friend_request(account["id"], requester_id)
        account_manager.mark_notifications_by(account["id"], kind="friend_request", ref_id=requester_id)
        return jsonify({"ok": True, "friend": public_account(other)})
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)

@app.route("/api/room/<code>/invite-friend", methods=["POST"])
def api_invite_friend(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    target_id = str(data.get("target_id", ""))
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = next((p for p in room.players if p.account_id == account["id"]), None)
        if not player:
            return error_response("Vous n'êtes pas inscrit dans ce salon.", 403)
        friends, _ = account_manager.friends_for(account["id"])
        if not any(str(f["id"]) == target_id for f in friends):
            return error_response("Vous devez être amis pour envoyer une invitation.")
        target = account_manager.find_by_id(target_id)
        if not target:
            return error_response("Ami introuvable.")
        invs = target.get("invitations", [])
        invitation_id = __import__("uuid").uuid4().hex[:12]
        invs.append({"id": invitation_id, "room_code": room.code, "from_id": account["id"], "from_name": account["name"], "created_at": __import__("time").time()})
        target["invitations"] = invs[-20:]
        account_manager.save_account(target)
        account_manager.add_notification(
            target["id"], "room_invite", "Invitation à jouer",
            f'{account["name"]} vous invite à rejoindre le salon {room.code}.',
            from_id=account["id"], from_name=account["name"], room_code=room.code, ref_id=invitation_id,
        )
        return jsonify({"ok": True})
    except StorageError as e:
        return error_response(e, 503)


# ---------------------------------------------------------- Notifications -

@app.route("/api/notifications")
def api_notifications():
    account, error = require_account()
    if error:
        return error
    try:
        items = account_manager.notifications_for(account["id"], unread_only=False, limit=30)
        unread = sum(1 for n in items if not n.get("read"))
        return jsonify({"ok": True, "notifications": items, "unread": unread})
    except StorageError as e:
        return error_response(e, 503)

@app.route("/api/notifications/read", methods=["POST"])
def api_notification_read():
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    try:
        if data.get("all"):
            account_manager.mark_notifications_by(account["id"])
        else:
            account_manager.mark_notification_read(account["id"], str(data.get("id", "")))
        return jsonify({"ok": True})
    except (ValueError, StorageError) as e:
        return error_response(e, 503 if isinstance(e, StorageError) else 400)

# --------------------------------------------------------------- API ------

@app.route("/api/rooms/public")
def api_public_rooms():
    account, error = require_account()
    if error:
        return error
    try:
        rooms = room_manager.find_public_open_rooms(20)
        result = []
        for room in rooms:
            result.append({
                "room_code": room.code,
                "visibility": room.visibility,
                "players": len(room.players),
                "max_players": 5,
                "host_name": room.get_player(room.host_id).name if room.host_id and room.get_player(room.host_id) else "—",
                "created_at": room.created_at,
            })
        return jsonify({"ok": True, "rooms": result})
    except StorageError as e:
        return error_response(e, 503)

@app.route("/api/matchmaking/random", methods=["POST"])
def api_random_matchmaking():
    """Place le joueur dans un salon lobby existant choisi aléatoirement,
    de préférence avec au moins un autre joueur connecté récemment.
    S'il n'y a aucun salon disponible, crée automatiquement une nouvelle table."""
    account, error = require_account()
    if error:
        return error
    try:
        room = room_manager.find_random_open_room(exclude_account_id=account["id"])
        if room is None:
            room = room_manager.create_room()
            room.visibility = "public"
        player = room.add_player(account["name"], account_id=account["id"])
        room_manager.save_room(room)
        return jsonify({"ok": True, "room_code": room.code, "player_id": player.id,
                        "account_id": account["id"], "player_name": account["name"],
                        "matched": len(room.players) > 1, "players": len(room.players)})
    except StorageError as e:
        return error_response(e, 503)
    except ValueError as e:
        return error_response(e)


@app.route("/api/status")
def api_status():
    return jsonify({"ok": True, "storage_persistent": room_manager.storage.is_persistent()})


@app.route("/api/room/create", methods=["POST"])
def api_create_room():
    account, error = require_account()
    if error:
        return error
    try:
        data = request.get_json(force=True) or {}
        visibility = str(data.get("visibility", "public")).lower()
        if visibility not in ("public", "private"):
            visibility = "public"
        room = room_manager.create_room()
        room.visibility = visibility
        player = room.add_player(account["name"], account_id=account["id"])
        room_manager.save_room(room)
    except StorageError as e:
        return error_response(e, 503)
    except ValueError as e:
        return error_response(e)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id, "account_id": account["id"], "player_name": account["name"]})


@app.route("/api/room/join", methods=["POST"])
def api_join_room():
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    code = data.get("room_code", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = room.reconnect(account["id"], None)
        if player is None:
            player = room.add_player(account["name"], account_id=account["id"])
        # Une invitation correspondant à ce salon est consommée à l'entrée.
        fresh = account_manager.find_by_id(account["id"])
        if fresh:
            matching = [i for i in fresh.get("invitations", []) if str(i.get("room_code", "")).upper() == room.code]
            fresh["invitations"] = [i for i in fresh.get("invitations", []) if str(i.get("room_code", "")).upper() != room.code]
            account_manager.save_account(fresh)
            for inv in matching:
                account_manager.mark_notifications_by(account["id"], kind="room_invite", ref_id=inv.get("id"))
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id, "account_id": account["id"], "player_name": account["name"]})


def resolve_player(room, account_id, player_id="", reconnect=True):
    """Résout l'identité durable du joueur et restaure un siège devenu BOT."""
    player = room.reconnect(account_id, player_id) if reconnect else room.get_player(player_id)
    if player is None or player.account_id != account_id:
        return None
    return player


def run_bot_for_stale_turn(room, active_account_id):
    """Détecte l'absence du joueur courant lors d'un polling.

    La présence des comptes est déjà rafraîchie par ``require_account``.
    On ne sonde que le joueur courant pour limiter les lectures du stockage
    persistant ; quand son tour est joué par le bot, le prochain polling
    vérifiera le joueur suivant.
    """
    if room.phase != "playing":
        return
    current = room.current_player()
    if not current or not current.account_id or current.account_id == active_account_id:
        return
    try:
        current_account = account_manager.find_by_id(current.account_id)
    except StorageError:
        return
    if current_account and not account_manager.is_online(current_account):
        room.mark_disconnected(current.id)


@app.route("/api/room/<code>/state")
def api_room_state(code):
    account, error = require_account()
    if error:
        return error
    try:
        room = room_manager.get_room(code)
    except StorageError as e:
        return error_response(e, 503)
    if room is None:
        return error_response("Salon introuvable.", 404)
    player_id = request.args.get("player_id", "")
    player = room.reconnect(account["id"], player_id)
    if player is None:
        return error_response("Vous n'êtes pas inscrit dans ce salon.", 403)
    run_bot_for_stale_turn(room, account["id"])
    room_manager.save_room(room)
    return jsonify({"ok": True, "state": room.state_for(player.id)})


@app.route("/api/room/<code>/start", methods=["POST"])
def api_start_room(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    # N'accepter que le booléen JSON true : bool("false") vaut True en
    # Python et permettait à une requête mal formée de forcer le démarrage.
    force = data.get("force", False) is True
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.start_game(player.id, force=force)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player.id)})


@app.route("/api/room/<code>/draw", methods=["POST"])
def api_draw(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    source = data.get("source", "pioche")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.draw(player.id, source)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player.id)})


@app.route("/api/room/<code>/discard", methods=["POST"])
def api_discard(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    card_id = data.get("card_id", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.discard(player.id, card_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player.id)})


@app.route("/api/room/<code>/chat", methods=["POST"])
def api_chat(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    message = data.get("message", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.add_chat_message(player.id, message)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "chat": room.chat[-150:]})


@app.route("/api/room/<code>/declare", methods=["POST"])
def api_declare(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    groups = data.get("groups", {})
    discard_card_id = data.get("discard_card_id", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.declare(player.id, groups, discard_card_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player.id)})


@app.route("/api/room/<code>/leave", methods=["POST"])
def api_leave_room(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id, reconnect=False)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.leave(player.id)
        # Un départ volontaire retire réellement le joueur du salon.
        # Si plus personne ne reste, le salon est supprimé immédiatement.
        if not room.players:
            room_manager.delete_room(room)
        else:
            room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True})


@app.route("/api/room/<code>/kick", methods=["POST"])
def api_kick_room_player(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    target_player_id = data.get("target_player_id", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id, reconnect=False)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.kick(player.id, target_player_id)
        if not room.players:
            room_manager.delete_room(room)
            return jsonify({"ok": True, "closed": True})
        room_manager.save_room(room)
        return jsonify({"ok": True, "state": room.state_for(player.id)})
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)


@app.route("/api/room/<code>/next-round", methods=["POST"])
def api_next_round(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = resolve_player(room, account["id"], player_id)
        if not player:
            return error_response("Joueur non autorisé.", 403)
        room.prepare_next_round(player.id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player.id)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
