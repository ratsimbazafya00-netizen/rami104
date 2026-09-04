# Rami 104 — jeu multijoueur en ligne (5 joueurs)

Application web (jouable depuis le navigateur du téléphone) implémentant
le Rami à 104 cartes tel que décrit dans le cahier des charges : 5 joueurs,
joker désigné par coupe, distribution de 13 cartes, pioche/défausse, et
victoire par combinaison **tri + escalier + carré + 4e groupe** ou par
**3 jokers réunis**.

## Installation

```bash
cd rami104
python3 -m venv venv        # optionnel mais recommandé
source venv/bin/activate    # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Lancement

```bash
python app.py
```

Le serveur démarre sur `http://0.0.0.0:5000`.

- **Sur l'ordinateur qui héberge** : ouvrez `http://localhost:5000`.
- **Sur les téléphones des 4 autres joueurs** (même réseau Wi-Fi) : trouvez
  l'adresse IP locale de l'ordinateur hôte (ex. `192.168.1.24`) et ouvrez
  `http://192.168.1.24:5000` dans le navigateur du téléphone.
  - Windows : `ipconfig` (ligne "Adresse IPv4")
  - macOS/Linux : `ifconfig` ou `ip addr`

Le premier joueur crée le salon (bouton "Créer le salon"), reçoit un
**code à 5 caractères**, et le partage aux 4 autres qui rejoignent avec
"Rejoindre une table". Le joueur 1 (créateur = hôte) démarre la partie
une fois les 5 joueurs présents.

> Pas de base de données : les parties vivent en mémoire tant que le
> serveur tourne. Redémarrer le serveur efface les salons en cours.

## Déroulement implémenté

1. Mélange très aléatoire des 104 cartes (2 jeux de 52, plusieurs passes
   de `random.SystemRandom().shuffle`).
2. Le joueur 3 (3e siège) coupe le jeu : la carte retournée désigne le
   joker. **Règle couleur opposée** : si la carte coupée est rouge, les
   cartes de même rang et de couleur **noire** deviennent joker (et
   inversement) — soit 4 cartes joker au total (2 exemplaires x 2 couleurs
   opposées), puisque le jeu compte 2 exemplaires de chaque carte.
3. Distribution de 13 cartes à chacun, dans l'ordre, en tournant à partir
   du joueur 1.
4. Le reste forme la pioche (sabot), placée au centre.
5. Le joueur 1 commence : il pioche, puis défausse. Le joueur suivant peut
   **soit** prendre la carte défaussée, **soit** piocher dans le sabot
   (jamais les deux), puis défausse à son tour à son voisin — et ainsi de
   suite.
6. La partie se termine dès qu'un joueur complète une main gagnante, dès
   qu'un joueur réunit 3 jokers, ou dès que la pioche est épuisée.

## Objectif / structure de la main gagnante — hypothèse retenue

Le cahier des charges décrit 4 groupes sans préciser leurs tailles
exactes. Pour obtenir un total cohérent de **13 cartes**, l'implémentation
retient :

| Groupe          | Taille | Règle                                              | Joker |
|------------------|:---:|-----------------------------------------------------|:---:|
| Tri              | 3   | Même rang, 3 couleurs différentes                    | Oui (1 max) **si et seulement si** le Carré est un carré pur (4 rangs identiques) **sans joker** |
| Escalier         | 3   | 3 cartes suivies, même couleur (As bas ou haut)      | Oui (1 max) **si et seulement si** le Carré est un escalier de 4 pur **sans joker** |
| Carré            | 4   | Carré (4 rangs identiques) **ou** escalier de 4       | Oui (1 max), sans condition |
| 4e groupe (libre)| 3   | Tri **ou** escalier                                   | Oui (1 max), sans condition |

**3 + 3 + 4 + 3 = 13 cartes.**

