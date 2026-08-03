'use client';

import React, { useState, useEffect } from 'react';

interface ActiveCall {
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
  live_until: string;
}

interface CallRecord {
  call_uuid: string;
  direction: 'incoming' | 'outgoing';
  call_type: 'answered' | 'missed' | 'rejected' | 'blocked' | 'not_connected';
  duration_sec: number;
  number: string | null;
  sim_slot: number | null;
  agent_id: string;
  device_id: string;
  started_at: string;
  ended_at: string;
  recording?: {
    file_name: string;
    file_size_bytes: number;
    match_confidence?: string;
    recording_url?: string;
  } | null;
}

interface AgentDevice {
  agent_id: string;
  device_id: string;
  last_seen: string;
  last_connection_test: string | null;
  battery_optimization_off: boolean | null;
  autostart_enabled: 'VERIFIED' | 'UNVERIFIED';
}

interface WebhookLogItem {
  id: number;
  event_type: string;
  agent_id: string | null;
  device_id: string | null;
  call_uuid: string | null;
  payload: any;
  status: string;
  created_at: string;
}

interface FallbackLogItem {
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

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export default function DashboardClient() {
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [callHistory, setCallHistory] = useState<CallRecord[]>([]);
  const [devices, setDevices] = useState<AgentDevice[]>([]);
  const [webhookLogs, setWebhookLogs] = useState<WebhookLogItem[]>([]);
  const [fallbackLogs, setFallbackLogs] = useState<FallbackLogItem[]>([]);
  const [secret, setSecret] = useState<string>('webspecia-secret-key-12345');
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simStatus, setSimStatus] = useState<string>('');
  const [simAgentId, setSimAgentId] = useState<string>('AGENT_101');
  const [lastCallUuid, setLastCallUuid] = useState<string | null>(null);
  const [reportsAgentFilter, setReportsAgentFilter] = useState<string>('all');

  const uniqueAgentIds = Array.from(
    new Set([...callHistory.map((c) => c.agent_id), ...devices.map((d) => d.agent_id)])
  ).sort();

