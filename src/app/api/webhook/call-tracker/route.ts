import { NextRequest, NextResponse } from 'next/server';
import { verifyHmacSignature } from '@/lib/hmac';
import { store } from '@/lib/store';
import { saveWebhookLog, upsertDevice, saveCallRecord, updateCallRecording } from '@/lib/db';
import fs from 'fs';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';
    const signature = req.headers.get('x-signature');

    // 1. Handling Multipart/form-data for recording_ready events & audio files
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const metaStr = formData.get('meta') as string;
      const file = formData.get('file') as File | null;

      if (!metaStr) {
        return NextResponse.json({ error: 'Missing meta part in request' }, { status: 400 });
      }

      // Non-blocking signature check
      const isValid = verifyHmacSignature(metaStr, signature, store.webhookSecret);
      const meta = JSON.parse(metaStr);
      meta._signature_status = isValid ? 'VERIFIED' : signature ? 'INVALID_SIGNATURE' : 'NO_SIGNATURE';
      let recordingUrl = meta.recording_url || undefined;

      // If audio file was uploaded, save it locally to public/recordings
      if (file) {
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const publicRecordingsDir = path.join(process.cwd(), 'public', 'recordings');
        if (!fs.existsSync(publicRecordingsDir)) {
          fs.mkdirSync(publicRecordingsDir, { recursive: true });
        }

        const safeFileName = `${meta.call_uuid || Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const filePath = path.join(publicRecordingsDir, safeFileName);
        fs.writeFileSync(filePath, buffer);

        recordingUrl = `/recordings/${safeFileName}`;
      }

      // Central Ingestion: Save raw webhook log in PostgreSQL
      await saveWebhookLog(
        meta.type || 'recording_ready',
        meta.agent_id || null,
        meta.device_id || null,
        meta.call_uuid || null,
        { meta, hasFile: !!file, recordingUrl }
      );

      if (meta.type === 'recording_ready') {
        const recordingData = {
          ...meta,
          recording_url: recordingUrl,
        };

        // Sync to In-memory store
        store.handleRecordingReady(recordingData);

        // Update PostgreSQL database record
        if (meta.call_uuid && recordingUrl) {
          await updateCallRecording(
            meta.call_uuid,
            recordingUrl,
            meta.file_name || (file ? file.name : undefined),
            meta.file_size_bytes || (file ? file.size : undefined)
          );
        }
      }

      return NextResponse.json({
        success: true,
        call_uuid: meta.call_uuid,
        recording_url: recordingUrl,
      });
    }

    // Check HMAC Signature status (Non-blocking: Process all incoming app events regardless)
    const isHmacValid = verifyHmacSignature(rawBody, signature, store.webhookSecret);
    const signatureStatus = isHmacValid ? 'VERIFIED' : signature ? 'INVALID_SIGNATURE' : 'NO_SIGNATURE';

    const payload = JSON.parse(rawBody);
    payload._signature_status = signatureStatus;

    // Central Ingestion: Log every raw event to PostgreSQL webhook_logs first
    await saveWebhookLog(
      payload.type || 'unknown',
      payload.agent_id || null,
      payload.device_id || null,
      payload.call_uuid || null,
      payload
    );

    // Routing & Database Updates
    if (payload.agent_id && payload.device_id) {
      await upsertDevice(payload.agent_id, payload.device_id, {
        batteryOptimizationOff: payload.battery_optimization_off,
        isConnectionTest: payload.type === 'connection_test',
      });
    }

    switch (payload.type) {
      case 'connection_test':
        store.touchDevice(payload.agent_id, payload.device_id, {
          batteryOptimizationOff: payload.battery_optimization_off,
          isConnectionTest: true,
        });
        return NextResponse.json({
          status: 'ok',
          message: 'Connection test successful',
          ts: new Date().toISOString(),
        });

      case 'live_state':
        store.handleLiveState(payload);
        break;

      case 'heartbeat':
        store.handleHeartbeat(payload);
        break;

      case 'call_record':
        store.handleCallRecord(payload);
        // Direct route to PostgreSQL call_records table
        await saveCallRecord({
          call_uuid: payload.call_uuid,
          agent_id: payload.agent_id,
          device_id: payload.device_id,
          direction: payload.direction,
          call_type: payload.call_type,
          duration_sec: payload.duration_sec,
          number: payload.number,
          sim_slot: payload.sim_slot,
          started_at: payload.started_at,
          ended_at: payload.ended_at,
        });
        break;

      default:
        return NextResponse.json({ error: 'Unknown event type' }, { status: 400 });
    }

    return NextResponse.json({
      status: 'success',
      received_type: payload.type,
      call_uuid: payload.call_uuid,
      routed_to_db: true,
    });
  } catch (err: any) {
    console.error('Webhook processing error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error', details: err.message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'online',
    endpoint: '/api/webhook/call-tracker',
    db_connected: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL),
    supported_events: [
      'live_state',
      'heartbeat',
      'call_record',
      'recording_ready',
      'connection_test',
    ],
    secret_configured: !!store.webhookSecret,
  });
}
