import { expect, test } from '@playwright/test';

test('renders the web operational shell', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Journal' })).toBeVisible();
  await expect(page.getByText('The application shell is ready.')).toBeVisible();
});
