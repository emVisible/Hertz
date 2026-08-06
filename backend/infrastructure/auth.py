"""JWT authentication infrastructure (AXIOM §8.3).

Provides token creation/verification and the FastAPI dependency.
Route-level enforcement lands when user management exists; the
primitives are available from Wave 1.
"""

from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.config import settings

_bearer = HTTPBearer(auto_error=False)

_bearer_dep = Depends(_bearer)

ALGORITHM = "HS256"


def _require_secret() -> str:
    if not settings.secret_key:
        raise RuntimeError("HERTZ_SECRET_KEY is not set; auth primitives require it")
    return settings.secret_key


def create_access_token(subject: str, expires_minutes: int | None = None) -> str:
    expires = expires_minutes or settings.access_token_expire_minutes
    payload = {
        "sub": subject,
        "exp": datetime.now(UTC) + timedelta(minutes=expires),
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, _require_secret(), algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, _require_secret(), algorithms=[ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from exc


async def get_current_subject(
    credentials: HTTPAuthorizationCredentials | None = _bearer_dep,
) -> str:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    payload = decode_access_token(credentials.credentials)
    return payload["sub"]
