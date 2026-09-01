# Rami 104 — déploiement Vercel

Cette version est préparée pour être importée dans GitHub puis déployée sur Vercel.

## Déploiement GitHub → Vercel

1. Décompresser `rami104_3_vercel.zip`.
2. Créer un nouveau dépôt GitHub.
3. Envoyer **le contenu du dossier `rami104`** à la racine du dépôt (pas le dossier ZIP lui-même).
4. Sur Vercel : **Add New → Project → Import Git Repository**.
5. Sélectionner le dépôt GitHub.
6. Laisser le Framework Preset en détection automatique et cliquer sur **Deploy**.

Le point d'entrée Vercel est `api/index.py`. `vercel.json` redirige les requêtes vers cette application Flask.

## Test local

```bash
pip install -r requirements.txt
python app.py
```

Puis ouvrir `http://127.0.0.1:5000`.

## Important pour le multijoueur

Le jeu actuel conserve les salons en mémoire dans le processus Python. Cela peut fonctionner pour un test, mais ce n'est pas un stockage partagé/persistant adapté à un déploiement serverless Vercel à grande échelle. Pour une version publique fiable, il faudra ensuite déplacer l'état des salons vers une base de données ou un stockage partagé.
