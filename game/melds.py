# -*- coding: utf-8 -*-
"""
Validation des combinaisons du Rami 104.

Structure obligatoire des 13 cartes d'un joueur pour gagner :

  - Groupe 1 : TRI      -> 3 cartes, même rang, 3 couleurs différentes.
  - Groupe 2 : ESCALIER -> 3 cartes consécutives, même couleur (suite).
  - Groupe 3 : CARRÉ    -> 4 cartes : soit un carré (4 rangs identiques,
               4 couleurs différentes), soit un escalier de 4 cartes
               consécutives même couleur. Un joker peut remplacer UNE carte
               manquante (1 max).
  - Groupe 4 : LIBRE    -> 3 cartes, tri OU escalier. Un joker peut
               remplacer UNE carte manquante (1 max), sans condition.

Total = 3 + 3 + 4 + 3 = 13 cartes.

RÈGLE DU JOKER DANS LE TRI ET L'ESCALIER (conditionnelle au Carré) :

  - Le TRI peut contenir 1 joker SI ET SEULEMENT SI le Carré est un carré
    PUR (4 rangs identiques, 4 couleurs différentes) SANS joker.
  - L'ESCALIER peut contenir 1 joker SI ET SEULEMENT SI le Carré est un
    escalier de 4 PUR (4 cartes consécutives, même couleur) SANS joker.

Autrement dit : le Carré ne peut "prêter" son autorisation de joker au Tri
ou à l'Escalier que s'il n'utilise pas lui-même de joker, et uniquement au
groupe qui partage sa nature (carré <-> Tri, escalier de 4 <-> Escalier).
Si le Carré utilise un joker, ni le Tri ni l'Escalier ne peuvent en avoir.
Le 4e groupe (libre) n'est jamais concerné par cette condition : il peut
toujours contenir 1 joker.
"""
from .cards import is_joker, RANK_ORDER


def _split_jokers(cards, joker_info):
    normaux = [c for c in cards if not is_joker(c, joker_info)]
    jokers = [c for c in cards if is_joker(c, joker_info)]
    return normaux, jokers


def _check_set(cards, joker_info, size, allow_joker):
    """`size` cartes de même rang, couleurs toutes différentes, complétées
    éventuellement par un joker si `allow_joker` est vrai."""
    if len(cards) != size:
        return False, "Nombre de cartes incorrect."
    normaux, jokers = _split_jokers(cards, joker_info)
    if jokers and not allow_joker:
        return False, "joker_non_autorise"
    if len(jokers) > 1:
        return False, "Un seul joker autorisé par combinaison."
    if not normaux:
        return False, "Il faut au moins deux cartes naturelles."
    rang = normaux[0].rank
    if any(c.rank != rang for c in normaux):
        return False, "Toutes les cartes doivent avoir le même rang."
    couleurs = [c.suit for c in normaux]
    if len(set(couleurs)) != len(couleurs):
        return False, "Deux cartes de la même couleur dans un tri."
    return True, "OK"


def _check_run(cards, joker_info, size, allow_joker):
    """`size` cartes consécutives de la même couleur (suite), complétées
    éventuellement par un joker si `allow_joker` est vrai. L'As peut être
    bas (A-2-3) ou haut (Q-K-A)."""
    if len(cards) != size:
        return False, "Nombre de cartes incorrect."
    normaux, jokers = _split_jokers(cards, joker_info)
    if jokers and not allow_joker:
        return False, "joker_non_autorise"
    if len(jokers) > 1:
        return False, "Un seul joker autorisé par combinaison."
    if not normaux:
        return False, "Il faut au moins deux cartes naturelles."
    couleur = normaux[0].suit
    if any(c.suit != couleur for c in normaux):
        return False, "Toutes les cartes doivent être de la même couleur."

    def essai(valeurs_as):
        vals = []
        for c in normaux:
            v = RANK_ORDER[c.rank]
            if c.rank == "A" and valeurs_as == "haut":
                v = 14
            vals.append(v)
        vals = sorted(set(vals))
        if len(vals) != len(normaux):
            return False  # doublon de rang
        span = vals[-1] - vals[0] + 1
        manquants = span - len(vals)
        if manquants > len(jokers):
            return False
        if span > size:
            return False
        if vals[0] < 1 or vals[-1] > 14:
            return False
        return True

    if essai("bas") or essai("haut"):
        return True, "OK"
    return False, "Les cartes ne forment pas une suite valide."


