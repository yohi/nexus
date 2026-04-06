import os
from pathlib import Path


class SessionStore:
    def __init__(self, root: Path):
        self.root = root

    def resolve(self, user_id: str) -> Path:
        return self.root / f"{user_id}.json"


def build_session_token(user_id: str) -> str:
    return f"session:{user_id}:{os.getpid()}"
