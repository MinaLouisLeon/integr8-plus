/**
 * English messages — the source language.
 *
 * TypeScript rather than JSON, so that `t('auth.signIn')` is a compile error
 * when the key is wrong and an autocomplete when it is not. That is most of
 * what makes P05's "no hardcoded strings" criterion enforceable: a developer
 * who cannot remember a key is shown the list rather than tempted to type the
 * sentence.
 *
 * Two rules for anybody adding to this file:
 *
 * - **A key names the meaning, not the words.** `auth.signIn`, not
 *   `auth.signInButton`, and never `auth.sign_in_blue_button`. The words change;
 *   the meaning is what a translator is given.
 * - **Never assemble a sentence from fragments.** Word order differs between
 *   languages, and in Arabic so does direction. Interpolation and plurals are
 *   what `{{count}}` and `_other` are for.
 */

export const en = {
  common: {
    appName: 'Integr8 Plus',
    loading: 'Loading…',
    retry: 'Try again',
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    signOut: 'Sign out',
    theme: {
      label: 'Theme',
      light: 'Light',
      dark: 'Dark',
      system: 'Match my system',
    },
    language: 'Language',
    // Development-only, and named so it is obvious in a translation file why
    // it exists: forcing right-to-left is how the layout is checked before any
    // Arabic copy exists.
    forceRtl: 'Preview right-to-left',
    // Also development-only: the desktop app shows whether it is a Tauri window
    // or a browser tab, so P05's "identical in both" criterion can be checked
    // by eye. Translated anyway, because a string on screen is a string on
    // screen.
    runtime: 'Runtime',
  },

  auth: {
    signInTitle: 'Sign in',
    signInSubtitle: 'Use the address your company invited.',
    email: 'Email address',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    magicLink: 'Email me a sign-in link',
    magicLinkSent: 'If that address has an account, a sign-in link is on its way.',
    signedOut: 'You have been signed out.',
    sessionExpired: 'Your session has expired. Please sign in again.',
    switchCompany: 'Switch company',
    // One message for a wrong password, an unknown address and an account with
    // no company. Distinguishing them would turn the form into a way of testing
    // which addresses are customers.
    invalidCredentials: 'That email address and password did not match.',
    accountLocked: 'Too many attempts. Try again in a few minutes.',
    rateLimited: 'Too many requests. Slow down and try again shortly.',
  },

  workspace: {
    signedInAs: 'Signed in as {{name}}',
    company: 'Company',
    role: {
      owner: 'Owner',
      admin: 'Admin',
      dispatcher: 'Dispatcher',
      engineer: 'Engineer',
      viewer: 'Viewer',
    },
    members: {
      title: 'People',
      count_one: '{{count}} person',
      count_other: '{{count}} people',
      empty: 'Nobody else has joined yet.',
      invite: 'Invite somebody',
    },
    sessions: {
      title: 'Your devices',
      empty: 'No other devices are signed in.',
      current: 'This device',
      lastSeen: 'Last used {{when}}',
      revoke: 'Sign out this device',
    },
    impersonationBanner: 'You are viewing this account as {{name}}. Everything you do is recorded.',
  },

  errors: {
    title: 'Something went wrong',
    // The request id is the one thing that makes a report actionable, so the
    // copy asks for it rather than hoping somebody thinks to include it.
    body: 'We could not complete that. If it keeps happening, quote this reference: {{requestId}}',
    offline: 'You appear to be offline. This will retry when you reconnect.',
    notFound: 'We could not find that.',
    forbidden: 'You do not have permission to do that.',
    clientTooOld: 'This version of the app is no longer supported. Please update to continue.',
    unexpected: 'An unexpected error occurred.',
  },

  states: {
    emptyTitle: 'Nothing here yet',
    emptyBody: 'When there is something to show, it will appear here.',
    loadingLabel: 'Loading',
  },

  form: {
    // One message per error code the form engine produces, keyed by the code
    // itself. The engine's `FIELD_ERROR_CODES` is the contract; a test in this
    // package fails if a code has no message here. Interpolated values arrive
    // already formatted as text — a minimum of 2.50 is "2.50" — so nothing here
    // re-formats a number and loses a trailing zero.
    errors: {
      required: 'This is required.',
      invalid: 'This is not a valid answer.',
      too_short: 'Enter at least {{minimum}} characters.',
      too_long: 'Enter no more than {{maximum}} characters.',
      pattern_mismatch: 'This is not in the expected format.',
      below_minimum: 'Must be at least {{minimum}}.',
      above_maximum: 'Must be no more than {{maximum}}.',
      too_many_decimal_places: 'Use no more than {{maximum}} decimal places.',
      before_earliest: 'Must be {{earliest}} or later.',
      after_latest: 'Must be {{latest}} or earlier.',
      unknown_option: 'Choose one of the options given.',
      duplicate_option: 'Each option can only be chosen once.',
      too_few_selected: 'Choose at least {{minimum}}.',
      too_many_selected: 'Choose no more than {{maximum}}.',
      too_few_files: 'Add at least {{minimum}}.',
      too_many_files: 'Add no more than {{maximum}}.',
      file_too_large: 'Each file must be smaller than {{maximum}} bytes.',
      file_type_not_accepted: 'This type of file is not accepted here.',
      out_of_range: 'Choose a value from {{minimum}} to {{maximum}}.',
      accuracy_too_low:
        'The location is not accurate enough. Wait for a better signal (within {{maximum}} metres).',
      // Shown only when the rule's author wrote no message of their own, which a
      // published form always carries. The fallback exists so a screen never
      // renders a raw key.
      rule_failed: 'This answer does not meet a rule on this form.',
    },
  },

  // The form builder (P07). Written for a company admin who has never seen an
  // expression, a schema or a regular expression: "Pick one", not "radio";
  // "When to show", not "visibleWhen".
  forms: {
    nav: {
      forms: 'Forms',
      home: 'Home',
    },

    list: {
      title: 'Forms',
      subtitle: 'Build the forms your engineers fill in on site.',
      newForm: 'New form',
      emptyTitle: 'No forms yet',
      emptyBody: 'Start a new form, or begin from one of the templates below.',
      emptyForFillers: 'No forms have been published yet.',
      name: 'Name',
      status: 'Status',
      updated: 'Last changed',
      live: 'Version {{number}} live',
      notPublished: 'Not published yet',
      unpublishedChanges: 'Unpublished changes',
      open: 'Open',
      copy: 'Make a copy',
    },

    create: {
      title: 'Start a new form',
      name: 'Form name',
      placeholder: 'e.g. Boiler service',
      submit: 'Create form',
    },

    copy: {
      title: 'Copy “{{name}}”',
      body: 'The copy starts as a draft with the same questions. The original does not change, and the copy has no history of its own.',
      name: 'Name of the copy',
      defaultName: '{{name}} (copy)',
      submit: 'Make a copy',
    },

    templates: {
      title: 'Start from a template',
      subtitle:
        'Ready-made forms you can copy and change. The templates themselves stay as they are.',
      fields_one: '{{count}} question',
      fields_other: '{{count}} questions',
      preview: 'Preview',
      use: 'Use this template',
      category: {
        maintenance: 'Maintenance',
        safety: 'Safety',
        completion: 'Job completion',
      },
    },

    builder: {
      back: 'All forms',
      tabs: {
        build: 'Build',
        preview: 'Preview and test',
        changes: 'Changes',
        history: 'History',
        settings: 'Settings',
      },
      save: {
        saved: 'All changes saved',
        matchesLive: 'Same as the live version',
        saving: 'Saving…',
        unsaved: 'Unsaved changes',
        failed: 'Not saved yet — trying again',
        conflict: 'Someone else saved this draft while you were editing.',
        loadTheirs: 'Load their version',
      },
      undo: 'Undo',
      redo: 'Redo',
      publish: 'Publish…',
      readOnly: 'You can look at this form, but only owners and admins can change it.',
      problems_one: '{{count}} problem to fix',
      problems_other: '{{count}} problems to fix',
      noProblems: 'Ready to publish',
      recovery: {
        title: 'Unsaved changes found',
        restoreBody: 'This device has changes from {{when}} that never reached the server.',
        staleBody:
          'This device has changes from {{when}}, but someone has saved this draft since. Restoring yours replaces theirs.',
        restore: 'Restore my changes',
        discard: 'Discard them',
      },
      refused: {
        last_page: 'A form needs at least one page.',
        last_section: 'A page needs at least one section.',
        not_found: 'That item no longer exists.',
        invalid_target: 'It cannot go there.',
      },
    },

    palette: {
      title: 'Add a question',
      hint: 'Drag one onto the form, or click it to add it to the selected section.',
      purpose: {
        writing: 'Writing',
        measuring: 'Numbers and measurements',
        scheduling: 'Dates and times',
        choosing: 'Choices',
        evidence: 'Evidence',
        location: 'Location',
      },
    },

    fieldType: {
      text: 'Short answer',
      long_text: 'Paragraph',
      barcode: 'Barcode or serial number',
      number: 'Whole number',
      decimal: 'Decimal number',
      rating: 'Rating',
      date: 'Date',
      time: 'Time',
      datetime: 'Date and time',
      dropdown: 'Dropdown list',
      radio: 'Pick one',
      multi_select: 'Pick several',
      checkbox: 'Tick box',
      yes_no: 'Yes or no',
      signature: 'Signature',
      photo: 'Photos',
      file: 'Files',
      gps: 'GPS location',
    },

    canvas: {
      page: 'Page {{number}}',
      section: 'Section',
      addSection: 'Add a section',
      addPage: 'Add a page',
      emptySection: 'Drag a question here',
      drag: 'Drag to move {{name}}',
      actions: 'Actions for {{name}}',
      duplicate: 'Duplicate',
      delete: 'Delete',
      moveUp: 'Move up',
      moveDown: 'Move down',
      required: 'Required',
      conditional: 'Shown only sometimes',
      calculated: 'Worked out automatically',
      checks_one: '{{count}} check',
      checks_other: '{{count}} checks',
    },

    remove: {
      title: 'Delete “{{name}}”?',
      kept: 'Answers already submitted keep it. It leaves the form when you next publish.',
      references: 'These rules read it, and will need fixing before you can publish:',
      visibleWhen: '{{from}} — when to show',
      calculation: '{{from}} — calculation',
      rule: '{{from}} — check',
      confirm: 'Delete',
    },

    config: {
      empty: 'Select a question, section or page to change it.',
      field: 'Question',
      section: 'Section',
      page: 'Page',
      groups: {
        basics: 'Basics',
        answer: 'Answer',
        visibility: 'When to show',
        checks: 'Checks',
      },
      label: 'Question',
      title: 'Title',
      help: 'Help text',
      helpPlaceholder: 'Extra guidance shown under the question',
      type: 'Kind of question',
      key: 'Answer key',
      keyHelp: 'Reports and exports use this. It never changes, even when you reword the question.',
      required: 'Must be answered',
      readOnly: 'Cannot be changed by the person filling it in',
      notSet: 'Not set',
      property: {
        minLength: 'Fewest characters',
        maxLength: 'Most characters',
        pattern: 'Required format',
        default: 'Starting answer',
        unit: 'Unit',
        min: 'Lowest allowed',
        max: 'Highest allowed',
        calculation: 'Work it out automatically',
        decimalPlaces: 'Decimal places',
        earliest: 'Earliest allowed',
        latest: 'Latest allowed',
        options: 'Options',
        minSelected: 'Choose at least',
        maxSelected: 'Choose at most',
        allowNotApplicable: 'Offer “Not applicable”',
        scale: 'Out of',
        minFiles: 'At least',
        maxFiles: 'At most',
        maxFileBytes: 'Largest file, in MB',
        acceptedTypes: 'File types accepted',
        maxAccuracyMeters: 'Accuracy needed, in metres',
      },
      options: {
        add: 'Add an option',
        label: 'Option {{number}}',
        remove: 'Remove option {{number}}',
        storedAs: 'Stored as {{value}}',
      },
      pattern: {
        source: 'Pattern',
        hint: 'For example, AB-1234 is [A-Z]{2}-[0-9]{4}',
        caseInsensitive: 'Ignore capital letters',
        message: 'Message when it does not match',
      },
      acceptedTypesHint: 'Separate with commas, e.g. application/pdf, image/*',
      yes: 'Yes',
      no: 'No',
      notApplicable: 'Not applicable',
      ticked: 'Ticked',
      notTicked: 'Not ticked',
    },

    calculation: {
      start: 'Work this answer out from other answers',
      stop: 'Stop working it out',
      addStep: 'Add a step',
      removeStep: 'Remove step',
      term: 'Value',
      number: 'A number',
      numberValue: 'Number',
      operator: {
        add: 'plus',
        subtract: 'minus',
        multiply: 'times',
        divide: 'divided by',
      },
      advanced:
        'This calculation was written outside the builder. It still works, but it can only be removed here.',
      broken:
        'This calculation reads a question that has been deleted, so it cannot work. Stop it and set it up again.',
    },

    conditions: {
      always: 'Always shown',
      addFirst: 'Show only when…',
      showWhen: 'Show this when',
      match: {
        all: 'all of these are true',
        any: 'any of these is true',
      },
      add: 'Add a condition',
      remove: 'Remove condition',
      question: 'Question',
      comparison: 'Comparison',
      value: 'Answer',
      chooseQuestion: 'Choose a question',
      choose: 'Choose…',
      compareWith: 'Compare with',
      aValue: 'a value',
      anotherAnswer: 'another answer',
      thisAnswer: 'This answer',
      incomplete: 'Unfinished conditions take effect once they are complete.',
      advanced:
        'This rule was written outside the builder. It still works, but it can only be removed here.',
      removeAdvanced: 'Remove this rule',
      broken:
        'This rule reads a question that has been deleted, so it cannot work. Remove it and add the condition again.',
      operator: {
        is: 'is',
        is_not: 'is not',
        is_answered: 'is answered',
        is_not_answered: 'is not answered',
        is_checked: 'is ticked',
        is_not_checked: 'is not ticked',
        is_greater_than: 'is more than',
        is_less_than: 'is less than',
        is_at_least: 'is at least',
        is_at_most: 'is at most',
        is_before: 'is before',
        is_after: 'is after',
        is_before_today: 'is before today',
        is_after_today: 'is after today',
        includes: 'includes',
        does_not_include: 'does not include',
      },
      problem: {
        unknown_field: 'Choose a question.',
        operator_not_allowed: 'That comparison does not apply to this question.',
        value_required: 'Enter an answer to compare with.',
        value_invalid: 'That is not a valid answer to this question.',
        unknown_option: 'Choose one of the options.',
        compared_field_unknown: 'Choose the other question.',
        compared_field_mismatch: 'Those two questions hold different kinds of answer.',
      },
    },

    checks: {
      empty: 'No extra checks. The answer only has to meet the limits above.',
      add: 'Add a check',
      remove: 'Remove check',
      acceptedWhen: 'The answer is accepted when',
      message: 'Message when the check fails',
      messagePlaceholder: 'e.g. Pressure after the service must be lower than before',
      messageRequired: 'Write the message people see when this check fails.',
    },

    preview: {
      desktop: 'Desktop',
      phone: 'Phone',
      broken: 'Fix these problems to see the form:',
      testTitle: 'Test fill',
      testHint:
        'Fill it in as an engineer would. Nothing entered here is saved, and none of it counts as a submission.',
      check: 'Check with the server',
      accepted: 'The server accepted these answers. Nothing was saved.',
      rejected: 'The server would refuse these answers:',
      reset: 'Clear answers',
      today: 'Date filled in',
      next: 'Next',
      back: 'Back',
      submit: 'Submit',
      pageOf: 'Page {{current}} of {{total}}',
      progress: '{{answered}} of {{total}} required questions answered',
      calculated: 'Worked out automatically',
      onDevice: 'Captured on the device',
      simulate: 'Simulate one',
      simulated: 'Simulated',
      clear: 'Clear',
      choose: 'Choose…',
      unsavedFirst: 'Saving your latest changes first…',
      issue: {
        not_an_object: 'The answers were not sent as a set of answers.',
        unknown_field: 'An answer was sent for a question this form does not have.',
        answer_to_hidden_field: 'An answer was sent for “{{field}}”, which is hidden.',
        answer_to_calculated_field:
          'An answer was typed for “{{field}}”, which is worked out automatically.',
      },
    },

    changes: {
      title: 'Changes since the live version',
      firstVersion: 'Nothing is published yet, so everything here is new.',
      none: 'No changes from the live version.',
      noDraft: 'There is no draft. Change something in Build to start one.',
      recheck: 'Check again',
      titleChanged: 'The form’s title changed',
      show: 'Show',
      problemsTitle: 'Problems to fix before publishing',
      in: 'In “{{name}}”',
      noProblems: 'No problems found.',
      breakingTitle: 'Changes that affect data you already have',
      kind: {
        added: 'Added',
        removed: 'Removed',
        moved: 'Moved',
        changed: 'Changed',
      },
      element: {
        page: 'Page',
        section: 'Section',
        field: 'Question',
      },
      properties: 'Changed: {{list}}',
      breaking: {
        field_removed:
          'Removed. Past answers stay with the versions that asked it, but new submissions will not have it, so reports will show gaps.',
        type_changed:
          'The kind of answer changed. Reports cannot put old and new answers in one column.',
        option_removed:
          'Options removed: {{detail}}. Past answers that chose them are kept but cannot be chosen again.',
        now_calculated: 'Now worked out automatically. Unfinished drafts lose what was typed.',
        now_required: 'Now required. Unfinished drafts must answer it before they can be sent.',
        constraint_tightened:
          'Stricter limits: {{detail}}. Some unfinished drafts may need correcting.',
      },
      affects: {
        reporting: 'Affects reports',
        drafts: 'Affects unfinished drafts',
      },
    },

    publish: {
      title: 'Publish version {{number}}',
      body: 'A published version can never be changed. Submissions already made stay with the version they were made on.',
      checking: 'Checking the whole form…',
      blocked: 'This form cannot be published until these problems are fixed:',
      note: 'What changed? (optional)',
      notePlaceholder: 'e.g. Added a question about flue gas readings',
      acknowledge: 'I understand how these changes affect the data we already have',
      confirm: 'Publish',
      published: 'Version {{number}} is live.',
      draftChanged:
        'The draft changed while you were reviewing it. Check it again before publishing.',
      nothing: 'There are no changes to publish.',
    },

    history: {
      title: 'Version history',
      empty: 'No version has been published yet.',
      version: 'Version {{number}}',
      published: 'Published {{when}}',
      noNote: 'No note',
      view: 'View',
      summary: '{{added}} added · {{removed}} removed · {{changed}} changed',
      breaking_one: '{{count}} change affecting existing data',
      breaking_other: '{{count}} changes affecting existing data',
      readOnly: 'Version {{number}} — read only',
      backToForm: 'Back to the form',
    },

    settings: {
      title: 'Settings',
      note: 'Settings apply straight away. They are not part of a version.',
      name: 'Form name',
      fillRoles: 'Who can fill it in',
      fillRolesHint: 'Choose at least one role.',
      signature: 'Require a signature before a job using this form can be closed',
      jobTypes: 'Job types that require this form',
      jobTypesPending: 'Available once job types are set up.',
      save: 'Save settings',
      saved: 'Settings saved.',
    },
  },
} as const;

export type Messages = typeof en;
