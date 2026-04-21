import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

import { SecretManager } from '../../src/endpoints/secrets.js';

export const info = {
    id: 'aws-bedrock-bridge',
    name: 'AWS Bedrock Bridge',
    description: 'OpenAI-compatible bridge for AWS Bedrock models.',
};

const CONFIG_FILE = 'aws-bedrock-bridge.json';
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_CONFIG = {
    enabled: true,
    region: DEFAULT_REGION,
    selectedModel: '',
    inferenceProfileId: '',
    thinkingEffort: 'high',
    serviceTier: 'default',
};
const SECRET_KEYS = {
    accessKeyId: 'aws_bedrock_access_key_id',
    secretAccessKey: 'aws_bedrock_secret_access_key',
    sessionToken: 'aws_bedrock_session_token',
};
const THINKING_EFFORTS = new Set(['max', 'high', 'medium', 'low']);
const SERVICE_TIER_TYPES = new Set(['reserved', 'priority', 'default', 'flex']);
const lastInvocationState = new Map();
const FALLBACK_MODEL_IDS = [
    'anthropic.claude-3-5-haiku-20241022-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3-7-sonnet-20250219-v1:0',
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'anthropic.claude-sonnet-4-6-v1',
    'anthropic.claude-opus-4-20250514-v1:0',
    'anthropic.claude-opus-4-6-v1',
];

function getConfigPath(directories) {
    return path.join(directories.root, CONFIG_FILE);
}

function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        if (/^(true|1|on|yes)$/i.test(value)) {
            return true;
        }

        if (/^(false|0|off|no)$/i.test(value)) {
            return false;
        }
    }

    return fallback;
}

function normalizeThinkingEffort(value) {
    const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return THINKING_EFFORTS.has(candidate) ? candidate : DEFAULT_CONFIG.thinkingEffort;
}

function normalizeServiceTier(value) {
    const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return SERVICE_TIER_TYPES.has(candidate) ? candidate : DEFAULT_CONFIG.serviceTier;
}

function normalizeConfig(config = {}) {
    return {
        enabled: normalizeBoolean(config.enabled, DEFAULT_CONFIG.enabled),
        region: typeof config.region === 'string' && config.region.trim() ? config.region.trim() : DEFAULT_CONFIG.region,
        selectedModel: typeof config.selectedModel === 'string' ? config.selectedModel.trim() : DEFAULT_CONFIG.selectedModel,
        inferenceProfileId: typeof config.inferenceProfileId === 'string' ? config.inferenceProfileId.trim() : DEFAULT_CONFIG.inferenceProfileId,
        thinkingEffort: normalizeThinkingEffort(config.thinkingEffort),
        serviceTier: normalizeServiceTier(config.serviceTier),
    };
}

function getInvocationKey(directories) {
    return getConfigPath(directories);
}

function getLastInvocation(directories) {
    return lastInvocationState.get(getInvocationKey(directories)) || null;
}

function setLastInvocation(directories, payload) {
    lastInvocationState.set(getInvocationKey(directories), payload);
}

function readConfig(directories) {
    const filePath = getConfigPath(directories);
    if (!fs.existsSync(filePath)) {
        return { ...DEFAULT_CONFIG };
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return normalizeConfig(data);
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function writeConfig(directories, config) {
    const filePath = getConfigPath(directories);
    const nextConfig = normalizeConfig(config);
    fs.writeFileSync(filePath, JSON.stringify(nextConfig, null, 4), 'utf8');
    return nextConfig;
}

function getSecretManager(directories) {
    return new SecretManager(directories);
}

function getCredentials(directories) {
    const manager = getSecretManager(directories);
    const accessKeyId = manager.readSecret(SECRET_KEYS.accessKeyId, null);
    const secretAccessKey = manager.readSecret(SECRET_KEYS.secretAccessKey, null);
    const sessionToken = manager.readSecret(SECRET_KEYS.sessionToken, null);

    return {
        accessKeyId,
        secretAccessKey,
        sessionToken,
    };
}

function hasCredentials(credentials) {
    return Boolean(credentials.accessKeyId && credentials.secretAccessKey);
}

function getCredentialPreview(directories, key) {
    const state = getSecretManager(directories).getSecretState();
    const values = state[key];
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }

    const active = values.find(secret => secret.active) || values[0];
    return active?.value || null;
}

function getClientConfig(directories, region) {
    const credentials = getCredentials(directories);
    if (!hasCredentials(credentials)) {
        throw new Error('AWS Bedrock credentials are not configured.');
    }

    const clientConfig = {
        region,
        credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
        },
    };

    if (credentials.sessionToken) {
        clientConfig.credentials.sessionToken = credentials.sessionToken;
    }

    return clientConfig;
}

