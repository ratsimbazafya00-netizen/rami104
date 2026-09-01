# -*- coding: utf-8 -*-
"""
Rami 104 - Serveur Flask multijoueur (5 joueurs en ligne, chacun sur son
téléphone). Communication par API REST + polling JS côté client (pas de
websockets nécessaires).

Lancement :
    pip install -r requirements.txt
    python app.py
Puis, sur le même réseau Wi-Fi, chaque joueur ouvre sur son téléphone :
    http://<IP_DU_SERVEUR>:5000
"""
from flask import Flask, request, jsonify, render_template

from game.engine import room_manager

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

@app.route("/api/room/create", methods=["POST"])
def api_create_room():
    data = request.get_json(force=True)
    name = (data or {}).get("player_name", "").strip()
    if not name:
        return error_response("Le nom du joueur est requis.")
    room = room_manager.create_room()
    player = room.add_player(name)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id})


@app.route("/api/room/join", methods=["POST"])
def api_join_room():
    data = request.get_json(force=True)
    code = (data or {}).get("room_code", "")
    name = (data or {}).get("player_name", "").strip()
    if not name:
        return error_response("Le nom du joueur est requis.")
    room = room_manager.get_room(code)
    if room is None:
        return error_response("Salon introuvable.", 404)
    try:
        player = room.add_player(name)
    except ValueError as e:
        return error_response(e)
    return jsonify({"ok": True, "room_code": room.code, "player_id": player.id})


@app.route("/api/room/<code>/state")
def api_room_state(code):
    room = room_manager.get_room(code)
    if room is None:
        return error_response("Salon introuvable.", 404)
    player_id = request.args.get("player_id", "")
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/start", methods=["POST"])
def api_start_room(code):
    room = room_manager.get_room(code)
    if room is None:
        return error_response("Salon introuvable.", 404)
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    force = bool(data.get("force", False))
    try:
        room.start_game(player_id, force=force)
    except ValueError as e:
        return error_response(e)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/draw", methods=["POST"])
def api_draw(code):
    room = room_manager.get_room(code)
    if room is None:
        return error_response("Salon introuvable.", 404)
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    source = data.get("source", "pioche")
    try:
        room.draw(player_id, source)
    except ValueError as e:
        return error_response(e)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/discard", methods=["POST"])
def api_discard(code):
    room = room_manager.get_room(code)
    if room is None:
        return error_response("Salon introuvable.", 404)
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    card_id = data.get("card_id", "")
    try:
        room.discard(player_id, card_id)
    except ValueError as e:
        return error_response(e)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


@app.route("/api/room/<code>/declare", methods=["POST"])
def api_declare(code):
    room = room_manager.get_room(code)
    if room is None:
        return error_response("Salon introuvable.", 404)
    data = request.get_json(force=True) or {}
    player_id = data.get("player_id", "")
    groups = data.get("groups", {})
    discard_card_id = data.get("discard_card_id", "")
    try:
        room.declare(player_id, groups, discard_card_id)
    except ValueError as e:
        return error_response(e)
    return jsonify({"ok": True, "state": room.state_for(player_id)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
