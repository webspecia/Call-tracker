import { NextResponse } from 'next/server';
import { pool, initDb } from '@/lib/db';

export async function GET() {
  try {
    await initDb();
    const result = await pool.query(
      `SELECT id, event_type, agent_id, device_id, call_uuid, payload, status, created_at
       FROM webhook_logs
       ORDER BY created_at DESC
       LIMIT 100`
    );

    return NextResponse.json({
      success: true,
      count: result.rowCount,
      logs: result.rows,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Failed to fetch webhook logs', details: err.message },
      { status: 500 }
    );
  }
}
