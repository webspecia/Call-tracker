import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// Configure Pool with SSL support suitable for Supabase / PostgreSQL cloud providers
export const pool = new Pool({
  connectionString,
  ssl: connectionString?.includes('supabase.co') || connectionString?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 20, // High concurrency pool limit
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

let isInitialized = false;

/**
 * Ensures all required database tables exist in PostgreSQL
 */
export async function initDb() {
  if (isInitialized) return;

  const client = await pool.connect();
  try {
    // 1. Central Webhook Ingestion Log table (stores all raw incoming webhooks immediately)
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        agent_id VARCHAR(100),
        device_id VARCHAR(100),
        call_uuid VARCHAR(100),
        payload JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'INGESTED',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_agent ON webhook_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_uuid ON webhook_logs(call_uuid);
    `);

    // 2. Devices Table (tracks registered devices and online heartbeats)
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_devices (
        device_id VARCHAR(100) PRIMARY KEY,
        agent_id VARCHAR(100) NOT NULL,
        last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        last_connection_test TIMESTAMPTZ,
        battery_optimization_off BOOLEAN,
        autostart_enabled VARCHAR(50) DEFAULT 'UNVERIFIED',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Call Records Table (stores incoming/outgoing call details and recording URLs)
    await client.query(`
      CREATE TABLE IF NOT EXISTS call_records (
        call_uuid VARCHAR(100) PRIMARY KEY,
        agent_id VARCHAR(100) NOT NULL,
        device_id VARCHAR(100) NOT NULL,
        direction VARCHAR(20) NOT NULL,
        call_type VARCHAR(30) NOT NULL,
        duration_sec INT DEFAULT 0,
        number VARCHAR(50),
        sim_slot INT,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        recording_url TEXT,
        recording_file_name TEXT,
        recording_file_size INT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_call_records_agent ON call_records(agent_id);
    `);

    isInitialized = true;
    console.log('PostgreSQL database initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize PostgreSQL database:', err);
  } finally {
    client.release();
  }
}

/**
 * Log raw incoming webhook payload centrally
 */
export async function saveWebhookLog(eventType: string, agentId: string | null, deviceId: string | null, callUuid: string | null, payload: any) {
  try {
    await initDb();
    await pool.query(
      `INSERT INTO webhook_logs (event_type, agent_id, device_id, call_uuid, payload, status)
       VALUES ($1, $2, $3, $4, $5, 'PROCESSED')`,
      [eventType, agentId, deviceId, callUuid, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error('Error writing to webhook_logs:', err);
  }
}

/**
 * Upsert agent device state
 */
export async function upsertDevice(agentId: string, deviceId: string, opts?: { batteryOptimizationOff?: boolean | null; isConnectionTest?: boolean }) {
  try {
    await initDb();
    const now = new Date();
    await pool.query(
      `INSERT INTO agent_devices (device_id, agent_id, last_seen, last_connection_test, battery_optimization_off)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (device_id) DO UPDATE SET
         agent_id = EXCLUDED.agent_id,
         last_seen = EXCLUDED.last_seen,
         last_connection_test = COALESCE($4, agent_devices.last_connection_test),
         battery_optimization_off = COALESCE($5, agent_devices.battery_optimization_off)`,
      [
        deviceId,
        agentId,
        now,
        opts?.isConnectionTest ? now : null,
        opts?.batteryOptimizationOff ?? null,
      ]
    );
  } catch (err) {
    console.error('Error upserting agent_devices:', err);
  }
}

/**
 * Save or update completed call record
 */
export async function saveCallRecord(record: {
  call_uuid: string;
  agent_id: string;
  device_id: string;
  direction: string;
  call_type: string;
  duration_sec: number;
  number: string | null;
  sim_slot: number | null;
  started_at: string;
  ended_at: string;
}) {
  try {
    await initDb();
    await pool.query(
      `INSERT INTO call_records (call_uuid, agent_id, device_id, direction, call_type, duration_sec, number, sim_slot, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (call_uuid) DO UPDATE SET
         direction = EXCLUDED.direction,
         call_type = EXCLUDED.call_type,
         duration_sec = EXCLUDED.duration_sec,
         number = EXCLUDED.number,
         sim_slot = EXCLUDED.sim_slot,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at`,
      [
        record.call_uuid,
        record.agent_id,
        record.device_id,
        record.direction,
        record.call_type,
        record.duration_sec,
        record.number,
        record.sim_slot,
        record.started_at,
        record.ended_at,
      ]
    );
  } catch (err) {
    console.error('Error saving call record:', err);
  }
}

/**
 * Link recording URL to call record
 */
export async function updateCallRecording(callUuid: string, recordingUrl: string, fileName?: string, fileSize?: number) {
  try {
    await initDb();
    await pool.query(
      `UPDATE call_records
       SET recording_url = $1, recording_file_name = $2, recording_file_size = $3
       WHERE call_uuid = $4`,
      [recordingUrl, fileName || null, fileSize || null, callUuid]
    );
  } catch (err) {
    console.error('Error updating call recording:', err);
  }
}
