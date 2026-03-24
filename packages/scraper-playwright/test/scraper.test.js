import test from 'node:test'
import assert from 'node:assert/strict'
import { dedupeItems, normalizeItem } from '../src/index.js'

test('normalizeItem returns stable item payload', () => {
  const output = normalizeItem(
    {
      url: '/item/m123456',
      title: '  Sony 相机  ',
      price: '¥ 12,000',
      image: '/img/test.jpg',
    },
    7,
  )

  assert.equal(output.source_id, 7)
  assert.equal(output.item_id, 'm123456')
  assert.equal(output.title, 'Sony 相机')
  assert.equal(output.price, '¥12,000')
  assert.match(output.url, /\/item\/m123456$/)
})

test('dedupeItems drops duplicate source+item pairs', () => {
  const items = [
    { source_id: 1, item_id: 'a', url: 'u1' },
    { source_id: 1, item_id: 'a', url: 'u1' },
    { source_id: 1, item_id: 'b', url: 'u2' },
  ]
  const output = dedupeItems(items)
  assert.equal(output.length, 2)
})
