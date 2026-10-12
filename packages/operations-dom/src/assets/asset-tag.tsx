import { useTranslation } from '@integr8/i18n';
import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * Printed asset tags (CRM/ERP plan, phase E3; ADR-0008).
 *
 * The QR code holds the asset's tag link (or its bare code when the web app's
 * address is not configured; the phone reads either). It is encoded at
 * error-correction level Q, which still reads with a quarter of the code
 * scratched or dirty, with the quiet zone the standard asks for, and drawn as
 * one SVG path in pure black on white so a thermal or laser printer renders
 * it crisply at any size.
 *
 * Under the code the tag repeats the asset number and its code in groups of
 * four, for typing in when a camera will not read it.
 */

export function QrCode({
  text,
  label,
  className = '',
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const { path, size } = useMemo(() => {
    const qr = encode(text, { ecc: 'Q', border: 4 });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) {
          d += `M${String(x)} ${String(y)}h1v1h-1z`;
        }
      });
    });
    return { path: d, size: qr.size };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/** `7K2M9P4QX8ZT` → `7K2M-9P4Q-X8ZT`. */
export function groupedCode(code: string): string {
  return code.replace(/(.{4})(?=.)/gu, '$1-');
}

export interface TagData {
  id: string;
  reference: string;
  name: string;
  tagCode: string;
  tagLink: string | null;
}

/**
 * One label, 63.5 × 38.1 mm: the size of the common 21-per-sheet A4 label
 * (3 × 7). Black on white only; the company name prints too, so a tag found
 * on a machine says whose it is.
 */
export function AssetTag({ tag, company }: { tag: TagData; company: string }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-[38.1mm] w-[63.5mm] items-center gap-[2mm] overflow-hidden bg-white p-[2mm] text-black"
      style={{ breakInside: 'avoid' }}
    >
      <QrCode
        text={tag.tagLink ?? tag.tagCode}
        label={t('assets.tags.qrLabel', { reference: tag.reference })}
        className="h-[34mm] w-[34mm] shrink-0"
      />
      <div className="flex min-w-0 flex-col gap-[1mm] text-start leading-tight">
        <span className="text-[7pt] font-semibold uppercase">{company}</span>
        <span dir="ltr" className="text-[11pt] font-bold">
          {tag.reference}
        </span>
        <span dir="auto" className="line-clamp-2 text-[8pt]">
          {tag.name}
        </span>
        <span dir="ltr" className="font-mono text-[7pt]">
          {groupedCode(tag.tagCode)}
        </span>
        <span className="text-[6pt]">{t('assets.tags.scan')}</span>
      </div>
    </div>
  );
}

/**
 * A sheet of tags for printing: three across, as many rows as it takes, with
 * the A4 sheet's margins. Hidden on screen; the page prints it alone.
 */
export function AssetTagSheet({ tags, company }: { tags: readonly TagData[]; company: string }) {
  return (
    <div
      aria-hidden="true"
      className="hidden print:grid print:grid-cols-[repeat(3,63.5mm)] print:gap-x-[2.5mm] print:px-[7mm] print:py-[15mm]"
    >
      {tags.map((tag) => (
        <AssetTag key={tag.id} tag={tag} company={company} />
      ))}
    </div>
  );
}
