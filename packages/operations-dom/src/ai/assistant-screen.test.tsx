import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AiCapabilities, AiConversation, AiMessage, AiProposal } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { AssistantScreen } from './assistant-screen.js';

const CONVERSATION = '00000000-0000-4000-8000-000000000a01';
const PROPOSAL = '00000000-0000-4000-8000-000000000a02';
const CUSTOMER = '00000000-0000-4000-8000-000000000301';
const RESET = '2026-10-16T00:00:00.000Z';

function axis(used: number, limit: number | null) {
  return {
    used,
    reserved: 0,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsAt: RESET,
  };
}

function capabilities(overrides: Partial<AiCapabilities> = {}): AiCapabilities {
  return {
    level: 'help',
    blockedBy: null,
    channel: 'web',
    tools: [],
    companyDataToProvider: false,
    locales: ['en', 'ar'],
    historyTurns: 6,
    allowHistory: true,
    usage: {
      daily: axis(2, 50),
      monthly: null,
      user: { daily: axis(1, 10), monthly: axis(1, null) },
      unlimited: false,
    },
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

  it('sends a question with an idempotency key, shows the answer and updates the meter', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/ai/capabilities': () => ({ body: capabilities() }),
      'GET /v1/ai/conversations': () => ({ body: { items: [conversation] } }),
      'GET /v1/ai/conversations/:id': () => ({ body: { conversation, messages: [] } }),
      'POST /v1/ai/conversations/:id/messages': () => ({
        body: {
          message: message(),
          usage: {
            daily: axis(3, 50),
            monthly: null,
            user: { daily: axis(2, 10), monthly: axis(2, null) },
            unlimited: false,
          },
          replayed: false,
        },
      }),
    });
    const { container, navigate } = renderScreen(<AssistantScreen />, client);
    const user = await openConversation([]);

    expect(screen.getByText('1 of 10')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your question'), 'How do I add a job?{Enter}');

    expect(await screen.findByText('Open Work orders and choose New.')).toBeInTheDocument();
    expect(screen.getByText('How do I add a job?')).toBeInTheDocument();
    expect(screen.getByText('2 of 10')).toBeInTheDocument();
    expect(screen.getByText('3 of 50')).toBeInTheDocument();
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
              daily: axis(asked === 1 ? 49 : 50, 50),
              monthly: null,
              user: { daily: axis(1, 10), monthly: axis(1, null) },
              unlimited: false,
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
    expect(screen.getByText(/No messages left\. They reset/u)).toBeInTheDocument();
  });
});
