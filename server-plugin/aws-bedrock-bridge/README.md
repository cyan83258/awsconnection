# aws-bedrock-bridge server plugin bundle

이 폴더는 AWS Bedrock Connection 확장과 함께 GitHub에 배포하기 위한 서버 플러그인 번들입니다.

설치 방법:

1. 이 폴더 전체를 `SillyTavern/plugins/aws-bedrock-bridge`로 복사합니다.
2. 대상 폴더에서 `npm install`을 실행합니다.
3. `config.yaml`에서 `enableServerPlugins: true`를 확인합니다.
4. SillyTavern을 재시작합니다.

Windows 데스크톱에서는 상위 폴더의 `install-server-plugin.ps1`를 실행하면 같은 작업을 자동으로 처리합니다.