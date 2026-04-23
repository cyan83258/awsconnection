import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { chat_completion_sources, oai_settings } from '../../../openai.js';

const extensionName = 'aws-connection';
const pluginBasePath = '/api/plugins/aws-bedrock-bridge';

function getExtensionFolderPath() {
    try {
        return new URL('.', import.meta.url).href.replace(/\/$/, '');
    } catch {
        return `scripts/extensions/third-party/${extensionName}`;
    }
}

const extensionFolderPath = getExtensionFolderPath();

const defaultSettings = {
    enabled: true,
    region: 'us-east-1',
    selectedModel: '',
    inferenceProfileId: '',
    thinkingEffort: 'high',
    serviceTier: 'default',
    costSaverEnabled: false,
    costSaverMaxTokens: 512,
    cachingMode: 'off',
    batchEnabled: false,
    batchInputS3Uri: '',
    batchOutputS3Uri: '',
    batchRoleArn: '',
    batchKmsKeyId: '',
};
let inspectionPollTimer = null;
let inspectionRefreshInFlight = false;
let lastRenderedInvocationAt = '';

const fallbackModels = [
    'anthropic.claude-3-5-haiku-20241022-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3-7-sonnet-20250219-v1:0',
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'anthropic.claude-sonnet-4-6-v1',
    'anthropic.claude-opus-4-20250514-v1:0',
    'anthropic.claude-opus-4-6-v1',
].map(id => ({
    id,
    object: 'model',
    bedrock: {
        provider: 'Anthropic',
        fallback: true,
    },
}));

let extensionSettings = extension_settings[extensionName];
if (!extensionSettings) {
    extensionSettings = {};
    extension_settings[extensionName] = extensionSettings;
}

function loadSettings() {
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.prototype.hasOwnProperty.call(extensionSettings, key)) {
            extensionSettings[key] = value;
        }
    }

    // Backward compat: migrate old cachingEnabled boolean to cachingMode.
    if (Object.prototype.hasOwnProperty.call(extensionSettings, 'cachingEnabled') && !['5m', '1h'].includes(extensionSettings.cachingMode)) {
        extensionSettings.cachingMode = extensionSettings.cachingEnabled ? '5m' : 'off';
    }

    $('#aws_bedrock_enabled').prop('checked', extensionSettings.enabled !== false);
    $('#aws_bedrock_region').val(extensionSettings.region || defaultSettings.region);
    $('#aws_bedrock_inference_profile_id').val(extensionSettings.inferenceProfileId || defaultSettings.inferenceProfileId);
    $('#aws_bedrock_thinking_effort').val(extensionSettings.thinkingEffort || defaultSettings.thinkingEffort);
    $('#aws_bedrock_service_tier').val(extensionSettings.serviceTier || defaultSettings.serviceTier);
    $('#aws_bedrock_cost_saver_enabled').prop('checked', extensionSettings.costSaverEnabled === true);
    $('#aws_bedrock_cost_saver_max_tokens').val(extensionSettings.costSaverMaxTokens || defaultSettings.costSaverMaxTokens);
    $('#aws_bedrock_caching_mode').val(extensionSettings.cachingMode || defaultSettings.cachingMode);
    $('#aws_bedrock_batch_enabled').prop('checked', extensionSettings.batchEnabled === true);
    $('#aws_bedrock_batch_input_s3_uri').val(extensionSettings.batchInputS3Uri || defaultSettings.batchInputS3Uri);
    $('#aws_bedrock_batch_output_s3_uri').val(extensionSettings.batchOutputS3Uri || defaultSettings.batchOutputS3Uri);
    $('#aws_bedrock_batch_role_arn').val(extensionSettings.batchRoleArn || defaultSettings.batchRoleArn);
    $('#aws_bedrock_batch_kms_key_id').val(extensionSettings.batchKmsKeyId || defaultSettings.batchKmsKeyId);
    $('#aws_bedrock_endpoint').val(getBridgeUrl());
}

