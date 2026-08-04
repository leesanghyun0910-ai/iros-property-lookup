#!/bin/sh
# 배포 사고 방지 가드
#
# 배포본과 main이 의도적으로 갈라져 있다. 프로덕션에는 건축물대장(세움터) 기능이
# 살아있지만 main에는 없으므로, main을 그대로 배포하면 해당 기능이 프로덕션에서
# 사라진다. 무심코 실행한 `npm run deploy` 한 번으로 그 일이 벌어지지 않도록
# 명시적 확인을 요구한다.
#
# 확인 절차를 건너뛰려면: ALLOW_PRODUCTION_DEPLOY=1 npm run deploy

set -e

if [ "$ALLOW_PRODUCTION_DEPLOY" = "1" ]; then
  echo "[deploy] ALLOW_PRODUCTION_DEPLOY=1 — 확인 절차를 건너뜁니다."
  exit 0
fi

cat <<'EOF'

  ⚠️  배포 전 확인

  현재 프로덕션에 배포된 버전에는 건축물대장(세움터) 기능이 포함되어 있습니다.
  main 브랜치에는 해당 기능이 없습니다.

  지금 배포하면 프로덕션에서 다음이 제거됩니다:
    · POST /api/building-register/status
    · POST /api/building-register/download
    · 건축물대장 조회 열 · 행별 PDF 버튼 · 일괄 PDF 버튼
    · D1(BUILDING_REGISTER_DB) / R2(BUILDING_REGISTER_PDFS) 바인딩
    · 건축물대장 임시 캐시 cleanup cron ("0 18 * * *")

  기능을 유지한 채 배포하려면 feature/building-register 를 머지한 뒤 실행하세요.
  확인 없이 배포하려면: ALLOW_PRODUCTION_DEPLOY=1 npm run deploy

EOF

# /dev/tty 는 파일로는 보이지만 실제로 열리지 않는 환경(CI, 파이프)이 있으므로
# 입력 경로 결정. stdin 이 터미널이면 그대로 쓰고, 아니면 /dev/tty 를 시도한다.
# /dev/tty 는 파일로는 보이지만 실제로 열리지 않는 환경(CI, 파이프)이 있으므로
# 서브셸에서 열림 여부를 직접 확인한다. 둘 다 안 되면 fail-closed.
answer=""
if [ -t 0 ]; then
  printf "  계속하려면 deploy 를 입력하세요: "
  read -r answer || answer=""
elif (: < /dev/tty) 2>/dev/null; then
  printf "  계속하려면 deploy 를 입력하세요: "
  read -r answer < /dev/tty || answer=""
else
  echo "  [중단] 대화형 터미널이 아닙니다."
  echo "         의도한 배포라면 ALLOW_PRODUCTION_DEPLOY=1 을 지정하세요."
  exit 1
fi

if [ "$answer" != "deploy" ]; then
  echo
  echo "  [중단] 배포를 취소했습니다."
  exit 1
fi

echo "  [계속] 배포를 진행합니다."
