import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageJsonPath = join(import.meta.dirname, '..', 'package.json');

test('package metadata includes the minicode website for app attribution', () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    homepage?: string;
  };

  assert.equal(pkg.homepage, 'https://minicode.seanholung.com');
});
