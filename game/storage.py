# -*- coding: utf-8 -*-
"""
Couche de stockage clé/valeur pour l'état des salons de jeu.

Problème résolu : sur Vercel, chaque requête peut être traitée par une
instance "serverless" différente (et la mémoire est effacée entre deux
requêtes, en particulier après quelques minutes d'inactivité). Un simple
dictionnaire Python en mémoire (utilisé en développement local) ne suffit
donc plus : il faut un stockage externe partagé et persistant.

Deux implémentations :

- InMemoryStorage   : dictionnaire Python classique. Utilisée automatiquement
                       quand aucune variable d'environnement de base
                       clé/valeur n'est détectée (ex. `python app.py` en
                       local). Le comportement est identique à la version
                       précédente (état perdu si le process redémarre, mais
                       stable tant qu'il tourne).

- UpstashRestStorage : stockage persistant via l'API REST d'Upstash Redis.
                       C'est le moteur utilisé par l'intégration "Vercel KV".
                       Aucune dépendance Python supplémentaire n'est requise
                       (uniquement `urllib`, présent dans la bibliothèque
                       standard), ce qui évite tout souci d'installation sur
                       Vercel.

Le choix se fait automatiquement dans `build_storage()` selon les variables
d'environnement disponibles.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request


class StorageError(RuntimeError):
    """Erreur de communication avec le stockage persistant."""


class InMemoryStorage:
    """Stockage en mémoire du process Python (développement local)."""

    def __init__(self):
        self._data = {}

    def get(self, key):
        return self._data.get(key)

    def set(self, key, value, ex=None):
        # `ex` (expiration en secondes) est ignoré ici : le process local
        # n'a pas besoin d'expiration automatique.
        self._data[key] = value

    def delete(self, key):
        self._data.pop(key, None)

    def is_persistent(self):
        return False


class UpstashRestStorage:
    """Stockage persistant via l'API REST Upstash Redis (branchée
    automatiquement par l'intégration Vercel KV, ou configurable à la main
    avec un compte Upstash gratuit)."""

    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

    def _request(self, path):
        req = urllib.request.Request(
            f"{self.url}/{path}",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=6) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            raise StorageError(f"Erreur de connexion au stockage persistant : {e}") from e

    def get(self, key):
        result = self._request(f"get/{urllib.parse.quote(key, safe='')}")
        return result.get("result")

    def set(self, key, value, ex=None):
        encoded_key = urllib.parse.quote(key, safe="")
        encoded_value = urllib.parse.quote(value, safe="")
        path = f"set/{encoded_key}/{encoded_value}"
        if ex:
            path += f"?EX={int(ex)}"
        self._request(path)

    def delete(self, key):
        self._request(f"del/{urllib.parse.quote(key, safe='')}")

    def is_persistent(self):
        return True


class RedisUrlStorage:
    """Stockage persistant via une connexion Redis classique (protocole TCP,
    chaîne `redis://` ou `rediss://`). C'est le format utilisé par
    l'intégration "Redis Cloud" du Marketplace Vercel, qui expose une seule
    variable `REDIS_URL` (contrairement à Upstash qui expose une paire
    URL REST + token). Nécessite le paquet `redis` (voir requirements.txt)."""

    def __init__(self, url):
        import redis  # import différé : évite de casser le mode mémoire si absent
        self._client = redis.Redis.from_url(url, decode_responses=True)

    def get(self, key):
        try:
            return self._client.get(key)
        except Exception as e:  # noqa: BLE001
            raise StorageError(f"Erreur de connexion au stockage persistant : {e}") from e

    def set(self, key, value, ex=None):
        try:
            self._client.set(key, value, ex=ex)
        except Exception as e:  # noqa: BLE001
            raise StorageError(f"Erreur de connexion au stockage persistant : {e}") from e

    def delete(self, key):
        try:
            self._client.delete(key)
        except Exception as e:  # noqa: BLE001
            raise StorageError(f"Erreur de connexion au stockage persistant : {e}") from e

    def is_persistent(self):
        return True


def build_storage():
    """Détecte automatiquement le stockage à utiliser à partir des variables
    d'environnement, dans cet ordre de priorité :
    1. `KV_REST_API_URL` / `KV_REST_API_TOKEN` (ancien Vercel KV natif).
    2. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (Upstash via
       API REST, connecté directement ou via le Marketplace).
    3. `REDIS_URL` (ou `REDIS_TLS_URL`) : connexion Redis classique, format
       utilisé par l'intégration "Redis Cloud" du Marketplace Vercel.
    4. Sinon : stockage en mémoire (développement local uniquement, ou
       déploiement sans base connectée — l'état ne survivra alors pas aux
       redémarrages d'instance)."""
    rest_url = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL")
    rest_token = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if rest_url and rest_token:
        return UpstashRestStorage(rest_url, rest_token)

    redis_url = os.environ.get("REDIS_URL") or os.environ.get("REDIS_TLS_URL")
    if redis_url:
        return RedisUrlStorage(redis_url)

    return InMemoryStorage()
