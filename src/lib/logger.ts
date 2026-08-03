import fs from 'fs';
import path from 'path';

export interface FallbackLogEntry {
  id: string;
  timestamp: string;
  eventType: string;
  agentId: string | null;
  deviceId: string | null;
  callUuid: string | null;
  errorCode?: string;
  errorName?: string;
  errorMessage: string;
  rootCauseAnalysis: string;
  payload: any;
}

// In-memory buffer of recent DB failure logs for instant UI dashboard access
const fallbackMemoryLogs: FallbackLogEntry[] = [];

/**
 * Automatically analyzes PostgreSQL / Node.js error codes to explain EXACTLY why DB write failed
 */
export function diagnoseDbError(err: any): { rootCause: string; code?: string } {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    return {
      code: 'MISSING_DATABASE_URL',
      rootCause: 'CRITICAL: DATABASE_URL environment variable is missing or empty. Please configure DATABASE_URL in .env.local or Vercel Environment Variables.'
    };
  }

  const message = err?.message || String(err);
  const code = err?.code;

  if (code === '28P01' || message.includes('password authentication failed')) {
    return {
      code: 'DB_AUTH_FAILED',
      rootCause: 'Authentication Error: PostgreSQL password or username in DATABASE_URL is incorrect.'
    };
  }

  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || message.includes('getaddrinfo ENOTFOUND')) {
    return {
      code: 'DB_HOST_UNREACHABLE',
      rootCause: 'Network Error: Cannot connect to PostgreSQL database host (Check internet connection or Supabase domain URL).'
    };
  }

  if (code === 'ETIMEDOUT' || message.includes('timeout')) {
    return {
      code: 'DB_TIMEOUT',
      rootCause: 'Connection Timeout: PostgreSQL database server took too long to respond.'
    };
  }

  if (message.includes('self signed certificate') || message.includes('SSL')) {
    return {
      code: 'DB_SSL_ERROR',
      rootCause: 'SSL Handshake Error: Ensure SSL rejectUnauthorized: false is enabled for cloud database providers like Supabase.'
    };
  }

  if (code === '42P01' || message.includes('does not exist')) {
    return {
      code: 'TABLE_MISSING',
      rootCause: 'Database Table Missing: Target table does not exist in PostgreSQL schema.'
    };
  }

  return {
    code: code || 'DB_UNKNOWN_ERROR',
    rootCause: `Database Write Failure: ${message}`
  };
}

/**
 * Writes diagnostic fallback log to local file /logs/fallback-errors.log and in-memory queue
 */
export function writeFallbackLog(
  eventType: string,
  agentId: string | null,
  deviceId: string | null,
  callUuid: string | null,
  payload: any,
  err: any
): FallbackLogEntry {
  const diagnosis = diagnoseDbError(err);
  const now = new Date().toISOString();
  const entryId = `fall-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const logEntry: FallbackLogEntry = {
    id: entryId,
    timestamp: now,
    eventType,
    agentId,
    deviceId,
    callUuid,
    errorCode: diagnosis.code,
    errorName: err?.name || 'DatabaseError',
    errorMessage: err?.message || String(err),
    rootCauseAnalysis: diagnosis.rootCause,
    payload,
  };

  // 1. Add to In-memory Log Queue (Limit to last 100 logs)
  fallbackMemoryLogs.unshift(logEntry);
  if (fallbackMemoryLogs.length > 100) {
    fallbackMemoryLogs.pop();
  }

  // 2. Append to local log file /logs/fallback-errors.log
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const filePath = path.join(logsDir, 'fallback-errors.log');
    const formattedLog = `
================================================================================
TIMESTAMP          : ${now}
LOG ID             : ${logEntry.id}
EVENT TYPE         : ${eventType}
AGENT ID           : ${agentId || 'N/A'}
DEVICE ID          : ${deviceId || 'N/A'}
CALL UUID          : ${callUuid || 'N/A'}
ERROR CODE         : ${logEntry.errorCode}
DIAGNOSTIC CAUSE   : ${logEntry.rootCauseAnalysis}
ERROR DETAILS      : ${logEntry.errorMessage}
RAW PAYLOAD        : ${JSON.stringify(payload)}
================================================================================
`;
    fs.appendFileSync(filePath, formattedLog, 'utf-8');
  } catch (fsErr) {
    console.error('Failed to write log file:', fsErr);
  }

  return logEntry;
}

/**
 * Returns recent fallback failure logs
 */
export function getFallbackLogs(): FallbackLogEntry[] {
  return fallbackMemoryLogs;
}