function saveExtensionSettings() {
    extensionSettings.enabled = $('#aws_bedrock_enabled').is(':checked');
    extensionSettings.region = String($('#aws_bedrock_region').val() || defaultSettings.region).trim() || defaultSettings.region;
    extensionSettings.selectedModel = String($('#aws_bedrock_model').val() || '').trim();
    extensionSettings.inferenceProfileId = String($('#aws_bedrock_inference_profile_id').val() || '').trim();
    extensionSettings.thinkingEffort = String($('#aws_bedrock_thinking_effort').val() || defaultSettings.thinkingEffort).trim() || defaultSettings.thinkingEffort;
    extensionSettings.serviceTier = String($('#aws_bedrock_service_tier').val() || defaultSettings.serviceTier).trim() || defaultSettings.serviceTier;
    extensionSettings.costSaverEnabled = $('#aws_bedrock_cost_saver_enabled').is(':checked');
    extensionSettings.costSaverMaxTokens = Math.max(32, Number.parseInt(String($('#aws_bedrock_cost_saver_max_tokens').val() || defaultSettings.costSaverMaxTokens), 10) || defaultSettings.costSaverMaxTokens);
    {
        const mode = String($('#aws_bedrock_caching_mode').val() || '').trim().toLowerCase();
        extensionSettings.cachingMode = ['off', '5m', '1h'].includes(mode) ? mode : defaultSettings.cachingMode;
    }
    extensionSettings.batchEnabled = $('#aws_bedrock_batch_enabled').is(':checked');
    extensionSettings.batchInputS3Uri = String($('#aws_bedrock_batch_input_s3_uri').val() || '').trim();
    extensionSettings.batchOutputS3Uri = String($('#aws_bedrock_batch_output_s3_uri').val() || '').trim();
    extensionSettings.batchRoleArn = String($('#aws_bedrock_batch_role_arn').val() || '').trim();
    extensionSettings.batchKmsKeyId = String($('#aws_bedrock_batch_kms_key_id').val() || '').trim();
    saveSettingsDebounced();
}

function inferModelFromInferenceProfile(profileId) {
    const profile = String(profileId || '').trim().toLowerCase();
    if (!profile) {
        return '';
    }

    if (profile.includes('claude-opus-4-6-v1')) {
        return 'anthropic.claude-opus-4-6-v1';
    }

    if (profile.includes('claude-sonnet-4-6-v1')) {
        return 'anthropic.claude-sonnet-4-6-v1';
    }

    return '';
}

async function syncPluginConfig() {
    saveExtensionSettings();

    return await fetchPlugin('/config', {
        method: 'POST',
        body: {
            enabled: extensionSettings.enabled,
            region: extensionSettings.region,
            selectedModel: extensionSettings.selectedModel,
            inferenceProfileId: extensionSettings.inferenceProfileId,
            thinkingEffort: extensionSettings.thinkingEffort,
            serviceTier: extensionSettings.serviceTier,
            costSaverEnabled: extensionSettings.costSaverEnabled,
            costSaverMaxTokens: extensionSettings.costSaverMaxTokens,
            cachingMode: extensionSettings.cachingMode,
            batchEnabled: extensionSettings.batchEnabled,
            batchInputS3Uri: extensionSettings.batchInputS3Uri,
            batchOutputS3Uri: extensionSettings.batchOutputS3Uri,
            batchRoleArn: extensionSettings.batchRoleArn,
            batchKmsKeyId: extensionSettings.batchKmsKeyId,
        },
    });
}

function getBridgeUrl() {
    return `${window.location.origin}${pluginBasePath}/v1`;
}

function setStatus(message, isError = false) {
    const status = $('#aws_bedrock_status');
    status.text(message);
    status.toggleClass('error', isError);
}

function setPluginNotice(message, isError = false) {
    const notice = $('#aws_bedrock_plugin_notice');
    if (!notice.length) {
        return;
    }

    const defaultMessage = '이 저장소에는 서버 플러그인 번들도 포함되어 있습니다. 데스크톱에서는 install-server-plugin.ps1로 설치하고, 모바일 GitHub 설치는 프런트 확장만 자동 설치됩니다.';
    notice.text(message || defaultMessage);
    notice.toggleClass('error', isError);
}

function isPluginUnavailableError(error) {
    const message = String(error?.message || '').toLowerCase();
    return error?.status === 404
        || message.includes('cannot get /api/plugins/aws-bedrock-bridge')
        || message.includes('plugin')
        || message.includes('not found');
}

function renderCredentialState(config) {
    const credentialState = config?.credentialState || {};
    const notes = [];

    const accessKeyPlaceholder = credentialState.accessKeyId || 'AKIA...';
    const secretKeyPlaceholder = credentialState.secretAccessKey || 'AWS Secret Access Key';
    const sessionTokenPlaceholder = credentialState.sessionToken || '임시 자격 증명일 때만 입력';

    $('#aws_bedrock_access_key_id').attr('placeholder', accessKeyPlaceholder);
    $('#aws_bedrock_secret_access_key').attr('placeholder', secretKeyPlaceholder);
    $('#aws_bedrock_session_token').attr('placeholder', sessionTokenPlaceholder);

    if (config?.hasAccessKeyId) {
        notes.push(`Access Key 저장됨 (${credentialState.accessKeyId || '마스킹됨'})`);
    } else {
        notes.push('Access Key 미저장');
    }

    if (config?.hasSecretAccessKey) {
        notes.push(`Secret Key 저장됨 (${credentialState.secretAccessKey || '마스킹됨'})`);
    } else {
        notes.push('Secret Key 미저장');
    }

    if (config?.hasSessionToken) {
        notes.push(`Session Token 저장됨 (${credentialState.sessionToken || '마스킹됨'})`);
    } else {
        notes.push('Session Token 없음');
    }

    $('#aws_bedrock_credentials_state').text(notes.join(' | '));
}