function createBedrockClients(directories, region) {
    const clientConfig = getClientConfig(directories, region);
    return {
        bedrock: new BedrockClient(clientConfig),
        runtime: new BedrockRuntimeClient(clientConfig),
    };
}

function toSystemBlock(text) {
    return { text };
}

function parseDataUrl(url) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(url || '');
    if (!match) {
        return null;
    }

    const mimeType = match[1].toLowerCase();
    const format = mimeType.split('/')[1]?.replace('jpeg', 'jpg');
    if (!format) {
        return null;
    }

    return {
        format,
        bytes: Buffer.from(match[2], 'base64'),
    };
}

function convertContent(content) {
    if (typeof content === 'string') {
        return content.trim() ? [{ text: content }] : [];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    const blocks = [];

    for (const part of content) {
        if (!part || typeof part !== 'object') {
            continue;
        }

        if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string' && part.text.length > 0) {
            blocks.push({ text: part.text });
            continue;
        }

        const imageUrl = part.image_url?.url || part.image_url || part.input_image?.image_url;
        if ((part.type === 'image_url' || part.type === 'input_image') && typeof imageUrl === 'string') {
            const parsed = parseDataUrl(imageUrl);
            if (parsed) {
                blocks.push({
                    image: {
                        format: parsed.format,
                        source: { bytes: parsed.bytes },
                    },
                });
            }
        }
    }

    return blocks;
}

function normalizeRole(role) {
    if (role === 'assistant') {
        return 'assistant';
    }

    return 'user';
}

function convertMessages(messages) {
    const system = [];
    const convertedMessages = [];

    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') {
            continue;
        }

        if (message.role === 'system' || message.role === 'developer') {
            for (const block of convertContent(message.content)) {
                if (typeof block.text === 'string' && block.text.trim()) {
                    system.push(toSystemBlock(block.text));
                }
            }
            continue;
        }

        const content = convertContent(message.content);
        if (content.length === 0) {
            continue;
        }

        const normalized = {
            role: normalizeRole(message.role),
            content,
        };

        const previous = convertedMessages[convertedMessages.length - 1];
        if (previous && previous.role === normalized.role) {
            previous.content.push(...normalized.content);
        } else {
            convertedMessages.push(normalized);
        }
    }

    if (convertedMessages.length === 0) {
        convertedMessages.push({
            role: 'user',
            content: [{ text: 'Hello.' }],
        });
    }

    return { system, messages: convertedMessages };
}

function extractTextContent(content) {
    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .map(block => typeof block?.text === 'string' ? block.text : '')
        .filter(Boolean)
        .join('');
}

function extractReasoningDetails(content) {
    if (!Array.isArray(content)) {
        return {
            detected: false,
            blockCount: 0,
            signatureDetected: false,
            redacted: false,
            preview: '',
        };
    }

    const reasoningTexts = [];
    let blockCount = 0;
    let signatureDetected = false;
    let redacted = false;

    for (const block of content) {
        const reasoningContent = block?.reasoningContent;
        if (!reasoningContent) {
            continue;
        }

        blockCount += 1;

        if (reasoningContent.reasoningText?.text) {
            reasoningTexts.push(reasoningContent.reasoningText.text);
        }

        if (reasoningContent.reasoningText?.signature) {
            signatureDetected = true;
        }

        if (reasoningContent.redactedContent) {
            redacted = true;
        }
    }

    return {
        detected: blockCount > 0,
        blockCount,
        signatureDetected,
        redacted,
        preview: reasoningTexts.join(' ').slice(0, 220),
    };
}

function mapFinishReason(stopReason) {
    switch (stopReason) {
        case 'max_tokens':
            return 'length';
        case 'stop_sequence':
        case 'end_turn':
            return 'stop';
        case 'tool_use':
            return 'tool_calls';
        case 'content_filtered':
            return 'content_filter';
        default:
            return 'stop';
    }
}

function toUsage(usage) {
    const promptTokens = Number(usage?.inputTokens || 0);
    const completionTokens = Number(usage?.outputTokens || 0);
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
    };
}

