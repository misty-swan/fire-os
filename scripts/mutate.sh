#!/bin/bash
# 変異（防御を外す）で試験が失敗することの再現用。例: scripts/mutate.sh src/server/auth/authorize.ts "旧文字列" "新文字列" --project workers tests/authorization.test.ts （ファイルは終了時に必ず元へ戻す）
# usage: mutate.sh <file> <python-old> <python-new> <vitest args...>
# 指定の文字列を置換して試験を実行し、必ず元に戻す。試験が失敗(=変異を検出)したら "DETECTED"。
f="$1"; old="$2"; new="$3"; shift 3
cp "$f" "$f.mutbak"
python3 - "$f" "$old" "$new" <<'PY'
import sys
f,old,new=sys.argv[1:4]
s=open(f).read()
if old not in s:
    print("PATTERN NOT FOUND"); sys.exit(3)
open(f,'w').write(s.replace(old,new,1))
PY
rc=$?
if [ $rc -ne 0 ]; then mv "$f.mutbak" "$f"; echo "MUTATION-ERROR"; exit 3; fi
out=$(timeout 600 npx vitest --run "$@" 2>&1)
code=$?
mv "$f.mutbak" "$f"
if [ $code -ne 0 ]; then echo "DETECTED: $(echo "$out" | rg -o '(×|FAIL).*' | head -3 | tr '\n' ' ')"; else echo "NOT DETECTED (tests passed)"; fi