function formatDateTime(value) {
    if (!value) {
        return '-';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString();
}

function renderInspection(payload) {
    const config = payload?.config || {};
    const lastInvocation = payload?.lastInvocation || null;
    const appliedThinking = lastInvocation?.applied?.thinking;
    const appliedServiceTier = lastInvocation?.response?.serviceTier || lastInvocation?.applied?.serviceTier?.type || null;
    const requestedServiceTier = lastInvocation?.applied?.serviceTier?.type || config.serviceTier || defaultSettings.serviceTier;
    const appliedCostSaver = lastInvocation?.applied?.costSaver;
    const reasoningDetected = lastInvocation?.response?.reasoningDetected;
    const reasoningBlockCount = lastInvocation?.response?.reasoningBlockCount || 0;
    const reasoningSignatureDetected = lastInvocation?.response?.reasoningSignatureDetected;
    const reasoningPreview = lastInvocation?.response?.reasoningPreview || '';
    const usage = lastInvocation?.response?.usage || null;
    const costEstimate = lastInvocation?.response?.costEstimate || null;
    const noteParts = [];
    const invocationAt = String(lastInvocation?.requestedAt || '');

    $('#aws_bedrock_inspect_enabled').text(config.enabled === false ? 'OFF' : 'ON');
    $('#aws_bedrock_inspect_thinking').text(config.thinkingEffort || defaultSettings.thinkingEffort);
    $('#aws_bedrock_inspect_service_tier').text(config.serviceTier || defaultSettings.serviceTier);
    $('#aws_bedrock_inspect_cost_saver').text(config.costSaverEnabled ? `ON (${config.costSaverMaxTokens || defaultSettings.costSaverMaxTokens})` : 'OFF');
    {
        const serverCachingMode = typeof config.cachingMode === 'string' && ['off', '5m', '1h'].includes(config.cachingMode) ? config.cachingMode : (config.cachingEnabled ? '5m' : 'off');
        $('#aws_bedrock_inspect_caching').text(serverCachingMode === 'off' ? 'OFF' : `ON (${serverCachingMode})`);
    }
    $('#aws_bedrock_inspect_batch').text(config.batchEnabled ? 'ON' : 'OFF');
    $('#aws_bedrock_inspect_time').text(formatDateTime(lastInvocation?.requestedAt));
    $('#aws_bedrock_inspect_model').text(lastInvocation?.modelId || config.selectedModel || '-');

    if (appliedThinking?.sent) {
        $('#aws_bedrock_inspect_thinking_applied').text(`adaptive:${appliedThinking.effort || config.thinkingEffort || defaultSettings.thinkingEffort}`);
    } else {
        $('#aws_bedrock_inspect_thinking_applied').text(appliedThinking?.reason || '전송 기록 없음');
    }

    $('#aws_bedrock_inspect_service_tier_applied').text(appliedServiceTier ? `요청 ${requestedServiceTier} / 응답 ${appliedServiceTier}` : `요청 ${requestedServiceTier} / 응답 미확인`);
    $('#aws_bedrock_inspect_cost_saver_applied').text(appliedCostSaver?.sent ? `max ${appliedCostSaver.maxTokens || config.costSaverMaxTokens || defaultSettings.costSaverMaxTokens}` : (appliedCostSaver?.reason || 'OFF'));
    $('#aws_bedrock_inspect_caching_applied').text(lastInvocation?.applied?.caching?.sent ? `checkpoint ${lastInvocation.applied.caching.checkpointCount || 0}개 (${lastInvocation.applied.caching.ttl || '5m'})` : (lastInvocation?.applied?.caching?.reason || '전송 기록 없음'));
    $('#aws_bedrock_inspect_batch_applied').text(lastInvocation?.applied?.batch?.sent ? (lastInvocation.applied.batch.jobArn || 'job 제출됨') : (lastInvocation?.applied?.batch?.reason || 'OFF'));
    $('#aws_bedrock_inspect_usage').text(usage ? `in ${usage.prompt_tokens || 0} / out ${usage.completion_tokens || 0}` : '-');
    $('#aws_bedrock_inspect_cost_estimate').text(costEstimate?.display || '가격표 미설정 또는 사용량 없음');
    $('#aws_bedrock_inspect_reasoning').text(reasoningDetected ? `감지됨 (${reasoningBlockCount}개)` : '감지 안 됨');
    $('#aws_bedrock_inspect_reasoning_signature').text(reasoningDetected ? (reasoningSignatureDetected ? '있음' : '없음') : '-');
    $('#aws_bedrock_inspect_reasoning_preview').text(reasoningPreview || 'adaptive thinking은 effort가 낮거나 질문이 단순하면 reasoning을 생략할 수 있습니다.');

    if (config.configured === false) {
        noteParts.push('AWS 자격 증명이 아직 저장되지 않았습니다.');
    }

    if (lastInvocation?.source) {
        noteParts.push(`마지막 요청 종류: ${lastInvocation.source}`);
    }

    if (lastInvocation?.invocationModelId && lastInvocation.invocationModelId !== lastInvocation.modelId) {
        noteParts.push(`실제 호출 대상: ${lastInvocation.invocationModelId}`);
    } else if (config.inferenceProfileId) {
        noteParts.push(`저장된 inference profile: ${config.inferenceProfileId}`);
    }

    if (appliedThinking?.reason) {
        noteParts.push(appliedThinking.reason);
    }

    if (appliedThinking?.sent) {
        noteParts.push(`thinking.type=adaptive, effort=${appliedThinking.effort}`);
        noteParts.push('일반 채팅 응답은 OpenAI 호환 형식으로 변환되므로 reasoning 본문은 채팅창에 직접 표시되지 않습니다. 적용 상태 확인에서만 raw reasoning 흔적을 볼 수 있습니다.');
    }

    if (requestedServiceTier) {
        noteParts.push(`service tier 요청값: ${requestedServiceTier}`);
    }

    if (appliedCostSaver?.sent) {
        noteParts.push(`cost saver max tokens: ${appliedCostSaver.maxTokens}`);
    } else if (appliedCostSaver?.reason) {
        noteParts.push(appliedCostSaver.reason);
    }

    if (lastInvocation?.applied?.caching?.sent) {
        noteParts.push(`caching checkpoint: ${lastInvocation.applied.caching.checkpointCount || 0}개`);
    } else if (lastInvocation?.applied?.caching?.reason) {
        noteParts.push(lastInvocation.applied.caching.reason);
    }

    if (lastInvocation?.applied?.batch?.sent) {
        noteParts.push(`batch job: ${lastInvocation.applied.batch.jobArn || 'submitted'}`);
    } else if (lastInvocation?.applied?.batch?.reason) {
        noteParts.push(lastInvocation.applied.batch.reason);
    }

    if (appliedServiceTier) {
        noteParts.push(`service tier 응답값: ${appliedServiceTier}`);
    } else if (requestedServiceTier) {
        noteParts.push('이번 응답에는 resolved service tier가 포함되지 않아 요청값만 확인했습니다. 속도만으로 flex 여부를 판단하면 안 됩니다.');
    }

    if (lastInvocation?.response?.reasoningRedacted) {
        noteParts.push('reasoning 일부가 provider에 의해 redacted 되었습니다.');
    }

    if (lastInvocation?.response?.performanceLatency) {
        noteParts.push(`응답 latency profile: ${lastInvocation.response.performanceLatency}`);
    }

    if (lastInvocation?.response?.stopReason) {
        noteParts.push(`stop reason: ${lastInvocation.response.stopReason}`);
    }

    if (lastInvocation?.response?.textPreview) {
        noteParts.push(`미리보기: ${lastInvocation.response.textPreview}`);
    }

    if (costEstimate?.display) {
        noteParts.push(`예상 비용: ${costEstimate.display}`);
    }

    if (costEstimate?.note) {
        noteParts.push(costEstimate.note);
    }

    if (Array.isArray(lastInvocation?.applied?.requestAdjustments) && lastInvocation.applied.requestAdjustments.length > 0) {
        noteParts.push(...lastInvocation.applied.requestAdjustments);
    }

    $('#aws_bedrock_inspect_note').text(noteParts.length > 0 ? noteParts.join(' | ') : '아직 검사 기록이 없습니다.');

    if (invocationAt && invocationAt !== lastRenderedInvocationAt) {
        lastRenderedInvocationAt = invocationAt;
        if (costEstimate?.display) {
            setStatus(`마지막 응답 예상 비용: ${costEstimate.display}`);
        }
    }
}

async function refreshInspectionSilently() {
    if (inspectionRefreshInFlight) {
        return;
    }

    inspectionRefreshInFlight = true;
    try {
        await refreshInspection(false);
    } catch {
        // Ignore polling failures; explicit actions already surface errors.
    } finally {
        inspectionRefreshInFlight = false;
    }
}

function startInspectionPolling() {
    if (inspectionPollTimer !== null) {
        window.clearInterval(inspectionPollTimer);
    }

    inspectionPollTimer = window.setInterval(refreshInspectionSilently, 15000);
}

async function fetchPlugin(path, options = {}) {
    const hasBody = options.body !== undefined;
    const response = await fetch(`${pluginBasePath}${path}`, {
        method: options.method || 'GET',
        headers: {
            ...getRequestHeaders(),
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
        body: hasBody ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
        let message = `요청 실패 (${response.status})`;
        const responseText = await response.text();

        if (responseText) {
            try {
                const payload = JSON.parse(responseText);
                message = payload?.error?.message || payload?.message || responseText || message;
            } catch {
                message = responseText;
            }
        }

        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    if (response.status === 204) {
        return null;
    }

    const responseText = await response.text();
    if (!responseText) {
        return null;
    }

    try {
        return JSON.parse(responseText);
    } catch {
        throw new Error('플러그인 응답을 해석하지 못했습니다.');
    }
}

async function loadConfig() {
    try {
        const config = await fetchPlugin('/config');
        extensionSettings.enabled = config.enabled !== false;
        extensionSettings.region = config.region || extensionSettings.region || defaultSettings.region;
        extensionSettings.selectedModel = config.selectedModel || extensionSettings.selectedModel || inferModelFromInferenceProfile(config.inferenceProfileId);
        extensionSettings.inferenceProfileId = config.inferenceProfileId || extensionSettings.inferenceProfileId || defaultSettings.inferenceProfileId;
        extensionSettings.thinkingEffort = config.thinkingEffort || extensionSettings.thinkingEffort || defaultSettings.thinkingEffort;
        extensionSettings.serviceTier = config.serviceTier || extensionSettings.serviceTier || defaultSettings.serviceTier;
        extensionSettings.costSaverEnabled = config.costSaverEnabled === true;
        extensionSettings.costSaverMaxTokens = Number(config.costSaverMaxTokens) || extensionSettings.costSaverMaxTokens || defaultSettings.costSaverMaxTokens;
        {
            const serverMode = typeof config.cachingMode === 'string' ? config.cachingMode.trim().toLowerCase() : '';
            if (['off', '5m', '1h'].includes(serverMode)) {
                extensionSettings.cachingMode = serverMode;
            } else if (typeof config.cachingEnabled === 'boolean') {
                extensionSettings.cachingMode = config.cachingEnabled ? '5m' : 'off';
            } else if (!extensionSettings.cachingMode) {
                extensionSettings.cachingMode = defaultSettings.cachingMode;
            }
        }
        extensionSettings.batchEnabled = config.batchEnabled === true;
        extensionSettings.batchInputS3Uri = config.batchInputS3Uri || extensionSettings.batchInputS3Uri || defaultSettings.batchInputS3Uri;
        extensionSettings.batchOutputS3Uri = config.batchOutputS3Uri || extensionSettings.batchOutputS3Uri || defaultSettings.batchOutputS3Uri;
        extensionSettings.batchRoleArn = config.batchRoleArn || extensionSettings.batchRoleArn || defaultSettings.batchRoleArn;
        extensionSettings.batchKmsKeyId = config.batchKmsKeyId || extensionSettings.batchKmsKeyId || defaultSettings.batchKmsKeyId;
        $('#aws_bedrock_region').val(extensionSettings.region);
        $('#aws_bedrock_enabled').prop('checked', extensionSettings.enabled);
        $('#aws_bedrock_inference_profile_id').val(extensionSettings.inferenceProfileId);
        $('#aws_bedrock_thinking_effort').val(extensionSettings.thinkingEffort);
        $('#aws_bedrock_service_tier').val(extensionSettings.serviceTier);
        $('#aws_bedrock_cost_saver_enabled').prop('checked', extensionSettings.costSaverEnabled);
        $('#aws_bedrock_cost_saver_max_tokens').val(extensionSettings.costSaverMaxTokens);
        $('#aws_bedrock_caching_mode').val(extensionSettings.cachingMode);
        $('#aws_bedrock_batch_enabled').prop('checked', extensionSettings.batchEnabled);
        $('#aws_bedrock_batch_input_s3_uri').val(extensionSettings.batchInputS3Uri);
        $('#aws_bedrock_batch_output_s3_uri').val(extensionSettings.batchOutputS3Uri);
        $('#aws_bedrock_batch_role_arn').val(extensionSettings.batchRoleArn);
        $('#aws_bedrock_batch_kms_key_id').val(extensionSettings.batchKmsKeyId);
        renderCredentialState(config);
        populateFallbackModels();
        saveSettingsDebounced();
        $('#aws_bedrock_endpoint').val(getBridgeUrl());
        renderInspection({ config });
        await refreshInspection(false);
        setPluginNotice();
        setStatus(config.configured ? 'AWS 자격 증명이 저장되어 있습니다.' : 'AWS 자격 증명을 저장하세요.');
    } catch (error) {
        populateFallbackModels('플러그인에 연결하지 못해 내장 모델 목록으로 초기화했습니다.');
        if (isPluginUnavailableError(error)) {
            setPluginNotice('서버 플러그인이 아직 설치되지 않았습니다. 이 저장소의 server-plugin/aws-bedrock-bridge 폴더를 SillyTavern/plugins/aws-bedrock-bridge로 복사한 뒤 npm install을 실행하세요. Windows는 install-server-plugin.ps1를 바로 실행하면 됩니다.', true);
        } else {
            setPluginNotice();
        }
        setStatus(`플러그인에 연결할 수 없습니다: ${error.message}`, true);
    }
}

async function refreshInspection(showStatus = true) {
    const payload = await fetchPlugin('/inspect');
    renderInspection(payload);

    if (showStatus) {
        setStatus('적용 상태를 새로고침했습니다.');
    }

    return payload;
}

function populateModelSelect(models, selectedModel) {
    const select = $('#aws_bedrock_model');
    select.empty();

    if (!Array.isArray(models) || models.length === 0) {
        select.append('<option value="">사용 가능한 모델이 없습니다</option>');
        return;
    }

    for (const model of models) {
        const provider = model.bedrock?.provider ? `[${model.bedrock.provider}] ` : '';
        select.append($('<option>', {
            value: model.id,
            text: `${provider}${model.id}`,
        }));
    }

    const finalModel = selectedModel || extensionSettings.selectedModel || models[0].id;
    select.val(finalModel);
    extensionSettings.selectedModel = String(select.val() || '');
    saveSettingsDebounced();
}

function populateFallbackModels(statusMessage = null) {
    const inferredModel = inferModelFromInferenceProfile(extensionSettings.inferenceProfileId);
    if (!extensionSettings.selectedModel && inferredModel) {
        extensionSettings.selectedModel = inferredModel;
    }

    populateModelSelect(fallbackModels, extensionSettings.selectedModel || inferredModel);

    if (statusMessage) {
        setStatus(statusMessage);
    }
}

async function saveCredentials() {
    try {
        saveExtensionSettings();
        const payload = {
            enabled: extensionSettings.enabled,
            region: extensionSettings.region,
            selectedModel: extensionSettings.selectedModel,
            inferenceProfileId: extensionSettings.inferenceProfileId,
            thinkingEffort: extensionSettings.thinkingEffort,
            serviceTier: extensionSettings.serviceTier,
            costSaverEnabled: extensionSettings.costSaverEnabled,
            costSaverMaxTokens: extensionSettings.costSaverMaxTokens,
            cachingMode: extensionSettings.cachingMode,
            batchEnabled: extensionSettings.batchEnabled,
            batchInputS3Uri: extensionSettings.batchInputS3Uri,
            batchOutputS3Uri: extensionSettings.batchOutputS3Uri,
            batchRoleArn: extensionSettings.batchRoleArn,
            batchKmsKeyId: extensionSettings.batchKmsKeyId,
        };

        const accessKeyId = String($('#aws_bedrock_access_key_id').val() || '').trim();
        const secretAccessKey = String($('#aws_bedrock_secret_access_key').val() || '').trim();
        const sessionToken = String($('#aws_bedrock_session_token').val() || '').trim();

        if (accessKeyId) {
            payload.accessKeyId = accessKeyId;
        }

        if (secretAccessKey) {
            payload.secretAccessKey = secretAccessKey;
        }

        if (sessionToken) {
            payload.sessionToken = sessionToken;
        } else {
            payload.sessionToken = '';
            payload.clearSessionToken = true;
        }

        const config = await fetchPlugin('/config', { method: 'POST', body: payload });

        $('#aws_bedrock_access_key_id').val('');
        $('#aws_bedrock_secret_access_key').val('');
        $('#aws_bedrock_session_token').val('');
        renderCredentialState(config);
        renderInspection({ config });
        await refreshInspection(false);
        const tokenMessage = config.hasSessionToken ? 'Session Token도 함께 저장했습니다.' : 'Session Token은 비워 둔 상태로 저장했습니다.';
        const batchMessage = extensionSettings.batchEnabled ? ' Batch inference를 켠 경우 SillyTavern 요청은 stream=false여야 합니다.' : '';
        const saverMessage = extensionSettings.costSaverEnabled ? ` Cost Saver는 최대 ${extensionSettings.costSaverMaxTokens} 토큰으로 제한합니다.` : '';
        setStatus(extensionSettings.inferenceProfileId ? `AWS 자격 증명과 Bedrock 옵션을 저장했습니다. ${tokenMessage} inference profile이 실제 호출에 사용됩니다.${batchMessage}${saverMessage}` : `AWS 자격 증명과 Bedrock 옵션을 저장했습니다. ${tokenMessage}${batchMessage}${saverMessage}`);
    } catch (error) {
        setStatus(`저장 실패: ${error.message}`, true);
    }
}

async function clearCredentials() {
    try {
        saveExtensionSettings();
        const config = await fetchPlugin('/config', {
            method: 'POST',
            body: {
                enabled: extensionSettings.enabled,
                region: extensionSettings.region,
                selectedModel: extensionSettings.selectedModel,
                inferenceProfileId: extensionSettings.inferenceProfileId,
                thinkingEffort: extensionSettings.thinkingEffort,
                serviceTier: extensionSettings.serviceTier,
                costSaverEnabled: extensionSettings.costSaverEnabled,
                costSaverMaxTokens: extensionSettings.costSaverMaxTokens,
                cachingMode: extensionSettings.cachingMode,
                batchEnabled: extensionSettings.batchEnabled,
                batchInputS3Uri: extensionSettings.batchInputS3Uri,
                batchOutputS3Uri: extensionSettings.batchOutputS3Uri,
                batchRoleArn: extensionSettings.batchRoleArn,
                batchKmsKeyId: extensionSettings.batchKmsKeyId,
                clearCredentials: true,
            },
        });

        $('#aws_bedrock_access_key_id').val('');
        $('#aws_bedrock_secret_access_key').val('');
        $('#aws_bedrock_session_token').val('');
        renderCredentialState(config);
        renderInspection({ config });
        await refreshInspection(false);
        setStatus('저장된 AWS 자격 증명을 삭제했습니다.');
    } catch (error) {
        setStatus(`자격 증명 삭제 실패: ${error.message}`, true);
    }
}

async function loadModels() {
    try {
        await syncPluginConfig();
        const region = encodeURIComponent(extensionSettings.region || defaultSettings.region);
        const payload = await fetchPlugin(`/models?region=${region}`);
        populateModelSelect(payload.data, payload.data?.find(model => model.id === extensionSettings.selectedModel)?.id || extensionSettings.selectedModel);
        if (payload.fallback) {
            setStatus(`${payload.data?.length || 0}개 모델을 불러왔습니다. ${payload.message || 'AWS 모델 조회 권한이 없어 내장 목록을 사용했습니다.'}`);
            return;
        }

        setStatus(`${payload.data?.length || 0}개 모델을 불러왔습니다.`);
    } catch (error) {
        populateFallbackModels(`모델 불러오기에 실패해 내장 목록으로 대체했습니다: ${error.message}`);
    }
}

function applyToSillyTavern() {
    saveExtensionSettings();

    const modelId = extensionSettings.selectedModel || String($('#aws_bedrock_model').val() || '').trim();
    if (!modelId) {
        setStatus('먼저 Bedrock 모델을 선택하세요.', true);
        return;
    }

    $('#main_api').val('openai').trigger('change');
    $('#chat_completion_source').val(chat_completion_sources.CUSTOM).trigger('change');

    oai_settings.chat_completion_source = chat_completion_sources.CUSTOM;
    oai_settings.custom_url = getBridgeUrl();
    oai_settings.custom_model = modelId;

    $('#custom_api_url_text').val(oai_settings.custom_url).trigger('input');
    $('#custom_model_id').val(modelId).trigger('input');

    const customSelect = $('#model_custom_select');
    if (customSelect.length) {
        if (customSelect.find(`option[value="${modelId.replace(/"/g, '\\"')}"]`).length === 0) {
            customSelect.append($('<option>', { value: modelId, text: modelId }));
        }
        customSelect.val(modelId).trigger('change');
    }

    saveSettingsDebounced();
    if (extensionSettings.enabled) {
        const saverMessage = extensionSettings.costSaverEnabled ? ` Cost Saver max ${extensionSettings.costSaverMaxTokens}.` : '';
        setStatus(extensionSettings.batchEnabled ? `OpenAI Custom provider에 Bedrock 브리지를 적용했습니다. Batch inference를 쓰려면 stream=false로 사용하세요.${saverMessage}` : `OpenAI Custom provider에 Bedrock 브리지를 적용했습니다.${saverMessage}`);
    } else {
        setStatus('연결은 OFF 상태로 저장되었고, ON으로 바꾸기 전까지 실제 호출은 차단됩니다.');
    }
}

async function applyToSillyTavernAndSync() {
    try {
        await syncPluginConfig();
        applyToSillyTavern();
        // Refresh the inspection panel so saved/applied states reflect the sync
        // immediately instead of waiting for the 15s poll.
        await refreshInspection(false);
    } catch (error) {
        setStatus(`Bedrock 설정 동기화 실패: ${error.message}`, true);
    }
}

async function saveBatchSettings() {
    try {
        saveExtensionSettings();
        const config = await fetchPlugin('/config', {
            method: 'POST',
            body: {
                enabled: extensionSettings.enabled,
                region: extensionSettings.region,
                selectedModel: extensionSettings.selectedModel,
                inferenceProfileId: extensionSettings.inferenceProfileId,
                thinkingEffort: extensionSettings.thinkingEffort,
                serviceTier: extensionSettings.serviceTier,
                costSaverEnabled: extensionSettings.costSaverEnabled,
                costSaverMaxTokens: extensionSettings.costSaverMaxTokens,
                cachingMode: extensionSettings.cachingMode,
                batchEnabled: extensionSettings.batchEnabled,
                batchInputS3Uri: extensionSettings.batchInputS3Uri,
                batchOutputS3Uri: extensionSettings.batchOutputS3Uri,
                batchRoleArn: extensionSettings.batchRoleArn,
                batchKmsKeyId: extensionSettings.batchKmsKeyId,
            },
        });
        renderInspection({ config });
        await refreshInspection(false);
        setStatus(`Batch 설정을 저장했습니다. input=${extensionSettings.batchInputS3Uri || '(비어있음)'}, output=${extensionSettings.batchOutputS3Uri || '(비어있음)'}, role=${extensionSettings.batchRoleArn || '(비어있음)'}`);
    } catch (error) {
        setStatus(`Batch 설정 저장 실패: ${error.message}`, true);
    }
}

async function connectOpenAiCustom() {
    saveExtensionSettings();
    if (!extensionSettings.enabled) {
        setStatus('연결이 OFF 상태입니다. 체크박스를 켜고 저장한 뒤 다시 시도하세요.', true);
        return;
    }

    try {
        await syncPluginConfig();
        applyToSillyTavern();
        $('#api_button_openai').trigger('click');
        setStatus('OpenAI Custom provider 연결 갱신을 요청했습니다.');
    } catch (error) {
        setStatus(`연결 동기화 실패: ${error.message}`, true);
    }
}

async function verifySettings() {
    try {
        await syncPluginConfig();

        const model = extensionSettings.selectedModel || String($('#aws_bedrock_model').val() || '').trim();
        if (!model) {
            setStatus('적용 상태 확인 전에 모델을 먼저 선택하세요.', true);
            return;
        }

        const payload = await fetchPlugin('/verify', {
            method: 'POST',
            body: { model },
        });

        renderInspection(payload);
        setStatus('Bedrock 설정 검사를 완료했습니다. 아래 패널에서 적용 결과를 확인하세요.');
    } catch (error) {
        setStatus(`적용 상태 확인 실패: ${error.message}`, true);
    }
}

function registerEventHandlers() {
    $(document).off('click', '#aws_bedrock_save').on('click', '#aws_bedrock_save', saveCredentials);
    $(document).off('click', '#aws_bedrock_clear_credentials').on('click', '#aws_bedrock_clear_credentials', clearCredentials);
    $(document).off('click', '#aws_bedrock_load_models').on('click', '#aws_bedrock_load_models', loadModels);
    $(document).off('click', '#aws_bedrock_apply').on('click', '#aws_bedrock_apply', applyToSillyTavernAndSync);
    $(document).off('click', '#aws_bedrock_connect').on('click', '#aws_bedrock_connect', connectOpenAiCustom);
    $(document).off('click', '#aws_bedrock_verify').on('click', '#aws_bedrock_verify', verifySettings);
    $(document).off('click', '#aws_bedrock_refresh_state').on('click', '#aws_bedrock_refresh_state', () => refreshInspection(true));
    $(document).off('click', '#aws_bedrock_save_batch').on('click', '#aws_bedrock_save_batch', saveBatchSettings);
    $(document).off('change input', '#aws_bedrock_enabled, #aws_bedrock_region, #aws_bedrock_model, #aws_bedrock_inference_profile_id, #aws_bedrock_thinking_effort, #aws_bedrock_service_tier, #aws_bedrock_cost_saver_enabled, #aws_bedrock_cost_saver_max_tokens, #aws_bedrock_caching_mode, #aws_bedrock_batch_enabled, #aws_bedrock_batch_input_s3_uri, #aws_bedrock_batch_output_s3_uri, #aws_bedrock_batch_role_arn, #aws_bedrock_batch_kms_key_id').on('change input', '#aws_bedrock_enabled, #aws_bedrock_region, #aws_bedrock_model, #aws_bedrock_inference_profile_id, #aws_bedrock_thinking_effort, #aws_bedrock_service_tier, #aws_bedrock_cost_saver_enabled, #aws_bedrock_cost_saver_max_tokens, #aws_bedrock_caching_mode, #aws_bedrock_batch_enabled, #aws_bedrock_batch_input_s3_uri, #aws_bedrock_batch_output_s3_uri, #aws_bedrock_batch_role_arn, #aws_bedrock_batch_kms_key_id', saveExtensionSettings);
}

function getSettingsContainer() {
    const mobileOrPrimaryContainer = $('#extensions_settings');
    if (mobileOrPrimaryContainer.length) {
        return mobileOrPrimaryContainer;
    }

    const secondaryContainer = $('#extensions_settings2');
    if (secondaryContainer.length) {
        return secondaryContainer;
    }

    return $();
}

jQuery(async () => {
    try {
        const timestamp = Date.now();
        const html = await $.get(`${extensionFolderPath}/index.html?v=${timestamp}`);
        const settingsContainer = getSettingsContainer();
        if (!settingsContainer.length) {
            throw new Error('확장 설정 컨테이너를 찾지 못했습니다.');
        }

        settingsContainer.append(html);

        const cssLink = $('<link>', {
            rel: 'stylesheet',
            type: 'text/css',
            href: `${extensionFolderPath}/style.css?v=${timestamp}`,
        });
        $('head').append(cssLink);

        loadSettings();
        registerEventHandlers();
        await loadConfig();
        startInspectionPolling();
    } catch (error) {
        console.error('AWS Bedrock Connection extension failed to initialize.', error);
    }
});