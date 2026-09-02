# -*- coding: utf-8 -*-
"""
Moteur du Rami 104 cartes : gestion d'un salon de jeu (Room) avec 5 joueurs,
distribution, pioche/défausse, joker, et conditions de victoire.
"""
import json
import threading
import time
import uuid

from .cards import Card, build_double_deck, shuffle_very_random, determine_joker, is_joker
from .melds import validate_full_hand
from .storage import build_storage

MAX_PLAYERS = 5
CARDS_PER_PLAYER = 13
JOKER_AUTO_WIN_COUNT = 3


class Player:
    def __init__(self, player_id, name, seat):
        self.id = player_id
        self.name = name
        self.seat = seat  # 0..4  (seat 0 = "joueur 1", etc.)
        self.hand = []     # list[Card]
        self.connected = True

    def joker_count(self, joker_info):
        return sum(1 for c in self.hand if is_joker(c, joker_info))


class Room:
    def __init__(self, code):
        self.code = code
        self.players = []          # list[Player], ordre = ordre de siège
        self.phase = "lobby"       # lobby | playing | finished
        self.deck = []             # pioche (sabot)
        self.discard_pile = []     # défausse, dernier élément = dessus de pile
        self.joker_info = None
        self.turn_index = 0        # index dans self.players
        self.turn_stage = "draw"   # draw | discard
        self.log = []
        self.winner_id = None
        self.win_reason = None
        self.winning_hand = None  # combinaisons de la main gagnante (si victoire par déclaration)
        self.lock = threading.RLock()
        self.created_at = time.time()

    # ---------- Lobby ----------

    def add_player(self, name):
        with self.lock:
            if self.phase != "lobby":
                raise ValueError("La partie a déjà commencé.")
            if len(self.players) >= MAX_PLAYERS:
                raise ValueError("Le salon est complet (5 joueurs).")
            pid = uuid.uuid4().hex[:8]
            player = Player(pid, name.strip()[:20] or f"Joueur{len(self.players)+1}", len(self.players))
            self.players.append(player)
            self._log(f"{player.name} a rejoint le salon (siège {player.seat + 1}).")
            return player

    def get_player(self, player_id):
        for p in self.players:
            if p.id == player_id:
                return p
        return None

    def _log(self, message):
        self.log.append(message)
        self.log = self.log[-60:]  # garde les 60 derniers événements

    # ---------- Démarrage ----------

    def start_game(self, requesting_player_id, force=False):
        with self.lock:
            if self.phase != "lobby":
                raise ValueError("La partie a déjà commencé.")
            requester = self.get_player(requesting_player_id)
            if requester is None or requester.seat != 0:
                raise ValueError("Seul le joueur 1 (hôte) peut démarrer la partie.")
            if len(self.players) < MAX_PLAYERS and not force:
                raise ValueError(
                    f"Il faut {MAX_PLAYERS} joueurs pour démarrer ({len(self.players)} inscrits)."
                )
            if len(self.players) < 3:
                raise ValueError("Il faut au moins 3 joueurs pour démarrer.")

            deck = build_double_deck()
            deck = shuffle_very_random(deck, passes=7)

            # Le joueur 3 (siège index 2, ou le dernier joueur si force avec <5)
            cut_seat = min(2, len(self.players) - 1)
            cut_card = deck.pop()  # on "coupe" en retirant la carte du dessus
            self.joker_info = determine_joker(cut_card)
            self._log(
                f"{self.players[cut_seat].name} coupe le jeu : carte retournée "
                f"{cut_card.rank}{cut_card.suit} ({cut_card.color}) -> "
                f"le joker est {self.joker_info['rank']} {self.joker_info['color']} "
                f"({' et '.join(self.joker_info['suits'])})."
            )

            # Distribution 13 cartes/joueur, dans l'ordre, en tournant
            n = len(self.players)
            for i in range(CARDS_PER_PLAYER * n):
                self.players[i % n].hand.append(deck.pop())

            self.deck = deck  # reste = pioche
            self.discard_pile = []
            self.turn_index = 0
            self.turn_stage = "draw"
            self.phase = "playing"
            self._log(
                f"Distribution terminée : {CARDS_PER_PLAYER} cartes par joueur, "
                f"{len(self.deck)} cartes restantes dans la pioche."
            )

            # Vérifie une victoire immédiate par 3 jokers dès la distribution
            self._check_joker_auto_win(initial=True)
            return True

    # ---------- Déroulement d'un tour ----------

    def current_player(self):
        if not self.players:
            return None
        return self.players[self.turn_index]

    def draw(self, player_id, source):
        """source: 'pioche' ou 'defausse'"""
        with self.lock:
            self._assert_playing()
            player = self._assert_turn(player_id, expected_stage="draw")

            if source == "pioche":
                if not self.deck:
                    self._end_by_empty_deck()
                    return
                card = self.deck.pop()
                player.hand.append(card)
                self._log(f"{player.name} pioche une carte du sabot.")
            elif source == "defausse":
                if not self.discard_pile:
                    raise ValueError("La défausse est vide.")
                entry = self.discard_pile.pop()
                card = entry["card"]
                player.hand.append(card)
                self._log(f"{player.name} prend {card.rank}{card.suit} dans la défausse (jetée par {entry['player_name']}).")
            else:
                raise ValueError("Source de pioche inconnue.")

            self.turn_stage = "discard"
            self._check_joker_auto_win()

    def discard(self, player_id, card_id):
        with self.lock:
            self._assert_playing()
            player = self._assert_turn(player_id, expected_stage="discard")
            card = self._pop_from_hand(player, card_id)
            self.discard_pile.append({"card": card, "player_id": player.id, "player_name": player.name})
            self._log(f"{player.name} défausse {card.rank}{card.suit}.")
            self._advance_turn()

            if not self.deck:
                self._end_by_empty_deck()

    def declare(self, player_id, groups_by_id, discard_card_id):
        """
        groups_by_id: {"tri": [card_id, ...], "escalier": [...],
                        "carre": [...], "groupe4": [...]}
        Le joueur doit avoir 14 cartes en main (vient de piocher) ; 13 sont
        réparties dans les 4 groupes, la 14e est défaussée si la main est
        valide.
        """
        with self.lock:
            self._assert_playing()
            player = self._assert_turn(player_id, expected_stage="discard")

            hand_by_id = {c.id: c for c in player.hand}
            missing = [cid for cid in list(groups_by_id.get("tri", [])) +
                       list(groups_by_id.get("escalier", [])) +
                       list(groups_by_id.get("carre", [])) +
                       list(groups_by_id.get("groupe4", [])) +
                       [discard_card_id]
                       if cid not in hand_by_id]
            if missing:
                raise ValueError("Certaines cartes ne sont pas dans votre main.")

            groups_cards = {
                key: [hand_by_id[cid] for cid in ids]
                for key, ids in groups_by_id.items()
            }

            all_used_ids = set()
            for ids in groups_by_id.values():
                all_used_ids.update(ids)
            all_used_ids.add(discard_card_id)
            if len(all_used_ids) != 14 or len(player.hand) != 14:
                raise ValueError("Il faut répartir vos 13 cartes + défausser la 14e.")

            valid, message, detail = validate_full_hand(groups_cards, self.joker_info)
            if not valid:
                raise ValueError(message)

            # Main gagnante : on retire tout, on déclare la victoire
            discard_card = hand_by_id[discard_card_id]
            self.winning_hand = {
                "tri": [c.to_dict() for c in groups_cards.get("tri", [])],
                "escalier": [c.to_dict() for c in groups_cards.get("escalier", [])],
                "carre": [c.to_dict() for c in groups_cards.get("carre", [])],
                "groupe4": [c.to_dict() for c in groups_cards.get("groupe4", [])],
                "discard": discard_card.to_dict(),
            }
            player.hand = []
            self.discard_pile.append({"card": discard_card, "player_id": player.id, "player_name": player.name})
            self.phase = "finished"
            self.winner_id = player.id
            self.win_reason = "Main complète (tri + escalier + carré + 4e groupe)."
            self._log(f"🏆 {player.name} déclare et GAGNE : {message}")

    # ---------- Fin de partie ----------

    def _end_by_empty_deck(self):
        self.phase = "finished"
        self.winner_id = None
        self.win_reason = "La pioche est épuisée : partie terminée sans gagnant."
        self._log("La pioche est vide. Fin de la partie (aucun gagnant par mise en main).")

    def _check_joker_auto_win(self, initial=False):
        for player in self.players:
            if player.joker_count(self.joker_info) >= JOKER_AUTO_WIN_COUNT:
                self.phase = "finished"
                self.winner_id = player.id
                origin = "à la distribution initiale" if initial else "en cours de partie"
                self.win_reason = f"{player.name} a obtenu {JOKER_AUTO_WIN_COUNT} jokers ({origin})."
                self._log(f"🏆 {player.name} gagne automatiquement : {JOKER_AUTO_WIN_COUNT} jokers réunis {origin} !")
                return True
        return False

    # ---------- Aides internes ----------

    def _assert_playing(self):
        if self.phase != "playing":
            raise ValueError("La partie n'est pas en cours.")

    def _assert_turn(self, player_id, expected_stage):
        player = self.get_player(player_id)
        if player is None:
            raise ValueError("Joueur inconnu.")
        if self.current_player().id != player_id:
            raise ValueError("Ce n'est pas votre tour.")
        if self.turn_stage != expected_stage:
            if expected_stage == "draw":
                raise ValueError("Vous devez d'abord défausser une carte.")
            else:
                raise ValueError("Vous devez d'abord piocher une carte.")
        return player

    def _pop_from_hand(self, player, card_id):
        for i, c in enumerate(player.hand):
            if c.id == card_id:
                return player.hand.pop(i)
        raise ValueError("Cette carte n'est pas dans votre main.")

    def _advance_turn(self):
        n = len(self.players)
        self.turn_index = (self.turn_index + 1) % n
        self.turn_stage = "draw"

    # ---------- Sérialisation pour un joueur donné ----------

    def state_for(self, player_id):
        with self.lock:
            me = self.get_player(player_id)
            players_public = []
            for p in self.players:
                players_public.append({
                    "id": p.id,
                    "name": p.name,
                    "seat": p.seat,
                    "card_count": len(p.hand),
                    "connected": p.connected,
                    "is_me": (me is not None and p.id == me.id),
                })
            data = {
                "room_code": self.code,
                "phase": self.phase,
                "players": players_public,
                "nb_players": len(self.players),
                "max_players": MAX_PLAYERS,
                "log": self.log[-25:],
                "joker_info": self.joker_info,
                "deck_count": len(self.deck),
                "discard_top": self.discard_pile[-1]["card"].to_dict() if self.discard_pile else None,
                "discard_pile": [
                    {
                        "card": entry["card"].to_dict(),
                        "player_id": entry["player_id"],
                        "player_name": entry["player_name"],
                    }
                    for entry in self.discard_pile
                ],
                "winner_id": self.winner_id,
                "winner_name": self.get_player(self.winner_id).name if self.winner_id else None,
                "win_reason": self.win_reason,
                "winning_hand": self.winning_hand,
                "am_i_host": bool(me and me.seat == 0),
            }
            if self.phase != "lobby":
                data["turn_player_id"] = self.current_player().id if self.players else None
                data["turn_player_name"] = self.current_player().name if self.players else None
                data["turn_stage"] = self.turn_stage
                data["is_my_turn"] = bool(me and self.current_player() and me.id == self.current_player().id)
            if me is not None:
                data["my_hand"] = sorted(
                    [c.to_dict() for c in me.hand],
                    key=lambda d: (d["suit"], d["rank"])
                )
                data["my_seat"] = me.seat
                data["my_joker_count"] = me.joker_count(self.joker_info) if self.joker_info else 0
            return data

    # ---------- (Dé)sérialisation pour le stockage persistant ----------
    # Un salon doit pouvoir être reconstruit à l'identique à chaque requête
    # (le process serverless qui traite la requête n'est pas forcément celui
    # qui a traité la précédente). On sérialise donc tout l'état utile en
    # JSON, et on le recharge/sauvegarde autour de chaque action.

    def to_state_dict(self):
        return {
            "code": self.code,
            "phase": self.phase,
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "seat": p.seat,
                    "connected": p.connected,
                    "hand": [c.to_dict() for c in p.hand],
                }
                for p in self.players
            ],
            "deck": [c.to_dict() for c in self.deck],
            "discard_pile": [
                {
                    "card": entry["card"].to_dict(),
                    "player_id": entry["player_id"],
                    "player_name": entry["player_name"],
                }
                for entry in self.discard_pile
            ],
            "joker_info": self.joker_info,
            "turn_index": self.turn_index,
            "turn_stage": self.turn_stage,
            "log": self.log,
            "winner_id": self.winner_id,
            "win_reason": self.win_reason,
            "winning_hand": self.winning_hand,
            "created_at": self.created_at,
        }

    @classmethod
    def from_state_dict(cls, data):
        room = cls(data["code"])
        room.phase = data.get("phase", "lobby")
        room.players = []
        for pd in data.get("players", []):
            player = Player(pd["id"], pd["name"], pd["seat"])
            player.hand = [Card.from_dict(cd) for cd in pd.get("hand", [])]
            player.connected = pd.get("connected", True)
            room.players.append(player)
        room.deck = [Card.from_dict(cd) for cd in data.get("deck", [])]
        room.discard_pile = [
            {
                "card": Card.from_dict(entry["card"]),
                "player_id": entry["player_id"],
                "player_name": entry["player_name"],
            }
            for entry in data.get("discard_pile", [])
        ]
        room.joker_info = data.get("joker_info")
        room.turn_index = data.get("turn_index", 0)
        room.turn_stage = data.get("turn_stage", "draw")
        room.log = data.get("log", [])
        room.winner_id = data.get("winner_id")
        room.win_reason = data.get("win_reason")
        room.winning_hand = data.get("winning_hand")
        room.created_at = data.get("created_at", time.time())
        return room


