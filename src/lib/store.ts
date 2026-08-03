export interface CallEventBase {
  call_uuid: string | null;
  type: 'live_state' | 'heartbeat' | 'call_record' | 'recording_ready' | 'connection_test';
  agent_id: string;
  device_id: string;
  ts: string;
}

export interface LiveStateEvent extends CallEventBase {
  type: 'live_state';
  call_uuid: string;
  state: 'ringing' | 'offhook' | 'ended';
  direction: 'incoming' | 'outgoing';
  number: string | null;
  sim_slot: number | null;
}

export interface HeartbeatEvent extends CallEventBase {
  type: 'heartbeat';
  call_uuid: string;
  state: 'offhook';
  seq: number;
  elapsed_sec: number;
  direction: 'outgoing';
  number: string | null;
  sim_slot: number | null;
}

export interface CallRecordEvent extends CallEventBase {
  type: 'call_record';
  call_uuid: string;
  direction: 'incoming' | 'outgoing';
  call_type: 'answered' | 'missed' | 'rejected' | 'blocked' | 'not_connected';
  duration_sec: number;
  number: string | null;
  sim_slot: number | null;
  started_at: string;
  ended_at: string;
}

export interface RecordingReadyEvent extends CallEventBase {
  type: 'recording_ready';
  call_uuid: string;
  duration_sec: number;
  file_name: string;
  file_size_bytes: number;
  match_confidence: 'number+time' | 'time';
  recording_url?: string;
}

export interface ConnectionTestEvent extends CallEventBase {
  type: 'connection_test';
  call_uuid: null;
}

export interface ActiveCall {
  call_uuid: string;
  agent_id: string;
  device_id: string;
  direction: 'incoming' | 'outgoing';
  state: 'ringing' | 'offhook' | 'ended';
  number: string | null;
  sim_slot: number | null;
  started_at: string;
  last_heartbeat_at?: string;
  elapsed_sec?: number;
  live_until: string; // ISO String (now + 3 mins)
}

export interface AgentDevice {
  agent_id: string;
  device_id: string;
  last_seen: string;
  last_connection_test: string | null;
  battery_optimization_off: boolean | null;
  autostart_enabled: 'VERIFIED' | 'UNVERIFIED';
}

// In-Memory Storage Singleton for Node process
class StorageStore {
  private activeCalls: Map<string, ActiveCall> = new Map();
  private callHistory: CallRecordEvent[] = [];
  private recordings: Map<string, RecordingReadyEvent> = new Map();
  private devices: Map<string, AgentDevice> = new Map();
  public webhookSecret: string = 'webspecia-secret-key-12345';

  constructor() {
    // Seed initial mock data for demonstrate UI responsiveness
    const now = new Date();
    const ago10m = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const ago15m = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    
    this.callHistory.push(
      {
        type: 'call_record',
        call_uuid: '550e8400-e29b-41d4-a716-446655440001',
        direction: 'incoming',
        call_type: 'answered',
        duration_sec: 142,
        number: '+919876543210',
        sim_slot: 0,
        agent_id: 'AGENT_101',
        device_id: 'DEV_SIM_O1',
        started_at: ago15m,
        ended_at: ago10m,
        ts: ago10m,
      },
      {
        type: 'call_record',
        call_uuid: '550e8400-e29b-41d4-a716-446655440002',
        direction: 'outgoing',
        call_type: 'not_connected',
        duration_sec: 0,
        number: '+919123456789',
        sim_slot: 1,
        agent_id: 'AGENT_102',
        device_id: 'DEV_SIM_V2',
        started_at: ago10m,
        ended_at: ago10m,
        ts: ago10m,
      }
    );

    this.devices.set('DEV_SIM_O1', {
      agent_id: 'AGENT_101',
      device_id: 'DEV_SIM_O1',
      last_seen: new Date().toISOString(),
      last_connection_test: ago15m,
      battery_optimization_off: true,
      autostart_enabled: 'UNVERIFIED',
    });

    this.devices.set('DEV_SIM_V2', {
      agent_id: 'AGENT_102',
      device_id: 'DEV_SIM_V2',
      last_seen: new Date().toISOString(),
      last_connection_test: null,
      battery_optimization_off: false,
      autostart_enabled: 'UNVERIFIED',
    });
  }

