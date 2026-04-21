# AWS Bedrock Connection

이 확장은 SillyTavern 내부 서버 플러그인 `aws-bedrock-bridge`를 이용해 AWS Bedrock 모델을 OpenAI Custom provider로 연결합니다.

## 기능

- AWS Access Key / Secret Key / Session Token 저장
- Bedrock 모델 목록 조회
- inference profile ID/ARN 저장과 실제 호출 대상 override
- 선택한 모델을 SillyTavern의 OpenAI Custom provider 설정에 자동 적용
- Bedrock 연결 ON/OFF
- Claude 4.6 adaptive thinking effort 설정 (`max`, `high`, `medium`, `low`)
- Bedrock service tier 설정 (`reserved`, `priority`, `default`, `flex`)
- 마지막 검증 요청에서 thinking 흔적과 resolved service tier 확인
- 외부 Docker, 별도 프록시 프로그램 없이 SillyTavern 내부에서 사용

## 요구 사항

- `config.yaml`에서 `enableServerPlugins: true`
- SillyTavern 재시작
- `plugins/aws-bedrock-bridge` 의존성 설치

## 사용 순서

1. SillyTavern을 재시작합니다.
2. 확장 설정에서 AWS Bedrock 자격 증명과 Region을 저장합니다.
3. 모델 목록을 불러옵니다.
4. 원하는 모델을 선택합니다.
5. 필요하면 연결 활성화, adaptive thinking effort, service tier를 설정합니다.
6. Claude Opus 4.6처럼 on-demand 호출이 막힌 모델이면 inference profile ID/ARN도 입력합니다.
7. `저장` 버튼으로 반영합니다.
8. `SillyTavern에 적용` 버튼을 누릅니다.
9. 필요하면 `연결 확인` 버튼으로 Custom provider 상태를 갱신합니다.
10. `적용 상태 확인`을 누르면 마지막 Bedrock 검증 요청의 reasoning 흔적, 응답 service tier, 실제 호출 대상을 볼 수 있습니다.

## 참고

- adaptive thinking은 현재 AWS 문서 기준으로 Claude Opus 4.6 / Claude Sonnet 4.6에서만 전송합니다.
- `max` effort는 Claude Opus 4.6에서만 전송합니다.
- adaptive thinking은 soft guidance라서 `medium` 또는 `low`에서는 reasoning이 생략될 수 있습니다.
- 일부 모델은 on-demand model ID로 직접 호출되지 않으며 inference profile ID 또는 ARN이 필요합니다.