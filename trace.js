const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

function isEnabled() {
  return process.env.TRACE_MODE === 'true';
}

function generateTraceId() {
  return Math.random().toString(36).substring(2, 8);
}

function getTraceId() {
  return asyncLocalStorage.getStore() || 'N/A';
}

function runWithTraceId(traceId, fn) {
  return asyncLocalStorage.run(traceId, fn);
}

function maskString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/nvapi-[a-zA-Z0-9\-_]+/g, '[NVIDIA_API_KEY_MASKED]')
    .replace(/EAAN[a-zA-Z0-9]+/g, '[META_ACCESS_TOKEN_MASKED]')
    .replace(/mongodb\+srv:\/\/[a-zA-Z0-9_%\-]+:[^@\s]+@[a-zA-Z0-9_.\-]+/g, 'mongodb+srv://[DB_USER]:[DB_PASSWORD]@[DB_HOST]');
}

function sanitizeObject(obj, seen = new WeakSet()) {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return maskString(obj);
  }

  if (typeof obj !== 'object') return obj;

  if (seen.has(obj)) {
    return '[Circular]';
  }

  // Handle Buffers
  if (Buffer.isBuffer(obj)) {
    return `[Buffer: ${obj.length} bytes]`;
  }

  seen.add(obj);

  if (Array.isArray(obj)) {
    if (obj.length > 5) {
      const truncated = [`[Array of ${obj.length} items (truncated for log privacy)]`].concat(
        obj.slice(0, 3).map(item => sanitizeObject(item, seen))
      );
      seen.delete(obj);
      return truncated;
    }
    const mapped = obj.map(item => sanitizeObject(item, seen));
    seen.delete(obj);
    return mapped;
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('key') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('password') ||
      lowerKey.includes('url') ||
      lowerKey.includes('uri') ||
      lowerKey.includes('connection')
    ) {
      result[key] = '[MASKED]';
    } else {
      result[key] = sanitizeObject(value, seen);
    }
  }
  seen.delete(obj);
  return result;
}

function safeJsonStringify(obj) {
  try {
    const sanitized = sanitizeObject(obj);
    return JSON.stringify(sanitized, null, 2);
  } catch (e) {
    return String(obj);
  }
}

function logRequestReceived(source, destination, payload) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

REQUEST RECEIVED

SOURCE:
${source}

DESTINATION:
${destination}

PAYLOAD:
${safeJsonStringify(payload)}
======================================================================
`);
}

function logResponseSent(payload) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

RESPONSE SENT TO USER

${safeJsonStringify(payload)}
======================================================================
`);
}

function logFunctionEntered(fileName, functionName, inputPayload, callingFunction = 'N/A') {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

FUNCTION ENTERED

FILE:
${fileName}

FUNCTION:
${functionName}

CALLED BY:
${callingFunction}

RECEIVED DATA:
${safeJsonStringify(inputPayload)}
======================================================================
`);
}

function logFunctionResult(fileName, functionName, outputPayload, executionTimeMs) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

FUNCTION RESULT

FUNCTION:
${functionName}

RETURNED:
${safeJsonStringify(outputPayload)}

FILE NAME:
${fileName}

FUNCTION NAME:
${functionName}

INPUT PAYLOAD:
N/A

OUTPUT PAYLOAD:
${safeJsonStringify(outputPayload)}

EXECUTION TIME:
${executionTimeMs}ms
======================================================================
`);
}

function logDataTransfer(sourceFunction, destinationFunction, payload) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  const payloadStr = safeJsonStringify(payload);
  const size = Buffer.byteLength(payloadStr, 'utf8');
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

DATA TRANSFER

FROM:
${sourceFunction}

TO:
${destinationFunction}

PAYLOAD:
${payloadStr}

PAYLOAD SIZE:
${size} bytes
======================================================================
`);
}

function logDataTransformation(originalJson, modifiedJson) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  
  const original = originalJson || {};
  const modified = modifiedJson || {};
  
  const origKeys = Object.keys(original);
  const modKeys = Object.keys(modified);
  
  const added = modKeys.filter(k => !(k in original));
  const removed = origKeys.filter(k => !(k in modified));
  const changed = origKeys.filter(k => (k in modified) && JSON.stringify(original[k]) !== JSON.stringify(modified[k]));

  console.log(`
======================================================================
[TRACE_ID=${traceId}]

DATA TRANSFORMATION

ORIGINAL JSON:
${safeJsonStringify(originalJson)}

MODIFIED JSON:
${safeJsonStringify(modifiedJson)}

FIELDS ADDED:
${JSON.stringify(added)}

FIELDS REMOVED:
${JSON.stringify(removed)}

FIELDS CHANGED:
${JSON.stringify(changed)}
======================================================================
`);
}

function logDatabaseQuery(collection, query, result, documentCount) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  
  let sampleResult = result;
  if (Array.isArray(result)) {
    sampleResult = result.slice(0, 1);
  }
  
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

DATABASE QUERY

COLLECTION:
${collection}

QUERY:
${safeJsonStringify(query)}

RESULT COUNT:
${documentCount}

SAMPLE RESULT:
${safeJsonStringify(sampleResult)}
======================================================================
`);
}

function logGeminiRequest(model, systemPrompt, userMessage, contextPassed) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  
  const systemPromptClean = maskString(systemPrompt || '');
  const userMessageClean = maskString(userMessage || '');
  const contextPassedClean = maskString(contextPassed || '');
  
  const tokenEstimate = Math.ceil((systemPromptClean.length + userMessageClean.length + contextPassedClean.length) / 4);
  
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

LLM REQUEST

MODEL:
${model}

SYSTEM PROMPT:
${systemPromptClean || 'N/A'}

USER MESSAGE:
${userMessageClean || 'N/A'}

CONTEXT PASSED:
${contextPassedClean || 'N/A'}

TOKEN ESTIMATE:
${tokenEstimate}
======================================================================
`);
}

function logGeminiResponse(model, responseText, latencyMs, systemPrompt, userMessage, contextPassed) {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  
  const systemPromptClean = maskString(systemPrompt || '');
  const userMessageClean = maskString(userMessage || '');
  const contextPassedClean = maskString(contextPassed || '');
  const responseTextClean = maskString(responseText || '');
  
  const requestTokens = Math.ceil((systemPromptClean.length + userMessageClean.length + contextPassedClean.length) / 4);
  const responseTokens = Math.ceil(responseTextClean.length / 4);
  const totalTokens = requestTokens + responseTokens;
  
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

LLM RESPONSE

MODEL RESPONSE:
${responseTextClean}

LATENCY:
${latencyMs}ms

TOKEN ESTIMATE:
${totalTokens}
======================================================================
`);
}

function logError(functionName, inputPayload, error, failedOperation = 'N/A') {
  if (!isEnabled()) return;
  const traceId = getTraceId();
  
  console.log(`
======================================================================
[TRACE_ID=${traceId}]

ERROR

TRACE ID:
${traceId}

FUNCTION NAME:
${functionName}

INPUT PAYLOAD:
${safeJsonStringify(inputPayload)}

STACK TRACE:
${error?.stack || String(error)}

FAILED OPERATION:
${failedOperation}
======================================================================
`);
}

module.exports = {
  isEnabled,
  generateTraceId,
  getTraceId,
  runWithTraceId,
  logRequestReceived,
  logResponseSent,
  logFunctionEntered,
  logFunctionResult,
  logDataTransfer,
  logDataTransformation,
  logDatabaseQuery,
  logGeminiRequest,
  logGeminiResponse,
  logError
};