  const fetchData = async () => {
    try {
      const res = await fetch('/api/crm/data');
      if (res.ok) {
        const data = await res.json();
        setActiveCalls(data.active_calls || []);
        setCallHistory(data.call_history || []);
        setDevices(data.devices || []);
        setWebhookLogs(data.webhook_logs || []);
        setFallbackLogs(data.fallback_logs || []);
        setSecret(data.webhook_secret || 'webspecia-secret-key-12345');
      }
    } catch (e) {
      console.error('Failed to fetch CRM data', e);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, []);

  const signHmac = async (rawBody: string) => {
    const subtle = window.crypto.subtle;
    const encoder = new TextEncoder();
    const cryptoKey = await subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await subtle.sign('HMAC', cryptoKey, encoder.encode(rawBody));
    return Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  const simulateCall = async (type: string) => {
    setIsSimulating(true);
    setSimStatus('Generating event & signature...');

    const uuid = `call-${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();
    const deviceId = `DEV_${simAgentId}`;

    let payload: any = {
      call_uuid: uuid,
      agent_id: simAgentId,
      device_id: deviceId,
      ts: now,
    };

    if (type === 'incoming_ringing') {
      payload = {
        ...payload,
        type: 'live_state',
        state: 'ringing',
        direction: 'incoming',
        number: '+919876543210',
        sim_slot: 0,
      };
    } else if (type === 'outgoing_offhook') {
      payload = {
        ...payload,
        type: 'live_state',
        state: 'offhook',
        direction: 'outgoing',
        number: '+919123456789',
        sim_slot: 1,
      };
    } else if (type === 'call_record_answered') {
      payload = {
        ...payload,
        type: 'call_record',
        direction: 'incoming',
        call_type: 'answered',
        duration_sec: 142,
        number: '+919876543210',
        sim_slot: 0,
        started_at: new Date(Date.now() - 142000).toISOString(),
        ended_at: now,
        battery_optimization_off: true,
      };
    } else if (type === 'connection_test') {
      payload = {
        call_uuid: null,
        agent_id: simAgentId,
        device_id: deviceId,
        ts: now,
        type: 'connection_test',
        battery_optimization_off: true,
      };
    }

    const rawBody = JSON.stringify(payload);

    try {
      const signatureHex = await signHmac(rawBody);

      const res = await fetch('/api/webhook/call-tracker', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signatureHex,
        },
        body: rawBody,
      });

      if (res.ok) {
        setSimStatus(`Event delivered!`);
        if (type === 'call_record_answered') setLastCallUuid(uuid);
        fetchData();
      } else {
        const err = await res.json();
        setSimStatus(`Error: ${err.error}`);
      }
    } catch (err: any) {
      setSimStatus(`Error: ${err.message}`);
    } finally {
      setIsSimulating(false);
    }
  };

  const simulateRecording = async () => {
    if (!lastCallUuid) {
      setSimStatus('Send a Call Record (Event B) first so the recording has a call_uuid to attach to.');
      return;
    }
    setIsSimulating(true);
    setSimStatus('Uploading simulated recording (multipart)...');

    const deviceId = `DEV_${simAgentId}`;
    const meta = {
      call_uuid: lastCallUuid,
      type: 'recording_ready',
      duration_sec: 142,
      file_name: `${lastCallUuid}.m4a`,
      file_size_bytes: 234567,
      match_confidence: 'number+time',
      agent_id: simAgentId,
      device_id: deviceId,
      ts: new Date().toISOString(),
    };
    const metaStr = JSON.stringify(meta);

    try {
      const signatureHex = await signHmac(metaStr);
      const fakeAudio = new Blob(['fake-audio-bytes'], { type: 'audio/mp4' });

      const form = new FormData();
      form.append('meta', metaStr);
      form.append('file', fakeAudio, meta.file_name);

      const res = await fetch('/api/webhook/call-tracker', {
        method: 'POST',
        headers: { 'X-Signature': signatureHex },
        body: form,
      });

      if (res.ok) {
        setSimStatus('Recording delivered!');
        fetchData();
      } else {
        const err = await res.json();
        setSimStatus(`Error: ${err.error}`);
      }
    } catch (err: any) {
      setSimStatus(`Error: ${err.message}`);
    } finally {
      setIsSimulating(false);
    }
  };

  // Metrics helper for Callyzer columns
  const getMetrics = () => {
    const totalCalls = callHistory.length;
    const totalDurationSec = callHistory.reduce((acc, c) => acc + (c.duration_sec || 0), 0);
    const incomingCalls = callHistory.filter((c) => c.direction === 'incoming');
    const incomingDurationSec = incomingCalls.reduce((acc, c) => acc + (c.duration_sec || 0), 0);
    const outgoingCalls = callHistory.filter((c) => c.direction === 'outgoing');
    const outgoingDurationSec = outgoingCalls.reduce((acc, c) => acc + (c.duration_sec || 0), 0);
    const missedCalls = callHistory.filter((c) => c.call_type === 'missed').length;
    const rejectedCalls = callHistory.filter((c) => c.call_type === 'rejected').length;
    const neverAttended = callHistory.filter((c) => c.call_type === 'not_connected' && c.direction === 'incoming').length;
    const notPickedByClient = callHistory.filter((c) => c.call_type === 'not_connected' && c.direction === 'outgoing').length;
    const connectedCalls = callHistory.filter((c) => c.call_type === 'answered').length;

    const formatDur = (sec: number) => {
      if (sec === 0) return '-';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `0h ${m}m ${s}s`;
    };

    return {
      totalCalls,
      totalDuration: formatDur(totalDurationSec),
      incomingCount: incomingCalls.length,
      incomingDuration: formatDur(incomingDurationSec),
      outgoingCount: outgoingCalls.length,
      outgoingDuration: formatDur(outgoingDurationSec),
      missedCalls,
      rejectedCalls,
      neverAttended,
      notPickedByClient,
      connectedCalls,
    };
  };

  const metrics = getMetrics();

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f1f5f9', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Dark Left Sidebar */}
      <aside style={{ width: '100px', backgroundColor: '#1e2029', color: '#94a3b8', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '24px', borderRight: '1px solid #2d303e' }}>
        {/* Sidebar Nav Items */}
        <nav style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[
            { id: 'dashboard', label: 'Dashboard', icon: '⏱️' },
            { id: 'reports', label: 'Reports', icon: '📋' },
            { id: 'fleet', label: 'Fleet', icon: '📱' },
            { id: 'logs', label: 'Raw Logs', icon: '📥' },
            { id: 'webhook', label: 'Webhook URL', icon: '🔗' },
            { id: 'simulator', label: 'Simulator', icon: '⚡' },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              style={{
                width: '100%',
                padding: '12px 4px',
                border: 'none',
                backgroundColor: activeTab === item.id ? '#282b37' : 'transparent',
                color: activeTab === item.id ? '#f59e0b' : '#94a3b8',
                borderLeft: activeTab === item.id ? '4px solid #f59e0b' : '4px solid transparent',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                fontWeight: activeTab === item.id ? 'bold' : 'normal',
              }}
            >
              <span style={{ fontSize: '18px' }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Right Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Top Navbar */}
        <header style={{ height: '60px', backgroundColor: '#ffffff', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1e293b', margin: 0 }}>
            Webspecia <span style={{ fontSize: '12px', fontWeight: 'normal', color: '#64748b', marginLeft: '8px' }}>Call Tracker CRM Panel</span>
          </h1>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Live indicator tag */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: '16px', backgroundColor: activeCalls.length > 0 ? '#fef3c7' : '#ecfdf5', color: activeCalls.length > 0 ? '#b45309' : '#047857', fontSize: '12px', fontWeight: 'bold' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: activeCalls.length > 0 ? '#f59e0b' : '#10b981' }} />
              {activeCalls.length > 0 ? `${activeCalls.length} Active Call` : 'Fleet Idle'}
            </span>

            <button
              onClick={fetchData}
              style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', backgroundColor: '#f8fafc', color: '#475569', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}
            >
              🔄 Refresh
            </button>
          </div>
        </header>

        {/* Dynamic Body Content */}
        <main style={{ padding: '24px', flex: 1, overflowY: 'auto' }}>
          {activeTab === 'dashboard' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* Live Active Call Alert Banner */}
              {activeCalls.length > 0 && (
                <div style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '16px' }}>
                  <h3 style={{ margin: '0 0 12px 0', fontSize: '15px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    🚨 Live Active Call Monitored
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                    {activeCalls.map((call) => (
                      <div key={call.call_uuid} style={{ backgroundColor: '#ffffff', border: '1px solid #fcd34d', borderRadius: '6px', padding: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#b45309' }}>{call.agent_id}</span>
                          <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#fef3c7', color: '#92400e', fontWeight: 'bold' }}>
                            {call.state.toUpperCase()}
                          </span>
                        </div>
                        <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#1e293b', marginTop: '6px' }}>
                          {call.number || 'Unknown Number'}
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
                          Direction: {call.direction} • SIM: {call.sim_slot !== null ? call.sim_slot + 1 : 'N/A'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 3-Column Callyzer Stat Cards (Today, Yesterday, Last Week) */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>
                {/* Column 1: Today */}
                <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '16px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1e293b', margin: 0 }}>Today</h2>
                    <span style={{ fontSize: '12px', color: '#94a3b8' }}>03 Aug 2026</span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    {/* Total Calls */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b' }}>{metrics.totalCalls}</div>
                      <div style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        📞 Total Calls
                      </div>
                    </div>
                    {/* Call Duration */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#1e293b' }}>{metrics.totalDuration}</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>⏱️ Call Duration</div>
                    </div>

                    {/* Incoming */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#16a34a' }}>{metrics.incomingCount}</div>
                      <div style={{ fontSize: '11px', color: '#16a34a' }}>↙️ Incoming</div>
                    </div>
                    {/* Incoming Duration */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#16a34a' }}>{metrics.incomingDuration}</div>
                      <div style={{ fontSize: '11px', color: '#16a34a' }}>↙️ Incoming Duration</div>
                    </div>

                    {/* Outgoing */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ea580c' }}>{metrics.outgoingCount}</div>
                      <div style={{ fontSize: '11px', color: '#ea580c' }}>↗️ Outgoing</div>
                    </div>
                    {/* Outgoing Duration */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#ea580c' }}>{metrics.outgoingDuration}</div>
                      <div style={{ fontSize: '11px', color: '#ea580c' }}>↗️ Outgoing Duration</div>
                    </div>

                    {/* Missed */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#dc2626' }}>{metrics.missedCalls}</div>
                      <div style={{ fontSize: '11px', color: '#dc2626' }}>↩️ Missed</div>
                    </div>
                    {/* Rejected */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#dc2626' }}>{metrics.rejectedCalls}</div>
                      <div style={{ fontSize: '11px', color: '#dc2626' }}>🚫 Rejected</div>
                    </div>

                    {/* Never Attended */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444' }}>{metrics.neverAttended}</div>
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>🚫 Never Attended</div>
                    </div>
                    {/* Not Pickup by Client */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444' }}>{metrics.notPickedByClient}</div>
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>🚫 Not Pickup by Client</div>
                    </div>

                    {/* Connected Calls */}
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px', gridColumn: 'span 2' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#2563eb' }}>{metrics.connectedCalls}</div>
                      <div style={{ fontSize: '11px', color: '#2563eb' }}>📞 Connected Calls</div>
                    </div>
                  </div>
                </div>

                {/* Column 2: Yesterday */}
                <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '16px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1e293b', margin: 0 }}>Yesterday</h2>
                    <span style={{ fontSize: '12px', color: '#94a3b8' }}>02 Aug 2026</span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>📞 Total Calls</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#94a3b8' }}>-</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>⏱️ Call Duration</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#16a34a' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#16a34a' }}>↙️ Incoming</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#94a3b8' }}>-</div>
                      <div style={{ fontSize: '11px', color: '#16a34a' }}>↙️ Incoming Duration</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ea580c' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#ea580c' }}>↗️ Outgoing</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#94a3b8' }}>-</div>
                      <div style={{ fontSize: '11px', color: '#ea580c' }}>↗️ Outgoing Duration</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#dc2626' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#dc2626' }}>↩️ Missed</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#dc2626' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#dc2626' }}>🚫 Rejected</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>🚫 Never Attended</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>🚫 Not Pickup by Client</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px', gridColumn: 'span 2' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#2563eb' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#2563eb' }}>📞 Connected Calls</div>
                    </div>
                  </div>
                </div>

                {/* Column 3: Last Week */}
                <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '16px' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1e293b', margin: 0 }}>Last Week</h2>
                    <span style={{ fontSize: '12px', color: '#94a3b8' }}>27 Jul to 02 Aug</span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>📞 Total Calls</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#1e293b' }}>-</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>⏱️ Call Duration</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#16a34a' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#16a34a' }}>↙️ Incoming</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#16a34a' }}>-</div>
                      <div style={{ fontSize: '11px', color: '#16a34a' }}>↙️ Incoming Duration</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ea580c' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#ea580c' }}>↗️ Outgoing</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#ea580c' }}>-</div>
                      <div style={{ fontSize: '11px', color: '#ea580c' }}>↗️ Outgoing Duration</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#dc2626' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#dc2626' }}>↩️ Missed</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#dc2626' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#dc2626' }}>🚫 Rejected</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>🚫 Never Attended</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>🚫 Not Pickup by Client</div>
                    </div>
                    <div style={{ backgroundColor: '#f8fafc', padding: '10px 12px', borderRadius: '6px', gridColumn: 'span 2' }}>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#2563eb' }}>0</div>
                      <div style={{ fontSize: '11px', color: '#2563eb' }}>📞 Connected Calls</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'reports' && (
            <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b', margin: 0 }}>
                  📋 Detailed Call Logs
                </h2>
                <select
                  value={reportsAgentFilter}
                  onChange={(e) => setReportsAgentFilter(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px', color: '#334155' }}
                >
                  <option value="all">All Agents</option>
                  {uniqueAgentIds.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', color: '#0f172a' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#334155', textAlign: 'left' }}>
                    <th style={{ padding: '12px' }}>Agent</th>
                    <th style={{ padding: '12px' }}>Number</th>
                    <th style={{ padding: '12px' }}>Direction</th>
                    <th style={{ padding: '12px' }}>Call Type</th>
                    <th style={{ padding: '12px' }}>Duration</th>
                    <th style={{ padding: '12px' }}>Recording</th>
                    <th style={{ padding: '12px' }}>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {callHistory
                    .filter((c) => reportsAgentFilter === 'all' || c.agent_id === reportsAgentFilter)
                    .map((c) => (
                      <tr key={c.call_uuid} style={{ borderBottom: '1px solid #e2e8f0', color: '#0f172a' }}>
                        <td style={{ padding: '12px', fontWeight: 'bold', color: '#0f172a' }}>{c.agent_id}</td>
                        <td style={{ padding: '12px', color: '#0f172a', fontWeight: '600' }}>{c.number || 'Unknown'}</td>
                        <td style={{ padding: '12px' }}>
                          <span style={{
                            padding: '3px 8px',
                            borderRadius: '4px',
                            fontWeight: 'bold',
                            fontSize: '11px',
                            backgroundColor: c.direction === 'incoming' ? '#dcfce7' : '#ffedd5',
                            color: c.direction === 'incoming' ? '#15803d' : '#c2410c'
                          }}>
                            {c.direction === 'incoming' ? '↙️ Incoming' : '↗️ Outgoing'}
                          </span>
                        </td>
                        <td style={{ padding: '12px' }}>
                          <span style={{
                            padding: '3px 8px',
                            borderRadius: '4px',
                            fontWeight: 'bold',
                            fontSize: '11px',
                            backgroundColor: c.call_type === 'answered' ? '#dbeafe' : '#fee2e2',
                            color: c.call_type === 'answered' ? '#1d4ed8' : '#b91c1c'
                          }}>
                            {c.call_type}
                          </span>
                        </td>
                        <td style={{ padding: '12px', color: '#0f172a', fontWeight: 'bold' }}>{c.duration_sec}s</td>
                        <td style={{ padding: '12px' }}>
                          {c.recording ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <span style={{ color: '#2563eb', fontWeight: 600, fontSize: '12px' }} title={`${c.recording.file_name} (${Math.round(c.recording.file_size_bytes / 1024)} KB)`}>
                                🎙️ {c.recording.file_name}
                              </span>
                              {c.recording.recording_url ? (
                                <audio controls src={c.recording.recording_url} style={{ height: '32px', width: '180px' }} />
                              ) : (
                                <span style={{ fontSize: '11px', color: '#64748b' }}>Ready</span>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: '#94a3b8' }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '12px', color: '#475569', fontWeight: '500' }}>{new Date(c.ended_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  {callHistory.filter((c) => reportsAgentFilter === 'all' || c.agent_id === reportsAgentFilter).length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>
                        No calls for this agent yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'fleet' && (
            <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b', marginBottom: '16px' }}>
                📱 Telecalling Agent Fleet Status
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
                {devices.map((dev) => (
                  <div key={dev.device_id} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '16px', backgroundColor: '#f8fafc' }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', color: '#1e293b' }}>{dev.agent_id}</h3>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>Device: {dev.device_id}</div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>Last seen: {timeAgo(dev.last_seen)}</div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                      Last connection test: {timeAgo(dev.last_connection_test)}
                    </div>

                    <div
                      style={{
                        fontSize: '12px',
                        marginTop: '10px',
                        fontWeight: 'bold',
                        color: dev.battery_optimization_off === true ? '#047857' : dev.battery_optimization_off === false ? '#dc2626' : '#64748b',
                      }}
                    >
                      {dev.battery_optimization_off === true && '✅ Battery optimisation off'}
                      {dev.battery_optimization_off === false && '❌ Battery optimisation ON (needs fixing)'}
                      {dev.battery_optimization_off === null && '❔ Battery status not yet reported'}
                    </div>

                    {/* Autostart cannot be verified by any Android API — always shown amber, self-reported only. See ARCHITECTURE.md §8. */}
                    <div style={{ fontSize: '12px', color: '#d97706', marginTop: '6px', fontWeight: 'bold' }}>
                      ⚠️ Autostart: UNVERIFIED (Self-reported — cannot be verified by the app)
                    </div>
                  </div>
                ))}
                {devices.length === 0 && (
                  <div style={{ color: '#94a3b8', fontSize: '13px' }}>No devices have reported in yet.</div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* DB Fallback Diagnostic Box */}
              {fallbackLogs.length > 0 && (
                <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '16px' }}>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', color: '#991b1b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    ⚠️ DB Failure Diagnostic Logs ({fallbackLogs.length} Events Fallbacked)
                  </h3>
                  <p style={{ fontSize: '12px', color: '#7f1d1d', margin: '0 0 12px 0' }}>
                    Database connection or write failed. Events were safely captured via the local logger fallback system. Inspect root causes below:
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '250px', overflowY: 'auto' }}>
                    {fallbackLogs.map((log) => (
                      <div key={log.id} style={{ backgroundColor: '#ffffff', border: '1px solid #fecaca', borderRadius: '6px', padding: '12px', fontSize: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ fontWeight: 'bold', color: '#dc2626' }}>🚨 [{log.errorCode}] {log.eventType}</span>
                          <span style={{ color: '#64748b', fontSize: '11px' }}>{new Date(log.timestamp).toLocaleString()}</span>
                        </div>
                        <div style={{ color: '#991b1b', fontWeight: 'bold', margin: '4px 0' }}>
                          💡 Root Cause: {log.rootCauseAnalysis}
                        </div>
                        <div style={{ color: '#475569', fontSize: '11px', fontFamily: 'monospace' }}>
                          Error: {log.errorMessage}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b', margin: 0 }}>
                    📥 Inbound Central Webhook Ingestion Logs (PostgreSQL)
                  </h2>
                  <span style={{ fontSize: '12px', color: '#64748b', backgroundColor: '#e2e8f0', padding: '4px 10px', borderRadius: '12px' }}>
                    {webhookLogs.length} events logged
                  </span>
                </div>
                <p style={{ fontSize: '12px', color: '#64748b', marginTop: 0, marginBottom: '16px' }}>
                  Central Ingestion Pipeline: All incoming webhook requests from external applications are logged here raw into PostgreSQL first, then routed to Agent IDs.
                </p>
                <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569', textAlign: 'left' }}>
                      <th style={{ padding: '10px' }}>ID</th>
                      <th style={{ padding: '10px' }}>Timestamp</th>
                      <th style={{ padding: '10px' }}>Event Type</th>
                      <th style={{ padding: '10px' }}>Agent ID</th>
                      <th style={{ padding: '10px' }}>Device ID</th>
                      <th style={{ padding: '10px' }}>Call UUID</th>
                      <th style={{ padding: '10px' }}>Status</th>
                      <th style={{ padding: '10px' }}>Raw Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {webhookLogs.map((log) => (
                      <tr key={log.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '10px', color: '#94a3b8' }}>#{log.id}</td>
                        <td style={{ padding: '10px', color: '#64748b', whiteSpace: 'nowrap' }}>
                          {new Date(log.created_at).toLocaleString()}
                        </td>
                        <td style={{ padding: '10px' }}>
                          <span style={{
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontWeight: 'bold',
                            fontSize: '11px',
                            backgroundColor: log.event_type === 'recording_ready' ? '#ede9fe' : log.event_type === 'call_record' ? '#dbeafe' : log.event_type === 'live_state' ? '#fef3c7' : '#f1f5f9',
                            color: log.event_type === 'recording_ready' ? '#6d28d9' : log.event_type === 'call_record' ? '#1e40af' : log.event_type === 'live_state' ? '#92400e' : '#334155',
                          }}>
                            {log.event_type}
                          </span>
                        </td>
                        <td style={{ padding: '10px', fontWeight: 'bold', color: '#0f172a' }}>{log.agent_id || '—'}</td>
                        <td style={{ padding: '10px', color: '#334155' }}>{log.device_id || '—'}</td>
                        <td style={{ padding: '10px', fontFamily: 'monospace', fontSize: '11px', color: '#0f172a', fontWeight: '600' }}>{log.call_uuid || '—'}</td>
                        <td style={{ padding: '10px' }}>
                          <span style={{ color: '#16a34a', fontWeight: 'bold', fontSize: '11px' }}>
                            ✓ {log.status}
                          </span>
                        </td>
                        <td style={{ padding: '10px' }}>
                          <details>
                            <summary style={{ cursor: 'pointer', color: '#2563eb', fontSize: '11px' }}>View JSON</summary>
                            <pre style={{ backgroundColor: '#0f172a', color: '#38bdf8', padding: '8px', borderRadius: '4px', fontSize: '10px', maxWidth: '300px', overflowX: 'auto', margin: '4px 0 0 0' }}>
                              {JSON.stringify(log.payload, null, 2)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                    {webhookLogs.length === 0 && (
                      <tr>
                        <td colSpan={8} style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>
                          No raw webhook logs recorded in PostgreSQL yet. Send an event from the Simulator or external application.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'webhook' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '800px' }}>
              <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b', marginTop: 0, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  🔗 Inbound Webhook Integration Details
                </h2>
                <p style={{ fontSize: '13px', color: '#64748b', marginTop: 0, marginBottom: '20px' }}>
                  Use this Webhook Endpoint URL and Secret Key in your external mobile app, telephony server, or third-party service to send call events directly to this CRM panel.
                </p>

                {/* Webhook Endpoint Box */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#334155', marginBottom: '6px' }}>
                    🌐 1. Webhook Endpoint URL:
                  </label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      type="text"
                      readOnly
                      value={typeof window !== 'undefined' ? `${window.location.origin}/api/webhook/call-tracker` : 'http://localhost:3000/api/webhook/call-tracker'}
                      style={{ flex: 1, padding: '10px 14px', borderRadius: '6px', border: '1px solid #cbd5e1', backgroundColor: '#f8fafc', fontSize: '13px', fontFamily: 'monospace', fontWeight: 'bold', color: '#0f172a' }}
                    />
                    <button
                      onClick={() => {
                        const url = typeof window !== 'undefined' ? `${window.location.origin}/api/webhook/call-tracker` : 'http://localhost:3000/api/webhook/call-tracker';
                        navigator.clipboard.writeText(url);
                        setCopiedUrl(true);
                        setTimeout(() => setCopiedUrl(false), 2000);
                      }}
                      style={{ padding: '10px 18px', borderRadius: '6px', border: 'none', backgroundColor: copiedUrl ? '#16a34a' : '#2563eb', color: '#ffffff', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                      {copiedUrl ? '✓ Copied!' : '📋 Copy URL'}
                    </button>
                  </div>
                  <span style={{ fontSize: '11px', color: '#64748b', marginTop: '4px', display: 'block' }}>
                    💡 Note for Physical Android Devices: If testing from an external network, expose port 3000 via <code>npx ngrok http 3000</code> and paste your ngrok URL.
                  </span>
                </div>

                {/* Webhook Secret Box */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#334155', marginBottom: '6px' }}>
                    🔑 2. Webhook Secret (HMAC X-Signature):
                  </label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      type="text"
                      readOnly
                      value={secret}
                      style={{ flex: 1, padding: '10px 14px', borderRadius: '6px', border: '1px solid #cbd5e1', backgroundColor: '#f8fafc', fontSize: '13px', fontFamily: 'monospace', fontWeight: 'bold', color: '#0f172a' }}
                    />
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(secret);
                        setCopiedSecret(true);
                        setTimeout(() => setCopiedSecret(false), 2000);
                      }}
                      style={{ padding: '10px 18px', borderRadius: '6px', border: '1px solid #cbd5e1', backgroundColor: copiedSecret ? '#ecfdf5' : '#ffffff', color: copiedSecret ? '#047857' : '#334155', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                      {copiedSecret ? '✓ Copied Secret!' : '📋 Copy Secret'}
                    </button>
                  </div>
                </div>

                {/* HTTP Headers & Payload Format Guide */}
                <div style={{ backgroundColor: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0', padding: '16px' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#1e293b' }}>⚙️ Required HTTP Request Headers</h4>
                  <pre style={{ backgroundColor: '#0f172a', color: '#38bdf8', padding: '10px', borderRadius: '6px', fontSize: '12px', overflowX: 'auto', margin: '0 0 12px 0' }}>
{`POST /api/webhook/call-tracker HTTP/1.1
Content-Type: application/json
X-Signature: <sha256_hmac_hex_of_raw_body_using_secret>`}
                  </pre>

                  <h4 style={{ margin: '8px 0 8px 0', fontSize: '13px', color: '#1e293b' }}>📦 Example JSON Event Payload</h4>
                  <pre style={{ backgroundColor: '#0f172a', color: '#4ade80', padding: '10px', borderRadius: '6px', fontSize: '12px', overflowX: 'auto', margin: 0 }}>
{`{
  "type": "call_record",
  "call_uuid": "550e8400-e29b-41d4-a716-446655440001",
  "agent_id": "AGENT_101",
  "device_id": "DEV_SIM_O1",
  "direction": "incoming",
  "call_type": "answered",
  "duration_sec": 120,
  "number": "+919876543210",
  "started_at": "2026-08-03T16:00:00Z",
  "ended_at": "2026-08-03T16:02:00Z",
  "ts": "2026-08-03T16:02:00Z"
}`}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'simulator' && (
            <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px', maxWidth: '600px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: '#1e293b', marginBottom: '12px' }}>
                ⚡ Webhook Call Simulator
              </h2>
              <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '16px' }}>
                Simulate Android Call Tracker HMAC events directly to test dashboard UI responsiveness.
              </p>

              <label style={{ display: 'block', fontSize: '12px', color: '#475569', fontWeight: 600, marginBottom: '6px' }}>
                Simulate as agent
              </label>
              <select
                value={simAgentId}
                onChange={(e) => setSimAgentId(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '13px', marginBottom: '16px', width: '100%' }}
              >
                {['AGENT_101', 'AGENT_102', 'AGENT_103'].map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button
                  onClick={() => simulateCall('connection_test')}
                  disabled={isSimulating}
                  style={{ padding: '12px', backgroundColor: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  0. Send Connection Test (onboarding)
                </button>
                <button
                  onClick={() => simulateCall('incoming_ringing')}
                  disabled={isSimulating}
                  style={{ padding: '12px', backgroundColor: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  1. Trigger Ringing (Incoming)
                </button>
                <button
                  onClick={() => simulateCall('outgoing_offhook')}
                  disabled={isSimulating}
                  style={{ padding: '12px', backgroundColor: '#ffedd5', color: '#c2410c', border: '1px solid #fdba74', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  2. Trigger Offhook (Outgoing)
                </button>
                <button
                  onClick={() => simulateCall('call_record_answered')}
                  disabled={isSimulating}
                  style={{ padding: '12px', backgroundColor: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  3. Send Call Record (Event B)
                </button>
                <button
                  onClick={simulateRecording}
                  disabled={isSimulating || !lastCallUuid}
                  style={{ padding: '12px', backgroundColor: lastCallUuid ? '#ede9fe' : '#f1f5f9', color: lastCallUuid ? '#6d28d9' : '#94a3b8', border: '1px solid #c4b5fd', borderRadius: '6px', fontWeight: 'bold', cursor: lastCallUuid ? 'pointer' : 'not-allowed' }}
                >
                  4. Attach Recording (Event C, multipart){!lastCallUuid && ' — send #3 first'}
                </button>
              </div>

              {simStatus && (
                <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '12px', color: '#2563eb' }}>
                  {simStatus}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
