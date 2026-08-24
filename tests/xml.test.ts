import assert from 'node:assert/strict';
import test from 'node:test';

import { childNamed, childrenNamed, decodeEntities, descendantsNamed, parseXml, XmlError } from '../src/yokogawa/xml';

test('reads elements, attributes and nesting', () => {
  const root = parseXml(
    `<?xml version="1.0"?><!-- a comment -->
     <OME xmlns="urn:ome"><Image ID="Image:1"><Pixels Type='uint16' SizeX="2000"/></Image>
     <Image ID="Image:2"/></OME>`,
  );

  assert.equal(root.name, 'OME');
  assert.deepEqual(root.attributes, {});
  const images = childrenNamed(root, 'Image');
  assert.equal(images.length, 2);
  assert.equal(images[0].attributes.ID, 'Image:1');
  assert.equal(childNamed(images[0], 'Pixels')?.attributes.SizeX, '2000');
  assert.equal(childNamed(images[0], 'Pixels')?.attributes.Type, 'uint16');
});

test('drops namespace prefixes from names and attributes', () => {
  const root = parseXml(
    `<bts:WellPlateProduct xmlns:bts="urn:bts" bts:ColumnPitch="9" bts:RowPitch="9"/>`,
  );
  assert.equal(root.name, 'WellPlateProduct');
  assert.equal(root.attributes.ColumnPitch, '9');
  assert.equal(root.attributes.RowPitch, '9');
  assert.equal(Object.keys(root.attributes).length, 2);
});

test('keeps document order and finds descendants at any depth', () => {
  const root = parseXml(
    `<a><b n="1"/><c><b n="2"><b n="3"/></b></c><b n="4"/></a>`,
  );
  assert.deepEqual(
    descendantsNamed(root, 'b').map((node) => node.attributes.n),
    ['1', '2', '3', '4'],
  );
  assert.deepEqual(
    childrenNamed(root, 'b').map((node) => node.attributes.n),
    ['1', '4'],
  );
});

test('expands entities and CDATA, and ignores whitespace-only text', () => {
  const root = parseXml(`<a t="a &lt; b &#38; c"><b><![CDATA[<raw>]]></b><c>\n   \n</c></a>`);
  assert.equal(root.attributes.t, 'a < b & c');
  assert.equal(childNamed(root, 'b')?.text, '<raw>');
  assert.equal(childNamed(root, 'c')?.text, undefined);
});

test('rejects malformed documents rather than guessing', () => {
  assert.throws(() => parseXml('<a><b></a>'), XmlError);
  assert.throws(() => parseXml('<a>'), XmlError);
  assert.throws(() => parseXml('   '), XmlError);
});

test('decodeEntities leaves unknown references alone', () => {
  assert.equal(decodeEntities('&nope; &amp;'), '&nope; &');
});
