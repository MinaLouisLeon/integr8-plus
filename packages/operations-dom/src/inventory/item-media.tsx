import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type ItemMedia, keys, useOperations } from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { buttonClass, cardClass, Failure, Field, inputClass, InlineError, Loading } from '../ui.js';

/**
 * An item's images and datasheets (eighth round; ADR-0012), from the media
 * storage everything else uses. Everyone who sees the item sees them: images
 * first, the main one marked — the phone keeps that one offline — then the
 * datasheets, which open in a new tab. Those who manage the catalogue add
 * files, choose the main image and take files off.
 */

const isImage = (media: Pick<ItemMedia, 'contentType'>) => media.contentType.startsWith('image/');

/** The file types an item takes: photos, and PDF datasheets. */
const ACCEPT = 'image/*,application/pdf';

export function ItemGallery({ itemId, canManage }: { itemId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const adapter = useMemo(() => apiMediaAdapter(client), [client]);

  const media = useQuery({
    queryKey: keys.itemMedia(itemId),
    queryFn: async () =>
      (await client.GET('/v1/inventory/items/{itemId}/media', { params: { path: { itemId } } }))
        .data!.items,
  });
  const settle = (items: ItemMedia[]) => {
    queries.setQueryData(keys.itemMedia(itemId), items);
  };
  const makeMain = useMutation({
    mutationFn: async (attachmentId: string) =>
      (
        await client.POST('/v1/inventory/items/{itemId}/media/{attachmentId}/main', {
          params: { path: { itemId, attachmentId } },
        })
      ).data!.items,
    onSuccess: settle,
  });
  const remove = useMutation({
    mutationFn: async (attachmentId: string) =>
      (
        await client.DELETE('/v1/inventory/items/{itemId}/media/{attachmentId}', {
          params: { path: { itemId, attachmentId } },
        })
      ).data!.items,
    onSuccess: settle,
  });
  const open = async (file: ItemMedia) => {
    const url = await adapter.url({
      mediaId: file.fileId,
      contentType: file.contentType,
      byteSize: file.byteSize,
    });
    window.open(url, '_blank', 'noopener');
  };

  const files = media.data ?? [];
  const images = files.filter(isImage);
  const datasheets = files.filter((file) => !isImage(file));
  const error = [makeMain.error, remove.error].find((candidate) => candidate !== null);
  const busy = makeMain.isPending || remove.isPending;

  return (
    <section aria-labelledby="inventory-item-media" className={cardClass}>
      <h2 id="inventory-item-media" className="text-base font-semibold text-content">
        {t('inventory.media.title')}
      </h2>
      {media.isPending ? (
        <Loading />
      ) : media.isError ? (
        <InlineError onRetry={() => void media.refetch()} />
      ) : files.length === 0 ? (
        <p className="text-sm text-content-muted">{t('inventory.media.empty')}</p>
      ) : (
        <>
          {images.length === 0 ? null : (
            <ul
              aria-label={t('inventory.media.images')}
              className="grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              {images.map((image) => (
                <li
                  key={image.id}
                  className={`flex flex-col gap-2 rounded-md border p-2 ${
                    image.isMain ? 'border-accent' : 'border-border-subtle'
                  }`}
                >
                  <button
                    type="button"
                    className="block overflow-hidden rounded"
                    aria-label={t('inventory.media.openNamed', { title: image.title })}
                    onClick={() => void open(image)}
                  >
                    <MediaThumbnail fileId={image.fileId} title={image.title} />
                  </button>
                  <span dir="auto" className="truncate text-xs text-content">
                    {image.title}
                  </span>
                  {image.isMain ? (
                    <span className="self-start rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-content">
                      {t('inventory.media.main')}
                    </span>
                  ) : null}
                  {canManage ? (
                    <div className="flex flex-wrap gap-1">
                      {image.isMain ? null : (
                        <button
                          type="button"
                          className={buttonClass.ghost}
                          disabled={busy}
                          aria-label={t('inventory.media.makeMainNamed', { title: image.title })}
                          onClick={() => makeMain.mutate(image.id)}
                        >
                          {t('inventory.media.makeMain')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        disabled={busy}
                        aria-label={t('inventory.media.removeNamed', { title: image.title })}
                        onClick={() => {
                          if (window.confirm(t('inventory.media.removeConfirm'))) {
                            remove.mutate(image.id);
                          }
                        }}
                      >
                        {t('inventory.media.remove')}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {datasheets.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium text-content-muted">
                {t('inventory.media.datasheets')}
              </h3>
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {datasheets.map((sheet) => (
                  <li
                    key={sheet.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <button
                      type="button"
                      dir="auto"
                      className="text-start text-accent underline-offset-4 hover:underline"
                      onClick={() => void open(sheet)}
                    >
                      {sheet.title}
                      <span className="sr-only"> {t('inventory.media.newTab')}</span>
                    </button>
                    {canManage ? (
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        disabled={busy}
                        aria-label={t('inventory.media.removeNamed', { title: sheet.title })}
                        onClick={() => {
                          if (window.confirm(t('inventory.media.removeConfirm'))) {
                            remove.mutate(sheet.id);
                          }
                        }}
                      >
                        {t('inventory.media.remove')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {error === undefined ? null : <Failure error={error} />}
      {canManage ? (
        <AddMedia itemId={itemId} hasMain={images.some((image) => image.isMain)} onAdded={settle} />
      ) : null}
    </section>
  );
}

/** An image's thumbnail once made, or the image itself; read through a short-lived link. */
export function MediaThumbnail({ fileId, title }: { fileId: string; title: string }) {
  const { client } = useOperations();
  const link = useQuery({
    queryKey: keys.media(fileId),
    queryFn: async () =>
      (await client.GET('/v1/media/{mediaId}', { params: { path: { mediaId: fileId } } })).data!,
    // Links expire after five minutes: read a fresh one before then.
    staleTime: 4 * 60_000,
  });
  const src = link.data?.thumbnailUrl ?? link.data?.url;
  return src === undefined ? (
    <span aria-hidden="true" className="block aspect-square w-full bg-surface-muted" />
  ) : (
    <img src={src} alt={title} className="aspect-square w-full object-cover" />
  );
}

/** Uploads a file through the media storage, then adds it to the item. */
function AddMedia({
  itemId,
  hasMain,
  onAdded,
}: {
  itemId: string;
  hasMain: boolean;
  onAdded: (items: ItemMedia[]) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const adapter = useMemo(() => apiMediaAdapter(client), [client]);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [main, setMain] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const image = file?.type.startsWith('image/') === true;
  const idempotencyKey = useIdempotencyKey({
    name: file?.name ?? null,
    size: file?.size ?? null,
    title,
    main,
  });

  const add = useMutation({
    mutationFn: async () => {
      const contentType = file!.type === '' ? 'application/octet-stream' : file!.type;
      const reference = await adapter.upload(file!, { contentType });
      return (
        await client.POST('/v1/inventory/items/{itemId}/media', {
          params: { path: { itemId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            fileId: reference.mediaId,
            title: (title.trim() === '' ? file!.name : title.trim()).slice(0, 200),
            ...(main ? { main: true } : {}),
          },
        })
      ).data!.items;
    },
    onSuccess: (items) => {
      onAdded(items);
      setFile(null);
      setTitle('');
      setMain(false);
      setInputKey((key) => key + 1);
    },
  });

  return (
    <form
      aria-label={t('inventory.media.add')}
      className="flex flex-col gap-3 border-t border-border-subtle pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (file !== null) {
          add.mutate();
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('inventory.media.file')} hint={t('inventory.media.fileHint')}>
          {(id, describedBy) => (
            <input
              key={inputKey}
              id={id}
              type="file"
              accept={ACCEPT}
              aria-describedby={describedBy}
              className="text-sm text-content"
              onChange={(event) => {
                add.reset();
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                setMain(false);
                if (chosen !== null && title.trim() === '') {
                  setTitle(chosen.name.slice(0, 200));
                }
              }}
            />
          )}
        </Field>
        <Field label={t('inventory.media.fileTitle')}>
          {(id) => (
            <input
              id={id}
              maxLength={200}
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
      </div>
      {image ? (
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={main || !hasMain}
            disabled={!hasMain}
            onChange={(event) => setMain(event.target.checked)}
          />
          {hasMain ? t('inventory.media.setMain') : t('inventory.media.firstIsMain')}
        </label>
      ) : null}
      {add.isError ? <Failure error={add.error} /> : null}
      <button
        type="submit"
        className={`${buttonClass.secondary} self-start`}
        disabled={file === null || add.isPending}
      >
        {add.isPending ? t('inventory.media.uploading') : t('inventory.media.upload')}
      </button>
    </form>
  );
}
