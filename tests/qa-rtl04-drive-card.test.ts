// QA-20261108 RTL-04/UI-04: no user-visible reference to a Google Drive integration that does not exist.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const settings = readFileSync('src/pages/Settings.tsx', 'utf8');
const layout = readFileSync('src/layouts/AppLayout.tsx', 'utf8');
const visible = (src: string) => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
describe('RTL-04 Google Drive card removed', () => {
  it('settings has no Google Drive card, flow or dialog', () => {
    expect(visible(settings)).not.toMatch(/Google Drive|غوغل درايف|جوجل درايف|googleapis\.com\/upload\/drive|triggerBackup/);
  });
  it('logout no longer offers a Google Drive backup', () => {
    expect(visible(layout)).not.toMatch(/Google Drive|triggerBackup|نسخ احتياطي الآن/);
  });
});
