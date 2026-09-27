"""Regenerate docs/API_INVENTORY.md from the live app (run after route changes)."""


from backend.main import app

MARKER = "<!-- INVENTORY:list -->"


def inventory_lines() -> list[str]:
    spec = app.openapi()
    lines = []
    for path in sorted(spec.get("paths", {})):
        for method in sorted(spec["paths"][path]):
            lines.append(f"`{method.upper()} {path}`")
    return lines


if __name__ == "__main__":
    lines = inventory_lines()
    body = "\n".join(lines) + "\n"
    doc = open("docs/API_INVENTORY.md").read()
    if MARKER not in doc:
        raise SystemExit("marker missing in docs/API_INVENTORY.md")
    head, _tail = doc.split(MARKER, 1)
    open("docs/API_INVENTORY.md", "w").write(head + MARKER + "\n\n" + body)
    print(f"wrote {len(lines)} operations")