function hasReasoningContent(content) {
    return Array.isArray(content) && content.some(block => Boolean(block?.reasoningContent));
}

function modelSupportsAdaptiveThinking(modelId) {
    return /claude-(opus|sonnet)-4-6/i.test(modelId || '');
}

function modelSupportsMaxThinking(modelId) {
    return /claude-opus-4-6/i.test(modelId || '');
}

function buildOptionState(config, modelId) {
    const thinking = {
        requested: config.thinkingEffort,
        sent: false,
        type: null,
        effort: null,
        reason: null,
    };

    if (!modelId) {
        thinking.reason = '모델이 선택되지 않아 thinking 설정을 전송하지 않았습니다.';
    } else if (!modelSupportsAdaptiveThinking(modelId)) {
        thinking.reason = '선택한 모델은 Claude 4.6 adaptive thinking 지원 모델이 아니라서 thinking을 전송하지 않았습니다.';
    } else if (config.thinkingEffort === 'max' && !modelSupportsMaxThinking(modelId)) {
        thinking.reason = 'max thinking은 Claude Opus 4.6에서만 지원되어 전송하지 않았습니다.';
    } else {
        thinking.sent = true;
        thinking.type = 'adaptive';
        thinking.effort = config.thinkingEffort;
    }

    return {
        enabled: config.enabled,
        thinking,
        serviceTier: {
            requested: config.serviceTier,
            sent: true,
            type: config.serviceTier,
            reason: null,
        },
        requestAdjustments: [],
    };
}

function cloneDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        return {};
    }

    return JSON.parse(JSON.stringify(document));
}

function isModelListingFallbackCandidate(error) {
    const message = String(error?.message || '');
    return (
        /ListFoundationModels/i.test(message) ||
        /AccessDenied/i.test(message) ||
        /not authorized/i.test(message) ||
        /Unauthorized/i.test(message)
    );
}

function toFallbackModel(modelId) {
    return {
        id: modelId,
        object: 'model',
        owned_by: 'Anthropic',
        bedrock: {
            name: modelId,
            provider: 'Anthropic',
            inputModalities: ['TEXT'],
            outputModalities: ['TEXT'],
            responseStreamingSupported: true,
            inferenceTypesSupported: [],
            fallback: true,
        },
    };
}

function buildFallbackModelList(config, region, reason) {
    const modelIds = new Set(FALLBACK_MODEL_IDS);
    if (config.selectedModel) {
        modelIds.add(config.selectedModel);
    }

    return {
        object: 'list',
        data: Array.from(modelIds).sort((left, right) => left.localeCompare(right)).map(toFallbackModel),
        region,
        fallback: true,
        message: reason,
    };
}

function buildConverseInput(body, config) {
    const { system, messages } = convertMessages(body.messages);
    const inferenceConfig = {};
    const requestedModelId = typeof body.model === 'string' ? body.model.trim() : '';
    const invocationModelId = config.inferenceProfileId || requestedModelId;

    if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) {
        inferenceConfig.maxTokens = Math.floor(body.max_tokens);
    }

    if (Array.isArray(body.stop) && body.stop.length > 0) {
        inferenceConfig.stopSequences = body.stop.filter(item => typeof item === 'string' && item.length > 0).slice(0, 4);
    }

    const input = {
        modelId: invocationModelId,
        messages,
    };
    const optionState = buildOptionState(config, requestedModelId);
    const additionalModelRequestFields = cloneDocument(body.additionalModelRequestFields);

    if (typeof body.temperature === 'number' && typeof body.top_p === 'number') {
        inferenceConfig.temperature = body.temperature;
        optionState.requestAdjustments.push('이 모델에서는 temperature와 top_p를 함께 보낼 수 없어 top_p를 제외했습니다.');
    } else if (typeof body.temperature === 'number') {
        inferenceConfig.temperature = body.temperature;
    } else if (typeof body.top_p === 'number') {
        inferenceConfig.topP = body.top_p;
    }

    if (system.length > 0) {
        input.system = system;
    }

    if (Object.keys(inferenceConfig).length > 0) {
        input.inferenceConfig = inferenceConfig;
    }

    if (optionState.thinking.sent) {
        additionalModelRequestFields.thinking = {
            type: optionState.thinking.type,
            effort: optionState.thinking.effort,
        };
    }

    if (Object.keys(additionalModelRequestFields).length > 0) {
        input.additionalModelRequestFields = additionalModelRequestFields;
    }

    input.serviceTier = {
        type: optionState.serviceTier.type,
    };

    return { input, optionState, requestedModelId, invocationModelId };
}

