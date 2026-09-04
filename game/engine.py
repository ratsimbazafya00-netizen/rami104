# -*- coding: utf-8 -*-
"""
Moteur du Rami 104 cartes : gestion d'un salon de jeu (Room) avec 5 joueurs,
distribution, pioche/défausse, joker, et conditions de victoire.
"""
import json
import random
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
    def __init__(self, player_id, name, seat, account_id=None):
        self.id = player_id
        self.account_id = account_id
        self.name = name
        self.seat = seat  # 0..4  (seat 0 = "joueur 1", etc.)
        self.hand = []     # list[Card]
        self.connected = True

    def joker_count(self, joker_info):
        return sum(1 for c in self.hand if is_joker(c, joker_info))


class Room:
    def __init__(self, code):
        self.code = code
        self.visibility = "public"
        self.round_number = 0
        self.players = []          # list[Player], ordre = ordre de siège
        self.phase = "lobby"       # lobby | playing | finished
        self.deck = []             # pioche (sabot)
        self.discard_pile = []     # défausse, dernier élément = dessus de pile
        self.last_discard_take = None  # dernière prise depuis la défausse, affichée très visiblement
        self.discard_action_seq = 0
        self.joker_info = None
        self.turn_index = 0        # index dans self.players
        self.turn_stage = "draw"   # draw | discard
        self.log = []
        self.chat = []  # messages conservés pendant toute la durée du salon
        self.winner_id = None
        self.win_reason = None
        self.winning_hand = None  # combinaisons de la main gagnante (si victoire par déclaration)
        self.last_winner_id = None  # gagnant de la manche précédente
        self.host_id = None
        self.lock = threading.RLock()
        self.created_at = time.time()

    # ---------- Lobby ----------

    def reconnect(self, account_id, player_id=None):
        """Reconnecte automatiquement un joueur existant dans le salon.
        L'ID de compte est l'identité durable; player_id sert seulement de raccourci.
        """
        with self.lock:
            player = self.get_player(player_id) if player_id else None
            if player is None or player.account_id != account_id:
                player = next((p for p in self.players if p.account_id == account_id), None)
            if player is None:
                return None
            was_bot = not player.connected or " [BOT]" in player.name
            player.connected = True
            player.name = player.name.replace(" [BOT]", "")[:20]
            if was_bot:
                self._log(f"↩️ {player.name} se reconnecte et reprend le contrôle de son siège.")
            return player

    def mark_disconnected(self, player_id):
        """Marque un joueur absent comme BOT et fait avancer son tour.

        Les requêtes de polling appellent cette méthode lorsqu'elles
        constatent que le joueur dont c'est le tour n'a plus envoyé de signe
        de vie. Le siège est conservé afin qu'il puisse se reconnecter plus
        tard et reprendre le contrôle.
        """
        with self.lock:
            player = self.get_player(player_id)
            if player is None:
                return False
            if not player.connected:
                return False
            player.connected = False
            if " [BOT]" not in player.name:
                player.name = player.name + " [BOT]"
            self._log(f"🤖 {player.name.replace(' [BOT]', '')} est absent : le BOT prend le relais.")
            if self.phase == "playing" and self.current_player() is player:
                self._bot_play_current_turn()
            return True

    def add_player(self, name, account_id=None):
        with self.lock:
            if self.phase not in ("lobby", "finished"):
                raise ValueError("La partie a déjà commencé.")
            if account_id and any(p.account_id == account_id for p in self.players):
                raise ValueError("Ce compte est déjà présent dans ce salon.")
            if len(self.players) >= MAX_PLAYERS:
                raise ValueError("Le salon est complet (5 joueurs).")
            pid = uuid.uuid4().hex[:8]
            player = Player(pid, name.strip()[:20] or f"Joueur{len(self.players)+1}", len(self.players), account_id=account_id)
            self.players.append(player)
            if self.host_id is None:
                self.host_id = player.id
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

    def add_chat_message(self, player_id, message):
        with self.lock:
            player = self.get_player(player_id)
            if player is None:
                raise ValueError("Joueur introuvable dans ce salon.")
            text = str(message or "").strip()
            if not text:
                raise ValueError("Le message est vide.")
            if len(text) > 300:
                raise ValueError("Le message est trop long (300 caractères maximum).")
            self.chat.append({
                "id": uuid.uuid4().hex[:12],
                "player_id": player.id,
                "player_name": player.name,
                "message": text,
                "created_at": time.time(),
            })
            self.chat = self.chat[-150:]

    # ---------- Démarrage ----------

    def start_game(self, requesting_player_id, force=False):
        with self.lock:
            if self.phase != "lobby":
                raise ValueError("La partie a déjà commencé.")
            requester = self.get_player(requesting_player_id)
            if requester is None or requester.id != self.host_id:
                raise ValueError("Seul l’hôte peut démarrer la partie.")
            if len(self.players) < MAX_PLAYERS and not force:
                raise ValueError(
                    f"Il faut {MAX_PLAYERS} joueurs pour démarrer ({len(self.players)} inscrits)."
                )
            if len(self.players) < 3:
                raise ValueError("Il faut au moins 3 joueurs pour démarrer.")

            self.round_number += 1
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
            # Le gagnant de la manche précédente commence la suivante.
            start_id = self.last_winner_id if self.last_winner_id and self.get_player(self.last_winner_id) else None
            if start_id:
                self.turn_index = next(i for i, p in enumerate(self.players) if p.id == start_id)
            else:
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
        # L'index est normalement toujours valide, mais il peut devenir
        # obsolète après le retrait d'un joueur ou la lecture d'un ancien
        # état persistant. Le normaliser évite un IndexError sur le polling.
        try:
            self.turn_index = int(self.turn_index) % len(self.players)
        except (TypeError, ValueError):
            self.turn_index = 0
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
                if self.discard_pile and self._is_joker_card(self.discard_pile[-1]["card"]):
                    raise ValueError("Le Joker est sur la défausse : vous devez piocher dans le sabot.")
                if not self.discard_pile:
                    raise ValueError("La défausse est vide.")
                entry = self.discard_pile.pop()
                card = entry["card"]
                player.hand.append(card)
                self.discard_action_seq += 1
                self.last_discard_take = {
                    "seq": self.discard_action_seq,
                    "player_id": player.id,
                    "player_name": player.name,
                    "card": card.to_dict(),
                    "discarded_by": entry["player_name"],
                    "created_at": time.time(),
                }
                self._log(f"🟢 {player.name} PREND {card.rank}{card.suit} DANS LA DÉFAUSSE (jetée par {entry['player_name']}).")
            else:
                raise ValueError("Source de pioche inconnue.")

            self.turn_stage = "discard"
            self._check_joker_auto_win()

    def _is_joker_card(self, card):
        return bool(self.joker_info and is_joker(card, self.joker_info))

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
                return
            if self.current_player() and not self.current_player().connected:
                self._bot_play_current_turn()

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

            if not isinstance(groups_by_id, dict):
                raise ValueError("Les groupes de déclaration sont invalides.")
            required_groups = ("tri", "escalier", "carre", "groupe4")
            if any(key not in groups_by_id for key in required_groups):
                raise ValueError("Les quatre groupes sont obligatoires.")
            if any(key not in required_groups for key in groups_by_id):
                raise ValueError("Un groupe de déclaration est inconnu.")
            for key in required_groups:
                if not isinstance(groups_by_id[key], list) or not all(
                    isinstance(card_id, str) for card_id in groups_by_id[key]
                ):
                    raise ValueError(f"Les cartes du groupe {key} sont invalides.")
            if not isinstance(discard_card_id, str) or not discard_card_id:
                raise ValueError("La carte à défausser est invalide.")

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
            self.last_winner_id = player.id
            self.win_reason = "Main complète (tri + escalier + carré + 4e groupe)."
            self._log(f"🏆 {player.name} déclare et GAGNE : {message}")

    def kick(self, requesting_player_id, target_player_id):
        """Expulse un joueur uniquement depuis le lobby et uniquement par l'hôte."""
        with self.lock:
            if self.phase != "lobby":
                raise ValueError("L'expulsion est possible uniquement dans le salon d'attente.")
            if requesting_player_id != self.host_id:
                raise ValueError("Seul l'hôte peut expulser un joueur.")
            if requesting_player_id == target_player_id:
                raise ValueError("L'hôte ne peut pas s'expulser lui-même.")
            player = self.get_player(target_player_id)
            if player is None:
                raise ValueError("Joueur introuvable.")
            name = player.name.replace(" [BOT]", "")
            self.players.remove(player)
            for i, p in enumerate(self.players):
                p.seat = i
            self._log(f"🚪 {name} a été expulsé du salon par l'hôte.")
            if not self.players:
                self.host_id = None
            return True

    def leave(self, player_id):
        """Quitte réellement le salon.

        Un clic explicite sur « Quitter » retire définitivement le joueur du
        salon pour cette manche : il ne devient PAS un BOT et son ancien
        player_id ne permet plus de reprendre sa place. Une reconnexion
        technique sans clic sur « Quitter » peut toujours utiliser
        ``reconnect()`` si le siège existe encore.
        """
        with self.lock:
            player = self.get_player(player_id)
            if player is None:
                raise ValueError("Joueur inconnu ou déjà sorti du salon.")

            was_host = player.id == self.host_id
            leaving_index = self.players.index(player)
            old_turn_index = self.turn_index
            was_current = self.phase == "playing" and leaving_index == old_turn_index

            # Retrait réel : aucun BOT n'est créé et l'ancien siège disparaît.
            self.players.remove(player)
            if self.last_winner_id == player.id:
                self.last_winner_id = None

            for i, p in enumerate(self.players):
                p.seat = i

            self._log(f"🚪 {player.name.replace(' [BOT]', '')} a quitté le salon.")

            if not self.players:
                self.host_id = None
                return True

            # Transfert de l'hôte si nécessaire.
            if was_host:
                winner = self.get_player(self.last_winner_id) if self.last_winner_id else None
                new_host = winner if winner else self.players[0]
                self.host_id = new_host.id
                self._log(f"👑 {new_host.name.replace(' [BOT]', '')} devient le nouvel hôte.")

            if self.phase == "playing":
                # Un seul joueur encore présent = victoire immédiate par abandon.
                if len(self.players) == 1:
                    winner = self.players[0]
                    winner.connected = True
                    winner.name = winner.name.replace(" [BOT]", "")[:20]
                    self.phase = "finished"
                    self.winner_id = winner.id
                    self.last_winner_id = winner.id
                    self.win_reason = "Victoire par abandon : dernier joueur encore présent dans la partie."
                    self.winning_hand = None
                    self.turn_index = 0
                    self.turn_stage = "draw"
                    self._log(f"🏆 {winner.name} GAGNE : il est le dernier joueur encore présent dans la partie.")
                    return True

                # Maintient le tour sur le bon joueur après suppression.
                if was_current:
                    self.turn_index = leaving_index % len(self.players)
                    self.turn_stage = "draw"
                elif leaving_index < old_turn_index:
                    self.turn_index = old_turn_index - 1
                else:
                    self.turn_index = min(old_turn_index, len(self.players) - 1)
                return True

            # Lobby / écran de fin : on compacte les sièges et corrige le tour.
            self.turn_index = min(old_turn_index, len(self.players) - 1)
            return True

    def _bot_play_current_turn(self):
        """Fait jouer automatiquement le BOT dont c'est le tour.
        Le bot pioche puis jette une carte au hasard. Répète si plusieurs
        joueurs BOT consécutifs doivent jouer.
        """
        safety = max(1, len(self.players) * 2)
        while self.phase == "playing" and safety > 0:
            safety -= 1
            player = self.current_player()
            if not player or player.connected:
                return
            if self.turn_stage == "draw":
                if self.deck:
                    card = self.deck.pop()
                    player.hand.append(card)
                    self._log(f"🤖 {player.name} pioche automatiquement dans le sabot.")
                    self.turn_stage = "discard"
                    # Les jokers gagnent aussi automatiquement lorsqu'ils
                    # sont réunis par un bot. Sans ce contrôle, un bot
                    # pouvait dépasser le seuil de trois jokers et la manche
                    # continuait indéfiniment.
                    if self._check_joker_auto_win():
                        return
                else:
                    self._end_by_empty_deck()
                    return
            if self.turn_stage == "discard":
                if not player.hand:
                    self._advance_turn()
                    continue
                card = player.hand.pop(random.randrange(len(player.hand)))
                self.discard_pile.append({"card": card, "player_id": player.id, "player_name": player.name})
                self._log(f"🤖 {player.name} défausse automatiquement une carte.")
                self._advance_turn()
                if not self.deck:
                    self._end_by_empty_deck()
                    return
            if self.current_player() and not self.current_player().connected:
                continue
            return

    def prepare_next_round(self, requesting_player_id):
        with self.lock:
            if self.phase != "finished":
                raise ValueError("La manche n'est pas terminée.")
            if requesting_player_id != self.host_id:
                raise ValueError("Seul l'hôte peut préparer la prochaine manche.")
            for p in self.players:
                p.hand = []
                p.connected = True
            self.deck = []
            self.discard_pile = []
            self.last_discard_take = None
            self.discard_action_seq = 0
            # Nouveau manche = nouveaux journaux : ne pas conserver
            # l'historique de la manche précédente.
            self.log = []
            self.joker_info = None
            self.winner_id = None
            self.win_reason = None
            self.winning_hand = None
            self.turn_stage = "draw"
            if self.last_winner_id and self.get_player(self.last_winner_id):
                self.turn_index = next(i for i, p in enumerate(self.players) if p.id == self.last_winner_id)
            else:
                self.turn_index = 0
            self.phase = "lobby"
            self._log("🔄 Nouvelle manche prête. Le gagnant de la manche précédente commencera.")
            return True

    # ---------- Fin de partie ----------

    def _end_by_empty_deck(self):
        self.phase = "finished"
        self.winner_id = None
        # Une manche nulle ne doit pas réutiliser le gagnant d'une manche
        # plus ancienne comme premier joueur de la prochaine.
        self.last_winner_id = None
        self.win_reason = "La pioche est épuisée : partie terminée sans gagnant."
        self._log("La pioche est vide. Fin de la partie (aucun gagnant par mise en main).")

    def _check_joker_auto_win(self, initial=False):
        for player in self.players:
            if player.joker_count(self.joker_info) >= JOKER_AUTO_WIN_COUNT:
                self.phase = "finished"
                self.winner_id = player.id
                self.last_winner_id = player.id
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
                    "account_id": p.account_id,
                    "name": p.name,
                    "seat": p.seat,
                    "card_count": len(p.hand),
                    "connected": p.connected,
                    "is_bot": not p.connected,
                    "is_me": (me is not None and p.id == me.id),
                    "is_host": (p.id == self.host_id),
                })

            # Un gagnant peut avoir quitté un salon terminé. Ne jamais
            # dereferencer un joueur absent pendant le polling des autres
            # joueurs : l'écran de fin doit rester consultable.
            winner = self.get_player(self.winner_id) if self.winner_id else None
            host = self.get_player(self.host_id) if self.host_id else None
            last_winner = self.get_player(self.last_winner_id) if self.last_winner_id else None
            data = {
                "room_code": self.code,
                "visibility": self.visibility,
                "round_number": self.round_number,
                "phase": self.phase,
                "players": players_public,
                "nb_players": len(self.players),
                "max_players": MAX_PLAYERS,
                "log": self.log[-25:],
                "chat": self.chat[-150:],
                "joker_info": self.joker_info,
                "deck_count": len(self.deck),
                "discard_top": self.discard_pile[-1]["card"].to_dict() if self.discard_pile else None,
                "last_discard_take": self.last_discard_take,
                "discard_pile": [
                    {
                        "card": entry["card"].to_dict(),
                        "player_id": entry["player_id"],
                        "player_name": entry["player_name"],
                    }
                    for entry in self.discard_pile
                ],
                "winner_id": self.winner_id,
                "winner_name": winner.name if winner else None,
                "win_reason": self.win_reason,
                "winning_hand": self.winning_hand,
                "am_i_host": bool(me and me.id == self.host_id),
                "host_id": self.host_id,
                "host_name": host.name if host else None,
                "last_winner_id": self.last_winner_id,
                "last_winner_name": last_winner.name if last_winner else None,
            }
            if self.phase != "lobby":
                current = self.current_player()
                data["turn_player_id"] = current.id if current else None
                data["turn_player_name"] = current.name if current else None
                data["turn_stage"] = self.turn_stage
                data["is_my_turn"] = bool(me and current and me.id == current.id)
            if me is not None:
                data["my_player_id"] = me.id
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
            "visibility": self.visibility,
            "round_number": self.round_number,
            "phase": self.phase,
            "players": [
                {
                    "id": p.id,
                    "account_id": p.account_id,
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
            "last_discard_take": self.last_discard_take,
            "discard_action_seq": self.discard_action_seq,
            "joker_info": self.joker_info,
            "turn_index": self.turn_index,
            "turn_stage": self.turn_stage,
            "log": self.log,
            "chat": self.chat,
            "winner_id": self.winner_id,
            "win_reason": self.win_reason,
            "winning_hand": self.winning_hand,
            "last_winner_id": self.last_winner_id,
            "host_id": self.host_id,
            "created_at": self.created_at,
        }

    @classmethod
    def from_state_dict(cls, data):
        room = cls(data["code"])
        room.visibility = data.get("visibility", "public")
        room.round_number = int(data.get("round_number", 0) or 0)
        room.phase = data.get("phase", "lobby")
        room.players = []
        for pd in data.get("players", []):
            player = Player(pd["id"], pd["name"], pd["seat"], account_id=pd.get("account_id"))
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
        room.last_discard_take = data.get("last_discard_take")
        room.discard_action_seq = int(data.get("discard_action_seq", 0) or 0)
        room.joker_info = data.get("joker_info")
        try:
            room.turn_index = int(data.get("turn_index", 0) or 0)
        except (TypeError, ValueError):
            room.turn_index = 0
        room.turn_stage = data.get("turn_stage", "draw")
        room.log = data.get("log", [])
        room.chat = data.get("chat", [])[-150:]
        room.winner_id = data.get("winner_id")
        room.win_reason = data.get("win_reason")
        room.winning_hand = data.get("winning_hand")
        room.last_winner_id = data.get("last_winner_id")
        room.host_id = data.get("host_id")
        if room.host_id is None and room.players:
            room.host_id = room.players[0].id
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

    def find_public_open_rooms(self, limit=20):
        """Liste les salons publics en attente, sans exposer les salons privés."""
        rooms = []
        try:
            keys = self.storage.keys("rami104:room:*") or []
        except Exception:
            keys = []
        for key in keys:
            raw = self.storage.get(key)
            if not raw:
                continue
            try:
                room = Room.from_state_dict(json.loads(raw))
            except Exception:
                continue
            if room.visibility != "public" or room.phase != "lobby" or len(room.players) >= MAX_PLAYERS:
                continue
            rooms.append(room)
        rooms.sort(key=lambda r: r.created_at, reverse=True)
        return rooms[:limit]

    def find_random_open_room(self, exclude_account_id=None):
        """Retourne aléatoirement un salon lobby non plein, idéalement avec
        déjà un joueur. Les salons terminés ne sont jamais proposés."""
        keys = []
        try:
            keys = self.storage.keys("rami104:room:*") or []
        except Exception:
            keys = []
        candidates = []
        for key in keys:
            raw = self.storage.get(key)
            if not raw:
                continue
            try:
                room = Room.from_state_dict(json.loads(raw))
            except Exception:
                continue
            if room.visibility != "public" or room.phase != "lobby" or len(room.players) >= MAX_PLAYERS:
                continue
            if exclude_account_id and any(p.account_id == exclude_account_id for p in room.players):
                continue
            candidates.append(room)
        if not candidates:
            return None
        occupied = [r for r in candidates if r.players]
        pool = occupied or candidates
        return random.choice(pool)

    def get_room(self, code):
        raw = self.storage.get(self._key((code or "").upper()))
        if not raw:
            return None
        return Room.from_state_dict(json.loads(raw))

    def delete_room(self, room_or_code):
        code = room_or_code.code if hasattr(room_or_code, "code") else str(room_or_code).upper()
        self.storage.delete(self._key(code))

    def save_room(self, room):
        self.storage.set(self._key(room.code), json.dumps(room.to_state_dict()), ex=ROOM_TTL_SECONDS)


room_manager = RoomManager()
