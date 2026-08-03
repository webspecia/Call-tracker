import { NextResponse } from 'next/server';
import { getFallbackLogs } from '@/lib/logger';

export async function GET() {
  const logs = getFallbackLogs();
  return NextResponse.json({
    success: true,
    count: logs.length,
    fallback_logs: logs,
  });
}