function buildChatCompletionResponse(modelId, text, stopReason, usage) {
    const created = Math.floor(Date.now() / 1000);
    return {
        id: `chatcmpl-bedrock-${Date.now()}`,
        object: 'chat.completion',
        created,
        model: modelId,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: text,
                },
                finish_reason: mapFinishReason(stopReason),
            },
        ],
        usage: toUsage(usage),
    };
}

function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseDone(res) {
    res.write('data: [DONE]\n\n');
}

function buildInvocationSummary({ source, region, requestedModelId, invocationModelId, config, optionState, response, stream = false }) {
    const outputContent = response?.output?.message?.content;
    const reasoning = extractReasoningDetails(outputContent);
    return {
        source,
        requestedAt: new Date().toISOString(),
        region,
        modelId: requestedModelId,
        invocationModelId,
        requested: {
            enabled: config.enabled,
            inferenceProfileId: config.inferenceProfileId,
            thinkingEffort: config.thinkingEffort,
            serviceTier: config.serviceTier,
        },
        applied: optionState,
        response: response ? {
            stream,
            stopReason: response.stopReason || null,
            serviceTier: response.serviceTier?.type || null,
            performanceLatency: response.performanceConfig?.latency || null,
            reasoningDetected: reasoning.detected,
            reasoningBlockCount: reasoning.blockCount,
            reasoningSignatureDetected: reasoning.signatureDetected,
            reasoningRedacted: reasoning.redacted,
            reasoningPreview: reasoning.preview,
            usage: toUsage(response.usage),
            additionalModelResponseFields: response.additionalModelResponseFields || null,
            textPreview: extractTextContent(outputContent).slice(0, 160),
        } : {
            stream,
            stopReason: null,
            serviceTier: null,
            performanceLatency: null,
            reasoningDetected: false,
            reasoningBlockCount: 0,
            reasoningSignatureDetected: false,
            reasoningRedacted: false,
            reasoningPreview: '',
            usage: null,
            additionalModelResponseFields: null,
            textPreview: '',
        },
    };
}

function formatBedrockErrorMessage(error, config) {
    const message = error?.message || 'Bedrock chat completion failed.';
    const requiresProfile = /on-demand throughput/i.test(message) && /inference profile/i.test(message);

    if (/The security token included in the request is invalid/i.test(message)) {
        return `${message} 저장된 Session Token이 만료됐거나 현재 Access Key/Secret Key와 맞지 않을 수 있습니다. 임시 자격 증명이 아니라면 Session Token 입력칸을 비운 채 다시 저장하세요.`;
    }

    if (!requiresProfile) {
        return message;
    }

    if (config?.inferenceProfileId) {
        return `${message} 현재 저장된 inference profile ID/ARN을 다시 확인하세요.`;
    }

    return `${message} 이 모델은 inference profile ID 또는 ARN으로 호출해야 합니다. AWS Bedrock Connection 확장에서 Inference Profile ID/ARN을 저장한 뒤 다시 시도하세요.`;
}

function isStreamingFallbackCandidate(error) {
    const message = String(error?.message || '');
    return (
        /InvokeModelWithResponseStream/i.test(message) ||
        /not authorized to perform:\s*bedrock:InvokeModelWithResponseStream/i.test(message) ||
        /response stream/i.test(message) ||
        /streaming.*not supported/i.test(message)
    );
}

function isAdaptiveEffortFallbackCandidate(error) {
    const message = String(error?.message || '');
    return /thinking(?:\.adaptive)?\.effort:\s*Extra inputs are not permitted/i.test(message);
}

function buildAdaptiveThinkingFallbackInput(input) {
    const fallback = {
        ...input,
        additionalModelRequestFields: cloneDocument(input.additionalModelRequestFields),
    };

    if (fallback.additionalModelRequestFields?.thinking?.type === 'adaptive') {
        fallback.additionalModelRequestFields.thinking = {
            type: 'adaptive',
        };
    }

    return fallback;
}

function buildAdaptiveThinkingFallbackState(optionState) {
    const nextState = cloneDocument(optionState);
    nextState.thinking.sent = true;
    nextState.thinking.type = 'adaptive';
    nextState.thinking.effort = null;
    nextState.thinking.reason = 'AWS가 effort 필드를 거절해서 adaptive만 전송하도록 자동 재시도했습니다.';
    return nextState;
}

