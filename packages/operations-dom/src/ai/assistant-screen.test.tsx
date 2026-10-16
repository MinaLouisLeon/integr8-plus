import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCapabilities, AiConversation, AiMessage, AiProposal } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { AssistantScreen } from './assistant-screen.js';

const CONVERSATION = '00000000-0000-4000-8000-000000000a01';
const PROPOSAL = '00000000-0000-4000-8000-000000000a02';
const CUSTOMER = '00000000-0000-4000-8000-000000000301';
// The next UTC midnight, so the reset is still to come whenever the suite runs:
// a fixed date turned into one in the past and reopened the composer.
const NOW = new Date();
const RESET = new Date(
  Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + 1),
).toISOString();

function allowance(remainingPercent: number | null, exhausted = false) {
  return { remainingPercent, resetsAt: remainingPercent === null ? null : RESET, exhausted };
}

function capabilities(overrides: Partial<AiCapabilities> = {}): AiCapabilities {
  return {
    level: 'help',
    blockedBy: null,
    channel: 'web',
    answerSource: 'model',
    tools: [],
    companyDataToProvider: false,
    locales: ['en', 'ar'],
    historyTurns: 6,
    allowHistory: true,
    usage: { allowance: allowance(62), sharePercent: 20, company: null },
    ...overrides,
  };
}

const conversation: AiConversation = {
  id: CONVERSATION,
  title: 'Boiler forms',
  locale: 'en',
  level: 'help',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

function message(overrides: Partial<AiMessage> = {}): AiMessage {
  return {
    id: '00000000-0000-4000-8000-000000000b01',
    role: 'assistant',
    text: 'Open Work orders and choose New.',
    sources: [
      {
        kind: 'help',
        articleKey: 'work-orders',
        label: 'Work orders',
        appRoute: 'workOrders',
        helpUrl: null,
      },
    ],
    toolSummaries: [],
    actionProposal: null,
    createdAt: '2026-10-01T09:00:05.000Z',
    ...overrides,
  };
}

function proposal(overrides: Partial<AiProposal> = {}): AiProposal {
  return {
    id: PROPOSAL,
    toolKey: 'customers.create',
    state: 'pending',
    preview: {
      title: 'Add customer Riverside Housing',
      fields: [{ label: 'Name', value: 'Riverside Housing' }],
      warnings: ['A customer with a similar name exists.'],
    },
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    createdAt: '2026-10-01T09:00:05.000Z',
    result: null,
    errorCode: null,
    ...overrides,
  };
}

/** The assistant with one conversation open, as every test but the first starts. */
async function openConversation(messages: AiMessage[]) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^Boiler forms/u }));
  if (messages.length > 0) {
    await screen.findByText(messages[0]!.text);
  }
  return user;
}

