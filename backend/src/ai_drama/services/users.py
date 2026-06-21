"""Local user-account services for authentication and admin management."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_drama.db import UserAccount
from ai_drama.models import UserCreate, UserUpdate

PASSWORD_HASH_ALGORITHM = "pbkdf2_sha256"
PASSWORD_HASH_ITERATIONS = 390_000


def ensure_default_admin_user(
    db: Session, *, username: str, password: str
) -> UserAccount:
    """Create or recover the bootstrap admin account for local deployments."""
    active_admin_count = _active_admin_count(db)
    existing = get_user_by_username(db, username)
    if active_admin_count > 0:
        if existing is not None:
            return existing
        first = db.scalar(select(UserAccount).order_by(UserAccount.id))
        if first is None:
            raise RuntimeError("active admin count is out of sync")
        return first

    if existing is None:
        existing = UserAccount(
            username=username.strip(),
            password_hash=hash_password(password),
            is_admin=True,
            is_active=True,
        )
        db.add(existing)
    else:
        existing.password_hash = hash_password(password)
        existing.is_admin = True
        existing.is_active = True
    db.commit()
    db.refresh(existing)
    return existing


def authenticate_user(
    db: Session, *, username: str, password: str
) -> UserAccount | None:
    user = get_user_by_username(db, username.strip())
    if user is None or not user.is_active:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def list_users(db: Session) -> list[UserAccount]:
    stmt = select(UserAccount).order_by(UserAccount.id)
    return list(db.scalars(stmt))


def get_user(db: Session, user_id: int) -> UserAccount | None:
    return db.get(UserAccount, user_id)


def get_user_by_username(db: Session, username: str) -> UserAccount | None:
    stmt = select(UserAccount).where(UserAccount.username == username.strip())
    return db.scalar(stmt)


def create_user(db: Session, data: UserCreate) -> UserAccount:
    username = data.username.strip()
    if not username:
        raise ValueError("username is required")
    if get_user_by_username(db, username) is not None:
        raise ValueError("username already exists")

    user = UserAccount(
        username=username,
        password_hash=hash_password(data.password),
        is_admin=data.is_admin,
        is_active=data.is_active,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user(
    db: Session,
    user_id: int,
    data: UserUpdate,
    *,
    actor_user_id: int,
) -> UserAccount:
    user = db.get(UserAccount, user_id)
    if user is None:
        raise LookupError(f"user {user_id} not found")

    fields = data.model_fields_set
    if "username" in fields and data.username is not None:
        username = data.username.strip()
        if not username:
            raise ValueError("username is required")
        existing = get_user_by_username(db, username)
        if existing is not None and existing.id != user.id:
            raise ValueError("username already exists")
        user.username = username

    if "password" in fields and data.password is not None:
        user.password_hash = hash_password(data.password)

    if "is_admin" in fields and data.is_admin is not None:
        if user.id == actor_user_id and user.is_admin and not data.is_admin:
            raise PermissionError("cannot remove your own admin permission")
        if user.is_admin and not data.is_admin:
            _require_another_active_admin(db, user.id)
        user.is_admin = data.is_admin

    if "is_active" in fields and data.is_active is not None:
        if user.id == actor_user_id and user.is_active and not data.is_active:
            raise PermissionError("cannot deactivate your own account")
        if user.is_admin and user.is_active and not data.is_active:
            _require_another_active_admin(db, user.id)
        user.is_active = data.is_active

    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user_id: int, *, actor_user_id: int) -> None:
    user = db.get(UserAccount, user_id)
    if user is None:
        raise LookupError(f"user {user_id} not found")
    if user.id == actor_user_id:
        raise PermissionError("cannot delete your own account")
    if user.is_admin and user.is_active:
        _require_another_active_admin(db, user.id)

    db.delete(user)
    db.commit()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        PASSWORD_HASH_ITERATIONS,
    ).hex()
    return (
        f"{PASSWORD_HASH_ALGORITHM}${PASSWORD_HASH_ITERATIONS}${salt}${digest}"
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations_raw, salt, digest = stored_hash.split("$", 3)
        iterations = int(iterations_raw)
    except ValueError:
        return False

    if algorithm != PASSWORD_HASH_ALGORITHM:
        return False

    candidate = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        iterations,
    ).hex()
    return hmac.compare_digest(candidate, digest)


def _active_admin_count(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(UserAccount)
            .where(UserAccount.is_admin.is_(True), UserAccount.is_active.is_(True))
        )
        or 0
    )


def _require_another_active_admin(db: Session, user_id: int) -> None:
    count = int(
        db.scalar(
            select(func.count())
            .select_from(UserAccount)
            .where(
                UserAccount.id != user_id,
                UserAccount.is_admin.is_(True),
                UserAccount.is_active.is_(True),
            )
        )
        or 0
    )
    if count == 0:
        raise PermissionError("at least one active admin is required")
