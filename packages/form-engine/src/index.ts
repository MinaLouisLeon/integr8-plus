/**
 * `@integr8/form-engine` — what a form is, and what it decides.
 *
 * Zero UI, zero I/O, zero platform. The same compiled definition and the same
 * answers produce the same visibility, the same calculated values and the same
 * errors on a server, in a browser and on a phone; the conformance suite runs
 * one corpus through Node and through Hermes to prove it.
 *
 * The flow, end to end:
 *
 *   const result = compileDefinition(json);          // at publish time, and on load
 *   if (!result.ok) show(result.issues);              // names the fields involved
 *
 *   let state = createFormState(result.form);         // defaults applied
 *   state = transition(result.form, state, { type: 'answer', field: 'result', value: 'fail' }).state;
 *   const view = viewForm(result.form, state, { today: '2026-09-13' });
 *
 *   validateSubmission(result.form, body, context);   // on the server, for truth
 *
 * A repeatable section's answers are its entries: `add_entry` with an id the
 * caller makes, then `answer` with that `entry` (P13b).
 */

export { canonicalJson, CanonicalJsonError, compareCodeUnits } from './canonical.js';

export {
  availableOptions,
  dependentChoiceParent,
  revealing,
  type AvailableOptions,
} from './choices.js';

export {
  compileDefinition,
  DEFINITION_ISSUE_CODES,
  type CompiledForm,
  type CompileResult,
  type DefinitionIssue,
  type DefinitionIssueCode,
  type ElementInfo,
  type ElementKind,
} from './compile.js';

export {
  add,
  compareDecimal,
  divide,
  formatDecimal,
  fractionDigits,
  fromInteger,
  isInteger,
  MAX_DIGITS,
  MAX_SCALE,
  multiply,
  parseDecimal,
  rescale,
  subtract,
  type Decimal,
} from './decimal.js';

export {
  DEFINITION_SCHEMA_VERSION,
  entriesSchema,
  ENTRY_ID,
  entryIdSchema,
  entrySchema,
  formDefinitionSchema,
  LIMITS,
  pageSchema,
  repeatSchema,
  sectionSchema,
  type Entry,
  type FormDefinition,
  type Page,
  type Repeat,
  type Section,
} from './definition.js';

export {
  entryScopeOf,
  evaluateExpression,
  evaluateForm,
  evaluationScope,
  ownAnswer,
  storedEntries,
  toRuleValue,
  truth,
  type Answers,
  type EntryEvaluation,
  type EvaluationContext,
  type FormEvaluation,
  type RuleValue,
  type Scope,
} from './evaluate.js';

export {
  AGGREGATE_OPERATORS,
  ARITHMETIC_OPERATORS,
  COMPARISON_OPERATORS,
  expressionSchema,
  measure,
  referencedFields,
  referencedSections,
  visit,
  type AggregateOperator,
  type ArithmeticOperator,
  type ComparisonOperator,
  type Expression,
} from './expression.js';

export {
  answerSchemaFor,
  choiceValues,
  dependsOnOf,
  dependsOnSchema,
  describeFieldType,
  FIELD_ERROR_CODES,
  FIELD_TYPES,
  fieldConfigIssues,
  fieldSchema,
  geoPointSchema,
  hasAnswerShape,
  isAnswered,
  isCalculated,
  mediaReferenceSchema,
  optionSchema,
  ruleSchema,
  validateAnswer,
  type DependentChoiceField,
  type DependsOn,
  type Field,
  type FieldConfigIssue,
  type FieldError,
  type FieldErrorCode,
  type FieldOf,
  type FieldPurpose,
  type FieldType,
  type FieldTypeDescription,
  type GeoPoint,
  type MediaReference,
  type Option,
  type Rule,
  type ValueType,
} from './field-types.js';

export {
  ELEMENT_ID,
  elementIdSchema,
  localeTagSchema,
  localizedTextSchema,
  type ElementId,
  type LocalizedText,
} from './ids.js';

export {
  checkPattern,
  matchesPattern,
  PATTERN_MAX_INPUT,
  PATTERN_MAX_SOURCE,
  type PatternCheck,
} from './pattern.js';

export {
  createFormState,
  toSubmission,
  touchKey,
  transition,
  viewForm,
  type FormEvent,
  type FormStateOptions,
  type FormProgress,
  type FormState,
  type FormStatus,
  type FormView,
  type RejectionReason,
  type Transition,
} from './state.js';

export {
  type FieldMedia,
  mediaReferences,
  REPORTABLE_TYPES,
  type ReportableField,
  reportableFields,
  type ReportableType,
} from './reporting.js';

export { parseDate, parseDatetime, parseTime } from './temporal.js';

export {
  answerKey,
  SUBMISSION_ISSUE_CODES,
  validateForm,
  validateSubmission,
  type FormValidation,
  type SubmissionCheck,
  type SubmissionIssue,
  type SubmissionIssueCode,
} from './validation.js';

export {
  FORM_VERSION_STATUSES,
  migrateAnswers,
  prepareForPublish,
  type AnswerMigration,
  type DroppedReason,
  type FormVersionStatus,
} from './versioning.js';

// ---------------------------------------------------------------------------
// Authoring — what the builder (P07) is made of. Pure, like everything above.
// ---------------------------------------------------------------------------

export {
  canCompareWithField,
  clauseProblem,
  CONDITION_OPERATORS,
  ENTRY_COUNT_OPERATORS,
  fromExpression,
  operatorsFor,
  takesValue,
  toExpression,
  type ClauseProblem,
  type ConditionClause,
  type ConditionModel,
  type ConditionOperator,
} from './authoring/conditions.js';

export {
  diffDefinitions,
  type BreakingChange,
  type BreakingReason,
  type ChangeKind,
  type DefinitionChange,
  type DefinitionDiff,
} from './authoring/diff.js';

export {
  addField,
  addPage,
  addSection,
  allIds,
  duplicate,
  fieldsOf,
  findField,
  isEditError,
  locate,
  moveField,
  movePage,
  moveSection,
  referencesTo,
  remapExpression,
  remove,
  subtreeIds,
  updateField,
  updatePage,
  updateSection,
  type DuplicateResult,
  type EditError,
  type EditResult,
  type Located,
  type Reference,
} from './authoring/editing.js';

export {
  emptyDefinition,
  generateId,
  newField,
  newPage,
  newRepeatableSection,
  newSection,
  text as localized,
} from './authoring/scaffold.js';
