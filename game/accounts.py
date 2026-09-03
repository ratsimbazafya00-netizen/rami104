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


def normalize_phone(phone):
    phone = "".join(ch for ch in (phone or "") if ch.isdigit() or ch == "+")
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
        # Ne jamais faire planter l'import de Flask si la variable n'a pas
        # encore été ajoutée dans Vercel. Une clé de secours permet au site
        # de démarrer ; en production, RAMI_SECRET_KEY doit être configurée
        # pour conserver une clé stable et sécurisée.
        if not secret:
            secret = "rami104-vercel-first-deploy-change-this-key"
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

    def save_account(self, account):
        raw = json.dumps(account)
        self.storage.set(phone_key(account["phone"]), raw)
        self.storage.set(pseudo_key(account["name"]), account["id"])
        self.storage.set(ACCOUNT_PREFIX + "id:" + account["id"], raw)

    def find_accounts(self, query, limit=20):
        """Recherche des comptes par pseudo ou numéro. Fonctionne avec les
        stockages disposant de scan/keys et retourne uniquement des données publiques."""
        q = (query or "").strip().lower()
        if len(q) < 2:
            return []
        found = []
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
            if q in acc.get("name", "").lower() or q in acc.get("phone", "").lower():
                found.append({"id": acc["id"], "name": acc["name"], "phone": acc["phone"]})
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
        if str(account_id) == str(target_id):
            raise ValueError("Vous ne pouvez pas vous ajouter vous-même.")
        me = self.find_by_id(account_id)
        target = self.find_by_id(target_id)
        if not me or not target:
            raise ValueError("Compte introuvable.")
        friends = set(me.get("friends", []))
        requests = set(me.get("friend_requests", []))
        if target_id in friends:
            raise ValueError("Vous êtes déjà amis.")
        if target_id in requests:
            return target
        requests.add(target_id)
        me["friend_requests"] = list(requests)
        self.save_account(me)
        return target

    def accept_friend_request(self, account_id, requester_id):
        me = self.find_by_id(account_id)
        other = self.find_by_id(requester_id)
        if not me or not other:
            raise ValueError("Compte introuvable.")
        requests = set(me.get("friend_requests", []))
        if requester_id not in requests:
            raise ValueError("Demande d'ami introuvable.")
        requests.remove(requester_id)
        me["friend_requests"] = list(requests)
        mf = set(me.get("friends", [])); of = set(other.get("friends", []))
        mf.add(requester_id); of.add(account_id)
        me["friends"] = list(mf); other["friends"] = list(of)
        self.save_account(me); self.save_account(other)
        return other

    def friends_for(self, account_id):
        me = self.find_by_id(account_id)
        if not me:
            return [], []
        friends=[]; pending=[]
        for fid in me.get("friends", []):
            acc=self.find_by_id(fid)
            if acc: friends.append({"id":acc["id"],"name":acc["name"]})
        for rid in me.get("friend_requests", []):
            acc=self.find_by_id(rid)
            if acc: pending.append({"id":acc["id"],"name":acc["name"]})
        return friends, pending


account_manager = AccountManager()
