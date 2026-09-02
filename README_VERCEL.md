# Rami 104 — déploiement Vercel (avec stockage persistant)

## Pourquoi les parties disparaissaient

Vercel exécute `api/index.py` comme une **fonction serverless** : chaque
requête peut être traitée par une instance différente, et la mémoire du
process Python est effacée dès que l'instance est recyclée (typiquement
après quelques minutes d'inactivité, ou en cas de pic de trafic qui crée
de nouvelles instances). Or la version précédente gardait les salons dans
un simple dictionnaire Python (`RoomManager.rooms = {}`) — donc perdu à
chaque recyclage.

**C'est corrigé** : l'état de chaque salon (joueurs, mains, pioche,
défausse, tour, etc.) est maintenant sérialisé en JSON et lu/écrit dans un
stockage externe persistant à chaque requête (voir `game/storage.py`).
Sans base connectée, l'app retombe automatiquement sur un stockage mémoire
(comportement identique à avant) — **il faut donc connecter une base pour
que la correction prenne effet sur Vercel.**

## Étape obligatoire : connecter Vercel KV

1. Sur le tableau de bord Vercel, ouvrez votre projet.
2. Onglet **Storage** → **Create Database** → choisissez **KV**
   (propulsé par Upstash Redis, un plan gratuit généreux est disponible).
3. Donnez-lui un nom, créez-la, puis cliquez sur **Connect Project** et
   sélectionnez ce projet.
4. Vercel injecte automatiquement les variables d'environnement
   `KV_REST_API_URL` et `KV_REST_API_TOKEN` dans le projet — rien à
   configurer côté code.
5. **Redéployez** le projet (Deployments → ⋯ → Redeploy) pour que la
   nouvelle fonction serverless voie ces variables d'environnement.

### Vérifier que ça fonctionne

Ouvrez `https://<votre-projet>.vercel.app/api/status` :

```json
{"ok": true, "storage_persistent": true}
```

- `"storage_persistent": true` → la base KV est bien connectée, les
  parties survivront désormais aux redémarrages d'instance.
- `"storage_persistent": false` → aucune base détectée, l'app utilise
  encore la mémoire locale (le problème reviendra). Vérifiez que
  l'intégration KV est bien connectée à **ce** projet et que vous avez
  redéployé après l'avoir ajoutée.

## Alternative : Upstash directement (sans passer par Vercel KV)

Si vous préférez gérer votre base Upstash vous-même (compte gratuit sur
[upstash.com](https://upstash.com)) :

1. Créez une base Redis sur Upstash.
2. Copiez `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` depuis
   son tableau de bord.
3. Sur Vercel : **Settings → Environment Variables**, ajoutez ces deux
   variables (mêmes noms).
4. Redéployez.

`game/storage.py` reconnaît les deux jeux de noms de variables
automatiquement.

## Déploiement GitHub → Vercel (rappel)

1. Envoyer le contenu du dossier `rami104` à la racine d'un dépôt GitHub.
2. Sur Vercel : **Add New → Project → Import Git Repository**.
3. Laisser le Framework Preset en détection automatique et déployer.
4. Ajouter la base KV comme décrit ci-dessus, puis redéployer.

Le point d'entrée Vercel est `api/index.py` ; `vercel.json` route toutes
les requêtes vers cette fonction Flask.

## Test local

Aucune base n'est nécessaire en local — le stockage mémoire est utilisé
automatiquement :

```bash
pip install -r requirements.txt
python app.py
```

Puis ouvrir `http://127.0.0.1:5000`.

## Limites restantes

- Chaque salon expire automatiquement après **6h d'inactivité** dans le
  stockage (évite d'accumuler indéfiniment de vieux salons abandonnés) —
  modifiable via `ROOM_TTL_SECONDS` dans `game/engine.py`.
- Le plan gratuit Vercel KV / Upstash a des limites de requêtes/mois :
  largement suffisant pour un usage entre amis, mais à surveiller si vous
  ouvrez le jeu à beaucoup de monde.
- Il n'y a pas de verrou distribué entre requêtes concurrentes : en cas
  d'actions strictement simultanées sur le même salon (rare, vu que
  chaque action nécessite que ce soit le tour du joueur), la dernière
  écriture l'emporte. Non bloquant pour un usage normal.
