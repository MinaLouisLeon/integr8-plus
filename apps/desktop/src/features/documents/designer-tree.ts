import type { Block, LeafBlock, TemplateDesign } from '@integr8/document-render';
import { freshBlockId } from './designer-model';

/**
 * The designer's block tree (1.3.0 decision 8): where a block is, moving it
 * between the template's column and a row's columns, and copying blocks with
 * ids nothing else in the template has. Pure functions of the design, so
 * dragging, the keyboard buttons, duplicating and pasting all agree.
 */

type AnyBlock = Block | LeafBlock;

/** The template's own column of blocks. */
export const ROOT = 'root';

/** A row's column as a drop target: `col:<rowId>:<index>`. */
export function columnContainer(rowId: string, column: number): string {
  return `col:${rowId}:${String(column)}`;
}

function parseContainer(container: string): { rowId: string; column: number } | null {
  const match = /^col:(.+):(\d+)$/u.exec(container);
  return match === null ? null : { rowId: match[1] ?? '', column: Number(match[2]) };
}

export interface BlockPlace {
  container: string;
  index: number;
}

/** Where a block is: the template's column or a row's, and its position there. */
export function locateBlock(blocks: readonly Block[], id: string): BlockPlace | null {
  for (const [index, block] of blocks.entries()) {
    if (block.id === id) {
      return { container: ROOT, index };
    }
    if (block.type === 'row') {
      for (const [column, inner] of block.columns.entries()) {
        const at = inner.blocks.findIndex((candidate) => candidate.id === id);
        if (at !== -1) {
          return { container: columnContainer(block.id, column), index: at };
        }
      }
    }
  }
  return null;
}

/** The blocks in a container. */
export function blocksIn(blocks: readonly Block[], container: string): readonly AnyBlock[] {
  if (container === ROOT) {
    return blocks;
  }
  const place = parseContainer(container);
  const row = blocks.find((block) => block.id === place?.rowId);
  return row?.type === 'row' ? (row.columns[place!.column]?.blocks ?? []) : [];
}

function withContainer(
  blocks: readonly Block[],
  container: string,
  change: (inner: AnyBlock[]) => AnyBlock[],
): Block[] {
  if (container === ROOT) {
    return change([...blocks]);
  }
  const place = parseContainer(container);
  return blocks.map((block) =>
    block.type === 'row' && block.id === place?.rowId
      ? {
          ...block,
          columns: block.columns.map((column, index) =>
            index === place.column
              ? { ...column, blocks: change([...column.blocks]) as LeafBlock[] }
              : column,
          ),
        }
      : block,
  );
}

/** Whether a block may stand in a container: rows and page breaks only in the template's own column. */
export function mayGoIn(block: AnyBlock, container: string): boolean {
  return container === ROOT || (block.type !== 'row' && block.type !== 'page_break');
}

/**
 * The blocks with one moved to `target`, its index counted as the list looks
 * before the move. Null when the move is not allowed or changes nothing.
 */
export function moveBlock(
  blocks: readonly Block[],
  id: string,
  target: BlockPlace,
): Block[] | null {
  const from = locateBlock(blocks, id);
  if (from === null) {
    return null;
  }
  const block = blocksIn(blocks, from.container)[from.index]!;
  if (!mayGoIn(block, target.container)) {
    return null;
  }
  if (block.type === 'row' && target.container.startsWith(`col:${block.id}:`)) {
    return null;
  }
  if (from.container === target.container) {
    const length = blocksIn(blocks, from.container).length;
    const index = Math.max(0, Math.min(length - 1, target.index));
    if (index === from.index) {
      return null;
    }
    return withContainer(blocks, from.container, (inner) => {
      const [moved] = inner.splice(from.index, 1);
      inner.splice(index, 0, moved!);
      return inner;
    });
  }
  const without = withContainer(blocks, from.container, (inner) =>
    inner.filter((candidate) => candidate.id !== id),
  );
  return withContainer(without, target.container, (inner) => {
    inner.splice(Math.max(0, Math.min(inner.length, target.index)), 0, block);
    return inner;
  });
}

/** Copies of blocks with ids unused in `design` (a row's blocks included), ready to insert. */
export function freshCopies(
  design: Pick<TemplateDesign, 'blocks'>,
  copies: readonly AnyBlock[],
): AnyBlock[] {
  let blocks: Block[] = [...design.blocks];
  const take = (block: AnyBlock): AnyBlock => {
    const id = freshBlockId({ blocks }, block.type);
    const copy = { ...structuredClone(block), id };
    // Reserve the id at once, so the next copy does not take it too.
    blocks = [...blocks, { type: 'divider', id }];
    if (copy.type === 'row') {
      return {
        ...copy,
        columns: copy.columns.map((column) => ({
          ...column,
          blocks: column.blocks.map((inner) => take(inner) as LeafBlock),
        })),
      };
    }
    return copy;
  };
  return copies.map(take);
}

/** The design with a copy of one block just after it. */
export function duplicateBlock(design: TemplateDesign, id: string): TemplateDesign | null {
  const place = locateBlock(design.blocks, id);
  if (place === null) {
    return null;
  }
  const original = blocksIn(design.blocks, place.container)[place.index]!;
  const [copy] = freshCopies(design, [original]);
  return {
    ...design,
    blocks: withContainer(design.blocks, place.container, (inner) => {
      inner.splice(place.index + 1, 0, copy!);
      return inner;
    }),
  };
}

/** The design with blocks inserted into a container (the template's own column by default). */
export function insertBlocks(
  design: TemplateDesign,
  incoming: readonly AnyBlock[],
  target: BlockPlace = { container: ROOT, index: design.blocks.length },
): TemplateDesign {
  const allowed = incoming.filter((block) => mayGoIn(block, target.container));
  const copies = freshCopies(design, allowed);
  return {
    ...design,
    blocks: withContainer(design.blocks, target.container, (inner) => {
      inner.splice(Math.max(0, Math.min(inner.length, target.index)), 0, ...copies);
      return inner;
    }),
  };
}
