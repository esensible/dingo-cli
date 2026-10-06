#!/usr/bin/env bash
# Copy the repo's Claude skills into web/skills/ so the page can serve them
# through window.api.skills() / api.skill(name), and write web/skills/index.json.
#
# Run inside the dev container:
#     bash web/sync-skills.sh
#
# Source: <repo>/.claude/skills/<name>/SKILL.md (+ assets/). Each copied skill
# replaces web/skills/<name>/ wholesale. Skills that exist only under web/skills
# (web-api, written for this page) are left alone and indexed too.
set -euo pipefail

web_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname "$web_dir")"
src_dir="$repo_dir/.claude/skills"
dst_dir="$web_dir/skills"

mkdir -p "$dst_dir"

for skill_md in "$src_dir"/*/SKILL.md; do
  [ -e "$skill_md" ] || { echo "no skills under $src_dir" >&2; exit 1; }
  name="$(basename "$(dirname "$skill_md")")"
  rm -rf "${dst_dir:?}/$name"
  mkdir -p "$dst_dir/$name"
  cp "$skill_md" "$dst_dir/$name/SKILL.md"
  if [ -d "$(dirname "$skill_md")/assets" ]; then
    cp -R "$(dirname "$skill_md")/assets" "$dst_dir/$name/assets"
  fi
  echo "synced $name"
done

# dingopdm-config tells the reader to start from internal/pdmcfg/testdata/example.json;
# serve it next to the skill so a browser agent can fetch it too.
example="$repo_dir/internal/pdmcfg/testdata/example.json"
if [ -f "$example" ] && [ -d "$dst_dir/dingopdm-config" ]; then
  mkdir -p "$dst_dir/dingopdm-config/assets"
  cp "$example" "$dst_dir/dingopdm-config/assets/example.json"
  echo "copied example.json → skills/dingopdm-config/assets/example.json"
fi

# index.json: [{ name, dir, description, path, chars, assets }] from each SKILL.md frontmatter.
python3 - "$dst_dir" <<'PY'
import json, os, sys

dst = sys.argv[1]

def frontmatter(text):
    """Minimal YAML frontmatter reader: top-level `key: value` scalars,
    including folded (>, >-) and literal (|, |-) block scalars."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        raise ValueError("no frontmatter")
    end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    out, i, body = {}, 1, lines[1:end]
    i = 0
    while i < len(body):
        line = body[i]
        if not line.strip() or line.startswith((" ", "\t")) or ":" not in line:
            i += 1
            continue
        key, val = line.split(":", 1)
        val = val.strip()
        if val in (">", ">-", "|", "|-"):
            block = []
            i += 1
            while i < len(body) and (body[i].startswith((" ", "\t")) or not body[i].strip()):
                block.append(body[i].strip())
                i += 1
            out[key.strip()] = (" " if val.startswith(">") else "\n").join(b for b in block if b).strip()
            continue
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
            val = val[1:-1]
        out[key.strip()] = val
        i += 1
    return out

index = []
for d in sorted(os.listdir(dst)):
    p = os.path.join(dst, d, "SKILL.md")
    if not os.path.isfile(p):
        continue
    with open(p, encoding="utf-8") as f:
        text = f.read()
    fm = frontmatter(text)
    if "name" not in fm or "description" not in fm:
        sys.exit(f"{p}: frontmatter needs name and description")
    assets = []
    adir = os.path.join(dst, d, "assets")
    if os.path.isdir(adir):
        for root, _, files in os.walk(adir):
            for fn in sorted(files):
                assets.append(os.path.relpath(os.path.join(root, fn), os.path.dirname(dst)))
    index.append({
        "name": fm["name"], "dir": d, "description": fm["description"],
        "path": f"skills/{d}/SKILL.md", "chars": len(text), "assets": sorted(assets),
    })

with open(os.path.join(dst, "index.json"), "w", encoding="utf-8") as f:
    json.dump(index, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"wrote {os.path.join(dst, 'index.json')}: " + ", ".join(s["name"] for s in index))
PY
