/**
 * A small form for the preview window's tests: a required question, a
 * question shown only when another is answered "yes", a calculation, and a
 * repeating section, in English and Arabic.
 */
export const tripForm = {
  schemaVersion: 2,
  title: { en: 'Car trip', ar: 'رحلة بالسيارة' },
  pages: [
    {
      id: 'p1',
      title: { en: 'Trip', ar: 'الرحلة' },
      sections: [
        {
          id: 'trip',
          title: { en: 'Trip', ar: 'الرحلة' },
          fields: [
            {
              id: 'purpose',
              type: 'text',
              label: { en: 'Purpose', ar: 'الغرض' },
              required: true,
            },
            { id: 'by_car', type: 'yes_no', label: { en: 'By car?', ar: 'بالسيارة؟' } },
            {
              id: 'km',
              type: 'number',
              label: { en: 'Kilometres', ar: 'الكيلومترات' },
              visibleWhen: {
                kind: 'compare',
                operator: 'eq',
                left: { kind: 'answer', field: 'by_car' },
                right: { kind: 'text', value: 'yes' },
              },
            },
            {
              id: 'cost',
              type: 'number',
              label: { en: 'Allowance', ar: 'البدل' },
              calculation: {
                kind: 'arithmetic',
                operator: 'multiply',
                left: { kind: 'answer', field: 'km' },
                right: { kind: 'number', value: '2' },
              },
            },
          ],
        },
        {
          id: 'stops',
          title: { en: 'Stops', ar: 'التوقفات' },
          repeat: { maxEntries: 5, entryLabel: { en: 'Stop', ar: 'توقف' } },
          fields: [{ id: 'place', type: 'text', label: { en: 'Place', ar: 'المكان' } }],
        },
      ],
    },
  ],
};
