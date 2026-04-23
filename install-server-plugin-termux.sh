#!/data/data/com.termux/files/usr/bin/bash
# awsconnection 확장 자동 설치/갱신 스크립트 (Termux 전용)
# 사용법: 확장 폴더(=이 스크립트가 있는 폴더)에서 그냥 실행
#   cd ~/SillyTavern/data/default-user/extensions/awsconnection
#   bash install-server-plugin-termux.sh
# 또는 SillyTavern 루트에서 실행해도 자동 감지함.

set -e

log()  { printf '\033[1;36m[aws-bridge]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aws-bridge]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[aws-bridge]\033[0m %s\n' "$*" >&2; }

# --------------------------------------------------------------------
# 1. 위치 자동 감지
# --------------------------------------------------------------------
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

EXT_DIR=""
ROOT_DIR=""

# 1-a. 스크립트가 확장 폴더 안에 있는 경우 (git clone 받은 뒤 여기서 실행)
if [ -d "$SCRIPT_DIR/server-plugin/aws-bedrock-bridge" ]; then
    EXT_DIR="$SCRIPT_DIR"
    # ~/SillyTavern/data/default-user/extensions/awsconnection → 4단계 위가 루트
    ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
fi

# 1-b. 현재 cwd 가 SillyTavern 루트인 경우
if [ -z "$EXT_DIR" ]; then
    for candidate in \
        "$PWD/data/default-user/extensions/awsconnection" \
        "$PWD/data/default-user/extensions/aws-connection"; do
        if [ -d "$candidate/server-plugin/aws-bedrock-bridge" ]; then
            EXT_DIR="$candidate"
            ROOT_DIR="$PWD"
            break
        fi
    done
fi

# 1-c. SILLYTAVERN_ROOT 환경변수 지정 시 사용
if [ -z "$EXT_DIR" ] && [ -n "$SILLYTAVERN_ROOT" ]; then
    for candidate in \
        "$SILLYTAVERN_ROOT/data/default-user/extensions/awsconnection" \
        "$SILLYTAVERN_ROOT/data/default-user/extensions/aws-connection"; do
        if [ -d "$candidate/server-plugin/aws-bedrock-bridge" ]; then
            EXT_DIR="$candidate"
            ROOT_DIR="$SILLYTAVERN_ROOT"
            break
        fi
    done
fi

if [ -z "$EXT_DIR" ] || [ -z "$ROOT_DIR" ]; then
    err "확장 폴더를 찾지 못했습니다."
    err "다음 중 하나를 만족해야 합니다:"
    err "  (1) 이 스크립트가 ~/SillyTavern/data/default-user/extensions/awsconnection/ 안에 있음"
    err "  (2) SillyTavern 루트(server.js가 있는 폴더)에서 실행"
    err "  (3) SILLYTAVERN_ROOT=/path/to/SillyTavern 환경변수 지정 후 실행"
    exit 1
fi

if [ ! -f "$ROOT_DIR/server.js" ] && [ ! -f "$ROOT_DIR/package.json" ]; then
    warn "SillyTavern 루트로 추정되는 '$ROOT_DIR' 에 server.js/package.json 이 없습니다."
    warn "경로가 맞는지 확인 후 Ctrl+C 로 중단하세요. 3초 뒤 계속 진행합니다."
    sleep 3
fi

log "확장 폴더: $EXT_DIR"
log "SillyTavern 루트: $ROOT_DIR"

# --------------------------------------------------------------------
# 2. node / npm 검증
# --------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    err "node 명령을 찾지 못했습니다. 'pkg install nodejs' 먼저 실행하세요."
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    err "npm 명령을 찾지 못했습니다. 'pkg install nodejs' 먼저 실행하세요."
    exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
    warn "Node.js 메이저 버전 $NODE_MAJOR 은(는) AWS SDK v3 요구사항(18+) 미만입니다."
fi

# --------------------------------------------------------------------
# 3. 서버 플러그인 동기화
# --------------------------------------------------------------------
SRC_PLUGIN="$EXT_DIR/server-plugin/aws-bedrock-bridge"
DEST_PLUGIN="$ROOT_DIR/plugins/aws-bedrock-bridge"

mkdir -p "$ROOT_DIR/plugins"

if [ -d "$DEST_PLUGIN/node_modules" ] && [ "${PRESERVE_NODE_MODULES:-0}" = "1" ]; then
    log "node_modules 보존 모드 (PRESERVE_NODE_MODULES=1)"
    TMP_NM="$(mktemp -d)"
    mv "$DEST_PLUGIN/node_modules" "$TMP_NM/"
    rm -rf "$DEST_PLUGIN"
    cp -r "$SRC_PLUGIN" "$DEST_PLUGIN"
    mv "$TMP_NM/node_modules" "$DEST_PLUGIN/"
    rmdir "$TMP_NM" 2>/dev/null || true