describe('AssistantScreen', () => {
  it('explains why there is nothing here when the assistant is off, and offers no composer', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/ai/capabilities': () => ({
        body: capabilities({ level: 'off', blockedBy: 'plan_off' }),
      }),
    });
    const { container } = renderScreen(<AssistantScreen />, client);

    expect(
      await screen.findByText(/not included in your company’s subscription/u),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/ai/conversations')).toBe(false);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('says a member with no share has no assistant yet, and offers no composer', async () => {
    const { client } = fakeApi({
      'GET /v1/ai/capabilities': () => ({
        body: capabilities({
          level: 'off',
          blockedBy: 'no_share',
          usage: { allowance: allowance(null), sharePercent: null, company: null },
        }),
      }),
    });
    renderScreen(<AssistantScreen />, client);

    expect(
      await screen.findByText(/not been given a share of your company’s assistant allowance/u),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('says when answers come from the help guide rather than a model (ADR-0002 D10)', async () => {
    const { client } = fakeApi({
      'GET /v1/ai/capabilities': () => ({
        body: capabilities({
          answerSource: 'library',
          usage: { allowance: allowance(80), sharePercent: null, company: null },
        }),
      }),
      'GET /v1/ai/conversations': () => ({ body: { items: [] } }),
    });
    renderScreen(<AssistantScreen />, client);

    expect(await screen.findByText(/help guide’s own articles/u)).toBeInTheDocument();
    expect(screen.queryByText(/^Answers from the help library only\./u)).not.toBeInTheDocument();
    // No share is needed, and nothing says one is.
    expect(screen.queryByText(/not been given a share/u)).not.toBeInTheDocument();
  });

  it('shows what is left as a percentage only, and no bar when nothing is limited', async () => {
    const { client } = fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities() }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
    });
    const { unmount } = renderScreen(<AssistantScreen />, client);

    const bar = await screen.findByRole('progressbar', { name: 'Your assistant allowance' });
    expect(bar).toHaveAttribute('aria-valuenow', '62');
    expect(screen.getByText(/^62% of your allowance left · resets /u)).toBeInTheDocument();
    unmount();

    const { client: unlimited } = fakeApi({
      'GET /v1/ai/capabilities': () => ({
        body: capabilities({
          usage: { allowance: allowance(null), sharePercent: 20, company: null },
        }),
      }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
    });
    renderScreen(<AssistantScreen />, unlimited);
    expect(await screen.findByRole('button', { name: /^Boiler forms/u })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/of your allowance left/u)).not.toBeInTheDocument();
  });

  it('closes the composer while the allowance is used up, saying when it resets', async () => {
    const { client } = fakeApi({
      'GET /v1/ai/capabilities': () => ({
        body: capabilities({
          usage: { allowance: allowance(0, true), sharePercent: 20, company: null },
        }),
      }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [] } }),
    });
    renderScreen(<AssistantScreen />, client);
    await openConversation([]);

    expect(screen.getByText(/^Allowance used up · resets /u)).toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(
      screen.getByText(/Your assistant allowance is used up\. It resets/u),
    ).toBeInTheDocument();
  });

  it('sends a question with an idempotency key, shows the answer and updates the meter', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities() }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [] } }),
      'POST /v1/ai/conversations/:id/messages': () => ({
        body: {
          message: message(),
          allowance: allowance(58),
          replayed: false,
        },
      }),
    });
    const { container, navigate } = renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    expect(screen.getByText(/^62% of your allowance left/u)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your question'), 'How do I add a job?{Enter}');

    expect(await screen.findByText('Open Work orders and choose New.')).toBeInTheDocument();
    expect(screen.getByText('How do I add a job?')).toBeInTheDocument();
    expect(screen.getByText(/^58% of your allowance left/u)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '58');
    expect(screen.getByLabelText('Your question')).toHaveValue('');

    const sent = calls.find((call) => call.method === 'POST');
    expect(sent?.body).toEqual({ message: 'How do I add a job?', locale: 'en' });

    await user.click(screen.getByRole('link', { name: 'Work orders' }));
    expect(navigate).toHaveBeenCalledWith('/work-orders');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('confirms a prepared action and shows the result only once the server says it is done', async () => {
    const pending = message({
      text: 'I can add this customer for you.',
      sources: [],
      actionProposal: proposal(),
    });
    const { client, calls } = fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities({ level: 'agent' }) }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [pending] } }),
      'POST /v1/ai/actions/:id/confirm': () => ({
        body: proposal({
          state: 'completed',
          result: {
            resourceType: 'customer',
            resourceId: CUSTOMER,
            summary: 'Riverside Housing was added.',
            appRoute: 'customers',
          },
        }),
      }),
    });
    const { navigate } = renderScreen(<AssistantScreen />, client);
    const user = await openConversation([pending]);

    const card = screen.getByRole('region', { name: 'A change the assistant prepared' });
    expect(within(card).getByText('Waiting for you')).toBeInTheDocument();
    expect(within(card).getByText('A customer with a similar name exists.')).toBeInTheDocument();
    expect(within(card).getByText(/Expires in \d+:\d\d/u)).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Confirm' }));

    expect(await within(card).findByText('Done')).toBeInTheDocument();
    expect(within(card).getByText('Riverside Housing was added.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    await user.click(within(card).getByRole('link', { name: 'Open the record' }));
    expect(navigate).toHaveBeenCalledWith(`/customers/${CUSTOMER}`);
    expect(calls.filter((call) => call.path.endsWith('/confirm'))).toHaveLength(1);
  });

  it('says the day’s messages are used up after a 429, keeps the question and closes the composer', async () => {
    let asked = 0;
    const { client } = fakeApi({
      'GET /v1/ai/capabilities': () => {
        asked += 1;
        return {
          body: capabilities({
            usage: {
              allowance: asked === 1 ? allowance(2) : allowance(0, true),
              sharePercent: 20,
              company: null,
            },
          }),
        };
      },
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [] } }),
      'POST /v1/ai/conversations/:id/messages': () =>
        apiError(429, 'ai_daily_quota_exceeded', 'Used up.', [
          {
            field: 'body.message',
            code: 'ai_daily_quota_exceeded',
            message: 'No messages left.',
            params: { resetsAt: RESET },
          },
        ]),
    });
    renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    await user.type(screen.getByLabelText('Your question'), 'One more?{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Today’s assistant messages are used up/u,
    );
    await waitFor(() => expect(screen.getByLabelText('Your question')).toBeDisabled());
    expect(screen.getByLabelText('Your question')).toHaveValue('One more?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(
      screen.getByText(/Your assistant allowance is used up\. It resets/u),
    ).toBeInTheDocument();
  });

  it('treats a refusal for tokens like one for messages: the composer stays closed until it resets', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities() }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [] } }),
      'POST /v1/ai/conversations/:id/messages': () =>
        apiError(429, 'ai_daily_token_quota_exceeded', 'Used up.', [
          {
            field: 'body.message',
            code: 'ai_daily_token_quota_exceeded',
            message: 'No tokens left.',
            params: { resetsAt: RESET },
          },
        ]),
    });
    renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    await user.type(screen.getByLabelText('Your question'), 'A long report?{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Today’s assistant allowance is used up/u,
    );
    await waitFor(() => expect(screen.getByLabelText('Your question')).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(
      screen.getByText(/Your assistant allowance is used up\. It resets/u),
    ).toBeInTheDocument();
    // Nothing in the refusal's words or the screen's gives a count away.
    expect(screen.queryByText(/token/iu)).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ */
/* Voice (docs/ai §10.5): the device's own recogniser and voices, faked here. */
/* ------------------------------------------------------------------------ */

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  interimResults = false;
  continuous = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
  hear(text: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: text }], { isFinal })],
    });
  }
}

