#!/usr/bin/env bash
#
# macOS launchd 에 «매일 아침 수집» 일정을 등록·해제·확인합니다.
#
#   bash scripts/launchd.sh install     등록 (화~토 한국시간 07:00)
#   bash scripts/launchd.sh run         지금 한 번 시험 실행 (일정과 무관)
#   bash scripts/launchd.sh status      등록 상태
#   bash scripts/launchd.sh diag        launchd 환경에서 어느 단계가 멈추는지 진단 (결과: $LOGDIR/diag.log)
#   bash scripts/launchd.sh uninstall   해제 (진단 작업 포함)
#
# 왜 화~토 07:00 인가: 07:00(KST)는 미국 정규장 마감(서머타임 05:00 / 11월부터 06:00) 뒤 «확정 봉»이 생긴 시각이고,
# 수집이 ~50분 걸려 08:00 전에 끝납니다. 월·일 아침은 미국이 주말(직전 거래일 없음)이라 뺍니다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.tapioca.ver2.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# launchd 의 출력은 Desktop 밖에 둡니다(백그라운드 프로세스의 Desktop 접근 권한 문제가 나도 오류가 보이게)
LOGDIR="$HOME/Library/Logs/tapioca-ver2"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    [[ -f "$ROOT/.env.local" ]] || { echo ".env.local 이 없습니다 — .env.local.example 을 복사해 SCREENER_SERVER 를 채우세요" >&2; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
    cat >"$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$ROOT/scripts/daily.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>6</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$LOGDIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/launchd.err.log</string>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
PLISTEOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "■ 등록했습니다: $PLIST"
    echo "  시험: bash scripts/launchd.sh run   ·   로그: $ROOT/data/logs/ 와 $LOGDIR"
    ;;
  run)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "■ 지금 실행을 시작했습니다. 진행: tail -f $ROOT/data/logs/daily-\$(date +%F).log"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>&1 | grep -E "state|last exit code|runs|path" || echo "등록돼 있지 않습니다"
    ;;
  diag)
    # 진짜 작업과 같은 방식(LaunchAgent, 같은 작업 폴더)으로 진단 스크립트를 한 번 돌린다. 수집·전송은 하지 않는다
    DIAG_LABEL="com.tapioca.ver2.diag"
    DIAG_PLIST="$HOME/Library/LaunchAgents/$DIAG_LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
    : >"$LOGDIR/diag.log"
    cat >"$DIAG_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$DIAG_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$ROOT/scripts/launchd-diag.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/diag.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/diag.log</string>
</dict>
</plist>
PLISTEOF
    launchctl bootout "$DOMAIN/$DIAG_LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$DIAG_PLIST"
    echo "■ 진단을 시작했습니다 (최대 약 2분). 결과: cat $LOGDIR/diag.log"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootout "$DOMAIN/com.tapioca.ver2.diag" 2>/dev/null || true
    rm -f "$PLIST" "$HOME/Library/LaunchAgents/com.tapioca.ver2.diag.plist"
    echo "■ 해제했습니다"
    ;;
  *)
    echo "사용법: bash scripts/launchd.sh install|run|status|uninstall" >&2
    exit 1
    ;;
esac
