/**
 * Building a form with the person, not for them (0075).
 *
 * The program cannot talk to the person; the AI app does. So the instructions
 * tell the AI to interview the person before it writes anything, this file
 * gives it the questions to ask (`get_interview_guide`) the same way in every
 * AI app, `summarize_form` turns what it wrote back into a plain list for the
 * person to confirm before saving, and `toConfirm` names what the person has
 * not decided yet, such as whether a QR code is the share code or a fixed one,
 * so the checks say "ask" instead of the AI guessing.
 */

export function interviewGuide(): string {
  return `# Interview the person before you build

Do not write the form or a PDF template from a description alone. Ask, one step at a time, and wait for the answers. Keep each message short: a few questions, with your suggestion for each so the person can just say "yes".

## 1. The form as a whole

- What is the form for, and who fills it in (an engineer on the phone, the office)?
- Its title in English and in Arabic.
- Its pages and sections: suggest a split and ask if it is right.

## 2. Every question you will create, one by one (or a few related ones together)

For each question, confirm before writing it:

1. **Type**: text, long text, number, date, time, yes/no, single choice, several choices, photo, signature, file, GPS, rating… Suggest one, and say why.
2. **Label** in English and in Arabic (offer your translation; ask the person to correct it).
3. **Required** or optional, and any hint text shown under it.
4. **Choices** (for a choice question): every option, in both languages, in order.
5. **Limits and checks**: minimum/maximum, units, a pattern (for a serial number), how many photos.
6. **Rules**: shown only when…, required only when…, calculated from other answers (and how).
7. **In the PDF**: does it print, where (with which other answers, in a table), and with what label.

Do not move on to the next question until the person has answered for this one, or has told you to use your suggestions for the rest.

## 3. Every PDF template

- Its name, and which page size and orientation.
- What goes in the header and the footer (logo, company name, page numbers, a line of text).
- The order of the blocks: headings, answers, tables, pictures, signatures.

## 4. Every QR code — always ask

A PDF template's QR code is one of two kinds; never choose for the person:

- **Share QR code** (\`"content": { "kind": "share" }\`): opens the document's own page. It stays **blank until the document is shared** from the Documents page, then the PDF is re-printed with it in its place.
- **Fixed QR code** (\`"content": { "kind": "fixed", "text": "…" }\`): a link or text printed on every PDF from the start, such as the company's website or a page about the product. It may use placeholders: \`{{company.website}}\`, \`{{answer.<question id>}}\`, \`{{field.<key>}}\`.

Ask: "Is this QR code the document's share code, or a fixed link? If fixed, what should it open?" Also ask its size and where it goes.

## 5. Confirm, then save

1. Check with \`check_form\` / \`check_package\` until they are OK; answer every "To confirm with the person" item they list by asking, not by guessing.
2. Call \`summarize_form\` and show the person the list it returns.
3. Save with \`save_package\` only after the person says the list is right.
`;
}

interface Localized {
  en?: unknown;
  ar?: unknown;
}

const say = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const text = value as Localized;
    const en = typeof text.en === 'string' ? text.en : '';
    const ar = typeof text.ar === 'string' ? text.ar : '';
    return [en, ar].filter((part) => part !== '').join(' / ');
  }
  return '';
};

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
      )
    : [];

/** Every block of a design, inside rows too, as written. */
function blocksOf(design: unknown): Record<string, unknown>[] {
  const top = records((design as { blocks?: unknown } | null)?.blocks);
  return top.flatMap((block) =>
    block.type === 'row'
      ? [block, ...records(block.columns).flatMap((column) => records(column.blocks))]
      : [block],
  );
}

export interface TemplateInput {
  name: string;
  design: unknown;
}

/**
 * What the person has not decided yet: each QR code written without a kind
 * (it would print as the share code without anyone choosing). One line each,
 * naming the template and the block.
 */
export function toConfirm(templates: readonly TemplateInput[]): string[] {
  return templates.flatMap((template) =>
    blocksOf(template.design)
      .filter((block) => block.type === 'qr' && block.content === undefined)
      .map(
        (block) =>
          `Template "${template.name}", QR block "${String(block.id)}": ask the person whether it is the document's share QR code (blank until shared) or a fixed link, and if fixed, what it opens. Then write "content": { "kind": "share" } or { "kind": "fixed", "text": "…" }.`,
      ),
  );
}

/** The "To confirm" part of a check's answer; empty when there is nothing to ask. */
export function confirmSection(templates: readonly TemplateInput[]): string {
  const items = toConfirm(templates);
  return items.length === 0
    ? ''
    : `\n\nTo confirm with the person (ask, do not guess):\n${items.map((item, index) => `${String(index + 1)}. ${item}`).join('\n')}`;
}

/** The form and its templates as a plain list, for the person to confirm before saving. */
export function summarizeForm(definition: unknown, templates: readonly TemplateInput[]): string {
  const form = (definition ?? {}) as { title?: unknown; pages?: unknown };
  const lines = [`# ${say(form.title) || 'Untitled form'}`, ''];
  for (const page of records(form.pages)) {
    lines.push(`## Page: ${say(page.title) || String(page.id)}`, '');
    for (const section of records(page.sections)) {
      const repeat = section.repeat === undefined ? '' : ' (repeating)';
      lines.push(`### Section: ${say(section.title) || String(section.id)}${repeat}`, '');
      lines.push(
        '| # | Question | Type | Required | Choices / notes |',
        '| --- | --- | --- | --- | --- |',
      );
      records(section.fields).forEach((field, index) => {
        const options = records(field.options)
          .map((option) => say(option.label) || String(option.value))
          .join(', ');
        const notes = [
          options,
          field.visibleWhen === undefined ? '' : 'shown only when a rule says',
          field.requiredWhen === undefined ? '' : 'required only when a rule says',
          field.calculation === undefined ? '' : 'calculated',
        ]
          .filter((part) => part !== '')
          .join('; ');
        const label = say(field.label) || say(field.heading) || say(field.body);
        const type = typeof field.type === 'string' ? field.type : 'information';
        lines.push(
          `| ${String(index + 1)} | ${label} \`${String(field.id)}\` | ${type} | ${field.required === true ? 'yes' : 'no'} | ${notes} |`,
        );
      });
      lines.push('');
    }
  }
  for (const template of templates) {
    lines.push(`## PDF template: ${template.name}`, '');
    for (const block of blocksOf(template.design)) {
      if (block.type === 'row') {
        continue;
      }
      let detail = '';
      if (block.type === 'qr') {
        const content = block.content as { kind?: unknown; text?: unknown } | undefined;
        detail =
          content?.kind === 'fixed'
            ? `fixed QR code: ${String(content.text)}`
            : content?.kind === 'share'
              ? 'share QR code (blank until the document is shared)'
              : 'QR code — NOT CONFIRMED: share or fixed?';
      } else if (typeof block.fieldId === 'string') {
        detail = `answer \`${block.fieldId}\``;
      } else if (block.text !== undefined) {
        detail = say(block.text).slice(0, 80);
      }
      lines.push(`- ${String(block.type)}${detail === '' ? '' : `: ${detail}`}`);
    }
    lines.push('');
  }
  lines.push(
    'Show this list to the person and ask: "Is this right? Anything to add, remove or change?" Save only after they confirm.',
  );
  return lines.join('\n');
}
