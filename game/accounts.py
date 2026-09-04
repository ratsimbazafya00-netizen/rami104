# -*- coding: utf-8 -*-
"""Comptes joueurs persistants et authentification légère pour Rami-104."""
import hashlib
import hmac
import json
import os
import secrets
import time
import uuid

from werkzeug.security import check_password_hash, generate_password_hash
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .storage import build_storage, StorageError

ACCOUNT_PREFIX = "rami104:account:"
PSEUDO_PREFIX = "rami104:pseudo:"
AUTH_SALT = "rami104-auth-v1"
AUTH_MAX_AGE = 60 * 60 * 24 * 30  # 30 jours
ONLINE_TTL = 45  # secondes sans activité avant de considérer un joueur hors ligne
PRESENCE_WRITE_INTERVAL = 10  # limite les écritures Redis


def normalize_phone(phone):
    # Les données d'une requête HTTP ne sont pas forcément des chaînes.
    # Convertir explicitement évite qu'un JSON mal formé ne provoque un 500.
    phone = "".join(ch for ch in str(phone or "") if ch.isdigit() or ch == "+")
    if phone.startswith("00"):
        phone = "+" + phone[2:]
    if not phone.startswith("+") and phone:
        phone = "+" + phone
    return phone


def phone_key(phone):
    digest = hashlib.sha256(normalize_phone(phone).encode("utf-8")).hexdigest()
    return ACCOUNT_PREFIX + digest


def normalize_pseudo(name):
    return " ".join((name or "").strip().split()).lower()


def pseudo_key(name):
    digest = hashlib.sha256(normalize_pseudo(name).encode("utf-8")).hexdigest()
    return PSEUDO_PREFIX + digest