def check_carre(cards, joker_info):
    """4 cartes : carré (4 rangs identiques) OU escalier de 4, joker
    autorisé (1 max). Retourne en plus des métadonnées (type + usage d'un
    joker) nécessaires pour déterminer si Tri/Escalier peuvent avoir un
    joker."""
    ok_set, msg_set = _check_set(cards, joker_info, size=4, allow_joker=True)
    if ok_set:
        _, jokers = _split_jokers(cards, joker_info)
        return True, "OK (carré)", {"type": "carre", "utilise_joker": len(jokers) > 0}
    ok_run, msg_run = _check_run(cards, joker_info, size=4, allow_joker=True)
    if ok_run:
        _, jokers = _split_jokers(cards, joker_info)
        return True, "OK (escalier de 4)", {"type": "escalier4", "utilise_joker": len(jokers) > 0}
    msg_set = "joker non autorisé ici" if msg_set == "joker_non_autorise" else msg_set
    msg_run = "joker non autorisé ici" if msg_run == "joker_non_autorise" else msg_run
    return False, f"Ni carré valide ({msg_set}) ni escalier de 4 valide ({msg_run}).", None


def check_groupe4(cards, joker_info):
    """3 cartes : tri ou escalier, joker autorisé (1 max), sans condition."""
    ok_set, msg_set = _check_set(cards, joker_info, size=3, allow_joker=True)
    if ok_set:
        return True, "OK (tri)"
    ok_run, msg_run = _check_run(cards, joker_info, size=3, allow_joker=True)
    if ok_run:
        return True, "OK (escalier)"
    return False, f"Ni tri valide ({msg_set}) ni escalier valide ({msg_run})."


def validate_full_hand(groupes, joker_info):
    """
    groupes: dict avec clés 'tri', 'escalier', 'carre', 'groupe4', chacune
    une liste de Card. Vérifie la structure complète (13 cartes) avec la
    règle conditionnelle du joker Tri/Escalier <-> Carré.
    Retourne (bool_valide, message, detail_par_groupe).
    """
    detail = {}
    toutes = []
    for cle in ("tri", "escalier", "carre", "groupe4"):
        toutes.extend(groupes.get(cle, []))
    if len(toutes) != 13:
        return False, f"Il faut exactement 13 cartes réparties dans les 4 groupes (reçu {len(toutes)}).", {}
    if len({c.id for c in toutes}) != 13:
        return False, "Une même carte est utilisée deux fois.", {}

    # 1) Le Carré doit d'abord être validé : sa nature (carré/escalier de 4)
    #    et l'usage ou non d'un joker déterminent ce qui est permis pour le
    #    Tri et l'Escalier.
    carre_cards = groupes.get("carre", [])
    ok_carre, msg_carre, meta_carre = check_carre(carre_cards, joker_info)
    detail["carre"] = {"valide": ok_carre, "message": msg_carre}
    if not ok_carre:
        return False, f"Carré invalide : {msg_carre}", detail

    autorise_joker_tri = (meta_carre["type"] == "carre" and not meta_carre["utilise_joker"])
    autorise_joker_escalier = (meta_carre["type"] == "escalier4" and not meta_carre["utilise_joker"])

    # 2) Tri
    tri_cards = groupes.get("tri", [])
    ok_tri, msg_tri = _check_set(tri_cards, joker_info, size=3, allow_joker=autorise_joker_tri)
    if msg_tri == "joker_non_autorise":
        msg_tri = ("Le joker n'est autorisé dans le tri que si le carré est un carré pur "
                   "(4 rangs identiques, sans joker).")
    detail["tri"] = {"valide": ok_tri, "message": msg_tri}
    if not ok_tri:
        return False, f"Tri invalide : {msg_tri}", detail

    # 3) Escalier
    escalier_cards = groupes.get("escalier", [])
    ok_escalier, msg_escalier = _check_run(escalier_cards, joker_info, size=3, allow_joker=autorise_joker_escalier)
    if msg_escalier == "joker_non_autorise":
        msg_escalier = ("Le joker n'est autorisé dans l'escalier que si le carré est un escalier "
                        "de 4 pur (sans joker).")
    detail["escalier"] = {"valide": ok_escalier, "message": msg_escalier}
    if not ok_escalier:
        return False, f"Escalier invalide : {msg_escalier}", detail

    # 4) 4e groupe (libre), joker toujours autorisé sans condition
    ok_g4, msg_g4 = check_groupe4(groupes.get("groupe4", []), joker_info)
    detail["groupe4"] = {"valide": ok_g4, "message": msg_g4}
    if not ok_g4:
        return False, f"4e groupe invalide : {msg_g4}", detail

    return True, "Main gagnante valide !", detail



