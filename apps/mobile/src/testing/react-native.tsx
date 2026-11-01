import {
  type ComponentPropsWithoutRef,
  createElement,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
} from 'react';

/**
 * React Native's components, drawn as plain DOM, for tests that render the
 * phone's own screens in jsdom (the form behaviour check).
 *
 * Only what the form screens use, and only what a test reads: the tree, the
 * text, what is pressable, and the markers. A `testID` such as
 * `question:serial` or `part:label` becomes the attribute `data-question` or
 * `data-part` (and `information:note:tip` both `data-information` and
 * `data-style`), the same markers the DOM renderers write, so one reader
 * (`readScreen` in `@integr8/form-input/behaviour`) reads all three. Layout,
 * styles and native behaviour are not modelled: this proves what the phone's
 * components say, not how they look.
 */

interface Common {
  children?: ReactNode;
  testID?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
}

const ROLES: Readonly<Record<string, string>> = {
  header: 'heading',
  button: 'button',
  link: 'link',
  alert: 'alert',
  radio: 'radio',
  checkbox: 'checkbox',
  radiogroup: 'radiogroup',
  progressbar: 'progressbar',
};

function markers(testID: string | undefined): Record<string, string> {
  if (testID === undefined) {
    return {};
  }
  const at = testID.indexOf(':');
  const kind = at === -1 ? '' : testID.slice(0, at);
  const value = testID.slice(at + 1);
  switch (kind) {
    case 'question':
      return { 'data-question': value };
    case 'page':
      return { 'data-page': value };
    case 'information': {
      const style = value.lastIndexOf(':');
      return { 'data-information': value.slice(0, style), 'data-style': value.slice(style + 1) };
    }
    case 'section':
      return { 'data-section': value };
    case 'repeat':
      return { 'data-section': value, 'data-repeat': '' };
    case 'entry':
      return { 'data-entry': value };
    case 'part':
      return { 'data-part': value };
    default:
      return { 'data-testid': testID };
  }
}

function host(tag: string, props: Common, extra: Record<string, unknown> = {}) {
  const role = props.accessibilityRole === undefined ? undefined : ROLES[props.accessibilityRole];
  return createElement(
    tag,
    {
      ...markers(props.testID),
      ...(role === undefined ? {} : { role }),
      ...(props.accessibilityLabel === undefined ? {} : { 'aria-label': props.accessibilityLabel }),
      ...extra,
    },
    props.children,
  );
}

export const View = forwardRef<HTMLDivElement, Common & Record<string, unknown>>(
  function View(props, ref) {
    return host('div', props, { ref });
  },
);

export const Text = forwardRef<HTMLSpanElement, Common & Record<string, unknown>>(
  function Text(props, ref) {
    return host('span', props, { ref });
  },
);

export function Pressable(props: Common & { onPress?: () => void } & Record<string, unknown>) {
  return host('button', props, {
    type: 'button',
    disabled: props.disabled === true,
    onClick: () => props.onPress?.(),
  });
}

export const ScrollView = forwardRef<{ scrollTo: () => void }, Common & Record<string, unknown>>(
  function ScrollView(props, ref) {
    useImperativeHandle(ref, () => ({ scrollTo: () => undefined }));
    return host('div', props);
  },
);

export function KeyboardAvoidingView(props: Common & Record<string, unknown>) {
  return host('div', props);
}

export function Modal(props: Common & { visible?: boolean } & Record<string, unknown>) {
  return props.visible === true ? host('div', props) : null;
}

export function TextInput(
  props: Common & {
    value?: string;
    onChangeText?: (text: string) => void;
    editable?: boolean;
    multiline?: boolean;
  } & Record<string, unknown>,
) {
  return host(props.multiline === true ? 'textarea' : 'input', props, {
    value: props.value ?? '',
    readOnly: props.editable === false,
    onChange: (event: { target: { value: string } }) => props.onChangeText?.(event.target.value),
  });
}

export function ActivityIndicator() {
  return null;
}

export function Image(props: ComponentPropsWithoutRef<'img'>) {
  return createElement('img', { alt: props.alt ?? '' });
}

export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  flatten: <T,>(style: T): T => style,
  hairlineWidth: 1,
  absoluteFill: {},
  absoluteFillObject: {},
};

export const Platform = {
  OS: 'android',
  select: <T,>(options: { android?: T; default?: T }): T | undefined =>
    options.android ?? options.default,
};

export const AccessibilityInfo = { announceForAccessibility: () => undefined };
export const Alert = { alert: () => undefined };
export const I18nManager = { isRTL: false };
export const PanResponder = { create: () => ({ panHandlers: {} }) };
export const useColorScheme = () => 'light';
