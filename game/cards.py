# -*- coding: utf-8 -*-
"""
Gestion des cartes pour le Rami 104 cartes.
104 cartes = 2 jeux de 52 cartes (pas de cartes "Joker" imprimées : le joker
est désigné dynamiquement à chaque partie en coupant le jeu).
"""
import random

SUITS = ["Pique", "Coeur", "Carreau", "Trefle"]
SUIT_SYMBOLS = {"Pique": "♠", "Coeur": "♥", "Carreau": "♦", "Trefle": "♣"}
RED_SUITS = {"Coeur", "Carreau"}
BLACK_SUITS = {"Pique", "Trefle"}

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
# Valeur numérique utilisée pour les suites (escaliers). L'As peut être
# bas (1, devant le 2) ou haut (14, après le Roi).
RANK_ORDER = {r: i + 1 for i, r in enumerate(RANKS)}  # A=1 ... K=13


class Card:
    """Une carte physique. `copy_id` (0 ou 1) distingue les deux exemplaires
    identiques présents dans un jeu de 104 cartes."""

    __slots__ = ("rank", "suit", "copy_id")

    def __init__(self, rank, suit, copy_id):
        self.rank = rank
        self.suit = suit
        self.copy_id = copy_id

    @property
    def id(self):
        return f"{self.rank}-{self.suit}-{self.copy_id}"

    @property
    def color(self):
        return "Rouge" if self.suit in RED_SUITS else "Noir"

    @property
    def order(self):
        return RANK_ORDER[self.rank]

    def to_dict(self):
        return {
            "id": self.id,
            "rank": self.rank,
            "suit": self.suit,
            "symbol": SUIT_SYMBOLS[self.suit],
            "color": self.color,
            "copy_id": self.copy_id,
            "label": f"{self.rank}{SUIT_SYMBOLS[self.suit]}",
        }

    def __repr__(self):
        return f"<Card {self.rank}{SUIT_SYMBOLS[self.suit]}#{self.copy_id}>"

    def __eq__(self, other):
        return isinstance(other, Card) and self.id == other.id

    def __hash__(self):
        return hash(self.id)


def build_double_deck():
    """Construit les 104 cartes (2 x 52)."""
    cards = []
    for copy_id in (0, 1):
        for suit in SUITS:
            for rank in RANKS:
                cards.append(Card(rank, suit, copy_id))
    return cards


def shuffle_very_random(cards, passes=7):
    """Mélange 'très aléatoire' : plusieurs passes de shuffle avec une
    source aléatoire de qualité cryptographique."""
    rng = random.SystemRandom()
    shuffled = list(cards)
    for _ in range(passes):
        rng.shuffle(shuffled)
    return shuffled


def opposite_color(color):
    return "Noir" if color == "Rouge" else "Rouge"


def determine_joker(cut_card):
    """À partir de la carte coupée/piochée par le joueur 3, détermine le
    rang et la couleur des vraies cartes joker (couleur opposée, même rang).

    Exemple : carte coupée = 4 Coeur (Rouge) -> joker = rang 4, couleur Noir
    -> les 2 exemplaires de 4 Pique et les 2 exemplaires de 4 Trefle sont
    les jokers (4 cartes joker au total, car jeu à 104 cartes = 2 x 52).
    """
    joker_rank = cut_card.rank
    joker_color = opposite_color(cut_card.color)
    joker_suits = [s for s in SUITS if (s in RED_SUITS) == (joker_color == "Rouge")]
    return {
        "cut_card": cut_card.to_dict(),
        "rank": joker_rank,
        "color": joker_color,
        "suits": joker_suits,
    }


def is_joker(card, joker_info):
    """Une carte est un vrai joker si son rang correspond au rang désigné
    ET que sa couleur est la couleur opposée à la carte coupée.
    (La carte coupée elle-même, et son double, restent des cartes normales.)"""
    if joker_info is None:
        return False
    return card.rank == joker_info["rank"] and card.suit in joker_info["suits"]
