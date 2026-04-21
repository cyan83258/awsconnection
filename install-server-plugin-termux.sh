#!/data/data/com.termux/files/usr/bin/bash

set -e

ROOT_DIR="$(pwd)"
EXT_DIR=""

for candidate in "data/default-user/extensions/awsconnection" "data/default-user/extensions/aws-connection"; do
    if [ -d "$candidate/server-plugin/aws-bedrock-bridge" ]; then
        EXT_DIR="$candidate"
        break
    fi
done

if [ -z "$EXT_DIR" ]; then
    echo "aws-connection 확장 폴더를 찾지 못했습니다. 먼저 GitHub 확장 설치부터 확인하세요."
    exit 1
fi

echo "확장 폴더: $EXT_DIR"

mkdir -p plugins
rm -rf plugins/aws-bedrock-bridge
cp -r "$EXT_DIR/server-plugin/aws-bedrock-bridge" plugins/

cd plugins/aws-bedrock-bridge
npm install --omit=dev
cd "$ROOT_DIR"

if grep -q '^enableServerPlugins:' config.yaml 2>/dev/null; then
    sed -i 's/^enableServerPlugins:.*/enableServerPlugins: true/' config.yaml
else
    printf '\nenableServerPlugins: true\n' >> config.yaml
fi

node - src/server-main.js <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let text = fs.readFileSync(file, 'utf8');
const oldLine = "            if (/^\\/api\\/plugins\\/aws-bedrock-bridge\\//.test(req.path)) {";
const newLine = "            if (/^\\/api\\/plugins\\/aws-bedrock-bridge(?:\\/|$)/.test(req.path)) {";

if (text.includes(newLine)) {
  console.log('CSRF 예외 패치는 이미 적용되어 있습니다.');
  process.exit(0);
}

if (text.includes(oldLine)) {
  text = text.replace(oldLine, newLine);
  fs.writeFileSync(file, text, 'utf8');
  console.log('CSRF 예외 패치를 갱신했습니다.');
  process.exit(0);
}

const marker = "        skipCsrfProtection: (req) => {\n";
if (!text.includes(marker)) {
  console.error('skipCsrfProtection 블록을 찾지 못해 CSRF 예외 패치를 적용하지 못했습니다.');
  process.exit(1);
}

text = text.replace(
  marker,
  marker + "            if (/^\\/api\\/plugins\\/aws-bedrock-bridge(?:\\/|$)/.test(req.path)) {\n                return true;\n            }\n\n",
);

fs.writeFileSync(file, text, 'utf8');
console.log('CSRF 예외 패치를 추가했습니다.');
NODE

echo "설치 완료: plugins/aws-bedrock-bridge"
echo "설정 확인: enableServerPlugins=true"
echo "다음 단계: SillyTavern을 재시작하세요."