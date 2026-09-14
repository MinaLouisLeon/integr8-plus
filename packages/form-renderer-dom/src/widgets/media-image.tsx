import type { MediaReference } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useEffect, useState } from 'react';
import type { MediaAdapter } from '../media.js';

/** A stored file's URL, fetched when shown: links are short-lived, so they are never kept in answers. */
export function useMediaUrl(media: MediaAdapter, reference: MediaReference): string | undefined {
  const [url, setUrl] = useState<{ id: string; url: string } | undefined>(undefined);
  // Keyed by the media id, not the reference object: answers are re-parsed on
  // every render, and an object dependency would fetch a new link every time.
  const { mediaId, contentType, byteSize } = reference;
  useEffect(() => {
    let current = true;
    media.url({ mediaId, contentType, byteSize }).then(
      (resolved) => {
        if (current) {
          setUrl({ id: mediaId, url: resolved });
        }
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [media, mediaId, contentType, byteSize]);
  return url?.id === reference.mediaId ? url.url : undefined;
}

export function MediaImage({
  media,
  reference,
  alt,
  className,
}: {
  media: MediaAdapter;
  reference: MediaReference;
  alt: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const url = useMediaUrl(media, reference);
  return url === undefined ? (
    <span role="status" className="text-xs text-content-muted">
      {t('fill.loadingMedia')}
    </span>
  ) : (
    <img src={url} alt={alt} className={className} />
  );
}
