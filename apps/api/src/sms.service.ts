type SmsResult = {
  provider: string;
  messageId?: string;
};

function digitsOnly(phone: string) {
  return phone.replace(/\D/g, '');
}

export async function sendSms(phone: string, text: string): Promise<SmsResult> {
  const provider = (process.env.SMS_PROVIDER ?? (process.env.NODE_ENV === 'production' ? 'disabled' : 'console')).toLowerCase();

  if (provider === 'console') {
    console.info('[sms:console]', { phone, text });
    return { provider: 'console' };
  }

  if (provider === 'mobizon') {
    const apiKey = process.env.MOBIZON_API_KEY;
    if (!apiKey) throw new Error('MOBIZON_API_KEY is required for SMS_PROVIDER=mobizon');

    const body = new URLSearchParams({
      recipient: digitsOnly(phone),
      text,
    });
    const sender = process.env.MOBIZON_SENDER?.trim();
    if (sender) body.set('from', sender);

    const url = new URL('https://api.mobizon.kz/service/message/sendSmsMessage');
    url.searchParams.set('output', 'json');
    url.searchParams.set('api', 'v1');
    url.searchParams.set('apiKey', apiKey);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json() as {
      code?: number;
      message?: string;
      data?: { messageId?: number | string };
    };

    if (!response.ok || payload.code !== 0) {
      throw new Error(`Mobizon SMS failed: ${payload.message || response.statusText}`);
    }

    return {
      provider: 'mobizon',
      messageId: payload.data?.messageId == null ? undefined : String(payload.data.messageId),
    };
  }

  throw new Error('SMS delivery is not configured');
}