class AccountManager:
    def __init__(self):
        self.storage = build_storage()
        secret = os.environ.get("RAMI_SECRET_KEY") or os.environ.get("SECRET_KEY")
        # Ne jamais utiliser une clé connue par défaut : sinon n'importe
        # quelle personne pourrait forger un jeton de connexion. En local,
        # une clé aléatoire permet quand même de démarrer l'application ;
        # elle sera renouvelée au redémarrage. En production,
        # RAMI_SECRET_KEY doit être configurée avec une valeur stable.
        if not secret:
            secret = secrets.token_urlsafe(32)
        self.signer = URLSafeTimedSerializer(secret, salt=AUTH_SALT)

    def _pseudo_in_use(self, name):
        key = pseudo_key(name)
        if self.storage.get(key):
            return True
        keys = []
        if hasattr(self.storage, "keys"):
            try:
                keys = self.storage.keys(ACCOUNT_PREFIX + "*") or []
            except Exception:
                keys = []
        wanted = normalize_pseudo(name)
        for k in keys:
            if ":id:" in k or ":pseudo:" in k:
                continue
            raw = self.storage.get(k)
            if not raw:
                continue
            try:
                acc = json.loads(raw)
            except Exception:
                continue
            if normalize_pseudo(acc.get("name", "")) == wanted:
                return True
        return False

    def register(self, name, phone, password, promo=""):
        name = (name or "").strip()[:20]
        phone = normalize_phone(phone)
        if len(name) < 2:
            raise ValueError("Le pseudo doit contenir au moins 2 caractères.")
        if len(phone) < 8:
            raise ValueError("Numéro de téléphone invalide.")
        if len(password or "") < 6:
            raise ValueError("Le mot de passe doit contenir au moins 6 caractères.")
        key = phone_key(phone)
        if self.storage.get(key):
            raise ValueError("Un compte existe déjà avec ce numéro.")
        pkey = pseudo_key(name)
        if self._pseudo_in_use(name):
            raise ValueError("Ce pseudo est déjà utilisé. Choisissez-en un autre.")
        # ID public unique généré automatiquement.
        account_id = "R104-" + secrets.token_hex(6).upper()
        while self.storage.get(ACCOUNT_PREFIX + "id:" + account_id):
            account_id = "R104-" + secrets.token_hex(6).upper()
        account = {
            "id": account_id,
            "name": name,
            "phone": phone,
            "password_hash": generate_password_hash(password),
            "promo": (promo or "").strip()[:30],
            "friends": [],
            "friend_requests": [],
            "invitations": [],
            "notifications": [],
            "created_at": time.time(),
        }
        self.storage.set(key, json.dumps(account))
        self.storage.set(pkey, account["id"])
        self.storage.set(ACCOUNT_PREFIX + "id:" + account["id"], json.dumps(account))
        return account

    def login(self, phone, password):
        phone = normalize_phone(phone)
        raw = self.storage.get(phone_key(phone))
        if not raw:
            raise ValueError("Numéro ou mot de passe incorrect.")
        account = json.loads(raw)
        if not check_password_hash(account.get("password_hash", ""), password or ""):
            raise ValueError("Numéro ou mot de passe incorrect.")
        return account

    def token_for(self, account):
        return self.signer.dumps({"id": account["id"], "name": account["name"], "phone": account["phone"]})

    def account_from_token(self, token):
        if not token:
            return None
        try:
            payload = self.signer.loads(token, max_age=AUTH_MAX_AGE)
        except (BadSignature, SignatureExpired):
            return None
        if not isinstance(payload, dict):
            return None
        raw = self.storage.get(phone_key(payload.get("phone", "")))
        if not raw:
            return None
        account = json.loads(raw)
        if not hmac.compare_digest(str(account.get("id", "")), str(payload.get("id", ""))):
            return None
        return account

    def _load_by_id(self, account_id):
        # Le stockage est clé par numéro hashé ; une petite indexation n'existe
        # pas encore, on conserve donc un index d'amis par compte dans son document.
        # Les méthodes publiques ci-dessous utilisent les clés connues via phone.
        return None

    def mark_online(self, account):
        """Met à jour la présence sans écrire dans Redis à chaque polling."""
        now = time.time()
        try:
            last = float(account.get("last_seen", 0) or 0)
        except (TypeError, ValueError):
            last = 0
        if now - last < PRESENCE_WRITE_INTERVAL:
            return account
        account["last_seen"] = now
        self.save_account(account)
        return account

    @staticmethod
    def is_online(account, now=None):
        now = time.time() if now is None else now
        try:
            return now - float(account.get("last_seen", 0) or 0) <= ONLINE_TTL
        except (TypeError, ValueError):
            return False

    def save_account(self, account):
        raw = json.dumps(account)
        self.storage.set(phone_key(account["phone"]), raw)
        self.storage.set(pseudo_key(account["name"]), account["id"])
        self.storage.set(ACCOUNT_PREFIX + "id:" + account["id"], raw)

    def find_accounts(self, query, limit=20):
        """Recherche publique par pseudo ou ID joueur, sans téléphone.
        Déduplique les comptes malgré les index téléphone/ID/pseudo.
        """
        q = (query or "").strip().lower()
        if len(q) < 2:
            return []
        found = []
        seen = set()
        keys = []
        if hasattr(self.storage, "keys"):
            try:
                keys = self.storage.keys(ACCOUNT_PREFIX + "*") or []
            except Exception:
                keys = []
        for key in keys:
            raw = self.storage.get(key)
            if not raw:
                continue
            try:
                acc = json.loads(raw)
            except Exception:
                continue
            aid = str(acc.get("id", ""))
            name = str(acc.get("name", ""))
            if not aid or aid in seen:
                continue
            if q in name.lower() or q in aid.lower():
                found.append({"id": aid, "name": name, "online": self.is_online(acc), "last_seen": acc.get("last_seen", 0)})
                seen.add(aid)
                if len(found) >= limit:
                    break
        return found

    def find_by_id(self, account_id):
        direct = self.storage.get(ACCOUNT_PREFIX + "id:" + str(account_id))
        if direct:
            try:
                return json.loads(direct)
            except Exception:
                pass
        keys = []
        if hasattr(self.storage, "keys"):
            try:
                keys = self.storage.keys(ACCOUNT_PREFIX + "*") or []
            except Exception:
                keys = []
        for key in keys:
            raw = self.storage.get(key)
            if raw:
                try:
                    acc = json.loads(raw)
                    if str(acc.get("id")) == str(account_id):
                        return acc
                except Exception:
                    pass
        return None

    def add_friend_request(self, account_id, target_id):
        """Enregistre une demande chez le destinataire.

        ``friend_requests`` représente les demandes reçues (c'est ce que
        ``friends_for`` expose dans ``pending``), et non les demandes
        envoyées. L'ancienne implémentation ajoutait l'ID du destinataire
        dans le document de l'expéditeur : la demande apparaissait donc chez
        le mauvais joueur et ne pouvait jamais être acceptée.
        """
        account_id = str(account_id)
        target_id = str(target_id)
        if account_id == target_id:
            raise ValueError("Vous ne pouvez pas vous ajouter vous-même.")
        me = self.find_by_id(account_id)
        target = self.find_by_id(target_id)
        if not me or not target:
            raise ValueError("Compte introuvable.")
        friends = set(me.get("friends", []))
        requests = set(target.get("friend_requests", []))
        if target_id in friends:
            raise ValueError("Vous êtes déjà amis.")
        if account_id in requests:
            return target, False
        requests.add(account_id)
        target["friend_requests"] = list(requests)
        self.save_account(target)
        return target, True

    def accept_friend_request(self, account_id, requester_id):
        account_id = str(account_id)
        requester_id = str(requester_id)
        me = self.find_by_id(account_id)
        other = self.find_by_id(requester_id)
        if not me or not other:
            raise ValueError("Compte introuvable.")
        requests = set(me.get("friend_requests", []))
        if requester_id not in requests:
            raise ValueError("Demande d'ami introuvable.")
        requests.remove(requester_id)
        me["friend_requests"] = list(requests)
        # Si les deux joueurs s'étaient invités simultanément, supprimer
        # aussi la demande devenue obsolète chez l'autre joueur.
        other["friend_requests"] = [
            rid for rid in other.get("friend_requests", [])
            if str(rid) != account_id
        ]
        mf = set(me.get("friends", [])); of = set(other.get("friends", []))
        mf.add(requester_id); of.add(account_id)
        me["friends"] = list(mf); other["friends"] = list(of)
        self.save_account(me); self.save_account(other)
        return other

    def friends_for(self, account_id):
        me = self.find_by_id(account_id)
        if not me:
            return [], []
        friends = []
        pending = []
        for fid in me.get("friends", []):
            acc = self.find_by_id(fid)
            if acc:
                friends.append({
                    "id": acc["id"], "name": acc["name"],
                    "online": self.is_online(acc),
                    "last_seen": acc.get("last_seen", 0),
                })
        for rid in me.get("friend_requests", []):
            acc = self.find_by_id(rid)
            if acc:
                pending.append({
                    "id": acc["id"], "name": acc["name"],
                    "online": self.is_online(acc),
                    "last_seen": acc.get("last_seen", 0),
                })
        return friends, pending


    def add_notification(self, account_id, kind, title, message, **extra):
        account = self.find_by_id(account_id)
        if not account:
            raise ValueError("Compte introuvable.")
        notifications = account.get("notifications", [])
        notification = {
            "id": uuid.uuid4().hex[:16],
            "kind": kind,
            "title": title,
            "message": message,
            "created_at": time.time(),
            "read": False,
        }
        notification.update(extra)
        notifications.append(notification)
        account["notifications"] = notifications[-50:]
        self.save_account(account)
        return notification

    def notifications_for(self, account_id, unread_only=False, limit=30):
        account = self.find_by_id(account_id)
        if not account:
            return []
        items = account.get("notifications", [])
        if unread_only:
            items = [n for n in items if not n.get("read")]
        return list(reversed(items[-limit:]))

    def mark_notification_read(self, account_id, notification_id):
        account = self.find_by_id(account_id)
        if not account:
            raise ValueError("Compte introuvable.")
        changed = False
        for n in account.get("notifications", []):
            if str(n.get("id")) == str(notification_id):
                n["read"] = True
                changed = True
                break
        if changed:
            self.save_account(account)
        return changed

    def mark_notifications_by(self, account_id, kind=None, ref_id=None):
        account = self.find_by_id(account_id)
        if not account:
            return
        changed = False
        for n in account.get("notifications", []):
            if kind and n.get("kind") != kind:
                continue
            if ref_id and str(n.get("ref_id")) != str(ref_id):
                continue
            if not n.get("read"):
                n["read"] = True
                changed = True
        if changed:
            self.save_account(account)


account_manager = AccountManager()