  // battery_optimization_off is reported by the app (readable via PowerManager, see ARCHITECTURE.md §8).
  // autostart_enabled has no verifying API and always stays UNVERIFIED — that is correct, not a bug.
  public touchDevice(
    agent_id: string,
    device_id: string,
    opts?: { batteryOptimizationOff?: boolean | null; isConnectionTest?: boolean }
  ) {
    const existing = this.devices.get(device_id);
    this.devices.set(device_id, {
      agent_id,
      device_id,
      last_seen: new Date().toISOString(),
      last_connection_test: opts?.isConnectionTest
        ? new Date().toISOString()
        : existing?.last_connection_test ?? null,
      battery_optimization_off:
        opts?.batteryOptimizationOff !== undefined
          ? opts.batteryOptimizationOff
          : existing?.battery_optimization_off ?? null,
      autostart_enabled: 'UNVERIFIED',
    });
  }

  public handleLiveState(event: LiveStateEvent) {
    this.touchDevice(event.agent_id, event.device_id, {
      batteryOptimizationOff: (event as any).battery_optimization_off,
    });
    
    if (event.state === 'ended') {
      this.activeCalls.delete(event.call_uuid);
      return;
    }

    const expiry = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const currentCall = this.activeCalls.get(event.call_uuid);

    this.activeCalls.set(event.call_uuid, {
      call_uuid: event.call_uuid,
      agent_id: event.agent_id,
      device_id: event.device_id,
      direction: event.direction,
      state: event.state,
      number: event.number,
      sim_slot: event.sim_slot,
      started_at: currentCall?.started_at || event.ts,
      live_until: expiry,
    });
  }

  public handleHeartbeat(event: HeartbeatEvent) {
    this.touchDevice(event.agent_id, event.device_id, {
      batteryOptimizationOff: (event as any).battery_optimization_off,
    });
    const existing = this.activeCalls.get(event.call_uuid);
    const expiry = new Date(Date.now() + 3 * 60 * 1000).toISOString();

    this.activeCalls.set(event.call_uuid, {
      call_uuid: event.call_uuid,
      agent_id: event.agent_id,
      device_id: event.device_id,
      direction: 'outgoing',
      state: 'offhook',
      number: event.number,
      sim_slot: event.sim_slot,
      started_at: existing?.started_at || event.ts,
      last_heartbeat_at: event.ts,
      elapsed_sec: event.elapsed_sec,
      live_until: expiry,
    });
  }

  public handleCallRecord(event: CallRecordEvent) {
    this.touchDevice(event.agent_id, event.device_id, {
      batteryOptimizationOff: (event as any).battery_optimization_off,
    });
    // Rule: call_record is authoritative off-switch for live status
    this.activeCalls.delete(event.call_uuid);

    // Deduplicate by call_uuid
    const existingIndex = this.callHistory.findIndex((c) => c.call_uuid === event.call_uuid);
    if (existingIndex >= 0) {
      this.callHistory[existingIndex] = event;
    } else {
      this.callHistory.unshift(event);
    }
  }

  public handleRecordingReady(event: RecordingReadyEvent) {
    this.touchDevice(event.agent_id, event.device_id);
    this.recordings.set(event.call_uuid, event);
  }

  public getActiveCalls(): ActiveCall[] {
    const nowIso = new Date().toISOString();
    const list: ActiveCall[] = [];
    
    // Filter out expired calls (live_until < now)
    for (const [uuid, call] of this.activeCalls.entries()) {
      if (call.live_until < nowIso) {
        this.activeCalls.delete(uuid);
      } else {
        list.push(call);
      }
    }
    return list;
  }

  public getCallHistory() {
    return this.callHistory.map(call => ({
      ...call,
      recording: this.recordings.get(call.call_uuid) || null
    }));
  }

  public getDevices(): AgentDevice[] {
    return Array.from(this.devices.values());
  }
}

// Global instance attached to globalThis to persist across Next.js API reloads in development
const globalForStore = globalThis as unknown as { store: StorageStore };
export const store = globalForStore.store || new StorageStore();
if (process.env.NODE_ENV !== 'production') globalForStore.store = store;