class FakeUtterance {
  lang = '';
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function installVoice(options: { recognition?: boolean; synthesis?: boolean } = {}) {
  const spoken: FakeUtterance[] = [];
  const cancel = vi.fn();
  const scope = window as unknown as Record<string, unknown>;
  if (options.recognition !== false) {
    scope.SpeechRecognition = FakeRecognition;
  }
  if (options.synthesis !== false) {
    scope.speechSynthesis = { speak: (u: FakeUtterance) => spoken.push(u), cancel };
    scope.SpeechSynthesisUtterance = FakeUtterance;
  }
  return { spoken, cancel };
}

function removeVoice() {
  const scope = window as unknown as Record<string, unknown>;
  delete scope.SpeechRecognition;
  delete scope.webkitSpeechRecognition;
  delete scope.speechSynthesis;
  delete scope.SpeechSynthesisUtterance;
  FakeRecognition.last = null;
  try {
    window.localStorage.clear();
  } catch {
    // jsdom without storage: nothing to clear.
  }
}

describe('AssistantScreen voice', () => {
  beforeEach(removeVoice);
  afterEach(removeVoice);

  function modelApi(answerSource: 'model' | 'library' = 'model') {
    return fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities({ answerSource }) }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [] } }),
      'POST /v1/ai/conversations/:id/messages': () => ({
        body: { message: message(), allowance: allowance(58), replayed: false },
      }),
    });
  }

  it('puts the spoken words in the box and leaves sending to the person', async () => {
    installVoice();
    const { client, calls } = modelApi();
    renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    await user.click(screen.getByRole('button', { name: 'Speak your question' }));
    expect(FakeRecognition.last?.started).toBe(true);
    expect(FakeRecognition.last?.lang).toBe('en-GB');
    expect(await screen.findByText('Listening…')).toBeInTheDocument();

    FakeRecognition.last!.hear('How do I', false);
    await waitFor(() => expect(screen.getByLabelText('Your question')).toHaveValue('How do I'));
    FakeRecognition.last!.hear('How do I add a job', true);
    await waitFor(() =>
      expect(screen.getByLabelText('Your question')).toHaveValue('How do I add a job'),
    );
    // Nothing was sent by speaking.
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('keeps what was already typed and adds the spoken words after it', async () => {
    installVoice();
    const { client } = modelApi();
    renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    await user.type(screen.getByLabelText('Your question'), 'Quick one:');
    await user.click(screen.getByRole('button', { name: 'Speak your question' }));
    FakeRecognition.last!.hear('count the boilers', true);
    await waitFor(() =>
      expect(screen.getByLabelText('Your question')).toHaveValue('Quick one: count the boilers'),
    );
  });

  it('says so, in words, when the microphone is blocked', async () => {
    installVoice();
    const { client } = modelApi();
    renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    await user.click(screen.getByRole('button', { name: 'Speak your question' }));
    FakeRecognition.last!.onerror?.({ error: 'not-allowed' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/microphone is blocked/u);
  });

  it('shows no microphone to a company answered from the library, or where the browser has none', async () => {
    installVoice();
    const { client } = modelApi('library');
    const { unmount } = renderScreen(<AssistantScreen />, client);
    await openConversation([]);
    expect(screen.queryByRole('button', { name: 'Speak your question' })).not.toBeInTheDocument();
    unmount();

    removeVoice();
    installVoice({ recognition: false });
    const { client: model } = modelApi('model');
    renderScreen(<AssistantScreen />, model);
    await openConversation([]);
    expect(screen.queryByRole('button', { name: 'Speak your question' })).not.toBeInTheDocument();
  });

  it('points the desktop app at the operating system’s dictation instead of listening itself', async () => {
    installVoice();
    const { client } = modelApi();
    renderScreen(<AssistantScreen />, client, { voiceInput: { kind: 'dictation', os: 'windows' } });
    const user = await openConversation([]);

    await user.click(screen.getByRole('button', { name: 'Speak your question' }));
    expect(FakeRecognition.last).toBeNull();
    expect(screen.getByLabelText('Your question')).toHaveFocus();
    expect(screen.getByText(/Press Win\+H and speak/u)).toBeInTheDocument();
  });

  it('offers no microphone on a desktop with no dictation (Linux)', async () => {
    installVoice();
    const { client } = modelApi();
    renderScreen(<AssistantScreen />, client, { voiceInput: { kind: 'none' } });
    await openConversation([]);
    expect(screen.queryByRole('button', { name: 'Speak your question' })).not.toBeInTheDocument();
  });

  it('starts with reading aloud off, says so loudly, and reads nothing until it is turned on', async () => {
    const { spoken } = installVoice();
    const { client } = modelApi();
    renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    expect(screen.getByRole('note')).toHaveTextContent(/Answers can be read aloud/u);
    const toggle = screen.getByRole('button', { name: /^Read answers aloud/u });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.type(screen.getByLabelText('Your question'), 'How do I add a job?{Enter}');
    await screen.findByText('Open Work orders and choose New.');
    expect(spoken).toHaveLength(0);
  });

  it('reads each answer as it arrives once turned on, remembers the choice, and the mute stops it', async () => {
    const { spoken, cancel } = installVoice();
    const { client } = modelApi();
    const { unmount } = renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Read answers aloud/u })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.type(screen.getByLabelText('Your question'), 'How do I add a job?{Enter}');
    await screen.findByText('Open Work orders and choose New.');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe('Open Work orders and choose New.');
    expect(spoken[0]?.lang).toBe('en-GB');
    // One stop in the header and one under the answer being read.
    expect(screen.getAllByRole('button', { name: 'Stop reading' })).toHaveLength(2);

    // The mute silences what is being read and turns the switch off.
    await user.click(screen.getByRole('button', { name: /^Read answers aloud/u }));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Read answers aloud/u })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    unmount();

    // Muted stays muted on the next visit, and the hint has been dealt with.
    renderScreen(<AssistantScreen />, client);
    await openConversation([]);
    expect(screen.getByRole('button', { name: /^Read answers aloud/u })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('reads an answer on demand even while muted, for a library company too', async () => {
    const { spoken } = installVoice();
    const answered = message();
    const { client } = fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities({ answerSource: 'library' }) }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({
        body: { conversation, messages: [answered] },
      }),
    });
    renderScreen(<AssistantScreen />, client);
    const user = await openConversation([answered]);

    expect(screen.queryByRole('button', { name: 'Speak your question' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Read this answer aloud' }));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe('Open Work orders and choose New.');
  });

  it('speaks Arabic to an Arabic member', async () => {
    const { spoken } = installVoice();
    const answered = message({ text: 'افتح أوامر العمل.' });
    const { client } = fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities() }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [answered] } }),
    });
    renderScreen(<AssistantScreen />, client, { locale: 'ar' });
    const user = await openConversation([answered]);
    await user.click(screen.getByRole('button', { name: 'قراءة هذه الإجابة بصوت عالٍ' }));
    expect(spoken[0]?.lang).toBe('ar-EG');
  });

  it('shows nothing about reading where the machine has no voices', async () => {
    installVoice({ synthesis: false });
    const { client } = modelApi();
    renderScreen(<AssistantScreen />, client);
    await openConversation([]);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Read answers aloud/u })).not.toBeInTheDocument();
  });
});
