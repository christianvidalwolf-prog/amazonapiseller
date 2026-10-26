"""SKU bloqueados (blocked_skus.txt): siempre a stock 0 y nunca se vuelven a listar en Amazon."""
import os

BLOCKED_SKUS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "blocked_skus.txt")


def load_blocked_skus() -> set[str]:
    if not os.path.exists(BLOCKED_SKUS_FILE):
        return set()
    with open(BLOCKED_SKUS_FILE, "r", encoding="utf-8") as f:
        return {line.strip().upper() for line in f if line.strip() and not line.lstrip().startswith("#")}