async function sendConverse(runtime, input, optionState) {
    try {
        return {
            response: await runtime.send(new ConverseCommand(input)),
            optionState,
        };
    } catch (error) {
        if (!isAdaptiveEffortFallbackCandidate(error)) {
            throw error;
        }

        const fallbackInput = buildAdaptiveThinkingFallbackInput(input);
        return {
            response: await runtime.send(new ConverseCommand(fallbackInput)),
            optionState: buildAdaptiveThinkingFallbackState(optionState),
        };
    }
}

async function sendConverseStream(runtime, input, optionState) {
    try {
        return {
            response: await runtime.send(new ConverseStreamCommand(input)),
            optionState,
        };
    } catch (error) {
        if (!isAdaptiveEffortFallbackCandidate(error)) {
            throw error;
        }

        const fallbackInput = buildAdaptiveThinkingFallbackInput(input);
        return {
            response: await runtime.send(new ConverseStreamCommand(fallbackInput)),
            optionState: buildAdaptiveThinkingFallbackState(optionState),
        };
    }
}

async function sendAsSingleChunkStream(res, runtime, input, optionState, requestedModelId, invocationModelId) {
    const result = await sendConverse(runtime, input, optionState);
    const response = result.response;
    const created = Math.floor(Date.now() / 1000);
    const streamId = `chatcmpl-bedrock-${Date.now()}`;
    const text = extractTextContent(response.output?.message?.content);
    const finishReason = mapFinishReason(response.stopReason);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
    });

    writeSse(res, {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model: requestedModelId || invocationModelId,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    if (text) {
        writeSse(res, {
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModelId || invocationModelId,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        });
    }

    writeSse(res, {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model: requestedModelId || invocationModelId,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    });
    writeSseDone(res);
    res.end();

    return result;
}

const VERIFY_PROMPT = [
    'Solve this briefly but correctly.',
    'Three players A, B, C each choose a number from 1 to 100.',
    'A beats B if A\'s number is greater than B\'s number modulo 100, with 100 treated as 0 for comparison.',
    'Likewise B beats C and C beats A.',
    'The winner is the player with the most pairwise wins.',
    'Is drawing uniformly at random a mixed-strategy Nash equilibrium? Answer with a short conclusion after your reasoning.',
].join(' ');

async function listModels(directories, requestedRegion) {
    const config = readConfig(directories);
    const region = requestedRegion || config.region || DEFAULT_REGION;
    const credentials = getCredentials(directories);

    if (!hasCredentials(credentials)) {
        return buildFallbackModelList(config, region, 'AWS 자격 증명이 아직 없어서 내장 Anthropic 모델 목록을 표시합니다.');
    }

    try {
        const { bedrock } = createBedrockClients(directories, region);
        const response = await bedrock.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }));

        const models = (response.modelSummaries || [])
            .filter(model => Array.isArray(model.outputModalities) ? model.outputModalities.includes('TEXT') : true)
            .map(model => ({
                id: model.modelId,
                object: 'model',
                owned_by: model.providerName || 'aws-bedrock',
                bedrock: {
                    name: model.modelName,
                    provider: model.providerName,
                    inputModalities: model.inputModalities || [],
                    outputModalities: model.outputModalities || [],
                    responseStreamingSupported: Boolean(model.responseStreamingSupported),
                    inferenceTypesSupported: model.inferenceTypesSupported || [],
                },
            }))
            .sort((left, right) => left.id.localeCompare(right.id));

        return {
            object: 'list',
            data: models,
            region,
            fallback: false,
        };
    } catch (error) {
        if (!isModelListingFallbackCandidate(error)) {
            console.warn('AWS Bedrock model listing fell back to built-in list:', error);
            return buildFallbackModelList(config, region, error?.message || 'AWS 모델 조회가 실패해 내장 Anthropic 모델 목록으로 대체했습니다.');
        }

        return buildFallbackModelList(config, region, 'AWS 계정에 bedrock:ListFoundationModels 권한이 없어 내장 Anthropic 모델 목록으로 대체했습니다.');
    }
}

