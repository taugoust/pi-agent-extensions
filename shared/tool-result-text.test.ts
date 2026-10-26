import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedToolResult, boundedToolResultText, normalizedToolResultText } from './tool-result-text.ts';
const code='const logLevel = "λ🚀";\nconst literal = \'{"content":[1,2],"slash":"\\\\"}\';\n'.repeat(100);
const source={content:[{type:'text',text:code}],details:{fixture:true}};
test('old Read mid-JSON preview is irrecoverable; live boundary clips normalized code instead',()=>{
 const legacy={truncated:true,preview:Buffer.from(JSON.stringify(source)).subarray(0,1984).toString('utf8')};
 assert.ok(legacy.preview.startsWith('{"content":[{"type":"text","text":"'));
 assert.throws(()=>JSON.parse(legacy.preview));
 const live=boundedToolResult(source);assert.equal(typeof live,'object');if(typeof live==='string')return;
 assert.equal(live.truncated,true);assert.equal(live.normalized,true);assert.ok(code.startsWith(live.preview));
 assert.ok(live.preview.includes('\n'));assert.ok(!live.preview.includes('"type":"text"'));assert.ok(!live.preview.includes('\ufffd'));
 assert.ok(Buffer.byteLength(JSON.stringify(live))<=2048);
});
test('retained transport normalizes before clipping and explicitly flags truncation',()=>{
 const text=boundedToolResultText(source);assert.ok(text.startsWith('const logLevel'));assert.ok(text.endsWith('\n[truncated]'));
 assert.ok(code.startsWith(text.slice(0,-'\n[truncated]'.length)));assert.ok(Buffer.byteLength(text)<=2048);assert.ok(!text.includes('\ufffd'));
});
test('both string-valued sources and text blocks preserve literal transport-shaped JSON',()=>{
 const literal='{"content":[{"type":"text","text":"literal file data"}],"isError":true}';
 for(const value of [literal,JSON.stringify(literal),{content:[{type:'text',text:literal}]}]) {
  assert.equal(normalizedToolResultText(value),typeof value==='string'?value:literal);
 }
 assert.equal(normalizedToolResultText({content:[{type:'text',text:'literal \\n and actual\nnewline λ🚀'}]}),'literal \\n and actual\nnewline λ🚀');
});
test('large typed result keeps useful output; large literal serialized source is not guessed away',()=>{
 const text='hello '.repeat(12000), typed={content:[{type:'text',text}]};
 for(const input of [typed,JSON.stringify(typed)]) {
  const result=boundedToolResultText(input);
  assert.ok(result.endsWith('\n[truncated]'));
  assert.ok((typeof input==='string'?input:text).startsWith(result.slice(0,-'\n[truncated]'.length)));
  assert.ok(Buffer.byteLength(result)<=2048);
 }
});
test('complete control sequences are removed before clipping useful output',()=>{
 const text='\x1b[31m'.repeat(500)+'actual result';
 assert.equal(boundedToolResultText({content:[{type:'text',text}]}),'actual result');
 assert.equal(boundedToolResultText(text),'actual result');
});
test('MCP resource text is readable but media data and metadata never leak',()=>{
 assert.equal(normalizedToolResultText({content:[{type:'resource',resource:{uri:'test:///file',text:'actual file text'}}]}),'actual file text');
 for(const type of ['video','image','audio','future']) for(const extra of [{},{size:16},{foo:true}]) {
  const block={type,mimeType:'x/binary',data:'PRIVATE_BINARY',...extra};
  assert.doesNotMatch(normalizedToolResultText({content:[block]}),/PRIVATE_BINARY/);
  assert.doesNotMatch(normalizedToolResultText(block),/PRIVATE_BINARY/);
 }
});
test('serialized budget includes escaping and rejects invalid limits',()=>{
 const result=boundedToolResult({content:[{type:'text',text:'\u0001"\\\n'.repeat(3000)}]});assert.ok(Buffer.byteLength(JSON.stringify(result))<=2048);
 assert.throws(()=>boundedToolResult(source,1));assert.throws(()=>boundedToolResultText(source,1));
});