else
    rm -rf "$DEST_PLUGIN"
    cp -r "$SRC_PLUGIN" "$DEST_PLUGIN"
fi
log "플러그인 파일 복사 완료 → $DEST_PLUGIN"

# --------------------------------------------------------------------
# 4. npm install
# --------------------------------------------------------------------
(
    cd "$DEST_PLUGIN"
    log "의존성 설치 중 (npm install)..."
    npm install --no-audit --no-fund --loglevel=error
)
log "의존성 설치 완료"

# --------------------------------------------------------------------
# 5. config.yaml : enableServerPlugins: true 보장
# --------------------------------------------------------------------
CONFIG_YAML="$ROOT_DIR/config.yaml"
if [ -f "$CONFIG_YAML" ]; then
    if grep -qE '^enableServerPlugins:' "$CONFIG_YAML"; then
        if ! grep -qE '^enableServerPlugins:[[:space:]]*true' "$CONFIG_YAML"; then
            sed -i 's/^enableServerPlugins:.*/enableServerPlugins: true/' "$CONFIG_YAML"
            log "config.yaml: enableServerPlugins 를 true 로 변경"
        else
            log "config.yaml: enableServerPlugins=true 확인"
        fi
    else
        printf '\nenableServerPlugins: true\n' >> "$CONFIG_YAML"
        log "config.yaml: enableServerPlugins: true 추가"
    fi
else
    warn "config.yaml 이 없습니다. SillyTavern을 한 번 실행해 생성한 뒤 다시 돌려주세요."
fi

# --------------------------------------------------------------------
# 6. server-main.js CSRF 예외 패치
# --------------------------------------------------------------------
SERVER_MAIN="$ROOT_DIR/src/server-main.js"
if [ -f "$SERVER_MAIN" ]; then
    node - "$SERVER_MAIN" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let text = fs.readFileSync(file, 'utf8');
const oldLine = "            if (/^\\/api\\/plugins\\/aws-bedrock-bridge\\//.test(req.path)) {";
const newLine = "            if (/^\\/api\\/plugins\\/aws-bedrock-bridge(?:\\/|$)/.test(req.path)) {";

if (text.includes(newLine)) {
  console.log('  - CSRF 예외 패치 이미 적용됨');
  process.exit(0);
}
if (text.includes(oldLine)) {
  text = text.replace(oldLine, newLine);
  fs.writeFileSync(file, text, 'utf8');
  console.log('  - CSRF 예외 패치 갱신');
  process.exit(0);
}
const marker = "        skipCsrfProtection: (req) => {\n";
if (!text.includes(marker)) {
  console.log('  - skipCsrfProtection 블록을 찾지 못해 CSRF 패치를 건너뜁니다 (버전 확인 필요)');
  process.exit(0);
}
text = text.replace(
  marker,
  marker + "            if (/^\\/api\\/plugins\\/aws-bedrock-bridge(?:\\/|$)/.test(req.path)) {\n                return true;\n            }\n\n",
);
fs.writeFileSync(file, text, 'utf8');
console.log('  - CSRF 예외 패치 추가');
NODE
else
    warn "src/server-main.js 없음 — CSRF 패치를 건너뜁니다."
fi

# --------------------------------------------------------------------
# 7. 마무리
# --------------------------------------------------------------------
PLUGIN_LINES="$(wc -l < "$DEST_PLUGIN/index.js" 2>/dev/null || echo 0)"
log "설치된 플러그인 index.js 라인 수: $PLUGIN_LINES (1500 이상이면 최신)"
log ""
log "==========================================="
log "설치/갱신 완료. SillyTavern 을 재시작하세요."
log "==========================================="
log "  1) 실행 중이면 종료:  pkill -f 'node.*server.js'   (또는 Ctrl+C)"
log "  2) 재시작:            cd '$ROOT_DIR' && ./start.sh"
log "  3) 브라우저 강제 새로고침 (Ctrl+Shift+R / 모바일은 탭 닫고 다시 열기)"
log "  4) 확장 UI에서 Caching/Batch 설정 후 '적용' 클릭"
log "  5) 검증:              cat '$ROOT_DIR/data/default-user/aws-bedrock-bridge.json'"
log "     → 'cachingMode' 필드가 보이면 성공"
