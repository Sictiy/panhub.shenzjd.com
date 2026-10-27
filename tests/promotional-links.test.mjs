import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterPromotionalResults, isPromotionalLink } from '../src/utils/promotionalLinks.ts';

test('filters upstream landing pages without removing legitimate resources', () => {
  assert.equal(isPromotionalLink('https://panhub.shenzjd.com/'), true);
  assert.equal(isPromotionalLink('请访问 https://www.shenzjd.com/info'), true);
  assert.equal(isPromotionalLink('https://pan.baidu.com/s/abc'), false);
  assert.equal(isPromotionalLink('https://shenzjd.com.example.org/file'), false);
  const result = filterPromotionalResults({
    baidu: [
      { url: 'https://panhub.shenzjd.com/', note: '请访问上游' },
      { url: '', tid: 'real-resource', note: '正常资源' },
      { url: 'https://pan.baidu.com/s/abc', note: '正常链接' },
    ],
    other: [{ url: 'https://shenzjd.com/' }],
  });
  assert.deepEqual(result, { baidu: [
    { url: '', tid: 'real-resource', note: '正常资源' },
    { url: 'https://pan.baidu.com/s/abc', note: '正常链接' },
  ] });
});
