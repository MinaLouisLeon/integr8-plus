import {
  compileDefinition,
  type Expression,
  type Field,
  type FormDefinition,
  updateField,
} from '@integr8/form-engine';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Button } from '~/components/ui';
import {
  FUNCTIONS,
  FUNCTION_TEMPLATES,
  type FormulaFunction,
  type FormulaProblem,
  type FormulaSuggestion,
  type FormulaType,
  formulaSources,
  parseFormula,
  printFormula,
  suggestionsAt,
} from '../model/formula';

/**
 * A calculation, typed as a formula (schema version 2; see `model/formula.ts`
 * for the language and why it is a formula).
 *
 * The text is the person's: it is kept as typed while it is wrong, and every
 * keystroke is checked — first by the formula's own reading, then by the
 * engine compiling the form with it — so the message under the box always says
 * whether the formula works and, if not, the first thing to fix. Only a formula
 * that works reaches the definition. `[` opens a list of the questions it may
 * read; typing a name offers the functions; Enter or a click takes one, and
 * the arrow keys move through them.
 */
export function FormulaEditor({
  definition,
  field,
  expression,
  locale,
  onChange,
}: {
  definition: FormDefinition;
  field: Field;
  expression: Expression | undefined;
  locale: string;
  onChange: (expression: Expression | undefined) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const expected: FormulaType = field.type === 'date' ? 'date' : 'number';
  const sources = formulaSources(definition, field.id);
  const printed =
    expression === undefined ? undefined : printFormula(expression, definition, locale);
  const [text, setText] = useState<string | undefined>(printed);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);

  if (expression !== undefined && printed === undefined) {
    // Written outside the builder, in a shape a formula cannot say.
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-content-muted">{t('forms.calculation.advanced')}</p>
        <Button variant="secondary" onClick={() => onChange(undefined)}>
          {t('forms.formula.stop')}
        </Button>
      </div>
    );
  }

  if (text === undefined) {
    return (
      <div>
        <Button variant="secondary" onClick={() => setText('')}>
          {t('forms.formula.start')}
        </Button>
      </div>
    );
  }

  const result = parseFormula(text, sources, locale, expected);
  const engineProblem = result.ok ? engineCheck(definition, field, result.expression) : undefined;
  const suggestions = suggestionsAt(text, caret, sources, locale);
  const chosen = Math.min(highlight, Math.max(suggestions.length - 1, 0));

  const edit = (next: string, nextCaret: number) => {
    setText(next);
    setCaret(nextCaret);
    setHighlight(0);
    const parsed = parseFormula(next, sources, locale, expected);
    if (parsed.ok && engineCheck(definition, field, parsed.expression) === undefined) {
      onChange(parsed.expression);
    }
  };

  const insert = (piece: string, from = caret, to = caret) => {
    const next = `${text.slice(0, from)}${piece}${text.slice(to)}`;
    // Inside the brackets a function was inserted with, ready for its first value.
    const open = piece.indexOf('(');
    const at = from + (open !== -1 && piece.endsWith(')') ? open + 1 : piece.length);
    edit(next, at);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(at, at);
    });
  };

  const take = (suggestion: FormulaSuggestion) => insert(suggestion.insert, suggestion.from, caret);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((chosen + step + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      take(suggestions[chosen]!);
    } else if (event.key === 'Escape') {
      setCaret(-1);
    }
  };

  const status = result.ok
    ? engineProblem === undefined
      ? {
          tone: 'ok' as const,
          message: `${t('forms.formula.works')} ${t(`forms.formula.result.${expected}`)}`,
        }
      : {
          tone: 'problem' as const,
          message: t('forms.formula.problem.engine', { message: engineProblem }),
        }
    : { tone: 'problem' as const, message: problemText(result.problem, t) };

  return (
    <div className="flex flex-col gap-2" data-formula={field.id}>
      <label htmlFor={id} className="text-sm font-medium text-content">
        {t('forms.formula.label')}
      </label>
      <div className="relative">
        <textarea
          id={id}
          ref={box}
          dir="ltr"
          rows={3}
          value={text}
          spellCheck={false}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={`${id}-suggestions`}
          aria-autocomplete="list"
          aria-describedby={`${id}-hint ${id}-status`}
          aria-invalid={status.tone === 'problem'}
          onChange={(event) => edit(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className={[
            'w-full rounded-md border bg-surface px-2 py-1.5 text-start font-mono text-sm text-content',
            status.tone === 'problem' ? 'border-danger' : 'border-border-subtle',
          ].join(' ')}
        />
        {suggestions.length === 0 ? null : (
          <ul
            id={`${id}-suggestions`}
            role="listbox"
            aria-label={t('forms.formula.suggestions')}
            className="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border-subtle bg-surface py-1 shadow-lg"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={`${suggestion.insert}-${String(index)}`}
                role="option"
                aria-selected={index === chosen}
                onMouseDown={(event) => {
                  // Keep the caret where it is while the suggestion is taken.
                  event.preventDefault();
                  take(suggestion);
                }}
                className={[
                  'cursor-pointer px-2 py-1 text-start text-sm',
                  index === chosen ? 'bg-accent-subtle text-content' : 'text-content',
                ].join(' ')}
              >
                {suggestion.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-content-muted">
        {t('forms.formula.hint')}
      </p>
      <p
        id={`${id}-status`}
        role="status"
        className={`text-xs ${status.tone === 'ok' ? 'text-success' : 'text-danger'}`}
      >
        {status.message}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-content">{t('forms.formula.functions')}</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {FUNCTIONS.filter((name) => functionFits(name, expected)).map((name) => (
            <li key={name} className="flex items-start gap-2">
              <Button
                variant="ghost"
                className="shrink-0 px-2 py-0.5 font-mono text-xs"
                aria-label={t('forms.formula.insert', { name })}
                onClick={() => insert(FUNCTION_TEMPLATES[name])}
              >
                {name}
              </Button>
              <span className="text-xs text-content-muted">
                {t(`forms.formula.describe.${name}`)}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <div>
        <Button
          variant="ghost"
          onClick={() => {
            setText(undefined);
            onChange(undefined);
          }}
        >
          {t('forms.formula.stop')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The functions worth offering: a date question ends in a moved date; a number
 * question can use any of them, a moved date included inside `days(…)`.
 */
function functionFits(name: FormulaFunction, expected: FormulaType): boolean {
  const dateMaking = name.startsWith('add_') || name.startsWith('subtract_');
  return expected === 'date' ? dateMaking || name === 'today' : true;
}

/**
 * What the engine says about the form with this calculation in place, if
 * anything: what the formula's own reading cannot know, like a calculation
 * that comes back round to the question it is on.
 */
function engineCheck(
  definition: FormDefinition,
  field: Field,
  expression: Expression,
): string | undefined {
  const updated = updateField(
    definition,
    field.id,
    (current) =>
      ({
        ...current,
        calculation: expression,
      }) as Field,
  );
  if ('error' in updated) {
    return undefined;
  }
  const compiled = compileDefinition({ ...updated, schemaVersion: 2 });
  if (compiled.ok) {
    return undefined;
  }
  const own =
    compiled.issues.find(
      (issue) =>
        issue.path.endsWith('.calculation') &&
        issue.elements.includes(field.id) &&
        issue.code !== 'invalid_field_config',
    ) ??
    compiled.issues.find(
      (issue) => issue.code === 'circular_dependency' && issue.elements.includes(field.id),
    );
  return own?.message;
}

function problemText(problem: FormulaProblem, t: TFunction): string {
  const kind = (value: FormulaType | 'number_or_moment') => t(`forms.formula.kind.${value}`);
  switch (problem.code) {
    case 'syntax':
      return problem.found === ''
        ? t('forms.formula.problem.syntaxEnd')
        : t('forms.formula.problem.syntax', { found: problem.found });
    case 'needs':
      return t('forms.formula.problem.needs', {
        expected: kind(problem.expected),
        found: kind(problem.found),
      });
    case 'mixed':
      return t('forms.formula.problem.mixed', {
        left: kind(problem.left),
        right: kind(problem.right),
      });
    case 'result':
      return t('forms.formula.problem.result', {
        expected: kind(problem.expected),
        found: kind(problem.found),
      });
    case 'empty':
      return t('forms.formula.problem.empty');
    case 'unclosed_reference':
      return t('forms.formula.problem.unclosed_reference');
    case 'time_in_days':
      return t('forms.formula.problem.time_in_days');
    case 'unknown_name':
    case 'ambiguous_name':
    case 'unknown_function':
    case 'arguments':
    case 'not_a_section':
      return t(`forms.formula.problem.${problem.code}`, { name: problem.name });
    case 'not_in_section':
      return t('forms.formula.problem.not_in_section', {
        name: problem.name,
        section: problem.section,
      });
    case 'places':
      return t('forms.formula.problem.places', { maximum: problem.maximum });
    case 'literal':
    case 'number_text':
      return t('forms.formula.problem.literal', { text: problem.text });
  }
}
