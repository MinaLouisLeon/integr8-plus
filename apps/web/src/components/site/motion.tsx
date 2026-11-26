'use client';

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * The Integr8 Media site's movement, written small.
 *
 * The company site uses the `motion` library for these; here they are a few
 * hooks and CSS transitions, because four effects do not justify a 40 kB
 * dependency in every public page. Each one does nothing when the operating
 * system asks for reduced motion: the text is simply there, the button stays
 * put. The stylesheet's reduced-motion rule is the second guard, for anything
 * a transition would still animate.
 */

const REDUCED = '(prefers-reduced-motion: reduce)';

/** True when the visitor's system asks for less motion. False on the server. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(REDUCED);
      media.addEventListener('change', notify);
      return () => media.removeEventListener('change', notify);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/** True once the element has scrolled into view, and from then on. */
export function useInView(
  ref: RefObject<Element | null>,
  rootMargin = '0px 0px -10% 0px',
): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null || inView) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, inView]);

  return inView;
}

/**
 * Pulls its child toward a mouse pointer while hovered, then eases back.
 * Touch and pen do nothing: there is no hover to follow.
 */
export function Magnetic({
  children,
  strength = 0.35,
  className = '',
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();

  return (
    <span
      ref={ref}
      className={`inline-block transition-transform duration-300 ease-[cubic-bezier(0.2,0.9,0.3,1.3)] ${className}`}
      onPointerMove={(event) => {
        const element = ref.current;
        if (reduced || event.pointerType !== 'mouse' || element === null) {
          return;
        }
        const box = element.getBoundingClientRect();
        const x = (event.clientX - (box.x + box.width / 2)) * strength;
        const y = (event.clientY - (box.y + box.height / 2)) * strength;
        element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }}
      onPointerLeave={() => {
        if (ref.current !== null) {
          ref.current.style.transform = '';
        }
      }}
    >
      {children}
    </span>
  );
}

/**
 * A line whose words rise out of a mask, one after another, when it scrolls
 * into view. Screen readers get the sentence once, whole.
 */
export function RevealText({
  text,
  className = '',
  delay = 0,
}: {
  text: string;
  className?: string;
  /** Seconds before the first word moves. */
  delay?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref);
  const words = text.split(/\s+/u).filter((word) => word !== '');

  return (
    <span ref={ref} className={`site-reveal ${inView ? 'is-in' : ''} ${className}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, index) => (
          <span key={`${String(index)}-${word}`}>
            {index === 0 ? null : ' '}
            <span className="site-reveal-word">
              <span style={{ transitionDelay: `${(delay + index * 0.06).toFixed(2)}s` }}>
                {word}
              </span>
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** The small rounded label above a heading, with the pulsing lime dot. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`mb-6 inline-flex items-center gap-2 rounded-full border border-site-line bg-white/[0.03] px-3 py-1 font-mono text-xs tracking-[0.2em] text-site-muted uppercase rtl:tracking-normal ${className}`}
    >
      <span aria-hidden="true" className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-lime opacity-75 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-lime" />
      </span>
      {children}
    </p>
  );
}

/** The film grain over the whole page: fixed, faint, and never in the way of a click. */
export function Grain() {
  return <div aria-hidden="true" className="site-grain" />;
}
