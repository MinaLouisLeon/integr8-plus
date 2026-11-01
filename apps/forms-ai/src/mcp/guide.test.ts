import { BLOCK_COLOURS, DOCUMENT_FONT_KEYS } from '@integr8/document-render';
import { FIELD_TYPES, INFORMATION_STYLES } from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_NOTES,
  BLOCK_OPTION_NOTES,
  blockShapes,
  EXPRESSION_NOTES,
  expressionKinds,
  FONT_NOTES,
  GUIDE_SECTIONS,
  guideSection,
  QUESTION_NOTES,
  QUESTION_OPTION_NOTES,
  questionShapes,
  slotKinds,
} from './guide.js';

/**
 * The guide cannot drift from the format: everything the schemas accept is
 * described, and every section renders. A new question type, option, rule
 * kind, block or font fails here until the guide says what it is.
 */
describe('the format guide', () => {
  it('renders every section', () => {
    for (const section of GUIDE_SECTIONS) {
      expect(guideSection(section).length).toBeGreaterThan(300);
    }
  });

  it('documents every question type and every property of each', () => {
    const text = guideSection('questions');
    expect(FIELD_TYPES).toHaveLength(18);
    for (const { type } of FIELD_TYPES) {
      expect(QUESTION_NOTES[type]).toBeTruthy();
      expect(text).toContain(`| \`${type}\` |`);
    }
    const shapes = questionShapes();
    expect(shapes.map((shape) => shape.type).sort()).toEqual(
      FIELD_TYPES.map((entry) => entry.type).sort(),
    );
    for (const shape of shapes) {
      for (const key of [...shape.required, ...shape.optional]) {
        expect(QUESTION_OPTION_NOTES, `question property "${key}"`).toHaveProperty([key]);
      }
    }
  });

  it('documents every rule and calculation kind', () => {
    const text = guideSection('logic');
    for (const kind of expressionKinds()) {
      expect(EXPRESSION_NOTES[kind], kind).toBeTruthy();
      expect(text).toContain(`\`${kind}\``);
    }
    expect(Object.keys(EXPRESSION_NOTES).sort()).toEqual(expressionKinds().sort());
  });

  it('documents every PDF block and every block property', () => {
    const text = guideSection('pdf_templates');
    const shapes = blockShapes();
    expect(Object.keys(BLOCK_NOTES).sort()).toEqual(shapes.map((shape) => shape.type).sort());
    for (const shape of shapes) {
      expect(text).toContain(`- \`${shape.type}\`:`);
      for (const key of [...shape.required, ...shape.optional]) {
        expect(BLOCK_OPTION_NOTES, `block property "${key}"`).toHaveProperty([key]);
      }
    }
  });

  it('documents fonts, colours, header and footer places, information styles', () => {
    const pdf = guideSection('pdf_templates');
    for (const font of DOCUMENT_FONT_KEYS) {
      expect(FONT_NOTES[font]).toBeTruthy();
      expect(pdf).toContain(`\`${font}\``);
    }
    for (const colour of BLOCK_COLOURS) {
      expect(BLOCK_OPTION_NOTES.colour).toContain(colour);
    }
    for (const kind of slotKinds()) {
      expect(pdf).toContain(`\`${kind}\``);
    }
    const information = guideSection('information');
    for (const style of INFORMATION_STYLES) {
      expect(information).toContain(`\`${style}\``);
    }
  });

  it('carries JSON Schemas that parse', () => {
    const text = guideSection('json_schema');
    const blocks = [...text.matchAll(/```json\n(.+)\n```/gu)].map(
      (match) => JSON.parse(match[1] ?? '') as object,
    );
    expect(blocks).toHaveLength(2);
  });
});
