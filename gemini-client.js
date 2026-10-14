const path = require('node:path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const API_VERSION = 'v1beta';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function integerEnv(name, fallback, minimum) {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} deve ser um inteiro >= ${minimum}.`);
    }
    return value;
}

function readConfig() {
    require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
    if (!process.env.GEMINI_API_KEY?.trim()) throw new Error('GEMINI_API_KEY ausente no .env.');
    const model = (process.env.GEMINI_MODEL || DEFAULT_MODEL).replace(/^models\//, '').trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('GEMINI_MODEL inválido.');
    return {
        apiKey: process.env.GEMINI_API_KEY.trim(), model,
        intervalMs: integerEnv('GEMINI_INTERVAL_MS', 15000, 0),
        timeoutMs: integerEnv('GEMINI_TIMEOUT_MS', 60000, 1),
        attempts: integerEnv('GEMINI_MAX_ATTEMPTS', 4, 1),
    };
}

function safeMessage(error, apiKey = process.env.GEMINI_API_KEY) {
    let message = String(error?.message || error);
    if (apiKey) message = message.split(apiKey).join('[CHAVE OCULTA]');
    return message.replace(/([?&]key=)[^&\s]+/gi, '$1[CHAVE OCULTA]').split('\n')[0];
}

function retryDelay(error, attempt, random = Math.random) {
    const details = error.errorDetails || [];
    // Quota diária ou quota zero não se resolve com uma espera curta.
    if (details.some(d => d.violations?.some(v =>
        /per.?day|daily/i.test(`${v.quotaId || ''} ${v.quotaMetric || ''}`)))) return null;
    if (/quota[^\n]*limit:\s*0\b/i.test(error.message || '')) return null;
    const status = Number(error.status);
    const transient = [408, 429, 500, 502, 503, 504].includes(status)
        || (!status && (/abort|timeout/i.test(`${error.name} ${error.message}`)
            || /fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(error.message || '')));
    if (!transient) return null;
    const retryInfo = details.find(d => String(d['@type']).endsWith('google.rpc.RetryInfo'));
    const seconds = retryInfo?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/)?.[1];
    const serverDelay = Math.max(error.retryAfterMs || 0, Number(seconds || 0) * 1000);
    // Se o servidor pedir uma espera longa, interrompe e preserva o progresso.
    if (serverDelay > 120000) return null;
    return Math.max(serverDelay, Math.min(60000, 15000 * 2 ** attempt) + Math.floor(random() * 1000));
}

async function withRetry(operation, config, { wait = sleep, log = console.warn } = {}) {
    for (let attempt = 0; attempt < config.attempts; attempt++) {
        try { return await operation(); }
        catch (error) {
            const delay = retryDelay(error, attempt);
            if (delay === null || attempt + 1 === config.attempts) throw error;
            log(`Falha temporária (${error.status || 'rede/timeout'}). Nova tentativa em ${Math.ceil(delay / 1000)}s (${attempt + 2}/${config.attempts}).`);
            await wait(delay);
        }
    }
}

async function listModels(config, fetchImpl = fetch) {
    const models = [];
    let pageToken;
    do {
        const url = new URL(`https://generativelanguage.googleapis.com/${API_VERSION}/models`);
        url.searchParams.set('pageSize', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const data = await withRetry(async () => {
            const response = await fetchImpl(url, {
                headers: { 'x-goog-api-key': config.apiKey },
                signal: AbortSignal.timeout(config.timeoutMs),
            });
            const body = await response.json();
            if (!response.ok) {
                const error = new Error(body.error?.message || `HTTP ${response.status}`);
                error.status = response.status;
                error.errorDetails = body.error?.details;
                const retryAfter = response.headers.get('retry-after');
                if (retryAfter) error.retryAfterMs = /^\d+(\.\d+)?$/.test(retryAfter)
                    ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
                throw error;
            }
            if (!Array.isArray(body.models)) throw new Error('Catálogo de modelos inválido.');
            return body;
        }, config);
        models.push(...data.models.filter(m => m.supportedGenerationMethods?.includes('generateContent')));
        pageToken = data.nextPageToken;
    } while (pageToken);
    return models;
}

async function createModel(config) {
    const models = await listModels(config);
    if (!models.some(m => m.name === `models/${config.model}`)) {
        throw new Error(`Modelo ${config.model} não consta no catálogo com generateContent. Execute node verificar-modelos.js e ajuste GEMINI_MODEL no .env.`);
    }
    return new GoogleGenerativeAI(config.apiKey).getGenerativeModel(
        { model: config.model }, { apiVersion: API_VERSION, timeout: config.timeoutMs });
}

function responseText(response) {
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') {
        throw new Error(`Resposta não concluída: ${candidate?.finishReason || response.promptFeedback?.blockReason || 'sem candidato'}.`);
    }
    const text = response.text().trim();
    if (!text) throw new Error('A API retornou texto vazio.');
    return text;
}

module.exports = { readConfig, safeMessage, retryDelay, withRetry, listModels, createModel, responseText, sleep };
