# -*- coding: utf-8 -*-
"""
Rami 104 - Serveur Flask multijoueur (5 joueurs en ligne, chacun sur son
téléphone). Communication par API REST + polling JS côté client (pas de
websockets nécessaires).

Lancement en local :
    pip install -r requirements.txt
    python app.py
Puis, sur le même réseau Wi-Fi, chaque joueur ouvre sur son téléphone :
    http://<IP_DU_SERVEUR>:5000

Déploiement Vercel : voir README_VERCEL.md — nécessite d'ajouter
l'intégration "Vercel KV" (ou une base Upstash Redis) pour que l'état des
parties survive entre deux requêtes serverless. Sans cela, les parties sont
perdues après quelques minutes d'inactivité (mémoire non persistante).
"""
from flask import Flask, request, jsonify, render_template

from game.engine import room_manager
from game.storage import StorageError

app = Flask(__name__)


def error_response(exc, code=400):
    return jsonify({"ok": False, "error": str(exc)}), code


# ---------------------------------------------------------------- Pages ---

@app.route("/")
def home():
    return render_template("home.html")


@app.route("/salon/<code>")
def salon(code):
    return render_template("game.html", room_code=code.upper())


# --------------------------------------------------------------- API ------

@app.route("/api/status")
def api_status():
    """Utile pour diagnostiquer un déploiement : indique si le stockage des
    parties est persistant (Vercel KV / Upstash) ou seulement en mémoire
    (ce qui explique la disparition des parties sur Vercel après quelques
    minutes)."""
    return jsonify({
        "ok": True,
        "storage_persistent": room_manager.storage.is_persistent(),
    })


@app.route("/api/room/create", methods=["POST"])
def api_create_room():
    data = request.get_json(force=True)
    name = (data or {}).get("player_name", "").strip()
    if not name:
        return error_response("Le nom du joueur est requis.")
    try:
        room = room_manager.create_room()
        player = room.add_player(name)
        room_manager.save_room(room)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id})


@app.route("/api/room/join", methods=["POST"])
def api_join_room():
    data = request.get_json(force=True)
    code = (data or {}).get("room_code", "")
    name = (data or {}).get("player_name", "").strip()
    if not name:
        return error_response("Le nom du joueur est requis.")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        player = room.add_player(name)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id})


@app.route("/api/room/<code>/state")
def api_room_state(code):
    try:
        room = room_manager.get_room(code)
    except StorageError as e:
        return error_response(e, 503)
    if room is None:
        return error_response("Salon introuvable.", 404)
    player_id = request.args.get("player_id", "")
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/start", methods=["POST"])
def api_start_room(code):
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    force = bool(data.get("force", False))
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        room.start_game(player_id, force=force)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/draw", methods=["POST"])
def api_draw(code):
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    source = data.get("source", "pioche")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        room.draw(player_id, source)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/discard", methods=["POST"])
def api_discard(code):
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    card_id = data.get("card_id", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        room.discard(player_id, card_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/declare", methods=["POST"])
def api_declare(code):
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    groups = data.get("groups", {})
    discard_card_id = data.get("discard_card_id", "")
    try:
        room = room_manager.get_room(code)
        if room is None:
            return error_response("Salon introuvable.", 404)
        room.declare(player_id, groups, discard_card_id)
        room_manager.save_room(room)
    except ValueError as e:
        return error_response(e)
    except StorageError as e:
        return error_response(e, 503)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