async function handleChatCompletion(req, res) {
    const directories = req.user.directories;
    const config = readConfig(directories);
    if (!config.enabled) {
        return res.status(503).send({ error: { message: 'AWS Bedrock bridge is disabled. Enable the connection in the AWS Bedrock extension first.' } });
    }

    const region = config.region || DEFAULT_REGION;
    const { runtime } = createBedrockClients(directories, region);
    const { input, optionState, requestedModelId, invocationModelId } = buildConverseInput(req.body || {}, config);

    if (!requestedModelId && !invocationModelId) {
        return res.status(400).send({ error: { message: 'model is required.' } });
    }

    if (req.body?.stream) {
        try {
            const streamResult = await sendConverseStream(runtime, input, optionState);
            const response = streamResult.response;
            const created = Math.floor(Date.now() / 1000);
            const streamId = `chatcmpl-bedrock-${Date.now()}`;
            let finishReason = 'stop';
            const summary = buildInvocationSummary({
                source: 'chat-stream',
                region,
                requestedModelId,
                invocationModelId,
                config,
                optionState: streamResult.optionState,
                response,
                stream: true,
            });
            setLastInvocation(directories, summary);

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
            });

            writeSse(res, {
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model: requestedModelId || invocationModelId,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            });

            for await (const event of response.stream) {
                const deltaText = event?.contentBlockDelta?.delta?.text;
                if (deltaText) {
                    writeSse(res, {
                        id: streamId,
                        object: 'chat.completion.chunk',
                        created,
                        model: requestedModelId || invocationModelId,
                        choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }],
                    });
                }

                if (event?.messageStop?.stopReason) {
                    finishReason = mapFinishReason(event.messageStop.stopReason);
                }
            }

            summary.response.stopReason = finishReason;
            setLastInvocation(directories, summary);

            writeSse(res, {
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model: requestedModelId || invocationModelId,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            });
            writeSseDone(res);
            return res.end();
        } catch (error) {
            if (!isStreamingFallbackCandidate(error)) {
                throw error;
            }

            const fallbackResult = await sendAsSingleChunkStream(res, runtime, input, optionState, requestedModelId, invocationModelId);
            setLastInvocation(directories, buildInvocationSummary({
                source: 'chat-stream-fallback',
                region,
                requestedModelId,
                invocationModelId,
                config,
                optionState: fallbackResult.optionState,
                response: fallbackResult.response,
                stream: true,
            }));
            return;
        }
    }

    const result = await sendConverse(runtime, input, optionState);
    const response = result.response;
    setLastInvocation(directories, buildInvocationSummary({
        source: 'chat',
        region,
        requestedModelId,
        invocationModelId,
        config,
        optionState: result.optionState,
        response,
    }));
    const text = extractTextContent(response.output?.message?.content);
    return res.send(buildChatCompletionResponse(requestedModelId || invocationModelId, text, response.stopReason, response.usage));
}

function buildConfigResponse(directories) {
    const config = readConfig(directories);
    const credentials = getCredentials(directories);
    return {
        enabled: config.enabled,
        region: config.region,
        selectedModel: config.selectedModel,
        inferenceProfileId: config.inferenceProfileId,
        thinkingEffort: config.thinkingEffort,
        serviceTier: config.serviceTier,
        configured: hasCredentials(credentials),
        hasAccessKeyId: Boolean(credentials.accessKeyId),
        hasSecretAccessKey: Boolean(credentials.secretAccessKey),
        hasSessionToken: Boolean(credentials.sessionToken),
        credentialState: {
            accessKeyId: getCredentialPreview(directories, SECRET_KEYS.accessKeyId),
            secretAccessKey: getCredentialPreview(directories, SECRET_KEYS.secretAccessKey),
            sessionToken: getCredentialPreview(directories, SECRET_KEYS.sessionToken),
        },
    };
}

function buildInspectResponse(directories) {
    return {
        config: buildConfigResponse(directories),
        lastInvocation: getLastInvocation(directories),
    };
}

