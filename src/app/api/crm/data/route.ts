import { NextResponse } from 'next/server';
import { store } from '@/lib/store';
import { pool, initDb } from '@/lib/db';
import { getFallbackLogs } from '@/lib/logger';

export async function GET() {
  const fallbackLogs = getFallbackLogs();

  try {
    const dbInitialized = await initDb();
    if (!dbInitialized) {
      return NextResponse.json({
        active_calls: store.getActiveCalls(),
        call_history: store.getCallHistory(),
        devices: store.getDevices(),
        webhook_logs: [],
        fallback_logs: fallbackLogs,
        webhook_secret: store.webhookSecret,
        db_connected: false,
        db_error: 'Database initialization failed. Check fallback_logs for root cause analysis.',
      });
    }

    // Fetch database call records with attached recordings
    const callDbResult = await pool.query(
      `SELECT call_uuid, agent_id, device_id, direction, call_type, duration_sec, number, sim_slot, started_at, ended_at, recording_url, recording_file_name, recording_file_size, created_at
       FROM call_records
       ORDER BY created_at DESC
       LIMIT 100`
    );

    // Fetch database devices
    const deviceDbResult = await pool.query(
      `SELECT device_id, agent_id, last_seen, last_connection_test, battery_optimization_off, autostart_enabled
       FROM agent_devices
       ORDER BY last_seen DESC`
    );

    // Fetch central ingestion webhook logs
    const logsResult = await pool.query(
      `SELECT id, event_type, agent_id, device_id, call_uuid, payload, status, created_at
       FROM webhook_logs
       ORDER BY created_at DESC
       LIMIT 50`
    );

    // Combine database records with memory store backup
    const memoryHistory = store.getCallHistory();
    const dbCallRecords = callDbResult.rows.map(row => ({
      type: 'call_record',
      call_uuid: row.call_uuid,
      direction: row.direction,
      call_type: row.call_type,
      duration_sec: row.duration_sec,
      number: row.number,
      sim_slot: row.sim_slot,
      agent_id: row.agent_id,
      device_id: row.device_id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      ts: row.created_at,
      recording: row.recording_url ? {
        type: 'recording_ready',
        call_uuid: row.call_uuid,
        duration_sec: row.duration_sec,
        file_name: row.recording_file_name || 'recording.mp3',
        file_size_bytes: row.recording_file_size || 0,
        match_confidence: 'number+time',
        recording_url: row.recording_url,
      } : null
    }));

    // Merge memory history with DB history (avoiding duplicate call_uuids)
    const combinedHistoryMap = new Map();
    dbCallRecords.forEach(c => combinedHistoryMap.set(c.call_uuid, c));
    memoryHistory.forEach(c => {
      if (!combinedHistoryMap.has(c.call_uuid)) {
        combinedHistoryMap.set(c.call_uuid, c);
      }
    });

    const combinedDevicesMap = new Map();
    deviceDbResult.rows.forEach(d => combinedDevicesMap.set(d.device_id, d));
    store.getDevices().forEach(d => {
      if (!combinedDevicesMap.has(d.device_id)) {
        combinedDevicesMap.set(d.device_id, d);
      }
    });

    return NextResponse.json({
      active_calls: store.getActiveCalls(),
      call_history: Array.from(combinedHistoryMap.values()),
      devices: Array.from(combinedDevicesMap.values()),
      webhook_logs: logsResult.rows,
      fallback_logs: fallbackLogs,
      webhook_secret: store.webhookSecret,
      db_connected: true,
    });
  } catch (err: any) {
    console.error('Error fetching CRM data:', err);
    // Fallback to memory store if DB is temporarily unreachable
    return NextResponse.json({
      active_calls: store.getActiveCalls(),
      call_history: store.getCallHistory(),
      devices: store.getDevices(),
      webhook_logs: [],
      fallback_logs: fallbackLogs,
      webhook_secret: store.webhookSecret,
      db_connected: false,
      db_error: err.message,
    });
  }
}

export async function POST(req: Request) {
  const body = await req.json();
  if (body.webhook_secret) {
    store.webhookSecret = body.webhook_secret;
  }
  return NextResponse.json({ success: true, webhook_secret: store.webhookSecret });
}
