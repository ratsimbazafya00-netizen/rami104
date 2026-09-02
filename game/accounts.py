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
        account = {
            "id": uuid.uuid4().hex[:16],
            "name": name,
            "phone": phone,
            "password_hash": generate_password_hash(password),
            "promo": (promo or "").strip()[:30],
            "created_at": time.time(),
        }
        self.storage.set(key, json.dumps(account))
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


account_manager = AccountManager()
