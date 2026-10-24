import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PILOT_NOTICE } from '@pa/contracts';

import GlobalError from '../app/global-error';

// The global error page replaces the root layout, so it must carry its own
// document and the pilot notice. Next renders it in the browser from the RSC
// payload, which the server-only web boundary test cannot observe.

describe('global error page', () => {
  it('renders its own document with the pilot notice', () => {
    const markup = renderToStaticMarkup(createElement(GlobalError, { error: new Error('layout failed'), retry: () => undefined }));
    expect(markup).toMatch(/^<html lang="en">.*<body[^>]*>/s);
    expect(markup).toContain(`<p role="note"`);
    expect(markup).toContain(PILOT_NOTICE);
    expect(markup).not.toContain('layout failed');
  });
});
