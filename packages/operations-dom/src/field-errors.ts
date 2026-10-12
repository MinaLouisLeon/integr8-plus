import { ApiRequestError, type ApiErrorDetail } from '@integr8/api-client';

/**
 * The detail a refusal gives for one field, such as `body.lines.2.quantity`,
 * when it names that field — so a form can say what is wrong beside the very
 * control, in the reader's language, with the values the server sent
 * (`params`) rather than its English.
 */
export function fieldDetail(error: unknown, field: string): ApiErrorDetail | undefined {
  if (!(error instanceof ApiRequestError)) {
    return undefined;
  }
  return error.details.find((detail) => detail.field === field);
}

/** The code a request was refused with, when it was refused with one. */
export function refusalCode(error: unknown): string | undefined {
  return error instanceof ApiRequestError ? error.code : undefined;
}
