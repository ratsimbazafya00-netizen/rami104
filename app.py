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
    friends, pending = account_manager.friends_for(account["id"])
    return jsonify({"ok": True, "account": {"id": account["id"], "name": account["name"], "phone": account["phone"]}, "friends": friends, "pending": pending, "invitations": account.get("invitations", [])[-20:]})


# ------------------------------------------------------ Amis / invitations -

def public_account(account):
    return {"id": account["id"], "name": account["name"], "phone": account["phone"]}

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
        target = account_manager.add_friend_request(account["id"], str(data.get("target_id", "")))
        return jsonify({"ok": True, "target": public_account(target)})
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
        other = account_manager.accept_friend_request(account["id"], str(data.get("requester_id", "")))
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
        invs.append({"id": __import__("uuid").uuid4().hex[:12], "room_code": room.code, "from_id": account["id"], "from_name": account["name"], "created_at": __import__("time").time()})
        target["invitations"] = invs[-20:]
        account_manager.save_account(target)
        return jsonify({"ok": True})
    except StorageError as e:
        return error_response(e, 503)


# --------------------------------------------------------------- API ------

@app.route("/api/status")
def api_status():
    return jsonify({"ok": True, "storage_persistent": room_manager.storage.is_persistent()})


@app.route("/api/room/create", methods=["POST"])
def api_create_room():
    account, error = require_account()
    if error:
        return error
    try:
        room = room_manager.create_room()
        player = room.add_player(account["name"], account_id=account["id"])
        room_manager.save_room(room)
    except StorageError as e:
        return error_response(e, 503)
    except ValueError as e:
        return error_response(e)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id})


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
        player = room.add_player(account["name"], account_id=account["id"])
        # Une invitation correspondant à ce salon est consommée à l'entrée.
        fresh = account_manager.find_by_id(account["id"])
        if fresh:
            fresh["invitations"] = [i for i in fresh.get("invitations", []) if str(i.get("room_code", "")).upper() != room.code]
            account_manager.save_account(fresh)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id})


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
    # Le player_id est une clé de session locale ; on vérifie aussi que le
    # joueur correspond bien au compte connecté pour empêcher l'usurpation.
    player = room.get_player(player_id)
    if player is None or player.account_id != account["id"]:
        return error_response("Vous n'êtes pas inscrit dans ce salon.", 403)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/start", methods=["POST"])
def api_start_room(code):
    account, error = require_account()
    if error:
        return error
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    force = bool(data.get("force", False))
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = room.get_player(player_id)
        if not player or player.account_id != account["id"]:
            return error_response("Joueur non autorisé.", 403)
        room.start_game(player_id, force=force)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


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
        player = room.get_player(player_id)
        if not player or player.account_id != account["id"]:
            return error_response("Joueur non autorisé.", 403)
        room.draw(player_id, source)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


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
        player = room.get_player(player_id)
        if not player or player.account_id != account["id"]:
            return error_response("Joueur non autorisé.", 403)
        room.discard(player_id, card_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


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
        player = room.get_player(player_id)
        if not player or player.account_id != account["id"]:
            return error_response("Joueur non autorisé.", 403)
        room.add_chat_message(player_id, message)
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
        player = room.get_player(player_id)
        if not player or player.account_id != account["id"]:
            return error_response("Joueur non autorisé.", 403)
        room.declare(player_id, groups, discard_card_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


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
        player = room.get_player(player_id)
        if not player or player.account_id != account["id"]:
            return error_response("Joueur non autorisé.", 403)
        room.leave(player_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True})


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
        player = room.get_player(player_id)
        if not player or player.account_id != account["id"]:
            return error_response("Joueur non autorisé.", 403)
        room.prepare_next_round(player_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