def find_winning_partition(cards, joker_info):
    """Cherche automatiquement une main gagnante de 13 cartes parmi 14.

    Retourne un dict d'IDs: tri, escalier, carre, groupe4, discard, ou None.
    La recherche respecte exactement les règles de validate_full_hand(),
    notamment la condition des jokers entre le carré et le tri/escalier.
    """
    from itertools import combinations

    cards = list(cards)
    if len(cards) != 14:
        return None

    def ids(group):
        return tuple(c.id for c in group)

    def disjoint(*groups):
        seen = set()
        for group in groups:
            for c in group:
                if c.id in seen:
                    return False
                seen.add(c.id)
        return True

    candidates3 = list(combinations(cards, 3))
    candidates4 = list(combinations(cards, 4))

    # Le carré est testé en premier car il détermine l'autorisation du joker.
    for carre_t in candidates4:
        ok_carre, _, meta = check_carre(list(carre_t), joker_info)
        if not ok_carre:
            continue
        allow_tri = meta["type"] == "carre" and not meta["utilise_joker"]
        allow_esc = meta["type"] == "escalier4" and not meta["utilise_joker"]

        tri_candidates = []
        esc_candidates = []
        g4_candidates = []
        remaining_after_carre = [c for c in cards if c.id not in {x.id for x in carre_t}]

        for tri_t in combinations(remaining_after_carre, 3):
            ok, _ = _check_set(list(tri_t), joker_info, 3, allow_tri)
            if ok:
                tri_candidates.append(tri_t)

        for esc_t in combinations(remaining_after_carre, 3):
            ok, _ = _check_run(list(esc_t), joker_info, 3, allow_esc)
            if ok:
                esc_candidates.append(esc_t)

        for g4_t in combinations(remaining_after_carre, 3):
            ok, _ = check_groupe4(list(g4_t), joker_info)
            if ok:
                g4_candidates.append(g4_t)

        for tri_t in tri_candidates:
            if not disjoint(carre_t, tri_t):
                continue
            used1 = {c.id for c in carre_t + tri_t}
            for esc_t in esc_candidates:
                if any(c.id in used1 for c in esc_t):
                    continue
                used2 = used1 | {c.id for c in esc_t}
                for g4_t in g4_candidates:
                    if any(c.id in used2 for c in g4_t):
                        continue
                    used = used2 | {c.id for c in g4_t}
                    if len(used) != 13:
                        continue
                    leftover = [c for c in cards if c.id not in used]
                    if len(leftover) != 1:
                        continue
                    return {
                        "tri": [c.id for c in tri_t],
                        "escalier": [c.id for c in esc_t],
                        "carre": [c.id for c in carre_t],
                        "groupe4": [c.id for c in g4_t],
                        "discard": leftover[0].id,
                    }
    return None