**Règle du joker Tri/Escalier, conditionnée au Carré :** le Carré ne
"prête" son autorisation de joker au Tri ou à l'Escalier que s'il est
lui-même pur (sans joker) — et seulement au groupe qui partage sa nature :
- Carré = carré pur (4 rangs identiques, sans joker) → le **Tri** peut
  contenir 1 joker (l'Escalier reste sans joker).
- Carré = escalier de 4 pur (sans joker) → l'**Escalier** peut contenir
  1 joker (le Tri reste sans joker).
- Si le Carré utilise lui-même un joker → ni le Tri ni l'Escalier ne
  peuvent en avoir un.

Le 4e groupe (libre) n'est jamais concerné par cette condition : il peut
toujours contenir 1 joker, indépendamment de l'état du Carré.

Concrètement, une main gagnante contient donc au maximum 2 jokers :
un pour le "trio Carré/Tri/Escalier" (selon la configuration ci-dessus),
et un pour le 4e groupe — ce qui est cohérent avec la règle des 3 jokers
qui déclenche la victoire automatique.

Si cette répartition ne correspond pas exactement à ce que vous aviez en
tête, il suffit de me le dire : la logique est centralisée dans
`game/melds.py` et se modifie facilement.

## Règle spéciale des 3 jokers

Si un joueur réunit 3 jokers dans sa main — que ce soit dès la
distribution initiale ou en cours de partie — il est déclaré gagnant
immédiatement, sans avoir besoin de compléter ses combinaisons. Vérifié
automatiquement après chaque pioche et après la distribution.

## Structure du projet

```
rami104/
├── app.py                  # Serveur Flask (pages + API REST)
├── game/
│   ├── cards.py             # Cartes, deck 104, détermination du joker
│   ├── melds.py              # Validation tri / escalier / carré / groupe4
│   └── engine.py              # Salon, tours, pioche/défausse, victoire
├── templates/
│   ├── home.html              # Créer / rejoindre un salon
│   └── game.html               # Table de jeu (lobby, plateau, fin)
├── static/
│   ├── css/style.css           # Thème "table de feutre" mobile-first
│   └── js/game.js               # Logique client (polling AJAX, actions)
└── requirements.txt
```

## Communication client/serveur

Pas de websockets : le navigateur de chaque joueur interroge le serveur
toutes les 1,5 s (`GET /api/room/<code>/state`) et envoie ses actions en
POST (`/draw`, `/discard`, `/declare`, `/start`). Simple, fiable, et ne
nécessite aucune dépendance supplémentaire.

## Limites connues / pistes d'amélioration

- État des parties en mémoire (pas de persistance si le serveur redémarre).
- Un clic explicite sur « Quitter le salon » retire définitivement le joueur
  de la manche en cours : il ne devient pas un BOT et ne peut pas reprendre
  cette manche en revenant sur le lien. Une coupure technique sans clic sur
  « Quitter » conserve le siège afin de permettre la reconnexion.
- Pour un déploiement hors réseau local (joueurs sur des réseaux
  différents), il faudrait héberger le serveur sur une machine accessible
  publiquement (ex. Render, Railway, VPS) plutôt qu'en local.
- Le classement en cas d'épuisement de la pioche sans gagnant n'est pas
  détaillé (actuellement : partie nulle). On peut ajouter un calcul de
  points par cartes restantes si souhaité.


## Salons publics / privés et reconnexion

- Chaque `Room` possède `visibility` (`public` ou `private`) et `round_number`.
- Les salons privés ne sont jamais proposés par l'appariement aléatoire ni par `/api/rooms/public`. Ils restent accessibles avec leur code ou via une invitation directe.
- L'accueil permet de choisir Public / Privé lors de la création et affiche les salons publics ouverts.
- `Room.reconnect()` peut restaurer un siège encore présent (notamment après une
  coupure technique). Un départ volontaire via « Quitter » supprime le siège,
  donc le joueur ne peut pas reprendre la manche en revenant sur le lien.
- La recherche d'amis accepte le pseudo ou l'ID `R104-...`, ne renvoie jamais le téléphone et déduplique les comptes malgré les différents index de stockage.
- Le bot choisit désormais sa carte de défausse aléatoirement.
- Le numéro de manche est incrémenté au démarrage de chaque manche et affiché sous la forme `MANCHE N`.
