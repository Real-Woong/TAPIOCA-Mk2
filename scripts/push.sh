#!/usr/bin/env bash
#
# Mac mini의 수집 배치 폴더 하나를 Oracle의 inbox로 올립니다.
#
#   SCREENER_SERVER=ubuntu@<서버주소> scripts/push.sh data/outbox/2026-11-02-daily
#
# ── 설계에서 정한 것 ────────────────────────────────────────────────────────
#
# **올리는 곳은 data/1_inbox/ 하나뿐입니다.** pull-data.sh는 «서버 → 로컬 한 방향»을
# 원칙으로 삼는데(실주문 원장·기준선을 덮지 않으려고), 이 스크립트는 그 반대 방향이라
# 목적지를 TAPIoca_ver2 전용 폴더로 못 박아 그 위험을 피합니다. data/ 의 다른 곳에는 쓰지 않습니다.
#
# **`.partial`로 올리고 다 올라가면 이름을 바꿉니다.** 전송이 중간에 끊겨도 Oracle이
# 반쯤 온 배치를 완성본으로 읽는 순간이 없습니다.
#
# **같은 이름의 배치가 이미 있으면 거부합니다.** 원본은 고쳐 쓰지 않고 쌓습니다.
# 다시 수집했다면 폴더 이름이 달라야 합니다.

set -euo pipefail

BATCH="${1:-}"
[[ -n "$BATCH" && -d "$BATCH" ]] || { echo "사용법: SCREENER_SERVER=user@host $0 <배치 폴더>" >&2; exit 1; }
[[ -n "${SCREENER_SERVER:-}" ]] || { echo "SCREENER_SERVER 환경변수가 필요합니다 (예: ubuntu@1.2.3.4)" >&2; exit 1; }
[[ -f "$BATCH/manifest.json" ]] || { echo "manifest.json 이 없습니다 — 수집이 끝나지 않은 배치입니다" >&2; exit 1; }

REMOTE_INBOX="${SCREENER_REMOTE_INBOX:-/home/ubuntu/toss-api/apps/TAPIOCA_ver2/data/1_inbox}"
NAME="$(basename "$BATCH")"
STATUS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)' "$BATCH/manifest.json")"

echo "■ 올립니다: $NAME (상태 $STATUS) → $SCREENER_SERVER:$REMOTE_INBOX"
# 사람이 없을 때 비밀번호·확인 질문에 멈추지 않도록 (daily.sh 와 같은 설정)
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
ssh "${SSH_OPTS[@]}" "$SCREENER_SERVER" "mkdir -p '$REMOTE_INBOX' && test ! -e '$REMOTE_INBOX/$NAME'" \
  || { echo "서버에 같은 이름의 배치가 이미 있습니다: $NAME" >&2; exit 1; }

rsync -az --partial -e "ssh ${SSH_OPTS[*]}" "$BATCH/" "$SCREENER_SERVER:$REMOTE_INBOX/$NAME.partial/"
ssh "${SSH_OPTS[@]}" "$SCREENER_SERVER" "mv '$REMOTE_INBOX/$NAME.partial' '$REMOTE_INBOX/$NAME'"
echo "■ 완료. Oracle의 검수는 manifest 의 파일 해시를 대조합니다."