function saveCredentials(directories, body) {
    const manager = getSecretManager(directories);

    if (body.clearCredentials === true) {
        manager.deleteSecret(SECRET_KEYS.accessKeyId, null);
        manager.deleteSecret(SECRET_KEYS.secretAccessKey, null);
        manager.deleteSecret(SECRET_KEYS.sessionToken, null);
        return;
    }

    if (typeof body.accessKeyId === 'string') {
        if (body.accessKeyId.trim()) {
            manager.writeSecret(SECRET_KEYS.accessKeyId, body.accessKeyId.trim(), 'AWS Bedrock Access Key ID');
        }
    }

    if (typeof body.secretAccessKey === 'string') {
        if (body.secretAccessKey.trim()) {
            manager.writeSecret(SECRET_KEYS.secretAccessKey, body.secretAccessKey.trim(), 'AWS Bedrock Secret Access Key');
        }
    }

    if (typeof body.sessionToken === 'string') {
        if (body.sessionToken.trim()) {
            manager.writeSecret(SECRET_KEYS.sessionToken, body.sessionToken.trim(), 'AWS Bedrock Session Token');
        } else {
            manager.deleteSecret(SECRET_KEYS.sessionToken, null);
        }
    }

    if (body.clearSessionToken === true) {
        manager.deleteSecret(SECRET_KEYS.sessionToken, null);
    }
}

export async function init(router) {
    router.get('/health', (_req, res) => {
        res.send({ ok: true, plugin: info.id });
    });

    router.get('/config', (req, res) => {
        res.send(buildConfigResponse(req.user.directories));
    });

    router.post('/config', (req, res) => {
        const body = req.body || {};
        saveCredentials(req.user.directories, body);

        const currentConfig = readConfig(req.user.directories);
        const nextConfig = writeConfig(req.user.directories, {
            enabled: body.enabled,
            region: typeof body.region === 'string' && body.region.trim() ? body.region.trim() : currentConfig.region,
            selectedModel: typeof body.selectedModel === 'string' ? body.selectedModel.trim() : currentConfig.selectedModel,
            inferenceProfileId: typeof body.inferenceProfileId === 'string' ? body.inferenceProfileId.trim() : currentConfig.inferenceProfileId,
            thinkingEffort: body.thinkingEffort,
            serviceTier: body.serviceTier,
        });

        res.send({ ...buildConfigResponse(req.user.directories), ...nextConfig });
    });

    router.get('/inspect', (req, res) => {
        res.send(buildInspectResponse(req.user.directories));
    });

    router.get('/models', async (req, res) => {
        try {
            const response = await listModels(req.user.directories, String(req.query.region || ''));
            res.send(response);
        } catch (error) {
            console.error('AWS Bedrock model listing failed:', error);
            res.status(500).send({ error: { message: error.message || 'Failed to load Bedrock models.' } });
        }
    });

    router.get('/v1/models', async (req, res) => {
        try {
            const response = await listModels(req.user.directories, '');
            res.send({ object: 'list', data: response.data });
        } catch (error) {
            console.error('AWS Bedrock /v1/models failed:', error);
            res.status(500).send({ error: { message: error.message || 'Failed to load Bedrock models.' } });
        }
    });

    router.post('/v1/chat/completions', async (req, res) => {
        try {
            await handleChatCompletion(req, res);
        } catch (error) {
            console.error('AWS Bedrock chat completion failed:', error);
            if (!res.headersSent) {
                const config = readConfig(req.user.directories);
                res.status(500).send({ error: { message: formatBedrockErrorMessage(error, config) } });
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    });

    router.post('/verify', async (req, res) => {
        try {
            const directories = req.user.directories;
            const config = readConfig(directories);

            if (!config.enabled) {
                return res.status(409).send({ error: { message: '연결이 OFF 상태입니다. 먼저 Bedrock 연결을 ON으로 저장하세요.' } });
            }

            const modelId = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : config.selectedModel;
            if (!modelId) {
                return res.status(400).send({ error: { message: '검사할 모델이 선택되지 않았습니다.' } });
            }

            const region = config.region || DEFAULT_REGION;
            const { runtime } = createBedrockClients(directories, region);
            const { input, optionState, requestedModelId, invocationModelId } = buildConverseInput({
                model: modelId,
                messages: [
                    {
                        role: 'user',
                        content: VERIFY_PROMPT,
                    },
                ],
                max_tokens: 384,
                temperature: 0,
            }, config);

            const result = await sendConverse(runtime, input, optionState);
            const response = result.response;
            const summary = buildInvocationSummary({
                source: 'verify',
                region,
                requestedModelId,
                invocationModelId,
                config,
                optionState: result.optionState,
                response,
            });

            setLastInvocation(directories, summary);
            res.send(buildInspectResponse(directories));
        } catch (error) {
            console.error('AWS Bedrock verify failed:', error);
            const config = readConfig(req.user.directories);
            res.status(500).send({ error: { message: formatBedrockErrorMessage(error, config) } });
        }
    });
}