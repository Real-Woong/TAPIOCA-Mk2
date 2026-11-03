#!/usr/bin/env bash
#
# Mac mini가 매일 아침 한 번 돌리는 «수집 → 전송 → 서버 검수» 묶음입니다. launchd가 부릅니다.
# 손으로 시험할 때도 그대로 돌리면 됩니다:   bash scripts/daily.sh
#
# 설정은 TAPIoca_ver2/.env.local 에 둡니다 (git 무시, 서버 주소 등):
#   SCREENER_SERVER=ubuntu@<서버주소>
#   SCREENER_REMOTE_DIR=/home/ubuntu/toss-api/apps/TAPIOCA_ver2     (생략 가능)
#
# ── 설계에서 정한 것 ────────────────────────────────────────────────────────
# **다시 돌려도 안전합니다.** 폴더 이름이 «한국 날짜-daily» 로 하루에 하나라, 수집이 중간에 멈췄다면
#   같은 폴더에서 이어 받고, 이미 올린 배치는 표식(.state/*.pushed)으로 건너뜁니다.
# **ABORTED(차단)면 올리지 않습니다.** 반쪽 데이터를 서버로 보내지 않습니다. PARTIAL은 올립니다(허용 여부는 서버 검수가 정함).
# **멈추면 실패로 끝냅니다.** 사람이 없는 launchd 에서는 «기다리는 중»이 영원히 갈 수 있어,
#   수집·서버 단계에 제한 시간을 걸고 넘으면 죽입니다(알림 후 종료). ssh 는 비밀번호를 묻지 않습니다(BatchMode).
# **겹쳐 돌지 않습니다.** 어제 수집이 아직 도는 중이면 오늘 것은 건너뜁니다(lock).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# launchd 는 PATH 가 거의 비어 있습니다. Homebrew 위치를 직접 넣습니다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# shellcheck disable=SC1091
[[ -f .env.local ]] && set -a && source .env.local && set +a
: "${SCREENER_SERVER:?SCREENER_SERVER 가 없습니다 — TAPIoca_ver2/.env.local 에 적으세요}"
REMOTE_DIR="${SCREENER_REMOTE_DIR:-/home/ubuntu/toss-api/apps/TAPIOCA_ver2}"

mkdir -p data/logs data/outbox/.state

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
COLLECT_LIMIT_SEC=$((90 * 60))   # 전체 수집은 평소 20분 안팎 — 90분이면 멈춘 것
SERVER_LIMIT_SEC=$((15 * 60))

# macOS 에는 timeout 명령이 없다 — 제한 시간 안에 안 끝나면 자식까지 죽이고 124 를 돌려준다
run_limited() {
  local limit="$1"; shift
  local flag; flag="$(mktemp -u "${TMPDIR:-/tmp}/limited.XXXXXX")"
  "$@" &
  local pid=$!
  ( sleep "$limit"; : >"$flag"; kill -TERM "$pid" 2>/dev/null; sleep 5; kill -KILL "$pid" 2>/dev/null ) &
  local guard=$!
  wait "$pid"; local code=$?
  kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null
  if [[ -e "$flag" ]]; then rm -f "$flag"; return 124; fi
  return $code
}
LOG="data/logs/daily-$(date +%F).log"
exec >>"$LOG" 2>&1

say() { echo "[$(date '+%F %T')] $*"; }
notify_fail() {
  say "✖ 실패: $1"
  osascript -e "display notification \"$1\" with title \"TAPIoca Ver2 수집 실패\"" >/dev/null 2>&1 || true
}

# ── lock: 이미 돌고 있으면 건너뜀 (죽은 lock 은 PID 가 없으면 치움)
LOCK="data/outbox/.state/daily.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OLD="$(cat "$LOCK/pid" 2>/dev/null || echo)"
  if [[ -n "$OLD" ]] && kill -0 "$OLD" 2>/dev/null; then
    say "이미 실행 중(PID $OLD) — 건너뜁니다"
    exit 0
  fi
  rm -rf "$LOCK" && mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# 이름은 «오늘 한국 날짜». 뉴욕 날짜로 하면 새벽에 손으로 돌린 배치와 이름이 겹쳐 낡은 폴더를 이어받는다
NAME="$(date +%F)-daily"
OUT="data/outbox/$NAME"
say "■ 시작 $NAME (Node $(node -v))"

# ── 1) 수집
run_limited "$COLLECT_LIMIT_SEC" node src/collect/collect-cli.js --mode daily --out "$OUT"
CODE=$?
case $CODE in
  0) say "수집 COMPLETE" ;;
  2) say "수집 PARTIAL — 서버 검수에서 허용 여부를 정합니다" ;;
  124) notify_fail "수집이 $((COLLECT_LIMIT_SEC / 60))분 안에 끝나지 않아 중단했습니다. 같은 명령을 다시 돌리면 이어서 받습니다"; exit 1 ;;
  3) notify_fail "차단으로 중단(ABORTED). 올리지 않았습니다. 같은 명령을 다시 돌리면 이어서 받습니다"; exit 3 ;;
  *) notify_fail "수집기 오류(코드 $CODE)"; exit 1 ;;
esac

# ── 2) 전송 (이미 올렸으면 건너뜀)
PUSHED="data/outbox/.state/$NAME.pushed"
if [[ -f "$PUSHED" ]]; then
  say "이미 올린 배치 — 전송 건너뜀"
else
  run_limited "$SERVER_LIMIT_SEC" bash scripts/push.sh "$OUT" || { notify_fail "서버 전송 실패"; exit 1; }
  date '+%F %T' >"$PUSHED"
fi

# 서버의 비대화형 셸은 ~/.bashrc 를 건너뛰어 nvm 의 npm 을 못 찾는다 — 직접 불러온다
REMOTE_ENV='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '

# ── 3) 서버에서 검수·적재, 이어서 후보 상태 갱신 (로그인 셸로 불러 서버의 node 경로를 얻음)
say "서버 검수 실행"
run_limited "$SERVER_LIMIT_SEC" ssh "${SSH_OPTS[@]}" "$SCREENER_SERVER" "bash -lc '${REMOTE_ENV}cd $REMOTE_DIR && npm run receive && npm run candidates && npm run paper'"
RCODE=$?
if [[ $RCODE -ne 0 ]]; then
  notify_fail "서버 검수에서 탈락/오류(코드 $RCODE). 서버 3_rejected/REJECTED.txt 를 보세요"
  exit 1
fi
say "서버 단계 완료 — 텔레그램 보고"
# 보고 실패는 수집·적재의 실패가 아니다 — 경고만 남기고 성공으로 끝낸다
run_limited 300 ssh "${SSH_OPTS[@]}" "$SCREENER_SERVER" "bash -lc '${REMOTE_ENV}cd $REMOTE_DIR && npm run report'" || say "⚠ 텔레그램 보고 실패 (수집·적재는 정상)"
say "■ 끝 — 수집·전송·적재 완료"
