# aws-bedrock-bridge server plugin bundle

이 폴더는 AWS Bedrock Connection 확장과 함께 GitHub에 배포하기 위한 서버 플러그인 번들입니다.

설치 방법:

1. 이 폴더 전체를 `SillyTavern/plugins/aws-bedrock-bridge`로 복사합니다.
2. 대상 폴더에서 `npm install`을 실행합니다.
3. `config.yaml`에서 `enableServerPlugins: true`를 확인합니다.
4. SillyTavern을 재시작합니다.

Windows 데스크톱에서는 상위 폴더의 `install-server-plugin.ps1`를 실행하면 같은 작업을 자동으로 처리합니다.

추가 참고:

- Cost Saver 모드는 thinking을 비활성화하고 최대 출력 토큰을 cap 해서 응답당 비용을 더 줄입니다.
- Prompt caching은 현재 Converse 요청의 재사용 가능한 prefix에 cache checkpoint를 자동 삽입하는 방식으로 동작합니다.
- Batch inference를 켜면 이 플러그인은 비스트리밍 요청을 S3 JSONL로 업로드하고 Bedrock `CreateModelInvocationJob`으로 제출한 뒤, 완료될 때까지 기다려 결과를 다시 OpenAI 호환 응답으로 변환합니다.
- Batch inference를 사용하려면 S3 input/output prefix와 Bedrock batch service role ARN이 필요합니다.
- 일반 비스트리밍 응답에는 `bedrock_cost_estimate_usd`와 `bedrock_cost_estimate_display` 필드도 함께 넣어 대략적인 비용을 확인할 수 있습니다.