# Durée de vie d'un salon inactif dans le stockage persistant (6h). Évite
# d'accumuler indéfiniment de vieux salons abandonnés.
ROOM_TTL_SECONDS = 6 * 60 * 60


class RoomManager:
    """Gère la création/chargement/sauvegarde des salons via une couche de
    stockage persistante (Vercel KV / Upstash Redis en production, mémoire
    locale en développement — voir `game/storage.py`).

    Important : chaque appel à `get_room` reconstruit un objet `Room` neuf
    à partir de l'état enregistré. Toute méthode qui modifie l'état d'un
    salon (add_player, start_game, draw, discard, declare...) doit donc être
    suivie d'un appel à `save_room` pour que la modification soit conservée
    d'une requête à l'autre.
    """

    def __init__(self):
        self.storage = build_storage()

    def _key(self, code):
        return f"rami104:room:{code}"

    def create_room(self):
        """Crée un nouveau salon avec un code unique (non encore sauvegardé :
        c'est à l'appelant d'appeler `save_room` une fois le salon prêt,
        par exemple après y avoir ajouté le premier joueur)."""
        for _ in range(20):
            code = uuid.uuid4().hex[:5].upper()
            if self.storage.get(self._key(code)) is None:
                return Room(code)
        raise RuntimeError("Impossible de générer un code de salon unique.")

    def get_room(self, code):
        raw = self.storage.get(self._key((code or "").upper()))
        if not raw:
            return None
        return Room.from_state_dict(json.loads(raw))

    def save_room(self, room):
        self.storage.set(self._key(room.code), json.dumps(room.to_state_dict()), ex=ROOM_TTL_SECONDS)


room_manager = RoomManager()
