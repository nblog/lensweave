"""User-account pydantic schemas for local admin management."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class LoginRequest(BaseModel):
    """Credentials submitted by the browser login page."""

    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return value.strip()


class AuthSession(BaseModel):
    """Authenticated browser session returned to the frontend."""

    token: str
    username: str
    is_admin: bool


class UserCreate(BaseModel):
    """Admin request body for creating a local account."""

    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=6, max_length=200)
    is_admin: bool = False
    is_active: bool = True

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return value.strip()


class UserUpdate(BaseModel):
    """Admin request body for editing a local account."""

    username: str | None = Field(default=None, min_length=1, max_length=80)
    password: str | None = Field(default=None, min_length=6, max_length=200)
    is_admin: bool | None = None
    is_active: bool | None = None

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class UserRead(BaseModel):
    """User account as returned to admin clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    is_admin: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime
