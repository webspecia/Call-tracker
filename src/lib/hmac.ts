import crypto from 'crypto';

export function verifyHmacSignature(
  rawBodyText: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader || !secret) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBodyText, 'utf8');
  const expectedSignature = hmac.digest('hex').toLowerCase();

  const cleanHeader = signatureHeader.trim().toLowerCase();
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(cleanHeader),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}
