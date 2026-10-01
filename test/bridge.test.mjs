// Тесты файлового моста мода (адаптировано из пакета mazlive-koth-beta).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {ModBridge} from '../agent/bridge.mjs';
import {Router,defaults,validate} from '../agent/rules.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'koth-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const b=new ModBridge(dir);
  fs.mkdirSync(b.root,{recursive:true});
  const state={protocol:2,session:'a'.repeat(32),updatedAt:Date.now(),phase:'running'};
  const write=()=>fs.writeFileSync(path.join(b.root,'status.json'),JSON.stringify(state));
  write();return {b,state,write};
}

test('atomic command matches protocol v2 and preserves Unicode',t=>{
  const {b}=fixture(t);
  const ticket=b.send('tank',{count:12,name:'Артём\n~'});
  const files=fs.readdirSync(path.join(b.root,'inbox'));
  assert.equal(files.length,1);
  assert.ok(files[0].endsWith('.cmd'));
  const f=fs.readFileSync(path.join(b.root,'inbox',files[0]),'utf8').split('\t');
  assert.equal(f.length,7);
  assert.deepEqual(f.slice(1,3),['tank','12']);
  assert.equal(Buffer.from(f[3],'base64').toString(),'Артём  ');
  assert.equal(f[4],ticket.id);
  assert.equal(f[5],ticket.session);
  assert.equal(f[6],'2');
});

test('limits, path injection, unsupported action',t=>{
  const {b}=fixture(t);
  for(const count of [0,13,1.5,NaN])assert.throws(()=>b.send('car',{count}));
  assert.throws(()=>b.send('exec'));
  assert.throws(()=>b.send('car',{id:'../escape'}));
  assert.throws(()=>b.ack({id:'../escape'}));
});

test('stale status, protocol mismatch, pause, and stop',t=>{
  const {b,state,write}=fixture(t);
  state.updatedAt-=6000;write();assert.throws(()=>b.send('start'));
  state.updatedAt=Date.now();state.protocol=1;write();assert.throws(()=>b.status());
  state.protocol=2;state.phase='paused';write();assert.throws(()=>b.send('car'));
  assert.ok(b.send('stop').id);
});

test('ACK missing and wrong session cannot report success',t=>{
  const {b}=fixture(t);
  const ticket=b.send('car');
  assert.equal(b.ack(ticket),null);
  fs.mkdirSync(path.join(b.root,'acks'));
  const file=path.join(b.root,'acks',ticket.id+'.json');
  fs.writeFileSync(file,JSON.stringify({...ticket,protocol:2,outcome:'queued'}));
  assert.equal(b.ack(ticket).outcome,'queued');
  fs.writeFileSync(file,JSON.stringify({...ticket,protocol:2,session:'bad'}));
  assert.throws(()=>b.ack(ticket));
});

test('full disk inbox rejects new events',t=>{
  const {b}=fixture(t);
  fs.mkdirSync(path.join(b.root,'inbox'));
  for(let i=0;i<100;i++)fs.writeFileSync(path.join(b.root,'inbox',i+'.cmd'),'x');
  assert.throws(()=>b.send('car'),/Queue full/);
});
