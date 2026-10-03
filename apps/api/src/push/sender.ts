/**
 * Sending push notifications (P14), through Expo's push service.
 *
 * Expo relays to Apple and Google, so one integration covers both platforms and
 * the server holds no APNs or FCM credentials of its own; those live in the EAS
 * project. Sending returns a ticket per message; whether Apple or Google took it
 * is known only from the receipt, fetched later. Either can say a token is no
 * longer registered, and the token is then disabled.
 */

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Android notification channel. `urgent` is set up on the phone to sound through. */
  channelId: 'jobs' | 'urgent';
  priority: 'default' | 'high';
}

export type PushTicket =
  { status: 'ok'; id: string } | { status: 'error'; message: string; notRegistered: boolean };

export type PushReceipt =
  { status: 'ok' } | { status: 'error'; message: string; notRegistered: boolean };

export interface PushSender {
  readonly provider: string;
  /** One ticket per message, in order. Throws when the service cannot be reached. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  /** Receipts for tickets that have them; a ticket not yet ready is left out. */
  receipts(ticketIds: readonly string[]): Promise<Map<string, PushReceipt>>;
}

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo accepts up to 100 messages, and up to 1000 receipt ids, per request. */
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 1000;

interface ExpoError {
  status: 'error';
  message?: string;
  details?: { error?: string };
}

export class ExpoPushSender implements PushSender {
  readonly provider = 'expo';
  readonly #accessToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: { accessToken?: string | undefined; fetch?: typeof fetch } = {}) {
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let start = 0; start < messages.length; start += SEND_CHUNK) {
      const chunk = messages.slice(start, start + SEND_CHUNK);
      const body = (await this.#post(
        SEND_URL,
        chunk.map((message) => ({ ...message, sound: 'default' })),
      )) as {
        data?: ({ status: 'ok'; id: string } | ExpoError)[];
      };
      const data = body.data ?? [];
      chunk.forEach((_, index) => {
        const ticket = data[index];
        tickets.push(
          ticket === undefined
            ? { status: 'error', message: 'No ticket returned.', notRegistered: false }
            : ticket.status === 'ok'
              ? { status: 'ok', id: ticket.id }
              : {
                  status: 'error',
                  message: ticket.message ?? 'Push refused.',
                  notRegistered: ticket.details?.error === 'DeviceNotRegistered',
                },
        );
      });
    }
    return tickets;
  }

  async receipts(ticketIds: readonly string[]): Promise<Map<string, PushReceipt>> {
    const receipts = new Map<string, PushReceipt>();
    for (let start = 0; start < ticketIds.length; start += RECEIPT_CHUNK) {
      const body = (await this.#post(RECEIPTS_URL, {
        ids: ticketIds.slice(start, start + RECEIPT_CHUNK),
      })) as { data?: Record<string, { status: 'ok' } | ExpoError> };
      for (const [id, receipt] of Object.entries(body.data ?? {})) {
        receipts.set(
          id,
          receipt.status === 'ok'
            ? { status: 'ok' }
            : {
                status: 'error',
                message: receipt.message ?? 'Push not delivered.',
                notRegistered: receipt.details?.error === 'DeviceNotRegistered',
              },
        );
      }
    }
    return receipts;
  }

  async #post(url: string, payload: unknown): Promise<unknown> {
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(this.#accessToken === undefined
          ? {}
          : { authorization: `Bearer ${this.#accessToken}` }),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Expo push answered ${String(response.status)}.`);
    }
    return response.json();
  }
}

/**
 * Keeps what would have been sent, for development and tests. A token containing
 * `unregistered` is refused the way Expo refuses a phone that uninstalled the app.
 */
export class RecordingPushSender implements PushSender {
  readonly provider = 'recording';
  readonly sent: PushMessage[] = [];
  #next = 0;

  send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    return Promise.resolve(
      messages.map((message) => {
        this.sent.push(message);
        if (message.to.includes('unregistered')) {
          return { status: 'error', message: 'DeviceNotRegistered', notRegistered: true };
        }
        this.#next += 1;
        return { status: 'ok', id: `ticket-${String(this.#next)}` };
      }),
    );
  }

  receipts(ticketIds: readonly string[]): Promise<Map<string, PushReceipt>> {
    return Promise.resolve(new Map(ticketIds.map((id) => [id, { status: 'ok' } as const])));
  }
}
