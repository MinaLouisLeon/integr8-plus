import { useTranslation } from '@integr8/i18n';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import { isTauri } from '~/lib/platform';

/**
 * The desktop app's own right-click menu.
 *
 * Inside the Tauri window the webview's menu is a browser's — Reload, Inspect,
 * Back — which in an installed business app is noise at best and a way to
 * wedge the window at worst. So it is suppressed everywhere, and what replaces
 * it is ours:
 *
 * - On a row that offers actions (a job, a customer, a form…), that row's own
 *   actions: the same handlers its buttons use, already filtered by what the
 *   seat may do.
 * - In a text field, or over selected text, Cut, Copy, Paste and Select all,
 *   so nothing the native menu did for text is lost.
 * - Anywhere else, nothing.
 *
 * In a plain browser tab (development) none of this is installed and the
 * browser's own menu stays, so the developer tools are a right-click away.
 *
 * The menu opens at the pointer and runs in the reading direction, clamped to
 * the window; it closes on Escape, a click elsewhere, scrolling, resizing, the
 * window losing focus or a change of screen; and it is a proper menu for the
 * keyboard: arrows, Home, End, Enter, Space, Tab.
 */

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
}

interface OpenMenu {
  /** The screen it was opened on; a change of screen takes the menu with it. */
  path: string;
  x: number;
  y: number;
  items: readonly MenuItem[];
  label: string;
}

interface MenuState {
  /** Opens a menu of `items` at the pointer of `event`, if this is the desktop window. */
  open: (
    event: { clientX: number; clientY: number; preventDefault(): void },
    items: readonly MenuItem[],
    label: string,
  ) => void;
  /** Whether right-click menus are ours here (the Tauri window) or the browser's. */
  enabled: boolean;
}

const ContextMenuContext = createContext<MenuState>({ open: () => undefined, enabled: false });

export function useContextMenu(): MenuState {
  return useContext(ContextMenuContext);
}

function isEditable(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement) {
    return !target.disabled;
  }
  if (target instanceof HTMLInputElement) {
    const textual = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''];
    return !target.disabled && textual.includes(target.type);
  }
  return target.isContentEditable;
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? '';
}

export function ContextMenuProvider({
  children,
  enabled = isTauri(),
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const location = useLocation();

  const close = useCallback(() => setMenu(null), []);

  const open = useCallback<MenuState['open']>(
    (event, items, label) => {
      if (!enabled || items.length === 0) {
        return;
      }
      event.preventDefault();
      setMenu({ path: location.pathname, x: event.clientX, y: event.clientY, items, label });
    },
    [enabled, location.pathname],
  );

  // Every right-click in the window. A row that handled it has already called
  // preventDefault and opened its own menu; React's listeners run before this
  // document-level one, so that case is simply left alone here.
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      const target = event.target;
      const editable = isEditable(target) ? target : null;
      const text = selectedText();
      if (editable === null && text === '') {
        setMenu(null);
        return;
      }
      setMenu({
        path: window.location.hash.replace(/^#/u, '').split('?')[0] ?? '',
        x: event.clientX,
        y: event.clientY,
        label: t('common.contextMenu.label'),
        items: clipboardItems(editable, text, {
          cut: t('common.contextMenu.cut'),
          copy: t('common.contextMenu.copy'),
          paste: t('common.contextMenu.paste'),
          selectAll: t('common.contextMenu.selectAll'),
        }),
      });
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [enabled, t]);

  const value = useMemo(() => ({ open, enabled }), [open, enabled]);

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      {menu?.path === location.pathname ? <Menu menu={menu} onClose={close} /> : null}
    </ContextMenuContext.Provider>
  );
}

function clipboardItems(
  editable: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null,
  text: string,
  labels: { cut: string; copy: string; paste: string; selectAll: string },
): MenuItem[] {
  const readOnly =
    editable === null ||
    ((editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) &&
      editable.readOnly);
  const hasSelection =
    text !== '' ||
    ((editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) &&
      (editable.selectionStart ?? 0) !== (editable.selectionEnd ?? 0));
  const canPaste = !readOnly && typeof navigator.clipboard?.readText === 'function';

  return [
    {
      key: 'cut',
      label: labels.cut,
      disabled: readOnly || !hasSelection,
      onSelect: () => {
        editable?.focus();
        document.execCommand('cut');
      },
    },
    {
      key: 'copy',
      label: labels.copy,
      disabled: !hasSelection,
      onSelect: () => {
        editable?.focus();
        document.execCommand('copy');
      },
    },
    {
      key: 'paste',
      label: labels.paste,
      disabled: !canPaste,
      onSelect: () => {
        void navigator.clipboard
          .readText()
          .then((pasted) => {
            editable?.focus();
            // insertText goes through the input's own editing, so a controlled
            // React field sees the change and undo still works.
            document.execCommand('insertText', false, pasted);
          })
          .catch(() => undefined);
      },
    },
    {
      key: 'selectAll',
      label: labels.selectAll,
      onSelect: () => {
        if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
          editable.focus();
          editable.select();
        } else {
          editable?.focus();
          document.execCommand('selectAll');
        }
      },
    },
  ];
}

const MARGIN = 8;

/**
 * Where the menu goes: at the pointer, running in the reading direction (to
 * the right in English, to the left in Arabic), pulled back inside the window
 * with a small margin. `inline` is the distance from the window's start edge,
 * which is its left in English and its right in Arabic.
 */
export function menuPosition(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  rtl: boolean;
}): { inline: number; top: number } {
  const fromStart = input.rtl ? input.viewportWidth - input.x : input.x;
  return {
    inline: Math.max(MARGIN, Math.min(fromStart, input.viewportWidth - input.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(input.y, input.viewportHeight - input.height - MARGIN)),
  };
}

function Menu({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  // Start at the pointer and run in the reading direction: to the right in
  // English, to the left in Arabic. Measured, then pulled back inside.
  const [position, setPosition] = useState<{ inline: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    setPosition(
      menuPosition({
        x: menu.x,
        y: menu.y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        rtl,
      }),
    );
  }, [menu.x, menu.y, rtl]);

  // Focus the first item that can be chosen, once placed.
  useEffect(() => {
    if (position === null) {
      return;
    }
    const first = ref.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();
  }, [position]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) {
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.label}
      tabIndex={-1}
      onKeyDown={move}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 min-w-48 rounded-md border border-border-subtle bg-surface py-1 text-sm shadow-lg"
      style={{
        insetInlineStart: position?.inline ?? 0,
        top: position?.top ?? 0,
        visibility: position === null ? 'hidden' : 'visible',
      }}
    >
      {menu.items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          disabled={item.disabled === true}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className={`block w-full px-3 py-1.5 text-start focus:outline-none disabled:opacity-40 ${
            item.destructive === true
              ? 'text-danger hover:bg-danger-subtle focus:bg-danger-subtle'
              : 'text-content hover:bg-surface-muted focus:bg-surface-muted'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
